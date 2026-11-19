# v1.4.0 validation report

## Checks completed in this environment
- `node --check` passed for backend source/test files, extension JavaScript files, and the downloads packaging script.
- JSON parsing passed for root/client/server package manifests, extension manifest, and `vercel.json`.
- Isolated Node checks passed for the 300,000-WBN → 20-batch calculation and pairing-code/token creation and verification.
- Both downloadable ZIP packages passed `unzip -t` integrity checks.
- Manual source inspection confirmed the Local Processor binds only to `127.0.0.1`, operational routes require bearer-token auth, and browser pairing is rate-limited.

## Checks not completed in this environment
- `npm install --no-audit --no-fund` timed out because the package registry could not be reached from this environment.
- `npm test` was attempted and could not start because workspace dependency `dotenv` was not installed. Therefore the full backend API tests are **not passed locally**.
- The React/Vite production build could not be run because dependencies were unavailable.
- Windows PowerShell installer execution was not run on a Windows machine.
- A live Vercel deployment, Chrome Local Network Access permission check, installed-extension connection, and live Delhivery RPC report/CSV flow were not available here.
- The 300,000-WBN backend integration test has been added to the automated suite, but it still needs to run in CI or a connected machine.

Do not treat this as production acceptance. Run the GitHub Actions checks, install the Windows package on a test PC, then smoke-test 2–3 WBN → 30,000 WBN → 100,000 WBN → 300,000 WBN before operational use.
