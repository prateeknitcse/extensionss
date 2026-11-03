# Scroll Leaderboard

A Chrome extension that counts how far you scroll, and a small server that ranks everyone on a shared leaderboard.

## Database (Neon)
1. Create a free project at neon.tech and copy the connection string (`postgres://...`).
2. The server creates and upgrades its tables on start. Nothing else to set up.

## Server
```
cd server
npm install
$env:DATABASE_URL="postgres://..."   # PowerShell; on Render set it as an environment variable
npm start
```
Runs on :3000 (or `PORT`). On Render: root directory `server`, build `npm install`, start `npm start`, env var `DATABASE_URL`. Health check path: `/healthz`.

Optional environment variables:

| Variable | Purpose |
|---|---|
| `ADMIN_KEY` | Enables moderation: `curl -X DELETE -H "x-admin-key: KEY" https://your-app.onrender.com/api/admin/user/NAME` removes a user and their data. Off when unset. |
| `BLOCKED_WORDS` | Comma-separated words that usernames may not contain (added to a small built-in list). |
| `INACTIVE_DAYS` | Accounts with no activity for this many days are removed with their data. Default 90. |

To copy old data from the previous `scroll.db` (SQLite) into Neon, once:
```
cd server
$env:DATABASE_URL="postgres://..."
node migrate-from-sqlite.mjs
```

## Extension
Set `SERVER_URL` in `extension/config.js` to your deployed server (e.g. your Render URL).
Then: chrome://extensions -> Developer mode -> Load unpacked -> select `extension/`.
After reloading the extension, refresh open tabs (old tabs keep the old content script).

### Features
- Live distance for today, with units: meters, kilometers, feet, Eiffel Towers (click the unit).
- Leaderboard with Today, Week and All time tabs. The top 10 plus your own rank, updated live.
- Last week's winner, streaks (a day counts at about 10 m), best day, and badges.
- Share card: copies an image of your weekly rank to paste anywhere.
- Pause tracking, or skip chosen sites (Settings).
- Dark mode, following the system until you choose.
- Days and weeks use your local time zone (the week runs Monday to Sunday).

### Usernames and accounts
- 3-20 characters (letters, numbers, `_`, `-`), case-insensitive, with a basic profanity filter.
- The first install to claim a username owns it. The install keeps a random secret; the server stores only its hash.
- One install has one identity. Changing your username moves your history to the new name and frees the old one.
- **Recovery code / multiple devices:** Settings -> Copy recovery code. On another browser (or after a reinstall), Settings -> Restore from recovery code with your username. Totals from each device add up (up to 5 devices).
- Delete my account removes the username and all its history from the server.
- Names with no data are freed after 7 days. Accounts inactive for 90 days are removed.

### What counts as scrolling
- Vertical scrolling the user causes: wheel, touchpad, touch, keyboard (arrows, space, Page keys, Home/End) and scrollbar drag. This includes scrolling inside panels (Gmail, AI chats, feeds), inside web components (open Shadow DOM) and inside iframes.
- How: after a user input, the extension reads the scroll position of the scrollable elements under the pointer or focus, every animation frame for a couple of seconds. It does not depend on the page's scroll events.
- Scrolling done by the page itself (carousels, auto-scroll while an AI answer streams, jumping to the top after navigating) is ignored. Typing in a text box is ignored.
- Not counted: horizontal scrolling, apps that fake scrolling by moving content with CSS transforms instead of real scrolling (some canvas-based editors), closed Shadow DOM, and pages Chrome does not let extensions run on (chrome://, the Web Store, the built-in PDF viewer).
- Distance in meters is approximate. It assumes 96 dpi and ignores page zoom.

### Limits against cheating
The server accepts only totals that grow, caps one device at 10 million px a day (about 2.6 km), and limits how fast a total can grow between syncs. Someone who writes their own client can still inflate a score within those limits.

See [PRIVACY.md](PRIVACY.md) for what is collected.
