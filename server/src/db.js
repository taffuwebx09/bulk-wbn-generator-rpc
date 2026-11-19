import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR || "data");
const dataFile = path.join(dataDir, "jobs.json");
fs.mkdirSync(dataDir, { recursive: true });

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      batches: Array.isArray(parsed.batches) ? parsed.batches : []
    };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read job database; starting empty:", error.message);
    return { jobs: [], batches: [] };
  }
}
const state = load();

function save() {
  const temp = `${dataFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, dataFile);
}

function clear() {
  state.jobs.length = 0;
  state.batches.length = 0;
  try { fs.rmSync(dataFile, { force: true }); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return true;
}
export const store = { jobs: state.jobs, batches: state.batches, save, clear, dataDir };
