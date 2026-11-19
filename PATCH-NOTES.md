# v1.4.0 — Vercel + Windows Local Processor architecture

- Preserved the existing 15,000-WBN batching and v1.3.1 parallel Chrome worker flow.
- Added a Vercel frontend configuration and a Downloads popup with Extension and Windows Local Processor packages.
- Added an explicit Connect Backend pairing flow from the hosted dashboard to the PC-local API.
- Added local pairing-code generation, SHA-256 hashed bearer-token storage, timing-safe comparisons, rate-limited pairing attempts, and token authorization for operational API routes.
- Kept the API bound to `127.0.0.1` only.
- Added a Windows install script that installs server dependencies and creates a desktop shortcut; shortcut startup launches the Local Processor in the background and opens the hosted dashboard.
- Added package generation for the extension and local processor ZIP files under `public/downloads`.
- Added exact default Vercel origin support to the server CORS allow-list and extension dashboard match. A custom Vercel domain must be added explicitly.
- Removed the Last Refresh header chip and added the Downloads action; added Local Backend connection status and pairing dialog.

## Important boundaries
- This is a Node.js-based Windows setup package, not a signed standalone EXE. Node.js 20+ is required on the PC.
- A live Vercel deploy, browser Local Network Access permission test, installed-extension RPC smoke test, and 300,000+ live Delhivery stress test remain required before declaring production acceptance.
