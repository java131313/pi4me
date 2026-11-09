// Temporary connectivity probe for the Render PG. Run: node pgtest.mjs (from apps/web). Deleted after use.
import pg from "pg";

const client = new pg.Client({
	connectionString: "postgresql://urlnote_user:pBNc8Y4ogcU39Ouj8HFCK8VkJRtvrBDK@dpg-dbo3umpsrm7s73atgug0-a.singapore-postgres.render.com/urlnote",
	ssl: { rejectUnauthorized: false },
	connectionTimeoutMillis: 15000,
});
try {
	await client.connect();
	const r = await client.query("SELECT now() AS t, (SELECT count(*) FROM pg_stat_activity) AS conns, (SELECT setting FROM pg_settings WHERE name='max_connections') AS max");
	console.log("OK:", r.rows[0]);
} catch (error) {
	console.log("FAIL:", error.message);
} finally {
	await client.end().catch(() => {});
}
