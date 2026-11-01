// Aggregates scroll px per local date, syncs totals to server every 10 min.
importScripts("config.js");

const todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SCROLL_DELTA") return;
  const key = `scroll_${todayKey()}`;
  chrome.storage.local.get([key], (res) => {
    const total = (res[key] || 0) + msg.px;
    chrome.storage.local.set({ [key]: total });
  });
});

chrome.alarms.create("sync", { periodInMinutes: 10 });

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
  const cfg = await chrome.storage.sync.get(["username"]);
  if (!cfg.username) return;
  const token = await getToken();

  const key = `scroll_${todayKey()}`;
  const data = await chrome.storage.local.get([key]);
  const px = data[key] || 0;
  if (px === 0) return;

  try {
    await fetch(`${SERVER_URL}/api/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: cfg.username,
        token,
        date: todayKey(),
        px,
      }),
    });
  } catch (e) {
    // offline or server down - will retry next alarm with same accumulated total
  }
}
