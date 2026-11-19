import { useEffect, useMemo, useState } from "react";
import {
  Layers, FileText, CheckCircle2, Activity, Play, RotateCcw, Trash2,
  Link2, Download, Info, AlertTriangle, X, Puzzle, MonitorDown, PlugZap,
  ShieldCheck
} from "lucide-react";

const API = import.meta.env.VITE_LOCAL_API_URL ||
  ((location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? "/api" : "http://127.0.0.1:4000/api");
const TOKEN_KEY = "bulkWbnLocalBackendToken";
const DOWNLOADS = {
  extension: "/downloads/bulk-wbn-rpc-extension.zip",
  backend: "/downloads/bulk-wbn-local-processor.zip"
};
function bridge(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); window.removeEventListener("message", handler); fn(value);
    };
    const handler = (event) => {
      if (event.source !== window || event.origin !== location.origin ||
          event.data?.source !== "BULK_WBN_EXTENSION" || event.data.requestId !== requestId) return;
      finish(resolve, event.data.response);
    };
    const timer = setTimeout(() => finish(reject, new Error("Extension did not respond. Reload the extension and try again.")), 6000);
    window.addEventListener("message", handler);
    window.postMessage({ source: "BULK_WBN_DASHBOARD", requestId, type, payload }, location.origin);
  });
}
async function apiJson(url, options = {}, useAuth = true) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { ...(options.headers || {}) };
  if (useAuth && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url.startsWith("http") ? url : `${API}${url}`, {
    cache: "no-store", ...options, headers
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `API request failed (${response.status})`);
  return data;
}
export default function App() {
  const [remarks, setRemarks] = useState("bulk_report");
  const [option, setOption] = useState("Default");
  const [raw, setRaw] = useState("");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [rpc, setRpc] = useState("Checking…");
  const [rpcConnected, setRpcConnected] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [connecting, setConnecting] = useState(false);

  const inputWbns = useMemo(() => raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean), [raw]);
  const uniqueWbns = useMemo(() => [...new Set(inputWbns)], [inputWbns]);
  const batchCount = Math.ceil(uniqueWbns.length / 15000);
  const lastBatch = uniqueWbns.length % 15000 || (uniqueWbns.length ? 15000 : 0);
  const duplicateCount = inputWbns.length - uniqueWbns.length;

  async function refresh() {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    try {
      const data = await apiJson("/jobs");
      const details = await Promise.all((data.jobs || []).map(async (job) => {
        try {
          const full = await apiJson(`/jobs/${job.id}`);
          return { ...job, batches: full.batches || [] };
        } catch { return { ...job, batches: [] }; }
      }));
      setJobs(details);
      setLastRefresh(new Date());
      setBackendConnected(true);
    } catch (e) {
      setBackendConnected(false);
      setMessage(`Backend connection needs attention: ${e.message}`);
    }
  }
  async function checkBackend() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { setBackendConnected(false); return null; }
    try {
      const health = await apiJson("/health", {}, false);
      await apiJson("/jobs");
      setBackendConnected(true);
      try { await bridge("SET_BACKEND_TOKEN", { token }); } catch { /* Extension may be installed after the first connection. */ }
      return health;
    } catch {
      setBackendConnected(false);
      return null;
    }
  }
  async function connectBackend() {
    if (!pairingCode.trim()) { setMessage("Enter the pairing code shown by Local Processor."); return; }
    setConnecting(true); setMessage("");
    try {
      // This click-triggered request also allows Chrome to show its Local Network Access permission prompt.
      await apiJson("/health", {}, false);
      const paired = await apiJson("/pair", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode: pairingCode.trim() })
      }, false);
      if (!paired.accessToken) throw new Error("Local Processor did not return an access token.");
      localStorage.setItem(TOKEN_KEY, paired.accessToken);
      setBackendConnected(true);
      try {
        const extension = await bridge("SET_BACKEND_TOKEN", { token: paired.accessToken });
        if (!extension?.ok) setMessage("Backend connected. Install/reload the Chrome Extension to enable RPC automation.");
        else setMessage("Backend securely connected. Check RPC login to continue.");
      } catch {
        setMessage("Backend connected. Install/reload the Chrome Extension, then refresh this dashboard.");
      }
      setPairingCode(""); setShowConnect(false);
      await refresh();
    } catch (e) {
      setBackendConnected(false);
      setMessage(`Could not connect Local Processor: ${e.message}. Confirm it is running and use the pairing code from its local pairing-code.txt file.`);
    } finally { setConnecting(false); }
  }
  async function disconnectBackend() {
    localStorage.removeItem(TOKEN_KEY);
    setBackendConnected(false); setJobs([]);
    try { await bridge("CLEAR_BACKEND_TOKEN"); } catch { /* extension may be absent */ }
    setMessage("Local Backend disconnected from this browser.");
  }
  async function checkRpc() {
    try {
      const result = await bridge("RPC_STATUS");
      setRpcConnected(Boolean(result?.connected));
      setRpc(result?.connected ? "Delhivery RPC Connected" : result?.error || "Not Connected");
    } catch (e) { setRpcConnected(false); setRpc("Extension not connected"); }
  }
  async function downloadJob(job) {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const response = await fetch(`${API}/jobs/${job.id}/download`, {
        cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("Final CSV is empty.");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `bulk-wbn-${job.id}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      setMessage(`Downloaded bulk-wbn-${job.id}.csv`);
    } catch (e) { setMessage(e.message); }
  }
  async function startJob(job, resume = false) {
    try {
      const result = await bridge(resume ? "RESUME_JOB" : "START_JOB", { jobId: job.id });
      if (!result?.ok) throw new Error(result?.error || "Extension could not start this job.");
      setMessage(resume ? "Resume / reconciliation requested." : "Job accepted by RPC extension.");
      await refresh();
    } catch (e) { setMessage(e.message); }
  }
  useEffect(() => {
    checkBackend().then(() => { refresh(); checkRpc(); });
    const timer = setInterval(refresh, 2500);
    const rpcTimer = setInterval(checkRpc, 30000);
    const backendTimer = setInterval(checkBackend, 15000);
    return () => { clearInterval(timer); clearInterval(rpcTimer); clearInterval(backendTimer); };
  }, []);

  async function generate() {
    if (!backendConnected) { setShowConnect(true); setMessage("Connect Local Backend before creating a job."); return; }
    if (!rpcConnected) { setMessage("Connect Chrome Extension and sign in to Delhivery RPC first."); return; }
    if (!remarks.trim() || !uniqueWbns.length) { setMessage("Enter a file name and at least one WBN."); return; }
    if (uniqueWbns.length > 2500000) { setMessage("Maximum 2,500,000 unique WBNs allowed in this capacity profile."); return; }
    setLoading(true); setMessage("");
    try {
      const data = await apiJson("/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remarks, reportOption: option, wbns: inputWbns })
      });
      setRaw("");
      if (data.job.duplicateCount) setMessage(`${data.job.duplicateCount.toLocaleString("en-IN")} duplicate WBNs removed.`);
      await startJob(data.job, false);
    } catch (e) { setMessage(e.message); }
    finally { setLoading(false); }
  }
  async function clearAllData() {
    setClearing(true); setMessage("");
    try {
      const stop = await bridge("CLEAR_ALL_DATA");
      if (!stop?.ok) throw new Error(stop?.error || "Could not stop the RPC extension safely.");
      await apiJson("/data", { method: "DELETE" });
      setJobs([]); setRaw(""); setRemarks("bulk_report"); setOption("Default");
      setLastRefresh(new Date()); setConfirmClear(false);
      setMessage("All backend data, batch records, generated CSV files and dashboard history have been deleted. Dashboard is fresh.");
    } catch (e) { setMessage(`Clear All Data failed: ${e.message}`); await refresh(); }
    finally { setClearing(false); }
  }

  const total = jobs.reduce((n, j) => n + (j.totalWbns || 0), 0);
  const totalB = jobs.reduce((n, j) => n + (j.totalBatches || 0), 0);
  const done = jobs.reduce((n, j) => n + (j.completedBatches || 0), 0);
  const active = jobs.filter((j) => ["running", "waiting"].includes(j.status)).length;
  const latestCompleted = jobs.find((j) => j.status === "completed" && j.downloadUrl);

  return <div className="app-shell">
    <header className="topbar">
      <div className="header-brand">
        <div className="delhivery-wordmark"><span>D</span>elhivery</div>
        <div className="brand-divider" />
        <div className="product-title"><h1>Bulk WBN Generator RPC</h1><p>Delhivery Bulk CSV Report Automation</p></div>
      </div>
      <div className="maker">/// <span>Made by <b>Tafajjul</b></span> ///</div>
      <div className="header-right">
        <div className={`connection-pill ${rpcConnected ? "is-connected" : ""}`}><i />{rpc}</div>
        <button className="downloads-trigger" onClick={() => setShowDownloads(true)}><Download size={16}/> Downloads</button>
      </div>
    </header>

    <main className="dashboard">
      <section className="system-connect-row">
        <div className={`system-status ${backendConnected ? "connected" : "disconnected"}`}><i/>Local Backend: {backendConnected ? "Connected" : "Not Connected"}</div>
        {backendConnected
          ? <button className="connect-action secondary" onClick={disconnectBackend}>Disconnect Backend</button>
          : <button className="connect-action" onClick={() => setShowConnect(true)}><PlugZap size={15}/> Connect Backend</button>}
      </section>
      <section className="stats-grid">
        <Stat label="Total WBNs" value={total.toLocaleString("en-IN")} icon={<Layers />} tone="blue" />
        <Stat label="Total Batches" value={totalB.toLocaleString("en-IN")} icon={<FileText />} tone="red" />
        <Stat label="Completed Batches" value={done.toLocaleString("en-IN")} icon={<CheckCircle2 />} tone="green" />
        <Stat label="Active Jobs" value={active.toLocaleString("en-IN")} icon={<Activity />} tone="slate" />
      </section>

      <section className="workspace-grid">
        <section className="panel generator-panel">
          <h2><FileText /> Generate Bulk Report</h2>
          <label>Remarks / File Name <em>*</em></label>
          <input className="field" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. daily_report_01" maxLength={80} />
          <label>Report Option <em>*</em></label>
          <select className="field" value={option} onChange={(e) => setOption(e.target.value)}><option value="Default">Default</option></select>
          <div className="label-line"><label>Waybill Numbers (WBN) <em>*</em></label><small>Paste one or more per line</small></div>
          <textarea className="field wbn-area" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste WBN numbers here..." />
          <div className="info-strip"><Info size={17} /> Maximum 15,000 WBN per RPC batch. Blank lines are ignored. Exact duplicate WBNs are removed (case-sensitive).</div>
          <div className="input-stats">
            <div><span>Unique WBNs</span><b>{uniqueWbns.length.toLocaleString("en-IN")}</b></div>
            <div><span>Required Batches</span><b>{batchCount.toLocaleString("en-IN")}</b></div>
            <div><span>Last Batch Size</span><b>{lastBatch.toLocaleString("en-IN")}</b></div>
          </div>
          {duplicateCount > 0 && <p className="message">{duplicateCount.toLocaleString("en-IN")} duplicate entries will be removed.</p>}
          <div className="action-row">
            <button className="btn btn-primary" onClick={generate} disabled={loading || !uniqueWbns.length || !backendConnected || !rpcConnected}><Play size={18} />{loading ? "Creating Job..." : "Generate Report"}</button>
            <button className="btn btn-neutral" onClick={() => { setRaw(""); setMessage(""); }}><RotateCcw size={18} /> Clear Input</button>
            <button className="btn btn-danger-outline" onClick={() => setConfirmClear(true)} disabled={clearing || !backendConnected}><Trash2 size={18} /> Clear All Data</button>
          </div>
          {message && <p className="message">{message}</p>}
        </section>

        <div className="right-column">
          <section className="panel rpc-panel">
            <h2><Link2 /> RPC Connection</h2>
            <Summary label="Connection Status" value={rpcConnected ? "Connected" : "Not Connected"} good={rpcConnected} />
            <Summary label="WBN per Batch" value="15,000" />
            <Summary label="Processing Mode" value="Parallel batches · auto-fetch" />
            <Summary label="Local Backend" value={backendConnected ? "Connected" : "Not Connected"} good={backendConnected} />
          </section>
          <section className="panel monitor-panel">
            <div className="monitor-heading"><h2><Layers /> Batch Monitor (Live)</h2><b>{done} / {totalB} Completed</b></div>
            {jobs.length === 0 ? <div className="empty">{backendConnected ? "No batches to display." : "Connect Local Backend to view jobs."}</div> : jobs.slice(0, 4).map((job) => {
              const jobBatches = job.batches || [];
              return <div className="job-monitor" key={job.id}>
                <div className="job-monitor-title"><b>{job.remarks}</b><small>{job.totalWbns.toLocaleString("en-IN")} WBNs</small></div>
                {jobBatches.map((batch) => {
                  const completed = batch.status === "completed" && Boolean(batch.csvAppend?.hash);
                  const progress = completed ? 100 : ["downloading", "merged"].includes(batch.status) ? 85 : ["submitted", "pending", "in_progress", "submitting"].includes(batch.status) ? 35 : 0;
                  return <div className="batch-row" key={`${job.id}-${batch.batchNumber}`}>
                    <b>{batch.batchNumber}</b><span>{batch.wbnCount.toLocaleString("en-IN")}</span>
                    <div className="progress-cell"><div className="progress-track"><div className={`progress-fill ${completed ? "done" : ""}`} style={{ width: `${progress}%` }} /></div><small>{progress}%</small></div>
                    <span className={`batch-status ${completed ? "complete" : ""}`}>{completed ? "Completed" : batch.status.replaceAll("_", " ")}</span>
                  </div>;
                })}
                {job.status === "completed" && <button className="inline-download" onClick={() => downloadJob(job)}><Download size={14} /> Download Merged CSV</button>}
                {["queued", "error", "needs_attention", "waiting"].includes(job.status) && <button className="inline-download" onClick={() => startJob(job, true)}><RotateCcw size={14} /> Resume / Check</button>}
              </div>;
            })}
          </section>
        </div>
      </section>

      {latestCompleted && <section className="success-banner">
        <div className="success-icon"><CheckCircle2 /></div>
        <div className="success-copy"><b>Report Completed Successfully</b><span>All {latestCompleted.totalBatches} batches processed and merged. Final CSV is ready for download.</span></div>
        <button className="btn btn-primary" onClick={() => downloadJob(latestCompleted)}><Download size={19} /> Download Merged CSV ({latestCompleted.totalWbns.toLocaleString("en-IN")})</button>
      </section>}
      <footer>Bulk WBN Generator RPC <span>·</span> Made by Tafajjul</footer>
    </main>

    {showDownloads && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowDownloads(false); }}>
      <section className="confirm-modal downloads-modal" role="dialog" aria-modal="true" aria-labelledby="downloads-title">
        <button className="modal-close" onClick={() => setShowDownloads(false)} aria-label="Close"><X size={19} /></button>
        <div className="modal-icon downloads-icon"><Download /></div>
        <h2 id="downloads-title">Downloads & Setup</h2>
        <p>Install the local processor on this Windows PC and add the RPC extension to the Chrome profile used for Delhivery.</p>
        <a className="download-option" href={DOWNLOADS.backend} download><MonitorDown/><span><b>Windows Local Processor</b><small>Backend package + desktop shortcut installer</small></span><Download/></a>
        <a className="download-option" href={DOWNLOADS.extension} download><Puzzle/><span><b>Chrome Extension</b><small>RPC connector for the authenticated Chrome profile</small></span><Download/></a>
        <div className="download-help"><ShieldCheck size={16}/> Backend runs locally on this PC. Do not share its pairing code.</div>
      </section>
    </div>}

    {showConnect && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowConnect(false); }}>
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
        <button className="modal-close" onClick={() => setShowConnect(false)} aria-label="Close"><X size={19} /></button>
        <div className="modal-icon downloads-icon"><PlugZap /></div>
        <h2 id="connect-title">Connect Local Backend</h2>
        <p>Start Local Processor using its Windows desktop shortcut. Open the local <b>pairing-code.txt</b> file and enter the pairing code below.</p>
        <label className="pairing-label" htmlFor="pairing-code">Local pairing code</label>
        <input id="pairing-code" className="field pairing-field" value={pairingCode} onChange={(e) => setPairingCode(e.target.value)} autoComplete="one-time-code" placeholder="Paste pairing code" />
        <div className="modal-actions">
          <button className="btn btn-neutral" onClick={() => setShowConnect(false)} disabled={connecting}>Cancel</button>
          <button className="btn btn-primary" onClick={connectBackend} disabled={connecting || !pairingCode.trim()}><PlugZap size={16}/>{connecting ? "Connecting..." : "Connect Backend"}</button>
        </div>
        <p className="small-security-note"><ShieldCheck size={14}/> Connection uses a local pairing secret and browser access permission.</p>
      </section>
    </div>}

    {confirmClear && <div className="modal-backdrop" role="presentation">
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="clear-title">
        <div className="modal-icon"><AlertTriangle /></div>
        <button className="modal-close" onClick={() => setConfirmClear(false)} aria-label="Close"><X size={19} /></button>
        <h2 id="clear-title">Clear All Data?</h2>
        <p>This will permanently delete all job history, batch records, generated CSV files, and saved data from the local backend. The dashboard will be reset to a fresh state.</p>
        <p className="modal-warning">This action cannot be undone.</p>
        <div className="modal-actions">
          <button className="btn btn-neutral" onClick={() => setConfirmClear(false)} disabled={clearing}>Cancel</button>
          <button className="btn btn-danger" onClick={clearAllData} disabled={clearing}><Trash2 size={17} />{clearing ? "Deleting..." : "Yes, Clear All Data"}</button>
        </div>
      </section>
    </div>}
  </div>;
}
function Stat({ label, value, icon, tone }) { return <div className={`stat-card ${tone}`}><div className="stat-icon">{icon}</div><div><span>{label}</span><b>{value}</b></div></div>; }
function Summary({ label, value, good }) { return <div className="summary-line"><span>{label}</span><b className={good ? "good-text" : ""}>{value}</b></div>; }
