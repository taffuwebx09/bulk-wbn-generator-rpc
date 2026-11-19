import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const dataDir = path.resolve(process.env.DATA_DIR || "data");
const authFile = path.join(dataDir, "auth.json");
export const pairingCodeFile = path.join(dataDir, "pairing-code.txt");
fs.mkdirSync(dataDir, { recursive: true });
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const same = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}
function loadOrCreate() {
  let state;
  try { state = JSON.parse(fs.readFileSync(authFile, "utf8")); } catch { state = null; }
  let pairingCode = null;
  try { pairingCode = fs.readFileSync(pairingCodeFile, "utf8").trim(); } catch { pairingCode = null; }
  if (!state || !pairingCode || !same(state.pairingCodeHash, sha256(pairingCode))) {
    pairingCode = randomBytes(16).toString("hex").toUpperCase();
    state = { pairingCodeHash: sha256(pairingCode), tokenHashes: [], createdAt: new Date().toISOString() };
    fs.writeFileSync(pairingCodeFile, `${pairingCode}\n`, { encoding: "utf8", mode: 0o600 });
    writeJson(authFile, state);
  }
  return state;
}
let authState = loadOrCreate();
function persist() { writeJson(authFile, authState); }

export function createAccessToken(pairingCode) {
  const submitted = String(pairingCode || "").trim().toUpperCase();
  if (!submitted || !same(authState.pairingCodeHash, sha256(submitted))) return null;
  const accessToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(accessToken);
  authState.tokenHashes = [...new Set([...(authState.tokenHashes || []), tokenHash])].slice(-10);
  persist();
  return accessToken;
}
export function verifyAccessToken(token) {
  if (typeof token !== "string" || token.length < 40 || token.length > 200) return false;
  const digest = sha256(token);
  return (authState.tokenHashes || []).some((stored) => same(stored, digest));
}
export function isPaired() { return (authState.tokenHashes || []).length > 0; }
