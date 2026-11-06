# Deploy

## Website (GitHub Pages)
Pushing to `main` runs **Deploy TimeSheet to GitHub Pages** → https://keubanks16.github.io/TimeSheet/
(If the first run fails, enable Pages once: repo **Settings → Pages → Source: GitHub Actions**.)

## Updates on the phone
The Pages workflow stamps the commit id into `index.html` (`__BUILD__`). The app re-checks that stamp whenever it comes to the foreground and shows a "New version available" bar; tapping it reloads. Nothing to bump by hand.

## API + database (Cloudflare Worker + D1) — one-time setup, no tokens
The D1 database `timesheet` (id in `worker/wrangler.toml`) already exists with its tables.

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository**.
2. Pick GitHub repo **TimeSheet** (approve GitHub access if asked).
3. Project name: `timesheet`. Leave root directory, build and deploy commands as they are (a `wrangler.toml` at the repo root points at the Worker).
4. **Create and deploy.**

Cloudflare redeploys the API by itself on every push to `main`.
If it ever shows the app page instead of JSON, open the project in Cloudflare → **Deployments → Retry deployment** (or **Settings → Build** and make sure the deploy command is `npx wrangler deploy`).
Check: https://timesheet.kollinmeubanks.workers.dev should show `{"ok":true,"app":"TimeSheet API","setup":false}`.

## Connect the app
Open the app → ⚙ Settings → **Cloud sync** → server is pre-filled → type a passcode → **Connect**.
The first device creates the passcode; every other device (laptop, etc.) just enters the same one.
Changes sync automatically while the app is open; the dot next to your name shows the sync state.

## Local testing
`wrangler dev` inside `worker/`, then open `index.html` and set the server to `http://localhost:8787`.
