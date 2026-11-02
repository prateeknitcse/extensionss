const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ---------- state ----------
let unit = "m";
let range = "week";
let todayPx = 0;
let board = null; // last leaderboard response
let shownDate = localDate();
let paused = false;
let blocked = [];
let tabHost = null; // hostname of the tab the popup was opened on

const RANGE_NOTE = {
  day: "your local date",
  week: "Mon-Sun, local time",
  all: "all time",
};
const RANGE_WORD = { day: "today", week: "this week", all: "all time" };

const fmt = (px) => `${convertPx(px, unit)} ${unitLabel(unit)}`;

function setStatus(msg, ok = false) {
  const s = $("status");
  s.textContent = msg;
  s.className = ok ? "ok" : "";
}

function setMenuStatus(msg, ok = false) {
  const s = $("menuStatus");
  s.textContent = msg;
  s.className = ok ? "ok" : "";
}

// ---------- today (read from local storage, so it updates as you scroll) ----------
function renderToday() {
  $("todayVal").textContent = convertPx(todayPx, unit);
  $("unit").textContent = unitLabel(unit);
}

async function loadToday() {
  const key = `scroll_${localDate()}`;
  const data = await chrome.storage.local.get([key]);
  todayPx = data[key] || 0;
  renderToday();
}

// ---------- leaderboard ----------
function row(rank, name, px, isMe) {
  const div = el("div", isMe ? "row me" : "row");
  div.append(el("span", "n", String(rank).padStart(2, "0")), el("span", "name", name), el("span", "m", fmt(px)));
  return div;
}

const message = (text) => el("div", "empty", text);

function badgesFor(me, participants) {
  const out = [];
  // Placement badges only mean something when there are enough players to compete with.
  if (me.rank === 1 && participants > 1) out.push(`No. 1 ${RANGE_WORD[range]}`);
  else if (me.rank && me.rank <= 3 && participants > 3) out.push(`Top 3 ${RANGE_WORD[range]}`);
  for (const [n, label] of [[30, "30-day streak"], [7, "7-day streak"], [3, "3-day streak"]]) {
    if (me.streak >= n) { out.push(label); break; }
  }
  const totalM = me.total_all_px * PX_TO_M;
  for (const [km, label] of [[100, "100 km total"], [10, "10 km total"], [1, "1 km total"]]) {
    if (totalM >= km * 1000) { out.push(label); break; }
  }
  if (me.days_active > 1 && me.today_px > 0 && me.today_px >= me.best_day_px) out.push("Personal best today");
  return out;
}

function renderBoard() {
  const lb = $("lb");
  const rank = $("rank");
  const stats = $("stats");
  const last = $("lastWeek");
  stats.replaceChildren();
  last.hidden = true;
  if (!board) return;

  const me = board.me;
  if (me) {
    if (me.rank) {
      rank.replaceChildren(
        "Rank ",
        Object.assign(el("b"), { textContent: `#${me.rank}` }),
        ` of ${board.participants} \u00b7 ${fmt(me.total_px)} ${RANGE_WORD[range]}`
      );
    } else {
      rank.textContent = `Not ranked ${RANGE_WORD[range]} yet. Start scrolling.`;
    }

    const parts = [];
    if (me.streak > 0) parts.push(`Streak ${me.streak} day${me.streak === 1 ? "" : "s"}`);
    if (me.best_day_px > 0) parts.push(`Best day ${fmt(me.best_day_px)}`);
    if (parts.length) stats.append(el("div", "", parts.join(" \u00b7 ")));
    const tags = badgesFor(me, board.participants);
    if (tags.length) {
      const wrap = el("div", "badges");
      for (const t of tags) wrap.append(el("span", "badge", t));
      stats.append(wrap);
    }
  } else {
    rank.textContent = "";
  }

  if (!board.top.length) {
    lb.replaceChildren(message("No data yet."));
  } else {
    const mine = me && me.username;
    lb.replaceChildren(...board.top.map((r) => row(r.rank, r.username, r.total_px, r.username === mine)));
  }

  if (range === "week" && board.lastWeek) {
    last.textContent = `Last week's winner: ${board.lastWeek.username} \u00b7 ${fmt(board.lastWeek.total_px)}`;
    last.hidden = false;
  }
}

async function fetchBoard(forRange) {
  const cfg = await chrome.storage.sync.get(["username"]);
  const q = new URLSearchParams({ range: forRange, today: localDate() });
  if (cfg.username) q.set("username", cfg.username);
  const res = await fetch(`${SERVER_URL}/api/leaderboard?${q}`);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

let loadSeq = 0;

async function loadLeaderboard(silent = false) {
  const seq = ++loadSeq; // responses can arrive out of order; only the newest one is shown
  const lb = $("lb");
  if (!silent) {
    lb.replaceChildren(message("Loading..."));
    $("rank").textContent = "";
  }
  // The server may be asleep (free hosting). Retry a few times before giving up.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const data = await fetchBoard(range);
      if (seq !== loadSeq || data.range !== range) return;
      board = data;
      renderBoard();
      return;
    } catch (e) {
      if (silent || seq !== loadSeq) return;
      if (attempt === 3) { lb.replaceChildren(message("Could not reach server.")); return; }
      lb.replaceChildren(message("Waking the server, retrying..."));
      await sleep(4000);
      if (seq !== loadSeq) return;
    }
  }
}

