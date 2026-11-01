# Scroll Leaderboard

## Server
cd server && npm install && npm start
(runs on :3000 — deploy anywhere Node runs, e.g. Render/Railway/Fly/VPS)

## Extension
chrome://extensions -> Developer mode -> Load unpacked -> select `extension/`
The server URL is built in: set `SERVER_URL` in `extension/config.js` to your deployed server (e.g. your Render URL) before loading or publishing. Users only enter a username in the popup.

On Render, Render's disk is wiped on each deploy unless you attach a persistent disk. Mount one (e.g. at `/data`) and set the env var `DB_PATH=/data/scroll.db`.

- Usernames are 3-20 characters (letters, numbers, `_`, `-`), case-insensitive.
- The first install to claim a username owns it. Each install keeps a random secret token in local storage; the server stores only its hash. Clearing extension data loses the claim.
- Everyone is on one global leaderboard. The popup shows the top 10 and your own rank.
- Scroll is tracked in px, synced every 10 min, leaderboard resets weekly (Mon-Sun UTC).
