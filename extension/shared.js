// Helpers used by both the popup and the background service worker.

const PX_TO_M = 0.000264583; // CSS px (96 dpi) -> meters. Approximate: it ignores page zoom.

const UNITS = {
  m: { label: "m", conv: (m) => m, digits: 1 },
  km: { label: "km", conv: (m) => m / 1000, digits: 2 },
  ft: { label: "ft", conv: (m) => m * 3.28084, digits: 0 },
  eiffel: { label: "Eiffels", conv: (m) => m / 330, digits: 2 }, // Eiffel Tower is about 330 m
};
const UNIT_ORDER = ["m", "km", "ft", "eiffel"];

function convertPx(px, unit) {
  const u = UNITS[unit] || UNITS.m;
  return u.conv(px * PX_TO_M).toFixed(u.digits);
}

function unitLabel(unit) {
  return (UNITS[unit] || UNITS.m).label;
}

// The user's own calendar date (YYYY-MM-DD), not UTC.
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Random secret that proves ownership of the username. Also works as the recovery code.
async function getToken() {
  const { token } = await chrome.storage.local.get(["token"]);
  if (token) return token;
  const fresh = crypto.randomUUID() + crypto.randomUUID();
  await chrome.storage.local.set({ token: fresh });
  return fresh;
}

// Identifies this browser, so one username can be used on several devices and their totals add up.
async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get(["deviceId"]);
  if (deviceId) return deviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}
