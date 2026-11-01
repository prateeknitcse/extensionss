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
  $("today").textContent = `Today: ${pxToMeters(data[key] || 0)} m`;
}

async function loadConfig() {
  const cfg = await chrome.storage.sync.get(["username"]);
  $("username").value = cfg.username || "";
}

$("save").addEventListener("click", async () => {
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
    setStatus("Saved.", true);
    loadLeaderboard();
  } catch (e) {
    setStatus("Could not reach server.");
  }
});

$("refresh").addEventListener("click", loadLeaderboard);

function row(name, meters, isMe, prefix) {
  const div = document.createElement("div");
  if (isMe) div.className = "me";
  const left = document.createElement("span");
  left.textContent = `${prefix}${name}`;
  const right = document.createElement("span");
  right.textContent = `${meters} m`;
  div.append(left, right);
  return div;
}

async function loadLeaderboard() {
  const cfg = await chrome.storage.sync.get(["username"]);
  const lb = $("lb");
  const rank = $("rank");
  lb.replaceChildren();
  rank.textContent = "";
  lb.textContent = "Loading...";
  try {
    const q = cfg.username ? `?username=${encodeURIComponent(cfg.username)}` : "";
    const res = await fetch(`${SERVER_URL}/api/leaderboard${q}`);
    if (!res.ok) throw new Error(String(res.status));
    const { top, me, participants } = await res.json();

    if (me) {
      rank.textContent = `You: #${me.rank} of ${participants} (${pxToMeters(me.total_px)} m this week)`;
    } else if (cfg.username) {
      rank.textContent = "Scroll a bit to get ranked this week.";
    }

    lb.replaceChildren();
    if (!top.length) { lb.textContent = "No data yet."; return; }
    for (const r of top) {
      lb.append(row(r.username, pxToMeters(r.total_px), r.username === cfg.username, `${r.rank}. `));
    }
  } catch (e) {
    lb.textContent = "Could not reach server.";
  }
}

loadToday();
loadConfig();
loadLeaderboard();
