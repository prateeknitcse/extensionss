// Aggregates scroll px per UTC date and syncs the total to the server shortly after scrolling
// (at most once per second), with a 1-minute alarm as a fallback.
importScripts("config.js");

const SYNC_INTERVAL_MS = 1000;

const todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// Serialize storage updates so scroll messages from several tabs can't overwrite each other.
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SCROLL_DELTA" || typeof msg.px !== "number") return;
  queue = queue
    .then(async () => {
      const key = `scroll_${todayKey()}`;
      const res = await chrome.storage.local.get([key]);
      await chrome.storage.local.set({ [key]: (res[key] || 0) + msg.px });
      scheduleSync();
    })
    .catch(() => {});
});

let lastSync = 0;
let timer = null;
let lastSent = { key: "", px: 0 };

function scheduleSync() {
  if (timer) return;
  const wait = Math.max(0, SYNC_INTERVAL_MS - (Date.now() - lastSync));
  timer = setTimeout(() => {
    timer = null;
    syncToServer();
  }, wait);
}

chrome.alarms.get("sync", (a) => {
  if (!a) chrome.alarms.create("sync", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") syncToServer();
});

async function getToken() {
  const { token } = await chrome.storage.local.get(["token"]);
  if (token) return token;
  const fresh = crypto.randomUUID() + crypto.randomUUID();
  await chrome.storage.local.set({ token: fresh });
  return fresh;
}

async function syncToServer() {
  lastSync = Date.now();
  const cfg = await chrome.storage.sync.get(["username"]);
  if (!cfg.username) return;
  const token = await getToken();

  const date = todayKey();
  const key = `scroll_${date}`;
  const data = await chrome.storage.local.get([key]);
  const px = data[key] || 0;
  if (px === 0) return;

  const id = `${cfg.username}|${key}`;
  if (lastSent.key === id && lastSent.px === px) return; // nothing new

  try {
    const res = await fetch(`${SERVER_URL}/api/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: cfg.username, token, date, px }),
    });
    if (res.ok) lastSent = { key: id, px };
  } catch (e) {
    // offline or server down - the next sync sends the same accumulated total
  }
}
