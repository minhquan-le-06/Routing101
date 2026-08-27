// frontend/js/signals/routing.js -- LLM-based Query Routing panel.
//
// Key design decision: unlike every other signal, run(resultsEl, statusEl)
// does NOT start a new search. app.js calls every signal's run() uniformly
// on Enter-in-the-query-box, on every sidebar filter change, and on tab
// switch -- cheap for a normal re-query, but each Routing "run" is an LLM
// call plus up to 100 index searches and creates a brand-new immutable
// job, so it must not fire on every filter tweak. Instead:
//   - run() is repurposed to mean "re-render the panel from current client
//     state" -- safe to call as often as app.js likes; it never hits the
//     network.
//   - Starting a job is a separate, explicit "Route this query" button
//     wired directly to startJob(), bypassing run()/app.js entirely.
//   - Polling is started once at module load (not inside mount()/run()),
//     so it keeps updating routingState.jobs for jobs from any tab
//     regardless of which signal is currently mounted -- "keeps running in
//     the background regardless of what tab/query the operator switches
//     to." DOM writes are skipped while Routing isn't the active signal.

import { startRoutingJob, getRoutingJob, listRoutingJobs } from "../api.js";
import { renderGrid } from "../render.js";
import { currentQuery } from "../query-input.js";
import { routingState, resetExportCandidates, scopeFilters } from "../state.js";

const POLL_INTERVAL_MS = 1500;
let mounted = false;         // true only while Routing is the active signal
let controlsElRef, resultsElRef, statusElRef;

function activeCount() {
    return [...routingState.jobs.values()].filter((j) => j.status === "running").length;
}

function groupMode() {
    return document.getElementById("group-by-video").checked ? "video" : null;
}

// --- job list + details rendering (controlsEl) ------------------------

function renderControls() {
    if (!controlsElRef) return;
    const jobs = [...routingState.jobs.values()].sort((a, b) => b.created_at - a.created_at);
    const disabled = activeCount() >= 10 ? "disabled" : "";

    controlsElRef.innerHTML = `
      <button class="btn" id="routing-start-btn" ${disabled}>▶ Route this query</button>
      <div class="thumb-caption muted" id="routing-cap">${activeCount()}/10 jobs running</div>
      <div id="routing-job-list" style="margin-top:0.6rem;"></div>`;

    controlsElRef.querySelector("#routing-start-btn").onclick = startJob;

    const listEl = controlsElRef.querySelector("#routing-job-list");
    for (const job of jobs) {
        const row = document.createElement("div");
        row.className = "thumb-caption" + (job.job_id === routingState.selectedJobId ? "" : " muted");
        row.style.cursor = "pointer";
        const badge = { running: "⏳", done: "✅", error: "⚠️" }[job.status] || "?";
        row.textContent = `${badge} ${job.query.slice(0, 32)}${job.query.length > 32 ? "…" : ""}`;
        row.onclick = () => selectJob(job.job_id);
        listEl.append(row);
    }

    renderDetails(jobs.find((j) => j.job_id === routingState.selectedJobId));
}

function renderDetails(job) {
    let detailsEl = controlsElRef.querySelector("#routing-details");
    if (!detailsEl) {
        detailsEl = document.createElement("div");
        detailsEl.id = "routing-details";
        detailsEl.style.marginTop = "0.6rem";
        controlsElRef.append(detailsEl);
    }
    if (!job || !job.step1) { detailsEl.innerHTML = ""; return; }
    const { keywords, paraphrasings, modalities } = job.step1;
    detailsEl.innerHTML = `
      <div class="thumb-caption muted">Step 1 -- extracted (reviewed after the fact)</div>
      <div class="thumb-caption"><b>Modalities:</b> ${modalities.join(", ")}</div>
      ${keywords.map((kw) => `<div class="thumb-caption"><b>${kw}</b>: ${paraphrasings[kw].join(" · ")}</div>`).join("")}
      ${job.n_runs != null ? `<div class="thumb-caption muted">${job.n_runs} searches run</div>` : ""}`;
}

// --- results rendering (resultsEl / statusEl) --------------------------

