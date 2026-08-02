# Day Plan backend (storage + coach)

This little server does two jobs for the planner:

1. **Cloud storage** — saves your planner under your name + PIN so it loads on any device, even after you delete the app.
2. **AI coach** — reads your data and talks to you using Claude.

## What you need

- Your Railway account (you already have one from Sylus).
- Your Anthropic API key (the same one Sylus uses is fine).

## Deploy on Railway (about 5 minutes)

1. Put these three files (`package.json`, `server.js`, this README) in a GitHub repo, e.g. `planner-server`. (Claude can create this repo for you.)
2. In Railway: **New Project → Deploy from GitHub repo → pick `planner-server`.**
3. Add a database: in the project, **New → Database → Add PostgreSQL.** Railway automatically gives the server a `DATABASE_URL`. Nothing to copy.
4. Add your key: open the server service → **Variables → New Variable**:
   - `ANTHROPIC_API_KEY` = your Anthropic key.
   - (optional) `MODEL` = the model string Sylus uses, if you want a specific one. Defaults to `claude-3-5-sonnet-latest`.
5. Railway builds and deploys. Under **Settings → Networking**, click **Generate Domain**. That public URL (e.g. `https://planner-server-production.up.railway.app`) is what the planner will talk to.
6. Give that URL to Claude, and the planner gets wired to it (sign-in + sync + coach tab).

## Endpoints (for reference)

- `POST /load`  `{ user, pin }` → your saved data (or `isNew: true`).
- `POST /save`  `{ user, pin, data }` → stores your data.
- `POST /coach` `{ user, pin, message, history }` → Claude's reply, informed by your data.

## Notes

- Your PIN is stored only as a one-way hash, never in plain text.
- Your Anthropic key lives on the server as an env var. It is never in the app or on your phone, so it cannot leak from the public site.
- If the coach ever says it is unavailable, it is usually Anthropic being briefly busy; try again.
