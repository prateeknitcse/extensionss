import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (use your Neon connection string).");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
});
pool.on("error", (e) => console.error("idle db client error:", e.message));

await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    username_key TEXT PRIMARY KEY,   -- lowercase, for case-insensitive uniqueness
    username     TEXT NOT NULL,      -- display name as first claimed
    token_hash   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS scroll (
    username TEXT NOT NULL,
    date     TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
    px       BIGINT NOT NULL,
    PRIMARY KEY (username, date)
  );
  CREATE INDEX IF NOT EXISTS scroll_date_idx ON scroll (date);
`);

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAILY_PX = 20_000_000; // sanity cap per user per day
const TOP_N = 10;

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const validToken = (t) => typeof t === "string" && t.length >= 16 && t.length <= 128;

function mondayOfThisWeek() {
  const d = new Date();
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

const isoDay = (offset = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function getUser(username) {
  const { rows } = await pool.query("SELECT * FROM users WHERE username_key = $1", [
    username.toLowerCase(),
  ]);
  return rows[0] || null;
}

// Returns the user row if the token matches, otherwise null.
async function authenticate(username, token) {
  if (typeof username !== "string" || !validToken(token)) return null;
  const user = await getUser(username);
  if (!user || !safeEqual(user.token_hash, hashToken(token))) return null;
  return user;
}

// Express 4 does not catch rejected promises from async handlers.
const route = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "server error" });
  });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2kb" }));

app.get("/healthz", (req, res) => res.send("ok"));

// Server-sent events: tells open popups to re-fetch the leaderboard when scroll data changes.
const MAX_STREAM_CLIENTS = 1000;
const streamClients = new Set();

app.get("/api/stream", (req, res) => {
  if (streamClients.size >= MAX_STREAM_CLIENTS) return res.status(503).end();
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  streamClients.add(res);
  req.on("close", () => streamClients.delete(res));
});

setInterval(() => {
  for (const c of streamClients) c.write(": ping\n\n"); // keeps proxies from closing idle streams
}, 25_000).unref();

let notifyTimer = null;
function notifyClients() {
  if (notifyTimer) return; // batch bursts into one event per 250 ms
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const c of streamClients) c.write("event: update\ndata: {}\n\n");
  }, 250);
}

// First install to claim a username owns it.
app.post(
  "/api/claim",
  route(async (req, res) => {
    const { username, token } = req.body || {};
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      return res
        .status(400)
        .json({ error: "Username must be 3-20 characters: letters, numbers, _ or -" });
    }
    if (!validToken(token)) return res.status(400).json({ error: "invalid token" });

    const inserted = await pool.query(
      `INSERT INTO users (username_key, username, token_hash)
       VALUES ($1, $2, $3) ON CONFLICT (username_key) DO NOTHING`,
      [username.toLowerCase(), username, hashToken(token)]
    );
    if (inserted.rowCount === 1) return res.json({ ok: true, username });

    const existing = await getUser(username);
    if (existing && safeEqual(existing.token_hash, hashToken(token))) {
      return res.json({ ok: true, username: existing.username });
    }
    res.status(409).json({ error: "Username is already taken" });
  })
);

app.post(
  "/api/scroll",
  route(async (req, res) => {
    const { username, token, date, px } = req.body || {};
    const user = await authenticate(username, token);
    if (!user) return res.status(403).json({ error: "Username not claimed by this install" });

    if (typeof date !== "string" || !DATE_RE.test(date) || date < isoDay(-1) || date > isoDay(1)) {
      return res.status(400).json({ error: "invalid date" });
    }
    if (typeof px !== "number" || !Number.isFinite(px) || px < 0 || px > MAX_DAILY_PX) {
      return res.status(400).json({ error: "invalid px" });
    }
    // Keep the larger value so a stale or replayed request can't lower a total.
    await pool.query(
      `INSERT INTO scroll (username, date, px) VALUES ($1, $2, $3)
       ON CONFLICT (username, date) DO UPDATE SET px = GREATEST(scroll.px, EXCLUDED.px)`,
      [user.username, date, Math.round(px)]
    );
    notifyClients();
    res.json({ ok: true });
  })
);

// Top N plus the caller's own rank: GET /api/leaderboard?username=name
app.get(
  "/api/leaderboard",
  route(async (req, res) => {
    const since = mondayOfThisWeek();

    const topRes = await pool.query(
      `SELECT username, SUM(px)::float8 AS total_px
       FROM scroll WHERE date >= $1
       GROUP BY username
       ORDER BY total_px DESC, username ASC
       LIMIT $2`,
      [since, TOP_N]
    );
    const top = topRes.rows.map((r, i) => ({ rank: i + 1, ...r }));

    const countRes = await pool.query(
      "SELECT COUNT(DISTINCT username)::int AS n FROM scroll WHERE date >= $1",
      [since]
    );
    const participants = countRes.rows[0].n;

    let me = null;
    const name = typeof req.query.username === "string" ? req.query.username : "";
    const user = name ? await getUser(name) : null;
    if (user) {
      const totalRes = await pool.query(
        "SELECT COALESCE(SUM(px), 0)::float8 AS t FROM scroll WHERE username = $1 AND date >= $2",
        [user.username, since]
      );
      const total = totalRes.rows[0].t;
      if (total > 0) {
        const higher = await pool.query(
          `SELECT COUNT(*)::int AS n FROM (
             SELECT username FROM scroll WHERE date >= $1
             GROUP BY username HAVING SUM(px) > $2
           ) t`,
          [since, total]
        );
        me = { username: user.username, total_px: total, rank: higher.rows[0].n + 1 };
      }
    }
    res.json({ top, me, participants });
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening on ${PORT}`));
