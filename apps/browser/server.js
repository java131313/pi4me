// Remote browser streaming service for pi-web: one headless Chromium, one controlling
// WebSocket client at a time. Screencast frames (JPEG, binary WS messages) flow to the
// client; mouse/keyboard/navigate messages flow back via Playwright. Built for a single
// user: the browser stays alive across disconnects, sessions last as long as wanted.

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.BROWSER_TOKEN ?? "";
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
// Kimi relay folded into the same process: one public port serves the browser WebSocket
// at /ws and the api.kimi.com passthrough at /coding/* (standalone version: apps/relay).
// One always-on Render free instance then covers both services within the 750h budget.
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";
const KIMI_UPSTREAM = "https://api.kimi.com";

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

// Request handler shared by standalone mode and the all-in-one server (apps/allinone):
// health check, Kimi relay passthrough, 404 for everything else.
export async function handleServiceRequest(req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (req.method === "GET" && url.pathname === "/healthz") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, hasPage: page !== null, relay: RELAY_TOKEN !== "" }));
		return;
	}
	if (url.pathname.startsWith("/coding/")) {
		await handleRelay(req, res, url);
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "not found" }));
}

// --- Kimi relay passthrough (identical semantics to apps/relay/server.mjs) ---

const DROP_RESPONSE_HEADERS = new Set(["transfer-encoding", "connection", "keep-alive", "content-encoding"]);

function relayForbidden(res, message) {
	res.writeHead(403, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: message }));
}

function relayTokenOk(provided) {
	const a = Buffer.from(String(provided ?? ""));
	const b = Buffer.from(RELAY_TOKEN);
	return a.length === b.length && timingSafeEqual(a, b);
}

async function handleRelay(req, res, url) {
	if (!RELAY_TOKEN) {
		relayForbidden(res, "relay is not configured");
		return;
	}
	if (!relayTokenOk(req.headers["x-relay-key"])) {
		relayForbidden(res, "invalid relay key");
		return;
	}
	const controller = new AbortController();
	res.on("close", () => controller.abort());
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	// Buffer the (small) request body instead of streaming it: Node >= 25 undici rejects
	// streaming request bodies, and chat request payloads never exceed a few KB.
	const upstream = await fetch(`${KIMI_UPSTREAM}${url.pathname}${url.search}`, {
		method: req.method,
		headers: {
			authorization: req.headers.authorization ?? "",
			"content-type": req.headers["content-type"] ?? "application/json",
			accept: req.headers.accept ?? "text/event-stream",
		},
		body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
		signal: controller.signal,
	});
	const headers = {};
	for (const [name, value] of upstream.headers) {
		if (!DROP_RESPONSE_HEADERS.has(name)) headers[name] = value;
	}
	res.writeHead(upstream.status, headers);
	if (upstream.body) {
		Readable.fromWeb(upstream.body).pipe(res);
	} else {
		res.end();
	}
	console.log(`relay ${req.method} ${url.pathname} -> ${upstream.status}`);
}

const wss = new WebSocketServer({ noServer: true });

// Route WebSocket upgrades: only /ws belongs to the browser service; anything else
// (the all-in-one server shares the port) is dropped.
export function handleUpgrade(req, socket, head) {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname !== "/ws") {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
}

wss.on("connection", (socket, req) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname !== "/ws" || !tokenOk(url.searchParams.get("token"))) {
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

// Standalone mode (`node server.js`): serve healthz/relay/browser on one port.
// When imported by the all-in-one server, that entrypoint owns the HTTP server instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (!TOKEN) {
		console.error("BROWSER_TOKEN env var is required");
		process.exit(1);
	}
	const httpServer = createServer((req, res) => {
		handleServiceRequest(req, res).catch((error) => {
			if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		});
	});
	httpServer.on("upgrade", handleUpgrade);
	httpServer.listen(PORT, () => console.log(`browser service listening on :${PORT}, chromium: ${EXECUTABLE_PATH}`));
}
