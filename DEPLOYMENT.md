# Deploy

## Website (GitHub Pages)
Pushing to `main` runs **Deploy TimeSheet to GitHub Pages** → https://keubanks16.github.io/TimeSheet/
(If the first run fails, enable Pages once: repo **Settings → Pages → Source: GitHub Actions**.)

## API + database (Cloudflare Worker + D1) — one-time setup, no tokens
The D1 database `timesheet` (id in `worker/wrangler.toml`) already exists with its tables.

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository**.
2. Pick GitHub repo **TimeSheet** (approve GitHub access if asked).
3. Project name: `timesheet`. **Root directory: `worker`**. Leave the build/deploy commands as they are.
4. **Create and deploy.**

Cloudflare redeploys the API by itself whenever `worker/` changes on `main`.
Check: https://timesheet.kollinmeubanks.workers.dev should show `{"ok":true,"app":"TimeSheet API","setup":false}`.

## Connect the app
Open the app → ⚙ Settings → **Cloud sync** → server is pre-filled → type a passcode → **Connect**.
The first device creates the passcode; every other device (laptop, etc.) just enters the same one.
Changes sync automatically while the app is open; the dot next to your name shows the sync state.

## Local testing
`wrangler dev` inside `worker/`, then open `index.html` and set the server to `http://localhost:8787`.
