import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH || "scroll.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS scroll (
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    date TEXT NOT NULL,
    px INTEGER NOT NULL,
    PRIMARY KEY (room, username, date)
  );
  CREATE TABLE IF NOT EXISTS users (
    username_key TEXT PRIMARY KEY,   -- lowercase, for case-insensitive uniqueness
    username TEXT NOT NULL,          -- display name as first claimed
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const ROOM = "global";
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

const getUser = db.prepare("SELECT * FROM users WHERE username_key = ?");
const insertUser = db.prepare(
  "INSERT INTO users (username_key, username, token_hash, created_at) VALUES (?, ?, ?, ?)"
);

// Keep the larger value so a stale or replayed request can't lower a total.
const upsert = db.prepare(`
  INSERT INTO scroll (room, username, date, px) VALUES (?, ?, ?, ?)
  ON CONFLICT(room, username, date) DO UPDATE SET px = MAX(px, excluded.px)
`);

const topQuery = db.prepare(`
  SELECT username, SUM(px) AS total_px
  FROM scroll
  WHERE room = ? AND date >= ?
  GROUP BY username
  ORDER BY total_px DESC, username ASC
  LIMIT ?
`);

const myTotalQuery = db.prepare(`
  SELECT COALESCE(SUM(px), 0) AS total_px
  FROM scroll WHERE room = ? AND username = ? AND date >= ?
`);

const higherCountQuery = db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT username, SUM(px) AS t FROM scroll
    WHERE room = ? AND date >= ?
    GROUP BY username
    HAVING t > ?
  )
`);

const participantsQuery = db.prepare(`
  SELECT COUNT(DISTINCT username) AS n FROM scroll WHERE room = ? AND date >= ?
`);

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

// Returns the user row if the token matches, otherwise null.
function authenticate(username, token) {
  if (typeof username !== "string" || typeof token !== "string" || token.length < 16 || token.length > 128) {
    return null;
  }
  const user = getUser.get(username.toLowerCase());
  if (!user || !safeEqual(user.token_hash, hashToken(token))) return null;
  return user;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2kb" }));

// First install to claim a username owns it.
app.post("/api/claim", (req, res) => {
  const { username, token } = req.body || {};
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters: letters, numbers, _ or -" });
  }
  if (typeof token !== "string" || token.length < 16 || token.length > 128) {
    return res.status(400).json({ error: "invalid token" });
  }
  const existing = getUser.get(username.toLowerCase());
  if (existing) {
    if (safeEqual(existing.token_hash, hashToken(token))) {
      return res.json({ ok: true, username: existing.username });
    }
    return res.status(409).json({ error: "Username is already taken" });
  }
  try {
    insertUser.run(username.toLowerCase(), username, hashToken(token), new Date().toISOString());
  } catch {
    return res.status(409).json({ error: "Username is already taken" });
  }
  res.json({ ok: true, username });
});

app.post("/api/scroll", (req, res) => {
  const { username, token, date, px } = req.body || {};
  const user = authenticate(username, token);
  if (!user) return res.status(403).json({ error: "Username not claimed by this install" });

  if (typeof date !== "string" || !DATE_RE.test(date) || date < isoDay(-1) || date > isoDay(1)) {
    return res.status(400).json({ error: "invalid date" });
  }
  if (typeof px !== "number" || !Number.isFinite(px) || px < 0 || px > MAX_DAILY_PX) {
    return res.status(400).json({ error: "invalid px" });
  }
  upsert.run(ROOM, user.username, date, Math.round(px));
  res.json({ ok: true });
});

// Top N plus the caller's own rank: GET /api/leaderboard?username=name
app.get("/api/leaderboard", (req, res) => {
  const since = mondayOfThisWeek();
  const top = topQuery.all(ROOM, since, TOP_N).map((r, i) => ({ rank: i + 1, ...r }));
  const participants = participantsQuery.get(ROOM, since).n;

  let me = null;
  const name = typeof req.query.username === "string" ? req.query.username : "";
  const user = name ? getUser.get(name.toLowerCase()) : null;
  if (user) {
    const total = myTotalQuery.get(ROOM, user.username, since).total_px;
    if (total > 0) {
      const rank = higherCountQuery.get(ROOM, since, total).n + 1;
      me = { username: user.username, total_px: total, rank };
    }
  }
  res.json({ top, me, participants });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening on ${PORT}`));