function renderResults(job) {
    if (!resultsElRef) return;
    if (!job) {
        resultsElRef.innerHTML = `<div class="status-banner info">Type a query and click "Route this query" to start.</div>`;
        statusElRef.innerHTML = "";
        return;
    }
    if (job.status === "running") {
        resultsElRef.innerHTML = `<div class="status-banner info">Running… (job ${job.job_id.slice(0, 8)})</div>`;
        statusElRef.innerHTML = "";
        return;
    }
    if (job.status === "error") {
        resultsElRef.innerHTML = `<div class="status-banner error">${job.error}</div>`;
        statusElRef.innerHTML = "";
        return;
    }
    if (job.results === undefined) {
        // GET /api/routing/jobs (used to rehydrate the job list on load)
        // returns only {job_id, status, query, created_at} -- the full
        // record (results/step1/run_summary/...) is fetched lazily by
        // selectJob() below only once a job is actually opened. `undefined`
        // here means "not fetched yet" (distinct from a genuinely empty
        // `[]` result set once it has been).
        resultsElRef.innerHTML = `<div class="status-banner info">Loading job details…</div>`;
        statusElRef.innerHTML = "";
        return;
    }
    resetExportCandidates(job.results);
    renderGrid(resultsElRef, job.results, groupMode());
    statusElRef.innerHTML = (job.warnings || []).map(
        (w) => `<div class="status-banner warn">${w}</div>`
    ).join("");
}

function renderAll() {
    renderControls();
    renderResults(routingState.jobs.get(routingState.selectedJobId));
}

// Selecting a job from the history list: the entry there may only be the
// summary shape from GET /api/routing/jobs (no results/step1/run_summary),
// so fetch the full record on demand before rendering it in full -- render
// immediately first so the selection highlight/badge responds right away,
// then again once the full record lands (a no-op if it was already full).
async function selectJob(jobId) {
    routingState.selectedJobId = jobId;
    renderAll();
    const job = routingState.jobs.get(jobId);
    if (job && job.status !== "running" && job.results === undefined) {
        try {
            const full = await getRoutingJob(jobId);
            routingState.jobs.set(jobId, full);
        } catch (e) { /* expired/gone server-side -- render what we have */ }
        renderAll();
    }
}

// --- job lifecycle -------------------------------------------------------

async function startJob() {
    const { query } = currentQuery();
    if (!query.trim()) return;
    if (activeCount() >= 10) return; // button is disabled in this case, but guard anyway
    let job;
    try {
        job = await startRoutingJob({
            query: query.trim(), ...scopeFilters(),
            top_k: parseInt(document.getElementById("top-k").value, 10) || 50,
        });
    } catch (e) {
        statusElRef.innerHTML = `<div class="status-banner error">${e.message}</div>`;
        return;
    }
    routingState.jobs.set(job.job_id, job);
    routingState.selectedJobId = job.job_id;
    renderAll();
}

async function pollOnce() {
    const running = [...routingState.jobs.values()].filter((j) => j.status === "running");
    for (const job of running) {
        try {
            const updated = await getRoutingJob(job.job_id);
            routingState.jobs.set(job.job_id, updated);
        } catch (e) { /* job may have expired server-side -- leave stale entry, harmless */ }
    }
    if (mounted && running.length) renderAll();
}

// Started once at module import time (app.js statically imports every
// signal module up front) -- keeps polling for ALL jobs regardless of
// which signal tab is currently active.
setInterval(pollOnce, POLL_INTERVAL_MS);

// Rehydrate from the server on page load, so a refresh recovers
// still-live/recently-finished jobs instead of starting from an empty list.
listRoutingJobs().then(({ jobs }) => {
    for (const j of jobs) if (!routingState.jobs.has(j.job_id)) routingState.jobs.set(j.job_id, j);
    if (mounted) renderAll();
}).catch(() => {});

// --- signal module contract ---------------------------------------------

export function mount(controlsEl) {
    mounted = true;
    controlsElRef = controlsEl;
    renderControls();
}

export function unmount() {
    mounted = false;
}

// Called by app.js on Enter-in-query-box, tab-switch, and every sidebar
// filter change -- deliberately a no-op re-render, NOT a new job (see the
// module-level comment above).
export function run(resultsEl, statusEl) {
    resultsElRef = resultsEl;
    statusElRef = statusEl;
    renderAll();
}
