import { locateReport, attrOf } from "./rpc-parser.js";
// Bulk WBN RPC Connector — MV3 restart-safe, parallel batch worker.
const RPC = "https://hq.delhivery.com";
const FORM = `${RPC}/reports/bulk_csv_report/`;
const LIST = `${RPC}/reports/list/`;
const API = "http://127.0.0.1:4000/api";
const JOB_ALARM = "bulk-wbn-rpc-next-step";
const MAX_BATCH = 15000;
// Submit several independent 15k reports together, then monitor/download each independently.
const MAX_PARALLEL_SUBMISSIONS = 5;
const MAX_PARALLEL_DOWNLOADS = 3;
const MAX_RECONCILE_ATTEMPTS = 15;
let processing = false;

async function apiFetch(path, options = {}) {
  const { bulkWbnBackendToken } = await chrome.storage.local.get("bulkWbnBackendToken");
  if (!bulkWbnBackendToken) throw new Error("Local Backend is not paired. Connect Backend from the dashboard first.");
  const response = await fetch(`${API}${path}`, {
    cache: "no-store", ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${bulkWbnBackendToken}` }
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Local API ${response.status}: ${detail || response.statusText}`);
  }
  return response;
}
async function rpcFetch(url, options = {}) {
  const response = await fetch(url, { credentials: "include", cache: "no-store", redirect: "follow", ...options });
  const finalUrl = new URL(response.url || url);
  if (response.status === 401 || response.status === 403 || finalUrl.protocol !== "https:" ||
      !(finalUrl.hostname === "hq.delhivery.com" || finalUrl.hostname.endsWith(".delhivery.com") || finalUrl.hostname.endsWith(".amazonaws.com"))) {
    throw new Error("Delhivery RPC session expired or redirected. Login again in the same Chrome profile.");
  }
  if (!response.ok) throw new Error(`RPC request failed with HTTP ${response.status}.`);
  return response;
}
async function rpcStatus() {
  try {
    const response = await rpcFetch(LIST);
    const path = new URL(response.url).pathname;
    const html = await response.text();
    const looksLikeList = path.startsWith("/reports/list/") && /<table\b/i.test(html) && /<tr\b/i.test(html);
    return { ok: true, connected: response.ok && looksLikeList, status: response.status,
      error: looksLikeList ? null : "RPC login/session is not on the Reports Listing page." };
  } catch (e) { return { ok: false, connected: false, error: e.message }; }
}
async function getCsrf() {
  const cookie = await chrome.cookies.get({ url: RPC, name: "csrftoken" });
  if (cookie?.value) return cookie.value;
  const response = await rpcFetch(FORM);
  if (!new URL(response.url).pathname.startsWith("/reports/bulk_csv_report/")) throw new Error("RPC session redirected away from the report form. Login again.");
  const html = await response.text();
  const input = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0])
    .find((tag) => attrOf(tag, "name") === "csrfmiddlewaretoken");
  const token = input ? attrOf(input, "value") : null;
  if (!token) throw new Error("CSRF token not found on RPC report form. Check login/form structure.");
  return token;
}
async function submitBatch(remarks, wbns, option) {
  if (!Array.isArray(wbns) || wbns.length < 1 || wbns.length > MAX_BATCH) throw new Error(`Invalid batch size: ${wbns?.length ?? 0}. Allowed 1–${MAX_BATCH}.`);
  const csrf = await getCsrf();
  const body = new URLSearchParams({
    csrfmiddlewaretoken: csrf, remarks, waybills: wbns.join("\r\n"),
    report_option: option || "Default"
  });
  const response = await rpcFetch(FORM, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRFToken": csrf, "Referer": FORM },
    body
  });
  const responseText = await response.text();
  const finalPath = new URL(response.url).pathname;
  if (!response.ok || !finalPath.startsWith("/reports/list/") ||
      /name=["']password["']|csrf verification failed|login required/i.test(responseText.slice(0, 1200))) {
    throw new Error(`RPC submission response was not the expected Reports Listing redirect (HTTP ${response.status}). Inspect RPC form/response; no automatic resubmit will occur.`);
  }
}
async function readReport(remark) {
  const response = await rpcFetch(LIST);
  if (!new URL(response.url).pathname.startsWith("/reports/list/")) throw new Error("RPC session redirected away from Reports Listing. Login again.");
  const row = locateReport(await response.text(), remark);
  return row;
}
async function readReportsPage() {
  const response = await rpcFetch(LIST);
  if (!new URL(response.url).pathname.startsWith("/reports/list/")) throw new Error("RPC session redirected away from Reports Listing. Login again.");
  return response.text();
}
async function mapWithConcurrency(items, limit, task) {
  let next = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  return Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { await task(items[index]); } catch (error) { console.error("Parallel batch task failed:", error); /* Other batches continue. */ }
    }
  }));
}
function batchRemark(job, batch) {
  return batch.rpcRemarks || `${job.remarks}_${job.id}_b${String(batch.batchNumber).padStart(4, "0")}`;
}
async function processParallelJob(job, initialBatches, state) {
  // Recover the narrow window where the CSV was appended but the worker stopped
  // before it could mark that batch completed.
  for (const batch of initialBatches) {
    if (batch.csvAppend?.hash && batch.status !== "completed") {
      await patchBatch(job.id, batch.batchNumber, { status: "completed", error: null });
    }
  }

  // Dispatch every queued batch without waiting for earlier reports to finish.
  const queued = initialBatches.filter((batch) => batch.status === "queued" && !batch.csvAppend?.hash);
  await mapWithConcurrency(queued, MAX_PARALLEL_SUBMISSIONS, async (batch) => {
    const full = await (await apiFetch(`/jobs/${job.id}/batches/${batch.batchNumber}`)).json();
    const wbns = full.batch?.wbns;
    if (!Array.isArray(wbns) || wbns.length < 1 || wbns.length > MAX_BATCH) {
      await patchBatch(job.id, batch.batchNumber, { status: "needs_attention", error: `Batch ${batch.batchNumber} WBN payload is missing or invalid.` });
      return;
    }
    const remark = batchRemark(job, batch);
    // Save the unique remark and submission intent before the non-idempotent POST.
    await patchBatch(job.id, batch.batchNumber, {
      status: "submitting", rpcRemarks: remark,
      submittedAt: new Date().toISOString(), reconcileAttempts: 0, error: null
    });
    await patchJob(job.id, { status: "running", error: null });
    try {
      await submitBatch(remark, wbns, job.reportOption);
      await patchBatch(job.id, batch.batchNumber, { status: "submitted", rpcRemarks: remark, error: null });
    } catch (error) {
      // It may have reached RPC even if the browser lost the response. Keep it
      // in submitting state and reconcile by exact remarks; never blindly repost.
      await patchBatch(job.id, batch.batchNumber, { status: "submitting", rpcRemarks: remark, error: error.message }).catch(() => {});
    }
  });

  const refreshed = await getJob(job.id);
  const batches = refreshed.batches;
  const activeStatuses = new Set(["submitting", "submitted", "pending", "in_progress", "downloading", "merged"]);
  const active = batches.filter((batch) => activeStatuses.has(batch.status) && !batch.csvAppend?.hash);

  // Read the Reports Listing once per cycle, then independently match all active
  // batch remarks against the same snapshot.
  if (active.length) {
    const html = await readReportsPage();
    await mapWithConcurrency(active, MAX_PARALLEL_DOWNLOADS, async (batch) => {
      try {
      const remark = batchRemark(job, batch);
      const row = locateReport(html, remark);
      if (!row) {
        if (batch.status === "submitting") {
          const attempts = (batch.reconcileAttempts || 0) + 1;
          if (attempts >= MAX_RECONCILE_ATTEMPTS) {
            await patchBatch(job.id, batch.batchNumber, {
              status: "needs_attention", reconcileAttempts: attempts,
              error: `RPC acceptance for ${remark} could not be confirmed after ${attempts} checks. Check Reports Listing before retrying.`
            });
          } else {
            await patchBatch(job.id, batch.batchNumber, { reconcileAttempts: attempts, lastPollingAt: new Date().toISOString() });
          }
        } else {
          await patchBatch(job.id, batch.batchNumber, { lastPollingAt: new Date().toISOString() });
        }
        return;
      }

      const checkedAt = new Date().toISOString();
      await patchBatch(job.id, batch.batchNumber, { rpcReportId: row.reportId, lastPollingAt: checkedAt, error: null });
      await patchJob(job.id, { lastRpcReportFound: true, lastRpcReportStatus: row.status, lastRpcRemark: remark, lastRpcCheckedAt: checkedAt });
      const reportCount = Number(String(row.count).replace(/,/g, ""));
      if (String(row.count).trim() !== "" && Number.isFinite(reportCount) && reportCount !== batch.wbnCount) {
        await patchBatch(job.id, batch.batchNumber, {
          status: "needs_attention",
          error: `RPC report count mismatch for ${remark}: RPC shows ${reportCount}, expected ${batch.wbnCount}.`
        });
        return;
      }
      if (/failed|error|cancelled/i.test(row.status)) {
        await patchBatch(job.id, batch.batchNumber, { status: "needs_attention", error: `RPC report ${remark} status: ${row.status}` });
        return;
      }
      if (!/complete/i.test(row.status) || !row.downloadUrl) {
        await patchBatch(job.id, batch.batchNumber, { status: /progress/i.test(row.status) ? "in_progress" : "pending" });
        return;
      }

      // A Complete report is downloaded immediately; a failure here is isolated
      // to this batch and retried from its persisted downloading state next poll.
      await patchBatch(job.id, batch.batchNumber, { status: "downloading", error: null });
      try {
        const csv = await downloadCsvText(row.downloadUrl);
        const response = await apiFetch("/reports/append", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.id, batchNo: batch.batchNumber, csv })
        });
        const append = await response.json();
        if (!append.ok) throw new Error(`Backend did not confirm CSV append for batch ${batch.batchNumber}.`);
        await patchBatch(job.id, batch.batchNumber, { status: "completed", error: null });
      } catch (error) {
        const isPermanent = /Local API 4\d\d:|instead of CSV|unexpected download URL|untrusted host/i.test(error.message);
        await patchBatch(job.id, batch.batchNumber, {
          status: isPermanent ? "needs_attention" : "downloading",
          error: error.message
        }).catch(() => {});
      }
      } catch (error) {
        await patchBatch(job.id, batch.batchNumber, {
          status: "needs_attention", error: `Batch monitor error: ${error.message}`
        }).catch(() => {});
      }
    });
  }

  const latest = await getJob(job.id);
  const latestBatches = latest.batches;
  const completed = latestBatches.filter((batch) => batch.status === "completed" && batch.csvAppend?.hash).length;
  const pending = latestBatches.some((batch) => ["queued", "submitting", "submitted", "pending", "in_progress", "downloading", "merged"].includes(batch.status) || (batch.status === "completed" && !batch.csvAppend?.hash));
  const attention = latestBatches.filter((batch) => batch.status === "needs_attention");

  if (completed === job.totalBatches) {
    await apiFetch(`/reports/finish/${job.id}`, { method: "POST" });
    await chrome.storage.local.remove("rpcJobState");
    await chrome.alarms.clear(JOB_ALARM);
    return;
  }

  if (pending) {
    await patchJob(job.id, {
      status: "running", error: attention.length ? `${attention.length} batch(es) need review; remaining batches continue processing.` : null,
      currentBatch: Math.max(0, ...latestBatches.filter((b) => b.status !== "queued").map((b) => b.batchNumber))
    });
    await setState({ ...state, phase: "parallel", retryCount: 0, lastCycleAt: new Date().toISOString() });
    await scheduleNextStep(0.5);
    return;
  }

  // All remaining batches need manual attention. Stop polling, but keep state so
  // the dashboard's Resume / Check action can reconcile them later.
  await patchJob(job.id, {
    status: attention.length ? "needs_attention" : "waiting",
    error: attention.length ? `${attention.length} batch(es) need review before the final CSV can be built.` : "No active RPC batches were found; use Resume / Check to continue."
  });
  await setState({ ...state, phase: "parallel", paused: true });
  await chrome.alarms.clear(JOB_ALARM);
}

