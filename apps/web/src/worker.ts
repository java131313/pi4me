// pi-web Worker entry: auth for all /api/* routes, JSON endpoints for keys and
// conversations, and the SSE chat endpoint that streams an LLM reply while persisting
// both turns to PostgreSQL. Static assets (the chat UI) are served by the platform.

import {
	createConversation,
	deleteApiKey,
	deleteConversation,
	ensureSchema,
	getConversation,
	insertApiKey,
	insertMessage,
	latestApiKey,
	listApiKeys,
	listConversations,
	listMessages,
	recentMessages,
	touchConversation,
} from "./db.ts";
import { streamChat } from "./llm.ts";
import { encodeSse, isProvider, type ProviderId, type SseEvent } from "./types.ts";

export interface Env {
	DATABASE_URL: string;
	PI_WEB_TOKEN: string;
	// Optional Kimi relay (apps/relay): api.kimi.com blocks Cloudflare Workers IPs.
	KIMI_RELAY_URL?: string;
	KIMI_RELAY_TOKEN?: string;
	// Optional remote browser service (apps/browser): WebSocket endpoint + shared secret.
	BROWSER_WS_URL?: string;
	BROWSER_TOKEN?: string;
}

// Model suggestions mirror pi's model catalog; the UI accepts any model id.
const MODEL_SUGGESTIONS: Record<ProviderId, string[]> = {
	anthropic: ["claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5.5"],
	openai: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
	google: ["gemini-3.5-flash", "gemini-flash-latest"],
	kimi: ["kimi-for-coding", "k3.1-pro", "k3", "k3-256k"],
};

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Constant-time comparison without node:crypto so the app type-checks against
// Workers types alone; the token length is not the secret here.
function tokenValid(provided: string, expected: string): boolean {
	const a = new TextEncoder().encode(provided);
	const b = new TextEncoder().encode(expected);
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

function maskKey(key: string): string {
	return key.length <= 8 ? "••••" : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

interface ChatRequest {
	conversationId?: string;
	provider?: string;
	model?: string;
	content?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) {
			return new Response("not found", { status: 404 });
		}
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204 });
		}
		if (!env.PI_WEB_TOKEN) {
			return json({ error: "PI_WEB_TOKEN is not configured on the Worker" }, 500);
		}
		const authorization = request.headers.get("authorization") ?? "";
		if (!tokenValid(authorization, `Bearer ${env.PI_WEB_TOKEN}`)) {
			return json({ error: "unauthorized" }, 401);
		}
		try {
			await ensureSchema(env);
			return await route(request, env, url);
		} catch (error) {
			return json({ error: errorMessage(error) }, 500);
		}
	},
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname;
	const method = request.method;

	if (path === "/api/health" && method === "GET") {
		return json({ ok: true });
	}
	if (path === "/api/models" && method === "GET") {
		return json(MODEL_SUGGESTIONS);
	}

	if (path === "/api/keys") {
		if (method === "GET") {
			const keys = await listApiKeys(env);
			return json(
				keys.map((row) => ({
					id: row.id,
					provider: row.provider,
					label: row.label,
					baseUrl: row.base_url,
					maskedKey: maskKey(row.api_key),
				})),
			);
		}
		if (method === "POST") {
			const body = (await request.json().catch(() => null)) as
				| { provider?: string; label?: string; apiKey?: string; baseUrl?: string }
				| null;
			if (!body || !isProvider(body.provider) || typeof body.apiKey !== "string" || !body.apiKey.trim()) {
				return json({ error: "provider (anthropic|openai|google|kimi) and apiKey are required" }, 400);
			}
			const id = await insertApiKey(env, {
				provider: body.provider,
				label: typeof body.label === "string" ? body.label.trim() : "",
				apiKey: body.apiKey.trim(),
				baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : "",
			});
			return json({ id }, 201);
		}
	}

	const keyMatch = path.match(/^\/api\/keys\/([^/]+)$/);
	if (keyMatch && method === "DELETE") {
		return json({ deleted: await deleteApiKey(env, keyMatch[1]) });
	}

	if (path === "/api/conversations" && method === "GET") {
		return json(await listConversations(env));
	}

	const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)(\/messages)?$/);
	if (conversationMatch && UUID_PATTERN.test(conversationMatch[1])) {
		const id = conversationMatch[1];
		if (conversationMatch[2] && method === "GET") {
			return json(await listMessages(env, id));
		}
		if (!conversationMatch[2] && method === "GET") {
			const conversation = await getConversation(env, id);
			return conversation ? json(conversation) : json({ error: "not found" }, 404);
		}
		if (!conversationMatch[2] && method === "DELETE") {
			return json({ deleted: await deleteConversation(env, id) });
		}
	}

	if (path === "/api/chat" && method === "POST") {
		return chat(request, env);
	}

	// Remote browser (apps/browser): hands the WebSocket endpoint + shared secret to the
	// authenticated UI. Deliberately delivered to the client — the pi-web token is the gate.
	if (path === "/api/browser/config" && method === "GET") {
		if (!env.BROWSER_WS_URL || !env.BROWSER_TOKEN) {
			return json({ error: "browser service not configured" }, 404);
		}
		return json({ url: env.BROWSER_WS_URL, token: env.BROWSER_TOKEN });
	}

	return json({ error: "not found" }, 404);
}

async function chat(request: Request, env: Env): Promise<Response> {
	const body = (await request.json().catch(() => null)) as ChatRequest | null;
	if (!body || typeof body.content !== "string" || !body.content.trim()) {
		return json({ error: "content is required" }, 400);
	}
	if (!isProvider(body.provider)) {
		return json({ error: "provider must be anthropic, openai, google or kimi" }, 400);
	}
	if (typeof body.model !== "string" || !body.model.trim()) {
		return json({ error: "model is required" }, 400);
	}
	const provider = body.provider;
	const model = body.model.trim();
	const content = body.content.trim();

	const keyRow = await latestApiKey(env, provider);
	if (!keyRow) {
		return json({ error: `no api key configured for provider "${provider}", add one in the keys panel` }, 400);
	}

	let conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
	let conversation = conversationId ? await getConversation(env, conversationId) : null;
	if (conversationId && !conversation) {
		return json({ error: "conversation not found" }, 404);
	}
	if (!conversation) {
		conversationId = await createConversation(env, { title: content.slice(0, 40), provider, model });
	} else {
		await touchConversation(env, conversationId, {
			model,
			title: conversation.title ? undefined : content.slice(0, 40),
		});
	}

	await insertMessage(env, { conversationId, role: "user", content, model: "", tokensIn: 0, tokensOut: 0 });
	const history = await recentMessages(env, conversationId, 50);

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: SseEvent) => controller.enqueue(encoder.encode(encodeSse(event)));
			send({ type: "meta", conversationId });
			let accumulated = "";
			try {
				const usage = await streamChat({
					provider,
					apiKey: keyRow.api_key,
					baseUrl: keyRow.base_url,
					model,
					messages: history,
					signal: request.signal,
					relayUrl: env.KIMI_RELAY_URL ?? "",
					relayToken: env.KIMI_RELAY_TOKEN ?? "",
					onDelta: (text) => {
						accumulated += text;
						send({ type: "delta", text });
					},
				});
				const messageId = await insertMessage(env, {
					conversationId,
					role: "assistant",
					content: accumulated,
					model,
					tokensIn: usage.tokensIn,
					tokensOut: usage.tokensOut,
				});
				send({ type: "done", messageId, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });
			} catch (error) {
				send({ type: "error", message: errorMessage(error) });
			} finally {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
		},
	});
}
