// Minimal relay for pi-web's Kimi provider: Worker → this service → api.kimi.com.
// api.kimi.com's Cloudflare WAF blocks Cloudflare Workers egress IPs, so production
// traffic routes through here. Access is gated by a shared-secret header (x-relay-key)
// and only /coding/* paths are forwarded; this is not an open proxy. The upstream
// Authorization header passes through untouched — the relay never sees stored keys.

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";

const UPSTREAM = "https://api.kimi.com";
const PORT = Number(process.env.PORT ?? 3000);
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";

if (!RELAY_TOKEN) {
	console.error("RELAY_TOKEN env var is required");
	process.exit(1);
}

// Hop-by-hop and transport-decoding headers must not be copied onto our own response.
const DROP_RESPONSE_HEADERS = new Set(["transfer-encoding", "connection", "keep-alive", "content-encoding"]);

function forbidden(res, message) {
	res.writeHead(403, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: message }));
}

function tokenOk(provided) {
	const a = Buffer.from(String(provided ?? ""));
	const b = Buffer.from(RELAY_TOKEN);
	return a.length === b.length && timingSafeEqual(a, b);
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");

	if (req.method === "GET" && url.pathname === "/healthz") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}
	if (!url.pathname.startsWith("/coding/")) {
		forbidden(res, "only /coding/* paths are relayed");
		return;
	}
	if (!tokenOk(req.headers["x-relay-key"])) {
		forbidden(res, "invalid relay key");
		return;
	}

	const controller = new AbortController();
	res.on("close", () => controller.abort());

	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	// Buffer the (small) request body instead of streaming it: Node >= 25 undici rejects
	// streaming request bodies, and chat request payloads never exceed a few KB.
	fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
		method: req.method,
		headers: {
			authorization: req.headers.authorization ?? "",
			"content-type": req.headers["content-type"] ?? "application/json",
			accept: req.headers.accept ?? "text/event-stream",
		},
		body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
		signal: controller.signal,
	})
		.then((upstream) => {
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
			console.log(`${req.method} ${url.pathname} -> ${upstream.status}`);
		})
		.catch((error) => {
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json" });
			}
			res.end(JSON.stringify({ error: `relay upstream error: ${error instanceof Error ? error.message : String(error)}` }));
		});
});

server.listen(PORT, () => console.log(`kimi relay listening on :${PORT} -> ${UPSTREAM}`));
