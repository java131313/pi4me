// Shared types for pi-web: providers, database rows, and the SSE wire format between Worker and UI.

export type ProviderId = "anthropic" | "openai" | "google" | "kimi";

export const PROVIDERS: readonly ProviderId[] = ["anthropic", "openai", "google", "kimi"];

export function isProvider(value: unknown): value is ProviderId {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export interface ApiKeyRow {
	id: string;
	provider: ProviderId;
	label: string;
	api_key: string;
	base_url: string;
}

export interface ConversationRow {
	id: string;
	title: string;
	provider: string;
	model: string;
	created_at: string;
	updated_at: string;
}

export interface MessageRow {
	id: number;
	role: "user" | "assistant";
	content: string;
	model: string;
	tokens_in: number;
	tokens_out: number;
	created_at: string;
}

// What we send to an LLM: only the persisted turns of the current conversation.
export type ChatMessage = { role: "user" | "assistant"; content: string };

export type SseEvent =
	| { type: "meta"; conversationId: string }
	| { type: "delta"; text: string }
	| { type: "done"; messageId: number; tokensIn: number; tokensOut: number }
	| { type: "error"; message: string };

export function encodeSse(event: SseEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}
