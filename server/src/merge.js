import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { parse as parseStream } from "csv-parse";
import { stringify } from "csv-stringify/sync";

const outputDir = path.resolve(process.env.DOWNLOADS_DIR || "downloads");
fs.mkdirSync(outputDir, { recursive: true });
const safeId = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");

function parseBatch(csv, batchNo) {
  if (typeof csv !== "string" || !csv.trim()) throw new Error(`Batch ${batchNo}: CSV is empty`);
  if (/^\s*</.test(csv) || /<html[\s>]/i.test(csv.slice(0, 1000))) {
    throw new Error(`Batch ${batchNo}: RPC returned HTML instead of CSV (session may have expired)`);
  }

  // Delhivery occasionally emits a row with more comma-separated fields than
  // its header. Keep those values instead of rejecting the entire batch or
  // silently dropping them. They are exported in explicitly named overflow
  // columns during finalization so the original values remain inspectable.
  const records = parse(csv.replace(/^\uFEFF/, ""), {
    bom: true,
    skip_empty_lines: true,
    relax_quotes: false,
    relax_column_count: true,
    record_delimiter: ["\r\n", "\n", "\r"]
  });
  if (records.length < 1 || !records[0].length || records[0].every((x) => String(x).trim() === "")) {
    throw new Error(`Batch ${batchNo}: CSV header is missing`);
  }
  const header = records[0].map((x) => String(x).trim());
  if (new Set(header).size !== header.length) throw new Error(`Batch ${batchNo}: duplicate CSV header names`);

  let maxColumns = header.length;
  let overflowRows = 0;
  for (const [i, row] of records.slice(1).entries()) {
    if (row.length < header.length) {
      throw new Error(`Batch ${batchNo}: row ${i + 2} has only ${row.length} columns; expected at least ${header.length}. The row was not discarded.`);
    }
    if (row.length > header.length) {
      const extra = row.length - header.length;
      if (extra > 5) throw new Error(`Batch ${batchNo}: row ${i + 2} has ${extra} unexpected extra fields; safe merge limit is 5. Original batch was not appended.`);
      maxColumns = Math.max(maxColumns, row.length);
      overflowRows++;
    }
  }
  return { header, rows: records.slice(1), records, maxColumns, overflowRows };
}

