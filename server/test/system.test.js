import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-wbn-test-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = path.join(temp, "data");
process.env.DOWNLOADS_DIR = path.join(temp, "downloads");

const { app } = await import("../src/index.js");
const { getBatchSizes, splitIntoBatches } = await import("../src/batching.js");
const { locateReport } = await import("../../extension/rpc-parser.js");
const server = app.listen(0, "127.0.0.1");
let base;
let accessToken;
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const pairingCode = fs.readFileSync(path.join(process.env.DATA_DIR, "pairing-code.txt"), "utf8").trim();
  const paired = await fetch(`${base}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairingCode }) });
  assert.equal(paired.status, 200);
  accessToken = (await paired.json()).accessToken;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
});
async function request(route, options) {
  const headers = { ...(options?.headers || {}) };
  if (!headers.Authorization && !["/health", "/pair"].includes(route)) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${base}${route}`, { ...options, headers });
  const type = response.headers.get("content-type") || "";
  return { response, data: type.includes("json") ? await response.json() : await response.text() };
}
async function createJob(wbns) {
  const { response, data } = await request("/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remarks: "test_report", reportOption: "Default", wbns })
  });
  assert.equal(response.status, 201, JSON.stringify(data));
  return data.job;
}

test("local API pairing protects operational routes with a bearer token", async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const blocked = await fetch(`${base}/jobs`);
  assert.equal(blocked.status, 401);
  const paired = await fetch(`${base}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairingCode: "WRONG-CODE" }) });
  assert.equal(paired.status, 401);
  const allowed = await fetch(`${base}/jobs`, { headers: { Authorization: `Bearer ${accessToken}` } });
  assert.equal(allowed.status, 200);
});

test("batch boundaries: 6, 15000, 15001, 30000 and 2500000", () => {
  assert.deepEqual(getBatchSizes(6), [6]);
  assert.deepEqual(getBatchSizes(15000), [15000]);
  assert.deepEqual(getBatchSizes(15001), [15000, 1]);
  assert.deepEqual(getBatchSizes(30000), [15000, 15000]);
  assert.deepEqual(getBatchSizes(300000), Array(20).fill(15000));
  assert.deepEqual(getBatchSizes(2500000), [...Array(166).fill(15000), 10000]);
  assert.deepEqual(splitIntoBatches(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
});
test("300,000 WBN capacity creates 20 batches without splitting past 15,000", async () => {
  const wbns = Array.from({ length: 300000 }, (_, i) => `CAP${String(i).padStart(9, "0")}`);
  const { response, data } = await request("/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remarks: "capacity_300k", reportOption: "Default", wbns })
  });
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.equal(data.job.totalWbns, 300000);
  assert.equal(data.job.totalBatches, 20);
  const { data: first } = await request(`/jobs/${data.job.id}/batches/1`);
  const { data: last } = await request(`/jobs/${data.job.id}/batches/20`);
  assert.equal(first.batch.wbns.length, 15000);
  assert.equal(last.batch.wbns.length, 15000);
  assert.equal(first.batch.wbns[0], "CAP000000000");
  assert.equal(last.batch.wbns.at(-1), "CAP000299999");
});

test("RPC HTML parser matches exact remarks and decodes ampersands", () => {
  const html = `<table><tr><td>6afd106a3b47c81877476fe5</td><td>bulk_report_8d32f1659596_b0001</td><td>Nov. 18, 2026, 8:11 a.m.</td><td>6</td><td>Package</td><td>Complete</td><td><a href="https://s3.amazonaws.com/reports/a.csv?x=1&amp;y=2">Download</a></td></tr></table>`;
  const found = locateReport(html, "bulk_report_8d32f1659596_b0001");
  assert.equal(found.reportId, "6afd106a3b47c81877476fe5");
  assert.equal(found.status, "complete");
  assert.equal(found.downloadUrl, "https://s3.amazonaws.com/reports/a.csv?x=1&y=2");
  assert.equal(locateReport(html, "some_other_job"), null);
  assert.throws(() => locateReport(html + html, "bulk_report_8d32f1659596_b0001"), /More than one/);
});
test("job creation creates 15000 + 1 batches and applies visible duplicate policy", async () => {
  const wbns = Array.from({ length: 15001 }, (_, i) => `WB${String(i).padStart(6, "0")}`);
  const { response, data } = await request("/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remarks: "split_test", wbns: [...wbns, "", wbns[0], "  "] })
  });
  assert.equal(response.status, 201);
  assert.equal(data.job.totalWbns, 15001);
  assert.equal(data.job.totalBatches, 2);
  assert.equal(data.job.duplicateCount, 1);
  assert.equal(data.job.blankCount, 2);
  const { data: first } = await request(`/jobs/${data.job.id}/batches/1`);
  const { data: second } = await request(`/jobs/${data.job.id}/batches/2`);
  assert.equal(first.batch.wbns.length, 15000);
  assert.equal(second.batch.wbns.length, 1);
});
test("CSV append is idempotent, preserves quoted commas/newlines, finish is guarded, final download works", async () => {
  const job = await createJob(Array.from({ length: 15001 }, (_, i) => `CSVWBN${String(i).padStart(6, "0")}`));
  let result = await request(`/reports/finish/${job.id}`, { method: "POST" });
  assert.equal(result.response.status, 409, "must reject a job with no merged batches");

  const csv1 = 'id,description,note\r\n1,"Parcel, fragile","line one\nline two"\r\n';
  result = await request("/reports/append", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.id, batchNo: 1, csv: csv1 })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.rows, 1);
  const repeated = await request("/reports/append", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.id, batchNo: 1, csv: csv1 })
  });
  assert.equal(repeated.data.duplicate, true);
  const different = await request("/reports/append", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.id, batchNo: 1, csv: "id,description,note\\r\\n9,x,y\\r\\n" })
  });
  assert.equal(different.response.status, 400);

  const stillIncomplete = await request(`/reports/finish/${job.id}`, { method: "POST" });
  assert.equal(stillIncomplete.response.status, 409);
  const csv2 = 'id,description,note\r\n2,"Box, large","plain text"\r\n';
  const second = await request("/reports/append", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.id, batchNo: 2, csv: csv2 })
  });
  assert.equal(second.response.status, 200);
  const finished = await request(`/reports/finish/${job.id}`, { method: "POST" });
  assert.equal(finished.response.status, 200);
  assert.equal(finished.data.rows, 2);
  const download = await fetch(`${base}/jobs/${job.id}/download`, { headers: { Authorization: `Bearer ${accessToken}` } });
  assert.equal(download.status, 200);
  const body = await download.text();
  assert.match(body, /"Parcel, fragile"/);
  assert.match(body, /line one\nline two/);
  assert.equal((body.match(/id,description,note/g) || []).length, 1);
});

test("batch reconciliation attempts are persisted for restart-safe parallel monitoring", async () => {
  const job = await createJob(["RECONCILE1"]);
  const patched = await request(`/jobs/${job.id}/batches/1`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "submitting", rpcRemarks: `reconcile_${job.id}_b0001`, reconcileAttempts: 3 })
  });
  assert.equal(patched.response.status, 200, JSON.stringify(patched.data));
  const loaded = await request(`/jobs/${job.id}/batches/1`);
  assert.equal(loaded.data.batch.status, "submitting");
  assert.equal(loaded.data.batch.reconcileAttempts, 3);
});

test("CSV rows with extra fields are retained in explicit overflow columns", async () => {
  const job = await createJob(["OVERFLOW1"]);
  const csv = 'id,description,note\r\n1,parcel,plain,EXTRA_VALUE\r\n';
  const appended = await request("/reports/append", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.id, batchNo: 1, csv })
  });
  assert.equal(appended.response.status, 200, JSON.stringify(appended.data));
  assert.equal(appended.data.rows, 1);
  assert.equal(appended.data.overflowRows, 1);
  assert.equal(appended.data.extraFields, 1);
  assert.match(appended.data.warning, /preserved/);

  const finished = await request(`/reports/finish/${job.id}`, { method: "POST" });
  assert.equal(finished.response.status, 200, JSON.stringify(finished.data));
  assert.equal(finished.data.overflowRows, 1);
  assert.equal(finished.data.extraFields, 1);
  const download = await fetch(`${base}/jobs/${job.id}/download`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await download.text();
  assert.match(body, /__EXTRA_FIELD_1/);
  assert.match(body, /EXTRA_VALUE/);
});

test("rejects invalid WBNs, malformed CSV and unknown batches", async () => {
  let result = await request("/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remarks: "bad", wbns: ["GOOD", "BAD/CHAR"] })
  });
  assert.equal(result.response.status, 400);
  const job = await createJob(["A"]);
  result = await request("/reports/append", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.id, batchNo: 4, csv: "id\\n1\\n" })
  });
  assert.equal(result.response.status, 404);
  result = await request("/reports/append", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.id, batchNo: 1, csv: "<html>login</html>" })
  });
  assert.equal(result.response.status, 400);
});
