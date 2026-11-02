import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import pg from "pg";
import rateLimit from "express-rate-limit";

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
  -- One row per user, per day, per device. A user's day total is the sum over devices.
  CREATE TABLE IF NOT EXISTS scroll (
    username   TEXT NOT NULL,
    date       TEXT NOT NULL,        -- YYYY-MM-DD, the user's local date
    px         BIGINT NOT NULL,
    device     TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE scroll ADD COLUMN IF NOT EXISTS device TEXT NOT NULL DEFAULT '';
  ALTER TABLE scroll ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  ALTER TABLE scroll DROP CONSTRAINT IF EXISTS scroll_pkey;
  CREATE UNIQUE INDEX IF NOT EXISTS scroll_user_date_device ON scroll (username, date, device);
  CREATE INDEX IF NOT EXISTS scroll_date_idx ON scroll (date);
`);

// ---------- constants ----------
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_DAILY_PX = 10_000_000; // per device per day, about 2.6 km
const BURST_PX = 150_000; // a single jump (End key on a long page) is allowed
const RATE_PX_PER_SEC = 40_000; // sustained speed limit between two syncs of the same device
const MAX_DEVICES = 5; // distinct devices active in the last 7 days per user
const STREAK_MIN_PX = 37_795; // about 10 m of scroll makes a day count towards a streak
const TOP_N = 10;
const INACTIVE_DAYS = Number(process.env.INACTIVE_DAYS) || 90;

// Small list of unambiguous terms. Add more with the BLOCKED_WORDS env var (comma separated).
const BLOCKED_WORDS = [
  "fuck", "bitch", "cunt", "nigger", "nigga", "faggot", "hitler", "whore",
  ...(process.env.BLOCKED_WORDS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
];

// ---------- helpers ----------
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const validToken = (t) => typeof t === "string" && t.length >= 16 && t.length <= 128;

function isBlockedName(name) {
  const n = name
    .toLowerCase()
    .replace(/[-_]/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s");
  return BLOCKED_WORDS.some((w) => n.includes(w));
}

const utcDay = (offset = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1) - day);
  return d.toISOString().slice(0, 10);
}

// A real calendar date that is at most one day away from today in UTC (covers every time zone).
function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  return s >= utcDay(-1) && s <= utcDay(1);
}

// Date range [from, to] for a leaderboard view, based on the caller's local "today".
function rangeBounds(range, today) {
  if (range === "day") return [today, today];
  if (range === "all") return ["0000-01-01", "9999-12-31"];
  const mon = mondayOf(today);
  return [mon, addDays(mon, 6)];
}

async function getUser(username) {
  const { rows } = await pool.query("SELECT * FROM users WHERE username_key = $1", [
    String(username).toLowerCase(),
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
    if (!res.headersSent) res.status(500).json({ error: "server error" });
  });

// ---------- app + rate limits ----------
const app = express();
app.set("trust proxy", 1); // Render sits behind one proxy; without this every client looks like the same IP
app.use(cors());
app.use(express.json({ limit: "2kb" }));

const ipLimiter = (max) =>
  rateLimit({
    windowMs: 60_000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, slow down." },
  });
// Scroll posts are also limited per username, so one busy network doesn't starve its other users.
const userLimiter = (max) =>
  rateLimit({
    windowMs: 60_000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
      typeof req.body?.username === "string" ? `u:${req.body.username.toLowerCase().slice(0, 32)}` : "anon",
    message: { error: "Too many requests, slow down." },
  });
app.use("/api/claim", ipLimiter(20));
app.use("/api/delete", ipLimiter(10));
app.use("/api/admin", ipLimiter(20));
app.use("/api/scroll", ipLimiter(1200));
app.use("/api/scroll", userLimiter(150));
app.use("/api/leaderboard", ipLimiter(900));
app.use("/api/stream", ipLimiter(30));

app.get("/healthz", (req, res) => res.send("ok"));

// ---------- live updates (server-sent events) ----------
const MAX_STREAM_CLIENTS = 1000;
const MAX_STREAMS_PER_IP = 10;
const streamClients = new Set();
const streamsByIp = new Map();

app.get("/api/stream", (req, res) => {
  if (streamClients.size >= MAX_STREAM_CLIENTS) return res.status(503).end();
  const ip = req.ip;
  if ((streamsByIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) return res.status(429).end();
  streamsByIp.set(ip, (streamsByIp.get(ip) || 0) + 1);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  streamClients.add(res);
  req.on("close", () => {
    streamClients.delete(res);
    const n = (streamsByIp.get(ip) || 1) - 1;
    if (n <= 0) streamsByIp.delete(ip);
    else streamsByIp.set(ip, n);
  });
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

// ---------- claim / rename ----------
// First install to claim a username owns it. One install has one identity: claiming a name moves
// everything from any other name the same install owned onto the new one and frees the old name.
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

    const key = username.toLowerCase();
    const tokenHash = hashToken(token);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: current } = await client.query("SELECT * FROM users WHERE username_key = $1", [key]);
      let finalName = username;
      if (current[0]) {
        if (!safeEqual(current[0].token_hash, tokenHash)) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Username is already taken" });
        }
        finalName = current[0].username;
      } else {
        if (isBlockedName(username)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "That username isn't allowed" });
        }
        const inserted = await client.query(
          `INSERT INTO users (username_key, username, token_hash)
           VALUES ($1, $2, $3) ON CONFLICT (username_key) DO NOTHING`,
          [key, username, tokenHash]
        );
        if (inserted.rowCount === 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Username is already taken" });
        }
      }

      const { rows: older } = await client.query(
        "SELECT username_key, username FROM users WHERE token_hash = $1 AND username_key <> $2",
        [tokenHash, key]
      );
      for (const o of older) {
        await client.query(
          `INSERT INTO scroll (username, date, px, device, updated_at)
           SELECT $1, date, px, device, updated_at FROM scroll WHERE username = $2
           ON CONFLICT (username, date, device) DO UPDATE SET px = GREATEST(scroll.px, EXCLUDED.px)`,
          [finalName, o.username]
        );
        await client.query("DELETE FROM scroll WHERE username = $1", [o.username]);
        await client.query("DELETE FROM users WHERE username_key = $1", [o.username_key]);
      }

      await client.query("COMMIT");
      if (older.length) notifyClients();
      res.json({ ok: true, username: finalName });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

// ---------- scroll sync ----------
app.post(
  "/api/scroll",
  route(async (req, res) => {
    const { username, token, date, px } = req.body || {};
    const device = typeof req.body?.device === "string" ? req.body.device : "";
    const user = await authenticate(username, token);
    if (!user) return res.status(403).json({ error: "Username not claimed by this install" });

    if (device && !DEVICE_RE.test(device)) return res.status(400).json({ error: "invalid device" });
    if (!validDate(date)) return res.status(400).json({ error: "invalid date" });
    if (typeof px !== "number" || !Number.isFinite(px) || px < 0 || px > MAX_DAILY_PX) {
      return res.status(400).json({ error: "invalid px" });
    }

    const wanted = Math.round(px);
    let stored = wanted;
    let changed = false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT px, updated_at FROM scroll WHERE username = $1 AND date = $2 AND device = $3 FOR UPDATE",
        [user.username, date, device]
      );

      if (!rows[0]) {
        if (device) {
          const dev = await client.query(
            `SELECT COUNT(DISTINCT device)::int AS n FROM scroll
             WHERE username = $1 AND device <> '' AND device <> $2
               AND updated_at > now() - interval '7 days'`,
            [user.username, device]
          );
          if (dev.rows[0].n >= MAX_DEVICES) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: "Too many devices for this username" });
          }
          // Rows from before devices existed are replaced by this device's own running total.
          await client.query("DELETE FROM scroll WHERE username = $1 AND date = $2 AND device = ''", [
            user.username,
            date,
          ]);
        }
        await client.query("INSERT INTO scroll (username, date, px, device) VALUES ($1, $2, $3, $4)", [
          user.username,
          date,
          wanted,
          device,
        ]);
        changed = true;
      } else {
        // Totals only grow, and no faster than a person can scroll. A value above the ceiling is
        // clamped, and the client's next sync (it sends running totals) catches up.
        const current = Number(rows[0].px);
        const elapsed = Math.max(0, (Date.now() - new Date(rows[0].updated_at).getTime()) / 1000);
        const ceiling = Math.floor(current + BURST_PX + RATE_PX_PER_SEC * elapsed);
        stored = Math.max(current, Math.min(wanted, ceiling));
        if (stored > current) {
          await client.query(
            "UPDATE scroll SET px = $1, updated_at = now() WHERE username = $2 AND date = $3 AND device = $4",
            [stored, user.username, date, device]
          );
          changed = true;
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    if (changed) notifyClients();
    res.json({ ok: true, px: stored });
  })
);

// ---------- leaderboard ----------
// GET /api/leaderboard?username=name&today=YYYY-MM-DD&range=day|week|all
app.get(
  "/api/leaderboard",
  route(async (req, res) => {
    const range = ["day", "week", "all"].includes(req.query.range) ? req.query.range : "week";
    const today = validDate(req.query.today) ? req.query.today : utcDay();
    const [from, to] = rangeBounds(range, today);

    const name = typeof req.query.username === "string" ? req.query.username : "";
    const user = USERNAME_RE.test(name) ? await getUser(name) : null;

    const lastWeekBounds = range === "week" ? [addDays(from, -7), addDays(from, -1)] : null;

    const [topRes, countRes, lastWeekRes, daysRes] = await Promise.all([
      pool.query(
        `SELECT username, SUM(px)::float8 AS total_px
         FROM scroll WHERE date BETWEEN $1 AND $2
         GROUP BY username ORDER BY total_px DESC, username ASC LIMIT $3`,
        [from, to, TOP_N]
      ),
      pool.query(
        "SELECT COUNT(DISTINCT username)::int AS n FROM scroll WHERE date BETWEEN $1 AND $2",
        [from, to]
      ),
      lastWeekBounds
        ? pool.query(
            `SELECT username, SUM(px)::float8 AS total_px
             FROM scroll WHERE date BETWEEN $1 AND $2
             GROUP BY username ORDER BY total_px DESC, username ASC LIMIT 1`,
            lastWeekBounds
          )
        : Promise.resolve({ rows: [] }),
      user
        ? pool.query("SELECT date, SUM(px)::float8 AS s FROM scroll WHERE username = $1 GROUP BY date", [
            user.username,
          ])
        : Promise.resolve({ rows: [] }),
    ]);

    let me = null;
    if (user) {
      const perDay = new Map(daysRes.rows.map((r) => [r.date, r.s]));
      let total = 0;
      let totalAll = 0;
      let best = 0;
      for (const [d, s] of perDay) {
        totalAll += s;
        if (s > best) best = s;
        if (d >= from && d <= to) total += s;
      }

      let rank = null;
      if (total > 0) {
        const higher = await pool.query(
          `SELECT COUNT(*)::int AS n FROM (
             SELECT username FROM scroll WHERE date BETWEEN $1 AND $2
             GROUP BY username HAVING SUM(px) > $3
           ) t`,
          [from, to, total]
        );
        rank = higher.rows[0].n + 1;
      }

      // Streak: consecutive days with at least ~10 m of scroll, ending today (or yesterday).
      const active = new Set([...perDay].filter(([, s]) => s >= STREAK_MIN_PX).map(([d]) => d));
      let cursor = active.has(today) ? today : active.has(addDays(today, -1)) ? addDays(today, -1) : null;
      let streak = 0;
      while (cursor && active.has(cursor)) {
        streak++;
        cursor = addDays(cursor, -1);
      }

      me = {
        username: user.username,
        total_px: total,
        rank,
        today_px: perDay.get(today) || 0,
        best_day_px: best,
        total_all_px: totalAll,
        days_active: perDay.size,
        streak,
      };
    }

    res.json({
      range,
      top: topRes.rows.map((r, i) => ({ rank: i + 1, ...r })),
      me,
      participants: countRes.rows[0].n,
      lastWeek: lastWeekRes.rows[0] || null,
    });
  })
);

// ---------- delete account ----------
async function deleteUser(client, user) {
  await client.query("DELETE FROM scroll WHERE username = $1", [user.username]);
  await client.query("DELETE FROM users WHERE username_key = $1", [user.username_key]);
}

app.post(
  "/api/delete",
  route(async (req, res) => {
    const { username, token } = req.body || {};
    const user = await authenticate(username, token);
    if (!user) return res.status(403).json({ error: "Username not claimed by this install" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await deleteUser(client, user);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    notifyClients();
    res.json({ ok: true });
  })
);

// Moderation: remove a user. Disabled unless the ADMIN_KEY env var is set.
// curl -X DELETE -H "x-admin-key: KEY" https://your-app.onrender.com/api/admin/user/NAME
app.delete(
  "/api/admin/user/:name",
  route(async (req, res) => {
    const key = process.env.ADMIN_KEY;
    if (!key || !safeEqual(req.get("x-admin-key") || "", key)) return res.status(404).end();
    const user = await getUser(req.params.name);
    if (!user) return res.status(404).json({ error: "no such user" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await deleteUser(client, user);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    notifyClients();
    res.json({ ok: true, removed: user.username });
  })
);

// ---------- housekeeping ----------
// Frees names that were claimed but never used (7 days), and removes accounts, with their data,
// that have had no activity for INACTIVE_DAYS (default 90).
async function housekeeping() {
  try {
    const squat = await pool.query(
      `DELETE FROM users u WHERE u.created_at < now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM scroll s WHERE s.username = u.username)`
    );
    const stale = await pool.query(
      `WITH stale AS (
         SELECT u.username_key, u.username FROM users u
         WHERE COALESCE((SELECT MAX(s.updated_at) FROM scroll s WHERE s.username = u.username), u.created_at)
               < now() - make_interval(days => $1::int)
       ),
       del_rows AS (DELETE FROM scroll WHERE username IN (SELECT username FROM stale))
       DELETE FROM users WHERE username_key IN (SELECT username_key FROM stale)`,
      [INACTIVE_DAYS]
    );
    if (squat.rowCount || stale.rowCount) {
      console.log(`housekeeping: freed ${squat.rowCount} unused names, removed ${stale.rowCount} inactive accounts`);
      notifyClients();
    }
  } catch (e) {
    console.error("housekeeping failed:", e.message);
  }
}
housekeeping();
setInterval(housekeeping, 6 * 60 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening on ${PORT}`));