const batchPath = (id, no) => path.join(outputDir, `${safeId(id)}.batch-${String(no).padStart(4, "0")}.csv`);
export function appendCsv(jobId, batchNo, csv, store) {
  const id = safeId(jobId), n = Number(batchNo);
  if (!id || id !== String(jobId)) throw new Error("Invalid job id");
  if (!Number.isInteger(n) || n < 1) throw new Error("Invalid batch number");
  const parsed = parseBatch(csv, n);
  const { header, rows, records, overflowRows, maxColumns } = parsed;
  const canonical = stringify(records);
  const hash = createHash("sha256").update(canonical).digest("hex");
  const file = batchPath(id, n);
  const existing = store.batches.find((b) => b.jobId === id && b.batchNumber === n);
  if (!existing) throw new Error(`Batch ${n} does not exist for job ${id}`);
  if (existing.csvAppend?.hash) {
    if (existing.csvAppend.hash !== hash) throw new Error(`Batch ${n} was already appended with different CSV content`);
    const fileHash = fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
    if (fileHash !== hash) {
      const temp = `${file}.${process.pid}.recovery.tmp`;
      fs.writeFileSync(temp, canonical, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, file);
    }
    return {
      ok: true, duplicate: true, recovered: fileHash !== hash, batchNo: n,
      rows: existing.csvAppend.rows, hash,
      overflowRows: existing.csvAppend.overflowRows || 0,
      extraFields: existing.csvAppend.extraFields || 0,
      warning: existing.csvAppend.overflowRows
        ? `${existing.csvAppend.overflowRows} row(s) contain extra CSV fields; values are preserved in clearly labelled columns in the final file.`
        : null
    };
  }
  const job = store.jobs.find((j) => j.id === id);
  if (!job) throw new Error("Job not found");
  if (JSON.stringify(job.csvHeader || header) !== JSON.stringify(header)) {
    throw new Error("CSV columns differ between RPC batches; merge stopped safely");
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, canonical, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  job.csvHeader = header;
  existing.csvAppend = {
    hash, rows: rows.length, file: path.basename(file),
    overflowRows, extraFields: Math.max(0, maxColumns - header.length),
    appendedAt: new Date().toISOString()
  };
  existing.rowsReceived = rows.length;
  existing.status = "merged";
  store.save();
  return {
    ok: true, duplicate: false, batchNo: n, rows: rows.length, hash,
    overflowRows, extraFields: Math.max(0, maxColumns - header.length),
    warning: overflowRows
      ? `${overflowRows} row(s) contain extra CSV fields; values are preserved in clearly labelled columns in the final file.`
      : null
  };
}

export async function buildFinalCsv(job, batches, store) {
  const id = safeId(job.id);
  if (!id || id !== job.id) throw new Error("Invalid job id");
  const ordered = [...batches].sort((a, b) => a.batchNumber - b.batchNumber);
  if (ordered.length !== job.totalBatches) throw new Error("Expected batch records are missing");
  if (ordered.some((b, i) => b.batchNumber !== i + 1 || !b.csvAppend?.hash)) {
    throw new Error("Cannot finish: one or more batches have not been downloaded and merged");
  }
  const finalPath = path.join(outputDir, `${id}.csv`);
  const temp = `${finalPath}.${process.pid}.tmp`;
  let header;
  let outputHeader;
  let totalRows = 0;
  let overflowRows = 0;
  try {
    // First pass determines the largest row width across all batches. This
    // makes the final schema consistent even if only a later batch has extras.
    const parsedBatches = [];
    let maxColumns = 0;
    for (const batch of ordered) {
      const file = batchPath(id, batch.batchNumber);
      if (!fs.existsSync(file)) throw new Error(`Batch ${batch.batchNumber} merged CSV file is missing`);
      const parsed = parseBatch(fs.readFileSync(file, "utf8"), batch.batchNumber);
      if (!header) header = parsed.header;
      if (JSON.stringify(header) !== JSON.stringify(parsed.header)) throw new Error("CSV header mismatch during final validation");
      if (parsed.rows.length !== batch.csvAppend.rows) throw new Error(`Batch ${batch.batchNumber} row count validation failed`);
      maxColumns = Math.max(maxColumns, parsed.maxColumns);
      overflowRows += parsed.overflowRows;
      parsedBatches.push(parsed);
    }
    if (!header) throw new Error("No CSV header available");
    outputHeader = [...header];
    for (let i = header.length; i < maxColumns; i++) outputHeader.push(`__EXTRA_FIELD_${i - header.length + 1}`);
    fs.writeFileSync(temp, stringify([outputHeader]), { encoding: "utf8", mode: 0o600 });

    for (const parsed of parsedBatches) {
      if (parsed.rows.length) {
        const normalizedRows = parsed.rows.map((row) => [...row, ...Array(Math.max(0, maxColumns - row.length)).fill("")]);
        fs.appendFileSync(temp, stringify(normalizedRows), "utf8");
      }
      totalRows += parsed.rows.length;
    }

    // Stream-parse the completed temporary file and verify every row against
    // the expanded output header without loading a large report into memory.
    let first = true, verifiedRows = 0;
    const parser = fs.createReadStream(temp).pipe(parseStream({ bom: true, skip_empty_lines: true }));
    for await (const record of parser) {
      if (first) {
        first = false;
        if (JSON.stringify(record) !== JSON.stringify(outputHeader)) throw new Error("Final CSV header validation failed");
      } else {
        if (record.length !== outputHeader.length) throw new Error("Final CSV contains a row with an invalid column count");
        verifiedRows++;
      }
    }
    if (first || verifiedRows !== totalRows) throw new Error("Final merged CSV row-count validation failed");
    fs.renameSync(temp, finalPath);
    fs.accessSync(finalPath, fs.constants.R_OK);
    return {
      file: finalPath, rows: totalRows, batches: ordered.length,
      overflowRows, extraFields: Math.max(0, outputHeader.length - header.length),
      warnings: overflowRows
        ? [`${overflowRows} row(s) contained more fields than the source header. Extra values were retained in ${outputHeader.slice(header.length).join(", ")}. Check those rows before operational use.`]
        : []
    };
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

export function finalFile(jobId) {
  const id = safeId(jobId);
  if (!id || id !== String(jobId)) throw new Error("Invalid job id");
  const file = path.join(outputDir, `${id}.csv`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("No validated merged report file found");
  return file;
}
export { outputDir, parseBatch };
