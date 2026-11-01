const pxToMeters = (px) => (px * 0.000264583).toFixed(1); // px(96dpi) -> inches -> meters-ish approx
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

const $ = (id) => document.getElementById(id);

function setStatus(msg, ok = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = ok ? "ok" : "";
}

async function getToken() {
  const { token } = await chrome.storage.local.get(["token"]);
  if (token) return token;
  const fresh = crypto.randomUUID() + crypto.randomUUID();
  await chrome.storage.local.set({ token: fresh });
  return fresh;
}

async function loadToday() {
  const key = `scroll_${new Date().toISOString().slice(0, 10)}`;
  const data = await chrome.storage.local.get([key]);
  $("todayVal").textContent = pxToMeters(data[key] || 0);
}

async function loadConfig() {
  const cfg = await chrome.storage.sync.get(["username"]);
  $("username").value = cfg.username || "";
  showAccount(cfg.username);
}

// Saved username -> show it with a "change" link; no username -> show the form.
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

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("username").value.trim();

  if (!USERNAME_RE.test(username)) return setStatus("Username: 3-20 characters, letters, numbers, _ or -");

  setStatus("Claiming username...", true);
  try {
    const res = await fetch(`${SERVER_URL}/api/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, token: await getToken() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setStatus(body.error || `Error ${res.status}`);
    await chrome.storage.sync.set({ username: body.username || username });
    $("username").value = body.username || username;
    setStatus("");
    showAccount(body.username || username);
    loadLeaderboard();
  } catch (e) {
    setStatus("Could not reach server.");
  }
});

$("refresh").addEventListener("click", () => loadLeaderboard());

function row(rank, name, meters, isMe) {
  const div = document.createElement("div");
  div.className = isMe ? "row me" : "row";
  const parts = [
    ["n", String(rank).padStart(2, "0")],
    ["name", name],
    ["m", `${meters} m`],
  ];
  for (const [cls, text] of parts) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    div.append(span);
  }
  return div;
}

function message(text) {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  return div;
}

let loadSeq = 0;

async function loadLeaderboard(silent = false) {
  const seq = ++loadSeq; // responses can arrive out of order; only the newest one is shown
  const cfg = await chrome.storage.sync.get(["username"]);
  const lb = $("lb");
  const rank = $("rank");
  if (!silent) {
    lb.replaceChildren(message("Loading..."));
    rank.textContent = "";
  }
  try {
    const q = cfg.username ? `?username=${encodeURIComponent(cfg.username)}` : "";
    const res = await fetch(`${SERVER_URL}/api/leaderboard${q}`);
    if (!res.ok) throw new Error(String(res.status));
    const { top, me, participants } = await res.json();
    if (seq !== loadSeq) return;

    if (me) {
      rank.replaceChildren(
        "Rank ",
        Object.assign(document.createElement("b"), { textContent: `#${me.rank}` }),
        ` of ${participants} \u00b7 ${pxToMeters(me.total_px)} m this week`
      );
    } else if (cfg.username) {
      rank.textContent = "Not ranked yet. Scroll a bit, syncs every 10 min.";
    }

    if (!top.length) { lb.replaceChildren(message("No data yet.")); return; }
    lb.replaceChildren(
      ...top.map((r) => row(r.rank, r.username, pxToMeters(r.total_px), r.username === cfg.username))
    );
  } catch (e) {
    if (!silent) lb.replaceChildren(message("Could not reach server."));
  }
}

function updateNow() {
  const d = new Date();
  const date = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("now").replaceChildren(date, document.createElement("br"), time);
}
updateNow();
setInterval(updateNow, 1000);

// Live updates while the popup is open: today's distance follows local storage,
// the leaderboard refreshes when the server announces a change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("scroll_"))) loadToday();
});
// Push: the server sends an "update" event whenever anyone's scroll changes.
// EventSource reconnects by itself. The slower poll below is a fallback.
const stream = new EventSource(`${SERVER_URL}/api/stream`);
stream.addEventListener("update", () => loadLeaderboard(true));
setInterval(() => loadLeaderboard(true), 30000);

// Theme: follows the system until the user picks one.
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
chrome.storage.sync.get(["theme"]).then(({ theme }) => applyTheme(theme));

loadToday();
loadConfig();
loadLeaderboard();
