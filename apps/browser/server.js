// Remote browser streaming service for pi-web: one headless Chromium, one controlling
// WebSocket client at a time. Screencast frames (JPEG, binary WS messages) flow to the
// client; mouse/keyboard/navigate messages flow back via Playwright. Built for a single
// user: the browser stays alive across disconnects, sessions last as long as wanted.

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.BROWSER_TOKEN ?? "";
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

if (!TOKEN) {
	console.error("BROWSER_TOKEN env var is required");
	process.exit(1);
}

let browserPromise = null;
let page = null;
let cdp = null;
let activeSocket = null;

function getBrowser() {
	browserPromise ??= chromium
		.launch({
			executablePath: EXECUTABLE_PATH,
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--mute-audio",
			],
		})
		.then((browser) => {
			browser.on("disconnected", () => {
				browserPromise = null;
				page = null;
				cdp = null;
			});
			return browser;
		});
	return browserPromise;
}

async function ensurePage() {
	const browser = await getBrowser();
	if (!page || page.isClosed()) {
		const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, deviceScaleFactor: 1, locale: "zh-CN" });
		page = await context.newPage();
		cdp = await context.newCDPSession(page);
		await cdp.send("Page.enable");
		page.on("close", () => {
			page = null;
			cdp = null;
		});
	}
	return { page, cdp };
}

function tokenOk(provided) {
	const a = Buffer.from(String(provided ?? ""));
	const b = Buffer.from(TOKEN);
	return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(socket, message) {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

async function startScreencast(socket) {
	const session = (await ensurePage()).cdp;
	const onFrame = (event) => {
		// Ack is mandatory: Chromium pauses the screencast once a few frames are unacked.
		session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
		if (socket.readyState === socket.OPEN) socket.send(Buffer.from(event.data, "base64"));
	};
	session.on("Page.screencastFrame", onFrame);
	socket.on("close", () => {
		session.off("Page.screencastFrame", onFrame);
		session.send("Page.stopScreencast").catch(() => {});
	});
	await session.send("Page.startScreencast", {
		format: "jpeg",
		quality: 70,
		everyNthFrame: 2,
		maxWidth: 1920,
		maxHeight: 1080,
	});
}

async function handleControl(socket, raw) {
	const message = JSON.parse(raw);
	const { page } = await ensurePage();
	switch (message.type) {
		case "navigate": {
			const target = /^https?:\/\//.test(message.url) ? message.url : `https://${message.url}`;
			try {
				await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
				sendJson(socket, { type: "navigated", url: page.url() });
			} catch (error) {
				sendJson(socket, { type: "error", message: error instanceof Error ? error.message : String(error) });
			}
			break;
		}
		case "click":
			await page.mouse.click(message.x, message.y, { button: message.button ?? "left", clickCount: message.clickCount ?? 1 });
			break;
		case "move":
			await page.mouse.move(message.x, message.y);
			break;
		case "wheel":
			await page.mouse.wheel(message.deltaX ?? 0, message.deltaY ?? 0);
			break;
		case "key":
			await page.keyboard.press(message.key);
			break;
		case "text":
			await page.keyboard.insertText(message.text);
			break;
		case "resize":
			await page.setViewportSize({ width: Math.max(320, message.width), height: Math.max(240, message.height) });
			break;
		case "html": {
			// HTML rendering mode: ship the live DOM so the client can show it in a
			// sandboxed iframe (selectable text, working links) instead of the frame stream.
			const html = await page.content();
			if (html.length > 8_000_000) {
				sendJson(socket, { type: "error", message: "page HTML too large for html mode" });
				break;
			}
			sendJson(socket, { type: "html", url: page.url(), title: await page.title(), html });
			break;
		}
	}
}

const httpServer = createServer((req, res) => {
	if (req.method === "GET" && req.url === "/healthz") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, hasPage: page !== null }));
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (socket, req) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (!tokenOk(url.searchParams.get("token"))) {
		socket.close(4001, "invalid token");
		return;
	}
	if (activeSocket && activeSocket.readyState === activeSocket.OPEN) {
		sendJson(socket, { type: "error", message: "browser is busy" });
		socket.close(4002, "busy");
		return;
	}
	activeSocket = socket;
	socket.isAlive = true;
	socket.on("pong", () => {
		socket.isAlive = true;
	});
	// Dead clients (unclean disconnects, vanished tabs) otherwise hold the single slot forever.
	const heartbeat = setInterval(() => {
		if (!socket.isAlive) {
			clearInterval(heartbeat);
			socket.terminate();
			return;
		}
		socket.isAlive = false;
		socket.ping();
	}, 25_000);
	void ensurePage().then(async () => {
		sendJson(socket, { type: "ready", url: page?.url() ?? "about:blank" });
		await startScreencast(socket);
	});
	socket.on("message", (data) => {
		// `ws` delivers text frames as Buffer by default; convert before parsing.
		if (typeof data !== "string" && !Buffer.isBuffer(data)) return;
		handleControl(socket, data.toString()).catch((error) =>
			sendJson(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }),
		);
	});
	socket.on("error", () => {
		clearInterval(heartbeat);
		if (activeSocket === socket) activeSocket = null;
	});
	socket.on("close", () => {
		clearInterval(heartbeat);
		if (activeSocket === socket) activeSocket = null;
	});
});

httpServer.listen(PORT, () => console.log(`browser service listening on :${PORT}, chromium: ${EXECUTABLE_PATH}`));