// ---------- tabs ----------
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-range]");
  if (!b || b.dataset.range === range) return;
  setRange(b.dataset.range);
  chrome.storage.sync.set({ range });
  loadLeaderboard();
});

function setRange(r) {
  range = r;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.range === r);
  $("note").textContent = RANGE_NOTE[r];
}

// ---------- units ----------
$("unit").addEventListener("click", async () => {
  unit = UNIT_ORDER[(UNIT_ORDER.indexOf(unit) + 1) % UNIT_ORDER.length];
  renderToday();
  renderBoard();
  await chrome.storage.sync.set({ unit });
});

// ---------- account ----------
function showAccount(username) {
  $("currentName").textContent = username || "";
  $("current").hidden = !username;
  $("form").hidden = !!username;
}

$("change").addEventListener("click", () => {
  $("current").hidden = true;
  $("form").hidden = false;
  setStatus("");
  $("username").focus();
  $("username").select();
});

async function claim(username, token) {
  const res = await fetch(`${SERVER_URL}/api/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, token }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  if (!USERNAME_RE.test(username)) return setStatus("Username: 3-20 characters, letters, numbers, _ or -");

  setStatus("Saving...", true);
  try {
    const r = await claim(username, await getToken());
    if (!r.ok) return setStatus(r.body.error || `Error ${r.status}`);
    await chrome.storage.sync.set({ username: r.body.username || username });
    $("username").value = r.body.username || username;
    setStatus("");
    showAccount(r.body.username || username);
    loadLeaderboard();
  } catch (err) {
    setStatus("Could not reach server.");
  }
});

// ---------- settings menu ----------
function renderMenu() {
  $("pause").textContent = paused ? "Resume tracking" : "Pause tracking";
  const b = $("block");
  if (!tabHost) {
    b.textContent = "This page can't be tracked";
    b.disabled = true;
  } else {
    b.disabled = false;
    b.textContent = blocked.includes(tabHost) ? `Track ${tabHost} again` : `Don't track ${tabHost}`;
  }
}

$("pause").addEventListener("click", async () => {
  paused = !paused;
  await chrome.storage.sync.set({ paused });
  renderMenu();
  setMenuStatus(paused ? "Tracking paused on every site." : "Tracking resumed.", true);
});

$("block").addEventListener("click", async () => {
  if (!tabHost) return;
  blocked = blocked.includes(tabHost) ? blocked.filter((h) => h !== tabHost) : [...blocked, tabHost];
  await chrome.storage.sync.set({ blocked });
  renderMenu();
  setMenuStatus(blocked.includes(tabHost) ? `Not tracking ${tabHost}.` : `Tracking ${tabHost} again.`, true);
});

async function loadTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab.url);
    if (u.protocol === "http:" || u.protocol === "https:") tabHost = u.hostname.replace(/^www\./, "");
  } catch (e) {}
  renderMenu();
}

$("copyCode").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(await getToken());
    setMenuStatus("Recovery code copied. Keep it private: it controls your username.", true);
  } catch (e) {
    setMenuStatus("Could not copy.");
  }
});

$("restore").addEventListener("click", () => {
  $("restoreForm").hidden = !$("restoreForm").hidden;
  setMenuStatus("");
});

$("restoreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("restoreName").value.trim();
  const code = $("restoreCode").value.trim();
  if (!USERNAME_RE.test(username)) return setMenuStatus("Enter your username (3-20 characters).");
  if (code.length < 16 || code.length > 128) return setMenuStatus("That recovery code doesn't look right.");

  setMenuStatus("Restoring...", true);
  try {
    const r = await claim(username, code);
    if (!r.ok) {
      return setMenuStatus(r.status === 409 ? "That code doesn't match this username." : r.body.error || `Error ${r.status}`);
    }
    await chrome.storage.local.set({ token: code });
    await chrome.storage.sync.set({ username: r.body.username || username });
    showAccount(r.body.username || username);
    $("restoreForm").hidden = true;
    $("restoreCode").value = "";
    setMenuStatus("Restored. This device now counts towards your username.", true);
    loadLeaderboard();
  } catch (err) {
    setMenuStatus("Could not reach server.");
  }
});

