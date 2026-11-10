// PostgreSQL access for pi-web: one short-lived client per use (managed PG kills idle
// connections and Workers isolates make pools unreliable), schema bootstrap, and queries.

import { Client } from "pg";
import type { ApiKeyRow, ChatMessage, ConversationRow, MessageRow, ProviderId } from "./types.ts";

export type PgClient = InstanceType<typeof Client>;

const TABLES = ["api_keys", "conversations", "messages"] as const;

function newClient(env: { DATABASE_URL: string }): PgClient {
	// ssl without verification is the managed-Postgres "require" mode: encrypted, chain not checked.
	return new Client({
		connectionString: env.DATABASE_URL,
		ssl: { rejectUnauthorized: false },
		connectionTimeoutMillis: 10_000,
	});
}

// A fresh short-lived connection per use: caching connections across requests hangs on
// Workers (the socket never becomes readable again after the request that created it).
// A per-chat-turn latency win instead comes from Cloudflare Hyperdrive, not from pooling here.
export async function withDb<T>(env: { DATABASE_URL: string }, fn: (client: PgClient) => Promise<T>): Promise<T> {
	const client = newClient(env);
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end().catch(() => {});
	}
}

async function queryRows<T>(client: PgClient, sql: string, params: unknown[] = []): Promise<T[]> {
	const result = await client.query(sql, params);
	return result.rows as T[];
}

let schemaPromise: Promise<void> | null = null;

// Creates the three tables on first use. gen_random_uuid() is built into PostgreSQL >= 13
// (Render runs 14+), so no extension is needed.
export function ensureSchema(env: { DATABASE_URL: string }): Promise<void> {
	schemaPromise ??= withDb(env, async (client) => {
		const { rows } = await client.query<{ table_name: string }>(
			"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
			[TABLES],
		);
		const existing = new Set(rows.map((row) => row.table_name));
		if (!existing.has("api_keys")) {
			await client.query(`CREATE TABLE api_keys (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				provider TEXT NOT NULL,
				label TEXT NOT NULL DEFAULT '',
				api_key TEXT NOT NULL,
				base_url TEXT NOT NULL DEFAULT '',
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`);
		}
		if (!existing.has("conversations")) {
			await client.query(`CREATE TABLE conversations (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				title TEXT NOT NULL DEFAULT '',
				provider TEXT NOT NULL DEFAULT '',
				model TEXT NOT NULL DEFAULT '',
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`);
		}
		if (!existing.has("messages")) {
			await client.query(`CREATE TABLE messages (
				id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				model TEXT NOT NULL DEFAULT '',
				tokens_in INTEGER NOT NULL DEFAULT 0,
				tokens_out INTEGER NOT NULL DEFAULT 0,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`);
			await client.query(
				"CREATE INDEX idx_messages_conversation ON messages(conversation_id, id)",
			);
		}
	}).then(() => undefined);
	return schemaPromise;
}

// --- api keys ---

export async function listApiKeys(env: { DATABASE_URL: string }): Promise<ApiKeyRow[]> {
	return withDb(env, (client) =>
		queryRows<ApiKeyRow>(
			client,
			`SELECT id, provider, label, api_key, base_url FROM api_keys ORDER BY created_at DESC`,
		),
	);
}

export async function insertApiKey(
	env: { DATABASE_URL: string },
	input: { provider: ProviderId; label: string; apiKey: string; baseUrl: string },
): Promise<string> {
	return withDb(env, async (client) => {
		const rows = await queryRows<{ id: string }>(
			client,
			`INSERT INTO api_keys (provider, label, api_key, base_url) VALUES ($1, $2, $3, $4) RETURNING id`,
			[input.provider, input.label, input.apiKey, input.baseUrl],
		);
		return rows[0].id;
	});
}

export async function deleteApiKey(env: { DATABASE_URL: string }, id: string): Promise<boolean> {
	return withDb(env, async (client) => {
		const result = await client.query("DELETE FROM api_keys WHERE id = $1", [id]);
		return (result.rowCount ?? 0) > 0;
	});
}

