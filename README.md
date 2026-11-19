# Bulk WBN Generator RPC — v1.4.0

A Vercel-hosted React/Vite dashboard paired with a per-PC Windows Local Processor and a Chrome Manifest V3 extension. The Local Processor owns jobs, batching, durable state and CSV merge. The extension uses the user's existing authenticated Delhivery RPC session.

## Architecture and data location

- **Vercel:** static frontend only; no WBN payloads, RPC credentials or report CSVs are sent to Vercel.
- **Windows Local Processor:** Node/Express API on `127.0.0.1:4000`, local job database, batch state, and final CSV files.
- **Chrome Extension:** installed in the Chrome profile used for Delhivery RPC; reads the existing logged-in session and submits/monitors/downloads reports.
- **Pairing:** the Local Processor creates a private pairing code in `%LOCALAPPDATA%\BulkWBNGenerator\data\pairing-code.txt`. The dashboard exchanges this code for an access token. The backend stores only token hashes; the dashboard and extension store the token locally in browser storage. Never share the pairing code.

The local API binds only to loopback and requires a bearer token for operational routes. CORS is limited to the configured dashboard origins plus the installed extension origin. A browser may ask permission for the dashboard to access the local network/loopback address; allow it for the dashboard you trust.

## Existing processing behavior preserved

- RPC batch ceiling: 15,000 WBNs.
- Parallel batch submission ceiling: 5 at a time (existing worker configuration).
- Concurrent CSV downloads ceiling: 3.
- Existing exact-remark report matching, report-count validation, uncertain-submission reconciliation, per-batch persistence and idempotent CSV append behavior remain in the extension worker.
- A job is finalized only after every batch CSV is appended and validated.
- Maximum input remains 2,500,000 unique WBNs. 300,000 WBNs require 20 batches of 15,000 each.
- Blank entries are ignored; outer whitespace is trimmed; exact duplicates are removed case-sensitively and the dashboard shows the duplicate count. Other characters are not silently rewritten.

A 300,000+ capacity target still depends on Delhivery RPC account/service limits, browser uptime, PC resources and successful live stress testing. Do not treat the arithmetic batch capacity as a verified live guarantee.

## Deploy frontend to Vercel

1. Import `taffuwebx09/bulk-wbn-generator-rpc` in Vercel.
2. Keep the project Root Directory as repository root.
3. `vercel.json` sets the Vite build command and `client/dist` output directory.
4. After the first deployment, note the exact Vercel production domain.
5. If the domain is not `https://bulk-wbn-generator-rpc.vercel.app`, update it in:
   - `server/src/index.js` default `allowedOrigins` and `DASHBOARD_ORIGINS`
   - `extension/manifest.json` under `content_scripts[0].matches` and `host_permissions`
   - `local-processor/Start-Local-Processor.ps1` `$dashboardUrl` and `DASHBOARD_ORIGINS`
   Then rebuild the two downloads packages and redeploy the frontend.

The project must be deployed from GitHub before the download links become available on the live Vercel dashboard. The ZIPs are served from `public/downloads/`.

## Windows Local Processor installation

1. From the dashboard **Downloads** popup, download **Windows Local Processor**.
2. Extract the ZIP to a normal folder.
3. Install Node.js 20 LTS or newer from https://nodejs.org/ if it is not already installed.
4. Double-click `local-processor/Install-Local-Processor.bat`.
5. The installer copies the server to `%LOCALAPPDATA%\BulkWBNGenerator\Processor`, installs production dependencies, and creates a `Bulk WBN Generator RPC` desktop shortcut.
6. Double-click the desktop shortcut. The Local Processor starts hidden, then Chrome opens the Vercel dashboard. On first run, Notepad displays the local pairing code.
7. In the dashboard, click **Connect Backend**, paste the code and connect.

Normal daily flow: double-click the desktop shortcut → dashboard opens → backend reconnects using the token saved in that browser. Keep the Windows PC and Chrome running during processing.

## Chrome Extension installation

1. Download **Chrome Extension** from the dashboard Downloads popup and extract the ZIP.
2. In the Chrome profile used for RPC, open `chrome://extensions`.
3. Enable Developer mode → **Load unpacked** → select the extracted `extension` folder.
4. Log into `https://hq.delhivery.com` in the same Chrome profile.
5. Refresh the Vercel dashboard. The extension bridge is injected only on the configured Vercel origin.

The extension does not store or hardcode cookies, session IDs, JWTs, CSRF tokens or temporary signed S3 URLs. It obtains CSRF from the authenticated RPC session at runtime.

## Local development

From repository root:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. For local development, Vite proxies `/api` to `http://127.0.0.1:4000`; connect through the pairing dialog using `server/data/pairing-code.txt`.

Validation:

```bash
npm test
npm run build
npm run package:downloads
```

## Local file locations

Installed Windows processor:

- Database and pairing code: `%LOCALAPPDATA%\BulkWBNGenerator\data\`
- Final and per-batch CSV files: `%LOCALAPPDATA%\BulkWBNGenerator\downloads\`
- Logs: `%LOCALAPPDATA%\BulkWBNGenerator\logs\`

These files contain operational waybill/report data and must not be uploaded to GitHub or shared publicly.

## Test and live integration boundary

Automated tests cover batch sizing (including 300,000 and 2,500,000), exact RPC remark matching, CSV decoding/merge safeguards, idempotent append, incomplete-job rejection, final download, and token pairing. They do not replace a live smoke test with the user's Delhivery RPC account. Before a production bulk run, verify a 2–3 WBN job, then 30,000 WBN, then scale gradually to 100,000 and 300,000+ while observing the RPC account limits and the Local Processor logs.