async function downloadCsvText(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !(parsed.hostname === "hq.delhivery.com" || parsed.hostname.endsWith(".delhivery.com") || parsed.hostname.endsWith(".amazonaws.com"))) {
    throw new Error("Refusing CSV download from an untrusted host.");
  }
  const response = await rpcFetch(url);
  if (!response.ok) throw new Error(`RPC CSV download failed (${response.status})`);
  const type = response.headers.get("content-type") || "";
  const csv = await response.text();
  if (!csv.trim() || /<html[\s>]/i.test(csv.slice(0, 1000)) || /text\/html/i.test(type)) {
    throw new Error("RPC download returned HTML/login content instead of CSV.");
  }
  return csv;
}
async function getJob(jobId) {
  const data = await (await apiFetch(`/jobs/${jobId}`)).json();
  return data;
}
async function patchJob(jobId, patch) {
  return apiFetch(`/jobs/${jobId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
}
async function patchBatch(jobId, batchNo, patch) {
  return apiFetch(`/jobs/${jobId}/batches/${batchNo}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
}
async function setState(state) { await chrome.storage.local.set({ rpcJobState: state }); }
async function scheduleNextStep(minutes = 0.5) { await chrome.alarms.create(JOB_ALARM, { delayInMinutes: minutes }); }
async function markNeedsAttention(state, message) {
  await setState({ ...state, phase: "needs_attention", error: message, updatedAt: new Date().toISOString() });
  await patchJob(state.jobId, { status: "needs_attention", error: message });
  await patchBatch(state.jobId, state.batchNo, { status: "needs_attention", error: message });
  await chrome.alarms.clear(JOB_ALARM);
}
async function processJobStep() {
  if (processing) return;
  processing = true;
  try {
    const { rpcJobState: state } = await chrome.storage.local.get("rpcJobState");
    if (!state?.jobId) { await chrome.alarms.clear(JOB_ALARM); return; }
    const { job, batches } = await getJob(state.jobId);
    if (["completed", "cancelled"].includes(job.status)) { await chrome.storage.local.remove("rpcJobState"); await chrome.alarms.clear(JOB_ALARM); return; }
    if (state.phase === "parallel") {
      await processParallelJob(job, batches, state);
      return;
    }
    // Safely migrate an active v1.3.0 serial job to independent batch tracking.
    // Existing submitting batches are reconciled by exact remarks, not resubmitted.
    if (state.batchNo && state.phase !== "needs_attention") {
      const migrated = { jobId: state.jobId, phase: "parallel", retryCount: 0, migratedFromSerial: true };
      await setState(migrated);
      await processParallelJob(job, batches, migrated);
      return;
    }
    const batch = batches.find((b) => b.batchNumber === state.batchNo);
    if (!batch) throw new Error(`Batch ${state.batchNo} missing from backend.`);
    const remark = state.remark || batch.rpcRemarks || `${job.remarks}_${job.id}_b${String(state.batchNo).padStart(4, "0")}`;
    if (state.phase === "needs_attention") {
      try {
        await patchJob(job.id, { status: "needs_attention", error: state.error || "Manual reconciliation required." });
        await patchBatch(job.id, state.batchNo, { status: "needs_attention", error: state.error || "Manual reconciliation required." });
        await chrome.alarms.clear(JOB_ALARM);
      } catch { await scheduleNextStep(2); }
      return;
    }

    if (state.phase === "submit") {
      if (batch.status === "submitting" || batch.status === "submitted" || batch.status === "pending" || batch.status === "in_progress" || batch.status === "complete" || batch.status === "downloading" || batch.csvAppend) {
        await setState({ ...state, phase: "waiting", remark });
        await scheduleNextStep(); return;
      }
      // Persist intent BEFORE making the non-idempotent RPC POST.
      const fullBatch = await (await apiFetch(`/jobs/${job.id}/batches/${state.batchNo}`)).json();
      if (!Array.isArray(fullBatch.batch?.wbns) || fullBatch.batch.wbns.length < 1 || fullBatch.batch.wbns.length > MAX_BATCH) throw new Error(`Batch ${state.batchNo} WBN payload is missing or invalid.`);
      await patchBatch(job.id, state.batchNo, { status: "submitting", rpcRemarks: remark, submittedAt: new Date().toISOString(), error: null });
      await setState({ ...state, phase: "submitting", remark, submitStartedAt: new Date().toISOString(), reconcileAttempts: 0 });
      await submitBatch(remark, fullBatch.batch.wbns, job.reportOption);
      await patchBatch(job.id, state.batchNo, { status: "submitted", rpcRemarks: remark, error: null });
      await patchJob(job.id, { status: "running", currentBatch: state.batchNo, error: null });
      await setState({ ...state, phase: "waiting", remark, submittedAt: new Date().toISOString(), retryCount: 0 });
      await scheduleNextStep(); return;
    }

    if (state.phase === "submitting" || state.phase === "reconcile") {
      // POST may have reached RPC before worker suspension. Never blindly submit twice.
      const row = await readReport(remark);
      if (row) {
        await patchBatch(job.id, state.batchNo, { status: "submitted", rpcRemarks: remark, rpcReportId: row.reportId });
        await setState({ ...state, phase: "waiting", remark, rpcReportId: row.reportId });
        await scheduleNextStep(); return;
      }
      const attempts = (state.reconcileAttempts || 0) + 1;
      if (attempts < 5) {
        await setState({ ...state, phase: "reconcile", remark, reconcileAttempts: attempts });
        await scheduleNextStep(1); return;
      }
      await markNeedsAttention(state, `Could not confirm whether RPC accepted ${remark}. To prevent duplicate reports, automatic resubmission was stopped. Check RPC Reports Listing manually.`);
      return;
    }

    if (state.phase === "waiting") {
      const checkedAt = new Date().toISOString();
      await patchBatch(job.id, state.batchNo, { lastPollingAt: checkedAt });
      await patchJob(job.id, { lastRpcRemark: remark, lastRpcCheckedAt: checkedAt });
      const row = await readReport(remark);
      if (!row) { await patchJob(job.id, { lastRpcReportFound: false, lastRpcReportStatus: "not_found" }); await scheduleNextStep(); return; }
      await patchJob(job.id, { lastRpcReportFound: true, lastRpcReportStatus: row.status, lastRpcRemark: remark });
      await patchBatch(job.id, state.batchNo, { rpcReportId: row.reportId });
      const reportCount = Number(String(row.count).replace(/,/g, ""));
      if (String(row.count).trim() !== "" && Number.isFinite(reportCount) && reportCount !== batch.wbnCount) {
        await markNeedsAttention(state, `RPC report count mismatch for ${remark}: RPC shows ${reportCount}, expected ${batch.wbnCount}.`);
        return;
      }
      if (/failed|error|cancelled/i.test(row.status)) {
        await patchBatch(job.id, state.batchNo, { status: "failed", error: `RPC report status: ${row.status}` });
        await markNeedsAttention(state, `RPC report ${remark} failed with status "${row.status}".`);
        return;
      }
      if (!/complete/i.test(row.status) || !row.downloadUrl) { await patchBatch(job.id, state.batchNo, { status: /progress/i.test(row.status) ? "in_progress" : "pending" }); await scheduleNextStep(); return; }
      await patchBatch(job.id, state.batchNo, { status: "downloading" });
      await setState({ ...state, phase: "downloading", remark, rpcReportId: row.reportId });
      const csv = await downloadCsvText(row.downloadUrl);
      const append = await (await apiFetch("/reports/append", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id, batchNo: state.batchNo, csv }) })).json();
      if (!append.ok) throw new Error(`Backend did not confirm CSV append for batch ${state.batchNo}.`);
      await patchBatch(job.id, state.batchNo, { status: "completed", error: null });
      const next = state.batchNo + 1;
      await patchJob(job.id, { currentBatch: state.batchNo, status: "running", error: null });
      if (next > job.totalBatches) {
        await apiFetch(`/reports/finish/${job.id}`, { method: "POST" });
        await chrome.storage.local.remove("rpcJobState"); await chrome.alarms.clear(JOB_ALARM);
      } else {
        await setState({ jobId: job.id, batchNo: next, phase: "submit", retryCount: 0 });
        await scheduleNextStep();
      }
      return;
    }

    if (state.phase === "downloading") {
      // Re-fetch the same exact report and let the backend's idempotent batch append guard handle retries.
      const row = await readReport(remark);
      if (!row || !/complete/i.test(row.status) || !row.downloadUrl) { await scheduleNextStep(); return; }
      const csv = await downloadCsvText(row.downloadUrl);
      const response = await apiFetch("/reports/append", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id, batchNo: state.batchNo, csv }) });
      const append = await response.json();
      if (!append.ok) throw new Error("Backend did not confirm CSV append.");
      await patchBatch(job.id, state.batchNo, { status: "completed", error: null });
      if (state.batchNo === job.totalBatches) {
        await apiFetch(`/reports/finish/${job.id}`, { method: "POST" });
        await chrome.storage.local.remove("rpcJobState"); await chrome.alarms.clear(JOB_ALARM);
      } else {
        await setState({ jobId: job.id, batchNo: state.batchNo + 1, phase: "submit" });
        await scheduleNextStep();
      }
      return;
    }

  } catch (e) {
    const { rpcJobState: state } = await chrome.storage.local.get("rpcJobState");
    if (state?.jobId) {
      const retries = (state.retryCount || 0) + 1;
      if (state.phase === "parallel") {
        if (retries <= 8 && !/Local API 4\d\d:|session expired|CSRF token not found|not the expected Reports Listing|unexpected download URL/i.test(e.message)) {
          await setState({ ...state, retryCount: retries, lastError: e.message, lastErrorAt: new Date().toISOString() });
          await patchJob(state.jobId, { status: "waiting", error: `Temporary monitoring error (${retries}/8): ${e.message}` }).catch(() => {});
          await scheduleNextStep(Math.min(5, retries));
        } else {
          await patchJob(state.jobId, { status: "needs_attention", error: e.message }).catch(() => {});
          await chrome.alarms.clear(JOB_ALARM);
        }
      } else if (retries <= 5 && !/Local API 4\d\d:|session expired|CSRF token not found|not the expected Reports Listing|unexpected download URL/i.test(e.message)) {
        await setState({ ...state, retryCount: retries, lastError: e.message, lastErrorAt: new Date().toISOString() });
        await patchBatch(state.jobId, state.batchNo, { retryCount: retries, error: e.message }).catch(() => {});
        await patchJob(state.jobId, { status: "waiting", error: `Temporary error (${retries}/5): ${e.message}` }).catch(() => {});
        await scheduleNextStep(Math.min(5, retries));
      } else {
        await markNeedsAttention(state, e.message);
      }
    }
  } finally { processing = false; }
}

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === JOB_ALARM) processJobStep(); });
chrome.runtime.onStartup.addListener(async () => {
  const { rpcJobState: state } = await chrome.storage.local.get("rpcJobState");
  if (state?.jobId) { if (state.phase === "submitting") await setState({ ...state, phase: "reconcile" }); await scheduleNextStep(0.5); }
});
chrome.runtime.onInstalled.addListener(async () => {
  const { rpcJobState: state } = await chrome.storage.local.get("rpcJobState");
  if (state?.jobId) { if (state.phase === "submitting") await setState({ ...state, phase: "reconcile" }); await scheduleNextStep(0.5); }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SET_BACKEND_TOKEN") {
    (async () => {
      const token = message.payload?.token;
      if (typeof token !== "string" || token.length < 40 || token.length > 200) throw new Error("Invalid Local Backend token.");
      await chrome.storage.local.set({ bulkWbnBackendToken: token });
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "CLEAR_BACKEND_TOKEN") {
    chrome.storage.local.remove("bulkWbnBackendToken").then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "CLEAR_ALL_DATA") {
    (async () => {
      if (processing) throw new Error("A batch operation is currently running. Wait for the current RPC action to finish, then clear all data.");
      await chrome.alarms.clear(JOB_ALARM);
      await chrome.storage.local.remove("rpcJobState");
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "RPC_STATUS") { rpcStatus().then(sendResponse).catch((e) => sendResponse({ ok: false, connected: false, error: e.message })); return true; }
  if (message?.type === "START_JOB" || message?.type === "RESUME_JOB") {
    (async () => {
      const jobId = message.payload?.jobId;
      if (!jobId) throw new Error("jobId is required.");
      const { rpcJobState: active } = await chrome.storage.local.get("rpcJobState");
      if (active?.jobId && active.jobId !== jobId) throw new Error(`Job ${active.jobId} is already active.`);
      const status = await rpcStatus();
      if (!status.connected) throw new Error(status.error || "Delhivery RPC login required.");
      const { job, batches } = await getJob(jobId);
      if (message.type === "START_JOB") {
        if (job.status !== "queued") throw new Error(`Job status is ${job.status}; only queued jobs can be started.`);
        await setState({ jobId, phase: "parallel", retryCount: 0 });
      } else {
        // Resume every unresolved batch independently. If a remark already
        // exists, reconcile it first; otherwise it is safe to submit as queued.
        for (const batch of batches) {
          if (batch.status === "needs_attention" || batch.status === "failed") {
            await patchBatch(jobId, batch.batchNumber, {
              status: batch.csvAppend?.hash ? "completed" : (batch.rpcRemarks ? "submitting" : "queued"),
              reconcileAttempts: 0, error: null
            });
          }
        }
        await setState({ jobId, phase: "parallel", retryCount: 0, resumedAt: new Date().toISOString() });
      }
      await patchJob(jobId, { status: "running", error: null });
      await scheduleNextStep(0.1);
      sendResponse({ ok: true, accepted: true });
      processJobStep();
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "DOWNLOAD_FINAL") {
    const url = message.url;
    if (typeof url !== "string" || !url.startsWith("http://localhost:4000/api/jobs/") && !url.startsWith("http://127.0.0.1:4000/api/jobs/")) {
      sendResponse({ ok: false, error: "Invalid final download URL." }); return false;
    }
    chrome.downloads.download({ url, filename: message.filename || "bulk-wbn-report.csv", saveAs: true })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
