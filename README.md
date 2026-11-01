# Scroll Leaderboard

## Database (Neon)
1. Create a free project at neon.tech and copy the connection string (`postgres://...`).
2. The server creates its tables on first start. Nothing else to set up.

## Server
```
cd server
npm install
$env:DATABASE_URL="postgres://..."   # PowerShell; on Render set it as an environment variable
npm start
```
Runs on :3000 (or `PORT`). On Render: build command `npm install`, start command `npm start`, env var `DATABASE_URL`. Health check path: `/healthz`.

To copy old data from the previous `scroll.db` (SQLite) into Neon, once:
```
cd server
$env:DATABASE_URL="postgres://..."
node migrate-from-sqlite.mjs
```

## Extension
Set `SERVER_URL` in `extension/config.js` to your deployed server (e.g. your Render URL).
Then: chrome://extensions -> Developer mode -> Load unpacked -> select `extension/`.
Users only enter a username in the popup.

- Usernames are 3-20 characters (letters, numbers, `_`, `-`), case-insensitive.
- The first install to claim a username owns it. Each install keeps a random secret token in local storage; the server stores only its hash. Clearing extension data loses the claim.
- Everyone is on one global leaderboard. The popup shows the top 10 and your own rank.
- Scroll is tracked in px, synced to the server about once per second while scrolling and pushed to open popups, leaderboard resets weekly (Mon-Sun UTC).
