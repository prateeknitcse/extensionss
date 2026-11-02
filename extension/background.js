// Aggregates scroll px per local date and syncs the running total to the server shortly after
// scrolling (at most once per second), with a 1-minute alarm as a fallback.
importScripts("config.js", "shared.js");

const SYNC_INTERVAL_MS = 1000;
const KEEP_DAYS = 14;

// Serialize storage updates so scroll messages from several tabs can't overwrite each other.
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SCROLL_DELTA" || typeof msg.px !== "number" || !(msg.px > 0)) return;
  queue = queue
    .then(async () => {
      const key = `scroll_${localDate()}`;
      const res = await chrome.storage.local.get([key]);
      await chrome.storage.local.set({ [key]: (res[key] || 0) + msg.px });
      scheduleSync();
    })
    .catch(() => {});
});

let lastSync = 0;
let timer = null;
let lastSent = { id: "", px: 0 };

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
  if (alarm.name !== "sync") return;
  syncToServer();
  pruneOld();
});

// Old days are only kept for a short while: the server holds the history.
async function pruneOld() {
  const all = await chrome.storage.local.get(null);
  const cutoff = localDate(new Date(Date.now() - KEEP_DAYS * 86400000));
  const stale = Object.keys(all).filter((k) => k.startsWith("scroll_") && k.slice(7) < cutoff);
  if (stale.length) await chrome.storage.local.remove(stale);
}
pruneOld();

async function syncToServer() {
  lastSync = Date.now();
  const cfg = await chrome.storage.sync.get(["username"]);
  if (!cfg.username) return;
  const [token, device] = await Promise.all([getToken(), getDeviceId()]);

  const date = localDate();
  const key = `scroll_${date}`;
  const data = await chrome.storage.local.get([key]);
  const px = Math.round(data[key] || 0);
  if (px === 0) return;

  const id = `${cfg.username}|${key}`;
  if (lastSent.id === id && lastSent.px === px) return; // nothing new

  try {
    const res = await fetch(`${SERVER_URL}/api/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: cfg.username, token, device, date, px }),
    });
    if (res.ok) {
      // If the server clamped the total, remember what it kept so the next sync sends the rest.
      const body = await res.json().catch(() => ({}));
      lastSent = { id, px: typeof body.px === "number" && body.px < px ? body.px : px };
    }
  } catch (e) {
    // offline or server down - the next sync sends the same running total
  }
}
