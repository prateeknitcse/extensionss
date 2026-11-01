// One-time copy of scroll rows from the old scroll.db into Postgres (Neon).
// Usage (PowerShell):  $env:DATABASE_URL="postgres://..."; node migrate-from-sqlite.mjs
// Safe to re-run: existing rows keep the larger px value.
import Database from "better-sqlite3";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL first.");

const sqlite = new Database("scroll.db", { readonly: true });
const rows = sqlite.prepare("SELECT username, date, px FROM scroll").all();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(`
  CREATE TABLE IF NOT EXISTS scroll (
    username TEXT NOT NULL, date TEXT NOT NULL, px BIGINT NOT NULL,
    PRIMARY KEY (username, date)
  )`);

for (const r of rows) {
  await pool.query(
    `INSERT INTO scroll (username, date, px) VALUES ($1, $2, $3)
     ON CONFLICT (username, date) DO UPDATE SET px = GREATEST(scroll.px, EXCLUDED.px)`,
    [r.username, r.date, r.px]
  );
}
console.log(`copied ${rows.length} rows`);
await pool.end();