// One active key per provider: the most recently added wins.
export async function latestApiKey(env: { DATABASE_URL: string }, provider: ProviderId): Promise<ApiKeyRow | null> {
	return withDb(env, async (client) => {
		const rows = await queryRows<ApiKeyRow>(
			client,
			`SELECT id, provider, label, api_key, base_url FROM api_keys WHERE provider = $1 ORDER BY created_at DESC LIMIT 1`,
			[provider],
		);
		return rows[0] ?? null;
	});
}

// --- conversations ---

export async function createConversation(
	env: { DATABASE_URL: string },
	input: { title: string; provider: ProviderId; model: string },
): Promise<string> {
	return withDb(env, async (client) => {
		const rows = await queryRows<{ id: string }>(
			client,
			`INSERT INTO conversations (title, provider, model) VALUES ($1, $2, $3) RETURNING id`,
			[input.title, input.provider, input.model],
		);
		return rows[0].id;
	});
}

const CONVERSATION_COLUMNS = `id, title, provider, model, created_at::text AS created_at, updated_at::text AS updated_at`;

export async function listConversations(env: { DATABASE_URL: string }): Promise<ConversationRow[]> {
	return withDb(env, (client) =>
		queryRows<ConversationRow>(
			client,
			`SELECT ${CONVERSATION_COLUMNS} FROM conversations ORDER BY updated_at DESC LIMIT 200`,
		),
	);
}

export async function getConversation(env: { DATABASE_URL: string }, id: string): Promise<ConversationRow | null> {
	return withDb(env, async (client) => {
		const rows = await queryRows<ConversationRow>(
			client,
			`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1`,
			[id],
		);
		return rows[0] ?? null;
	});
}

export async function touchConversation(
	env: { DATABASE_URL: string },
	id: string,
	input: { model: string; title?: string },
): Promise<void> {
	await withDb(env, (client) =>
		client.query("UPDATE conversations SET updated_at = now(), model = $2, title = COALESCE(NULLIF($3, ''), title) WHERE id = $1", [
			id,
			input.model,
			input.title ?? "",
		]),
	);
}

export async function deleteConversation(env: { DATABASE_URL: string }, id: string): Promise<boolean> {
	return withDb(env, async (client) => {
		const result = await client.query("DELETE FROM conversations WHERE id = $1", [id]);
		return (result.rowCount ?? 0) > 0;
	});
}

// --- messages ---

export async function insertMessage(
	env: { DATABASE_URL: string },
	input: { conversationId: string; role: "user" | "assistant"; content: string; model: string; tokensIn: number; tokensOut: number },
): Promise<number> {
	return withDb(env, async (client) => {
		const rows = await queryRows<{ id: string }>(
			client,
			`INSERT INTO messages (conversation_id, role, content, model, tokens_in, tokens_out)
			 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			[input.conversationId, input.role, input.content, input.model, input.tokensIn, input.tokensOut],
		);
		return Number(rows[0].id);
	});
}

// The context sent to the model: the newest turns, oldest first.
export async function recentMessages(env: { DATABASE_URL: string }, conversationId: string, limit = 50): Promise<ChatMessage[]> {
	const rows = await withDb(env, (client) =>
		queryRows<ChatMessage>(
			client,
			`SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2`,
			[conversationId, limit],
		),
	);
	return rows.reverse();
}

export async function listMessages(env: { DATABASE_URL: string }, conversationId: string, limit = 500): Promise<MessageRow[]> {
	return withDb(env, (client) =>
		queryRows<MessageRow>(
			client,
			`SELECT id, role, content, model, tokens_in, tokens_out, created_at::text AS created_at
			 FROM messages WHERE conversation_id = $1 ORDER BY id ASC LIMIT $2`,
			[conversationId, limit],
		),
	);
}