$("deleteAcct").addEventListener("click", async () => {
  const cfg = await chrome.storage.sync.get(["username"]);
  if (!cfg.username) return setMenuStatus("No account to delete.");
  if (!confirm(`Delete "${cfg.username}" and all its scroll history from the leaderboard? This can't be undone.`)) return;
  try {
    const res = await fetch(`${SERVER_URL}/api/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: cfg.username, token: await getToken() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return setMenuStatus(body.error || `Error ${res.status}`);
    }
    await chrome.storage.sync.remove("username");
    $("username").value = "";
    showAccount(null);
    setMenuStatus("Account deleted.", true);
    loadLeaderboard();
  } catch (err) {
    setMenuStatus("Could not reach server.");
  }
});

// ---------- share card ----------
$("share").addEventListener("click", async () => {
  const cfg = await chrome.storage.sync.get(["username"]);
  if (!cfg.username) return setMenuStatus("Save a username first.");
  setMenuStatus("Making card...", true);

  let data;
  try {
    data = await fetchBoard("week");
  } catch (e) {
    return setMenuStatus("Could not reach server.");
  }
  const me = data.me;
  if (!me || !me.rank) return setMenuStatus("Scroll a bit to get ranked this week first.");

  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 420;
  const c = canvas.getContext("2d");
  const INK = "#1d1b17", MUTED = "#6f685c", ACCENT = "#b3341a";
  const SERIF = 'Georgia, "Times New Roman", serif';
  const MONO = 'Consolas, "Cascadia Mono", Menlo, monospace';

  c.fillStyle = "#f4efe6";
  c.fillRect(0, 0, 800, 420);
  c.strokeStyle = INK;
  c.lineWidth = 4;
  c.beginPath();
  c.moveTo(40, 90);
  c.lineTo(760, 90);
  c.stroke();

  c.fillStyle = INK;
  c.font = `italic 700 38px ${SERIF}`;
  c.fillText("Scroll Leaderboard", 40, 70);
  c.fillStyle = MUTED;
  c.font = `16px ${MONO}`;
  c.textAlign = "right";
  c.fillText(new Date().toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }), 760, 70);
  c.textAlign = "left";

  c.font = `13px ${MONO}`;
  c.fillText("THIS WEEK", 40, 140);

  const value = convertPx(me.total_px, unit);
  c.fillStyle = INK;
  c.font = `700 120px ${SERIF}`;
  c.fillText(value, 40, 255);
  const w = c.measureText(value).width;
  c.fillStyle = MUTED;
  c.font = `34px ${MONO}`;
  c.fillText(unitLabel(unit), 40 + w + 12, 255);

  c.fillStyle = ACCENT;
  c.font = `700 30px ${MONO}`;
  c.fillText(`Rank #${me.rank} of ${data.participants}`, 40, 320);
  c.fillStyle = INK;
  c.font = `24px ${MONO}`;
  const extra = me.streak > 0 ? `   |   ${me.streak}-day streak` : "";
  c.fillText(`${me.username}${extra}`, 40, 362);

  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setMenuStatus("Share card copied. Paste it into a chat or post.", true);
  } catch (e) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "scroll-leaderboard.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setMenuStatus("Share card saved as scroll-leaderboard.png.", true);
  }
});

// ---------- refresh, theme ----------
$("refresh").addEventListener("click", () => loadLeaderboard());

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
function currentTheme() {
  return document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light");
}
function applyTheme(theme) {
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  $("theme").textContent = currentTheme() === "dark" ? "light mode" : "dark mode";
}
$("theme").addEventListener("click", async () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  await chrome.storage.sync.set({ theme: next });
});

// ---------- clock and live updates ----------
function updateNow() {
  const d = new Date();
  const date = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("now").replaceChildren(date, document.createElement("br"), time);

  if (localDate() !== shownDate) { // midnight passed while the popup was open
    shownDate = localDate();
    loadToday();
    loadLeaderboard(true);
  }
}
updateNow();
setInterval(updateNow, 1000);

// Today's distance follows local storage as you scroll.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("scroll_"))) loadToday();
});

// Push: the server sends an "update" event whenever anyone's scroll changes.
// EventSource reconnects by itself. The slower poll below is a fallback.
const stream = new EventSource(`${SERVER_URL}/api/stream`);
stream.addEventListener("update", () => loadLeaderboard(true));
setInterval(() => loadLeaderboard(true), 30000);

// ---------- start ----------
async function init() {
  const s = await chrome.storage.sync.get(["username", "theme", "unit", "range", "paused", "blocked"]);
  if (UNITS[s.unit]) unit = s.unit;
  if (["day", "week", "all"].includes(s.range)) range = s.range;
  paused = !!s.paused;
  blocked = Array.isArray(s.blocked) ? s.blocked : [];
  $("username").value = s.username || "";
  $("restoreName").value = s.username || "";
  applyTheme(s.theme);
  setRange(range);
  showAccount(s.username);
  renderToday();
  loadToday();
  loadTab();
  loadLeaderboard();
}
init();
