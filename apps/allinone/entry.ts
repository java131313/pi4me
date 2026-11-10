// pi-web all-in-one server: serves the chat UI (static) and /api/* (from apps/web's
// Worker handler) alongside the remote browser WebSocket and Kimi relay (from
// apps/browser). One port, one process — deployed as a single Render service so the
// API sits in the same region as PostgreSQL instead of round-tripping from a Worker.
//
// Source resolution works in both layouts: the Docker image copies sources next to
// this file (web-src/, browser-service.js, public/); a local checkout falls back to
// the workspace paths (../web/src, ../browser/server.js, ../web/public).
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

const here = import.meta.url;
const resolvePath = (local: string, workspace: string) =>
	existsSync(new URL(local, here)) ? local : workspace;

const workerModule = (await import(resolvePath("./web-src/worker.ts", "../web/src/worker.ts"))) as {
	default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
};
const browserService = (await import(resolvePath("./browser-service.js", "../browser/server.js"))) as {
	handleServiceRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
	handleUpgrade(req: IncomingMessage, socket: import("node:net").Socket, head: Buffer): void;
};
const indexHtml = readFileSync(new URL(resolvePath("./public/index.html", "../web/public/index.html"), here));

const PORT = Number(process.env.PORT ?? 3000);

// Convert a Node request into a Web Standards Request so the Worker handler runs unchanged.
function toWebRequest(req: IncomingMessage): Request {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		headers.set(key, Array.isArray(value) ? value.join(", ") : value);
	}
	const method = req.method ?? "GET";
	return new Request(`http://localhost${req.url}`, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(req) as unknown as ReadableStream),
		duplex: "half",
	});
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
	res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
	if (response.body) {
		Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
	} else {
		res.end();
	}
}

const server = createServer((req, res) => {
	(async () => {
		if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(indexHtml);
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname.startsWith("/api/")) {
			const response = await workerModule.default.fetch(toWebRequest(req), process.env, {});
			await sendWebResponse(res, response);
			return;
		}
		await browserService.handleServiceRequest(req, res);
	})().catch((error: unknown) => {
		if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	});
});

server.on("upgrade", (req, socket, head) => browserService.handleUpgrade(req, socket, head));

server.listen(PORT, () => console.log(`pi-web all-in-one listening on :${PORT}`));
