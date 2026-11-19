# Bulk WBN Generator RPC — Windows Local Processor

## Install once
1. Install Node.js 20 LTS or newer from https://nodejs.org/.
2. Extract this ZIP to a normal folder (not inside the browser Downloads preview).
3. Double-click `Install-Local-Processor.bat`.
4. The installer installs the backend dependencies and creates `Bulk WBN Generator RPC.lnk` on your Windows Desktop.
5. Double-click the desktop shortcut. On the first run, Notepad opens the local `pairing-code.txt` file. Keep this code private.
6. In the Vercel dashboard, choose **Connect Backend**, paste the code, and connect.

## Each normal use
Double-click the desktop shortcut. The Local Processor runs in the background and Chrome opens the dashboard. Keep this Windows PC and Chrome running while reports are being processed.

## Local files
- Database/pairing code: `%LOCALAPPDATA%\BulkWBNGenerator\data\`
- CSV downloads: `%LOCALAPPDATA%\BulkWBNGenerator\downloads\`
- Logs: `%LOCALAPPDATA%\BulkWBNGenerator\logs\`

The API listens only on `127.0.0.1:4000`; it is not intended to be exposed to the LAN or public internet. Pairing tokens are stored as SHA-256 hashes by the backend. The pairing code is generated locally and should never be shared.

## Chrome Extension
Install the separate Chrome Extension ZIP from the dashboard Downloads popup using `chrome://extensions` → enable Developer mode → Load unpacked → select the extracted `extension` folder. The extension must be installed in the same Chrome profile in which Delhivery RPC is logged in.

## Troubleshooting
- If pairing fails, start the shortcut and open `%LOCALAPPDATA%\BulkWBNGenerator\data\pairing-code.txt` in Notepad to copy the code again.
- If the dashboard cannot reach localhost, allow the Chrome Local Network Access permission for the dashboard site and ensure Local Processor is running.
- Check `%LOCALAPPDATA%\BulkWBNGenerator\logs\processor-error.log` for startup errors.
- If you use a custom Vercel domain, update the allowed origin in the Local Processor server and Chrome Extension manifest, then reinstall/update both packages.
