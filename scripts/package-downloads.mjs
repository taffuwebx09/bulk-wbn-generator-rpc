import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "downloads");
const localServer = path.join(root, "local-processor", "server");
fs.mkdirSync(out, { recursive: true });
fs.rmSync(localServer, { recursive: true, force: true });
fs.mkdirSync(localServer, { recursive: true });
function copyTree(source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (["node_modules", "data", "downloads", "test"].includes(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copyTree(from, to); }
    else fs.copyFileSync(from, to);
  }
}
copyTree(path.join(root, "server"), localServer);
function zip(name, entries) {
  const target = path.join(out, name);
  fs.rmSync(target, { force: true });
  execFileSync("zip", ["-qr", target, ...entries], { cwd: root });
}
zip("bulk-wbn-rpc-extension.zip", ["extension"]);
zip("bulk-wbn-local-processor.zip", ["local-processor"]);
console.log("Created public/downloads packages from the current project sources.");
