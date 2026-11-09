// LLM streaming for pi-web: direct fetch + SSE parsing against the supported provider
// APIs (Anthropic, OpenAI-compatible, Google, and Kimi For Coding). pi's own pi-ai
// package targets Node (undici, fs, dispatcher config), so these lines replace it
// inside the Worker; model ids and Kimi's endpoint follow pi's catalog.

import type { ChatMessage, ProviderId } from "./types.ts";

export interface StreamParams {
	provider: ProviderId;
	apiKey: string;
	// Only used by the openai provider (OpenAI-compatible endpoints such as DeepSeek).
	baseUrl: string;
	model: string;
	messages: ChatMessage[];
	signal: AbortSignal;
	onDelta: (text: string) => void;
	// Only used by the kimi provider: api.kimi.com's WAF blocks Cloudflare Workers
	// egress IPs, so production routes Worker → relay → api.kimi.com with a shared
	// secret. Empty strings mean "call api.kimi.com directly" (works off-Cloudflare).
	relayUrl: string;
	relayToken: string;
}

export interface StreamUsage {
	tokensIn: number;
	tokensOut: number;
}

// Kimi For Coding: OpenAI-compatible endpoint from pi's kimi-coding provider,
// base URL built in so only the API key is needed.
const KIMI_BASE_URL = "https://api.kimi.com/coding/v1";

export function streamChat(params: StreamParams): Promise<StreamUsage> {
	switch (params.provider) {
		case "anthropic":
			return streamAnthropic(params);
		case "openai":
			return streamOpenAi(params);
		case "google":
			return streamGoogle(params);
		case "kimi": {
			const viaRelay = params.relayUrl && params.relayToken;
			const base = viaRelay ? `${params.relayUrl.replace(/\/+$/, "")}/coding/v1` : KIMI_BASE_URL;
			const extraHeaders = viaRelay ? { "x-relay-key": params.relayToken } : undefined;
			return streamOpenAi({ ...params, baseUrl: base }, "Kimi", extraHeaders);
		}
	}
}

// Reads an SSE body and invokes onEvent for every JSON data payload. A thrown error from
// onEvent aborts the read; end of body means end of stream for all three providers.
async function readSse(response: Response, onEvent: (data: unknown) => void): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("provider returned an empty response body");
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		for (let sep = buffer.indexOf("\n\n"); sep !== -1; sep = buffer.indexOf("\n\n")) {
			const rawEvent = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			for (const line of rawEvent.split("\n")) {
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trimStart();
				if (!payload || payload === "[DONE]") continue;
				try {
					onEvent(JSON.parse(payload));
				} catch {
					// Non-JSON keepalive payloads are not events.
				}
			}
		}
	}
}

async function providerError(response: Response, name: string): Promise<Error> {
	let detail = response.statusText;
	try {
		const body = (await response.json()) as { error?: { message?: string } | string; message?: string };
		if (typeof body.error === "object" && body.error?.message) detail = body.error.message;
		else if (typeof body.error === "string") detail = body.error;
		else if (body.message) detail = body.message;
		else detail = JSON.stringify(body).slice(0, 300);
	} catch {
		// Keep the status text for non-JSON error bodies.
	}
	return new Error(`${name} ${response.status}: ${detail}`);
}

const ANTHROPIC_VERSION = "2023-06-01";

async function streamAnthropic(p: StreamParams): Promise<StreamUsage> {
	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		signal: p.signal,
		headers: {
			"content-type": "application/json",
			"x-api-key": p.apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		},
		body: JSON.stringify({ model: p.model, max_tokens: 8192, stream: true, messages: p.messages }),
	});
	if (!response.ok) throw await providerError(response, "Anthropic");
	let tokensIn = 0;
	let tokensOut = 0;
	await readSse(response, (data) => {
		const event = data as {
			type?: string;
			delta?: { type?: string; text?: string };
			usage?: { input_tokens?: number; output_tokens?: number };
			error?: { message?: string };
		};
		if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
			p.onDelta(event.delta.text);
		} else if (event.type === "message_start" && event.usage) {
			tokensIn = event.usage.input_tokens ?? tokensIn;
			tokensOut = event.usage.output_tokens ?? tokensOut;
		} else if (event.type === "message_delta" && event.usage?.output_tokens != null) {
			tokensOut = event.usage.output_tokens;
		} else if (event.type === "error") {
			throw new Error(`Anthropic stream error: ${event.error?.message ?? JSON.stringify(data)}`);
		}
	});
	return { tokensIn, tokensOut };
}

async function streamOpenAi(p: StreamParams, name = "OpenAI", extraHeaders?: Record<string, string>): Promise<StreamUsage> {
	const base = (p.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
	const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
	const response = await fetch(url, {
		method: "POST",
		signal: p.signal,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${p.apiKey}`,
			...extraHeaders,
		},
		body: JSON.stringify({
			model: p.model,
			stream: true,
			stream_options: { include_usage: true },
			messages: p.messages,
		}),
	});
	if (!response.ok) throw await providerError(response, name);
	let tokensIn = 0;
	let tokensOut = 0;
	await readSse(response, (data) => {
		const event = data as {
			choices?: { delta?: { content?: string } }[];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		const delta = event.choices?.[0]?.delta?.content;
		if (delta) p.onDelta(delta);
		if (event.usage) {
			tokensIn = event.usage.prompt_tokens ?? tokensIn;
			tokensOut = event.usage.completion_tokens ?? tokensOut;
		}
	});
	return { tokensIn, tokensOut };
}

async function streamGoogle(p: StreamParams): Promise<StreamUsage> {
	const url =
		`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:streamGenerateContent` +
		`?alt=sse&key=${encodeURIComponent(p.apiKey)}`;
	const response = await fetch(url, {
		method: "POST",
		signal: p.signal,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			contents: p.messages.map((message) => ({
				role: message.role === "assistant" ? "model" : "user",
				parts: [{ text: message.content }],
			})),
		}),
	});
	if (!response.ok) throw await providerError(response, "Google");
	let tokensIn = 0;
	let tokensOut = 0;
	await readSse(response, (data) => {
		const event = data as {
			candidates?: { content?: { parts?: { text?: string }[] } }[];
			usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
		};
		const parts = event.candidates?.[0]?.content?.parts;
		if (parts) {
			const text = parts.map((part) => part.text ?? "").join("");
			if (text) p.onDelta(text);
		}
		if (event.usageMetadata) {
			tokensIn = event.usageMetadata.promptTokenCount ?? tokensIn;
			tokensOut = event.usageMetadata.candidatesTokenCount ?? tokensOut;
		}
	});
	return { tokensIn, tokensOut };
}
