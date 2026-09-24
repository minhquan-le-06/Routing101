// frontend/js/export/ui.js -- the actual Export CSV UI: query-type
// segmented control, confirmed/unconfirmed answer curation, Neighbours/
// Similars preview grids (KIS/VQA only), TRAKE's per-video event curation.
// Mounted by export/page.js into the standalone Export CSV tab (frontend/export.html)
// -- this module knows nothing about being in a separate tab: the host
// supplies a plain container element, a `getCandidates` accessor (so
// "Similars" can read a *different* tab's live search results without this
// module importing that tab's state.js), and an `onDone()` callback for
// "the user cancelled" (a completed export leaves the form in place instead
// -- see #exp-export's handler -- so onDone is never called for that case).
//
// Two bodies depending on query type:
//   KIS/VQA -- one frame's worth of query-answer curation (confirmed/
//     unconfirmed) plus a two-section preview (nearest-by-time
//     "Neighbours", already-ranked "Similars"). POSTs to /api/export and
//     triggers the CSV download directly.
//   TRAKE -- no confirmed/unconfirmed distinction at all any more. A
//     curate -> cache -> merge flow instead:
//       1. Curate one video at a time: an inline <video> preview (loaded
//          by typing a video id, or seeded from `trigger`) plus an "Add"
//          button that captures whatever frame is currently playing into
//          an ordered event list (drag to reorder, ✕ to remove). No
//          Neighbours/Similars preview for TRAKE -- the Frame ID box is
//          the only other way to add an event, besides the video itself.
//       2. "Generate rows" POSTs that video's {video_id, frame_idxs} to
//          /api/export/trake-rows and caches the <=99 returned candidate
//          sequences client-side, keyed by video_id (`s.trake.cache`
//          below) -- repeatable for as many candidate videos as the human
//          wants to compare, each just adding another entry.
//       3. Export: the human checks which cached videos to include and
//          their priority order; the rows are interleaved client-side (no
//          backend round-trip, no re-reading anything) into one <=99-row
//          set and POSTed to /api/export/trake-write, which only formats
//          + returns CSV text for already-resolved rows -- the one file
//          this whole flow ever writes to disk.
//     All of one video's events still share that one video_id (the AIC
//     TRAKE row format is one video per row) -- switching the curation
//     panel to a different video starts a fresh event list, independent
//     per-video cache entries are what let several candidate videos
//     coexist for the merge step.
//
// `trigger` shapes:
//   {kind: "flat", video_id, n}         -- any non-TRAKE signal's result card
//   {kind: "trake", candidate}          -- a TRAKE candidate card
//   {kind: "frame", video_id, frame_idx, current_time?, thumbnail?} -- a raw
//     native frame from a video playback dialog, no keyframe n at all
//     (TRAKE-only: KIS/VQA need an n for the backend's flat CSV path, which
//     this trigger doesn't have). current_time/thumbnail are optional --
//     dialogs/playback.js's "Export this frame" buttons send both (the playback
//     dialog's own currentTime + a canvas snapshot) so the curation video
//     below resumes from the same spot and the seeded event gets a real
//     preview; a trigger without them still works, just starts the
//     curation video at 0:00 with no event thumbnail, as before.
//
// Split by feature: this file is the shell (DOM skeleton, query-type
// switch, status banner, topbar row, Export button, trigger seeding);
// answers.js (KIS/VQA), curation.js (shared video panel) and trake.js
// (TRAKE cache/merge) each export a create*(ctx) factory over one shared
// context object, built in dependency order below; state.js holds the
// state shape and pure helpers.

import { exportCsv, getExportFrame, getExportNearestKeyframe, writeTrakeCsv } from "../api.js";
import { createAnswers } from "./answers.js";
import { createCuration } from "./curation.js";
import { freshState, previewPage } from "./state.js";
import { createTrake } from "./trake.js";

const NEIGHBOUR_COUNT_EXPORT = 10; // fixed row-generation window, independent of preview expand state

// The Video ID/Frame ID typing boxes: `L21_V001`-shaped video id,
// plain-integer frame number (the leading zeros in the "001" placeholder
// are just display convention -- parseInt handles them fine either way).
// The same parser serves both meanings the Frame ID box can have: a
// keyframe n (KIS/VQA, resolved server-side via /api/export/frame) or a
// raw native frame_idx (TRAKE, used directly, no resolution needed) --
// both are just positive integers as typed. Return null on a malformed
// box so the caller can show one "correct format" error rather than
// letting a bad value reach the backend as a confusing 404/422.
function parseVideoIdInput(str) {
    const s = (str || "").trim();
    return /^L\d+_V\d+$/i.test(s) ? s.toUpperCase() : null;
}
function parseFrameIdInput(str) {
    const s = (str || "").trim();
    if (!/^\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    return n > 0 ? n : null;
}

// AIC submission naming: query-p3-<#>-<type>.csv, matching the real
// submission/*.csv samples in the repo -- note VQA's type slug is "qa",
// not "vqa".
const TYPE_SLUG = { KIS: "kis", VQA: "qa", TRAKE: "trake" };
function queryFilename(queryType, name) {
    return `query-p3-${name}-${TYPE_SLUG[queryType]}`;
}

export function buildExportUI(container, trigger, { getCandidates, onDone }) {
    const s = freshState(trigger);

    const box = document.createElement("div");
    box.className = "export-dialog";
    box.innerHTML = `
        <h2>Export CSV</h2>
        <div class="status-banner" id="exp-status" style="display:none;"></div>
        <div class="export-topbar" id="exp-topbar">
          <div class="segmented" id="exp-segmented">
            <button type="button" data-type="KIS">KIS</button>
            <button type="button" data-type="VQA">VQA</button>
            <button type="button" data-type="TRAKE">TRAKE</button>
          </div>
          <input type="number" id="exp-name" min="1" step="1" placeholder="QUERY NUMBER - REQUIRED">
          <div class="export-change-fields" id="exp-change-fields">
            <input type="text" id="exp-change-video" placeholder="Vid ID">
            <input type="text" id="exp-change-frame" placeholder="Frame ID">
            <button class="btn" id="exp-change-btn" type="button">Change</button>
          </div>
          <div class="export-actions">
            <button class="btn" id="exp-cancel">Cancel</button>
            <button class="btn btn-primary" id="exp-export">⬇ Export</button>
          </div>
        </div>
        <div class="checkbox-row" id="exp-confirmed-row">
          <input type="checkbox" id="exp-confirmed" checked>
          <label for="exp-confirmed" style="margin:0;">Confirmed</label>
          <input type="checkbox" id="exp-keyframes" style="margin:0 0 0 1rem;">
          <label for="exp-keyframes" style="margin:0;">Keyframes</label>
        </div>
        <div id="exp-flat-body">
          <div class="export-answer-area" id="exp-answer-area">
            <div id="exp-answer-content"></div>
            <input type="text" id="exp-answer-text" placeholder="VQA answer" style="display:none;">
          </div>
          <div id="exp-native-content" style="display:none;"></div>
        </div>
        <div id="exp-trake-body" style="display:none;">
          <div id="exp-trake-content"></div>
        </div>
        <div class="export-preview-area" id="exp-preview-area">
          <div class="export-preview-section">
            <div class="export-preview-header"><b>Neighbours</b> <span class="thumb-caption muted">(nearest keyframes by time)</span></div>
            <div class="grid export-preview-grid" id="exp-nbr-grid"></div>
            <button class="btn" id="exp-nbr-more">Show ${previewPage()} more</button>
          </div>
          <div class="export-preview-section">
            <div class="export-preview-header"><b>Similars</b> <span class="thumb-caption muted" id="exp-sim-caption">(this query's ranked results)</span></div>
            <div class="grid export-preview-grid" id="exp-sim-grid"></div>
            <button class="btn" id="exp-sim-more">Show ${previewPage()} more</button>
          </div>
        </div>`;
    container.innerHTML = "";
    container.append(box);

    const el = (sel) => box.querySelector(sel);

    // Status banner doubles as the validation-error banner (used throughout
    // below) and the post-export confirmation (item: "leave it there with a
    // message, user can reexport if they want" -- see #exp-export's handler,
    // which shows success here rather than tearing the form down).
    function showStatus(message, kind = "error") {
        const banner = el("#exp-status");
        banner.className = `status-banner ${kind}`;
        banner.textContent = message;
        banner.style.display = "block";
    }
    function clearStatus() {
        el("#exp-status").style.display = "none";
    }

    function renderTypeVisibility() {
        el("#exp-segmented").querySelectorAll("button").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.type === s.queryType);
        });
        const isTrake = s.queryType === "TRAKE";
        // KIS/VQA with "Keyframes" unchecked: curated via a video-playback
        // panel (like TRAKE's) instead of the keyframe grids, in native
        // frame_idx space -- see the "KIS/VQA native curation" section.
        const nativeMode = !isTrake && !s.keyframes;
        const isVqa = s.queryType === "VQA";
        el("#exp-trake-body").style.display = isTrake ? "block" : "none";
        el("#exp-flat-body").style.display = isTrake ? "none" : "block";
        // No confirmed/unconfirmed distinction for TRAKE any more (see
        // module docstring) -- the row (Confirmed + Keyframes) only means
        // something for KIS/VQA.
        el("#exp-confirmed-row").style.display = isTrake ? "none" : "flex";
        // #exp-answer-text gets relocated out of #exp-answer-area below
        // (native+VQA only, into #exp-change-fields) -- hiding the whole
        // area here doesn't take it down too, since a moved DOM node is
        // no longer a descendant of its old (now-hidden) parent.
        el("#exp-answer-area").style.display = nativeMode ? "none" : "block";
        el("#exp-native-content").style.display = nativeMode ? "block" : "none";
        // No Neighbours/Similars preview for TRAKE, or for native KIS/VQA
        // (Keyframes unchecked) -- per spec, neither has a keyframe-space
        // "similar" pool to browse (row generation computes the
        // equivalent server-side, snapped to the nearest keyframe for
        // native mode -- see backend/export.py's
        // similar_candidates_for_native_frame). renderPreview() itself
        // skips fetching for both cases too, not just this toggle.
        el("#exp-preview-area").style.display = (isTrake || nativeMode) ? "none" : "flex";

        // Video ID/Frame ID/Change-or-Add-event: TRAKE still repurposes
        // this row (a raw frame_idx event, added to whatever video the
        // TRAKE panel below is curating) and keyframe-mode KIS/VQA keeps
        // its original "Change" lookup -- native (Keyframes-unchecked)
        // KIS/VQA drops the Video ID/Frame ID/button trio entirely
        // instead (item 1.1, both KIS and VQA): the only way to add a
        // frame there is the curation panel's own video. VQA reuses that
        // vacated topbar slot for the answer text box (item 2, "export
        // this qa answer same as checked keyframes mode" -- same
        // s.answerText field either way, just needs somewhere visible to
        // type into once #exp-answer-area itself is out of the picture);
        // KIS leaves the whole row empty/hidden.
        const changeFields = el("#exp-change-fields");
        const changeVideo = el("#exp-change-video");
        const changeFrame = el("#exp-change-frame");
        const changeBtn = el("#exp-change-btn");
        const answerText = el("#exp-answer-text");
        if (nativeMode) {
            changeVideo.style.display = "none";
            changeFrame.style.display = "none";
            changeBtn.style.display = "none";
            changeFields.style.display = isVqa ? "flex" : "none";
            if (isVqa) changeFields.append(answerText); // .export-change-fields input styles it to fill the row
        } else {
            changeVideo.style.display = "block";
            changeFrame.style.display = "block";
            changeBtn.style.display = "block";
            changeFields.style.display = "flex";
            el("#exp-answer-area").append(answerText); // back to its normal spot, after #exp-answer-content
            changeFrame.placeholder = isTrake ? "Frame ID (real frame)" : "Frame ID";
            changeBtn.textContent = isTrake ? "Add event" : "Change";
            changeVideo.readOnly = isTrake;
            changeVideo.value = isTrake ? (s.trake.videoId || "") : "";
            changeVideo.title = isTrake ? "Switch curation video from the panel below" : "";
        }

        // Same typing box either way -- unconfirmed mode used to disable
        // this with an "LLM needed" placeholder (answering unconfirmed
        // VQA queries was meant to be automated later), but that's no
        // longer the plan: a human types the answer regardless of mode.
        answerText.style.display = isVqa ? "block" : "none";
        answerText.disabled = false;
        answerText.placeholder = "VQA answer";
    }

    // Shared context for the feature modules, each factory adding its own
    // functions -- order matters: curation first (trake.js and answers.js
    // use its panel), then the two users of it.
    const ctx = { s, box, el, getCandidates, showStatus, clearStatus, renderTypeVisibility };
    Object.assign(ctx, createCuration(ctx));
    Object.assign(ctx, createTrake(ctx));
    Object.assign(ctx, createAnswers(ctx));
    const {
        loadCurationVideo, addEventToCuration, addEventFromN,
        generateRowsForCurationVideo, mergeTrakeCache, renderTrakeContent,
        renderAnswerContent, renderPreview, applyChangedFrame, renderNativeContent,
    } = ctx;

    // --- wiring ---------------------------------------------------------

    el("#exp-segmented").querySelectorAll("button").forEach((btn) => {
        btn.onclick = () => {
            // Snapshot before s.queryType flips -- whichever KIS/VQA frame
            // was in play (confirmed mode's single answerFrame, or
            // unconfirmed's first pick) is "the chosen keyframe" a switch
            // into TRAKE should match playback to, so the curation video
            // resumes at that exact keyframe's timestamp instead of 0:00.
            const enteringTrake = btn.dataset.type === "TRAKE" && s.queryType !== "TRAKE";
            const seedFrame = enteringTrake ? (s.answerFrame || s.answers[0] || null) : null;
            // Reverse handoff: leaving TRAKE into a Keyframes-unchecked
            // KIS/VQA whose native panel hasn't loaded a video yet (e.g.
            // seeded straight from a "frame" trigger -- item 7, both
            // panels get seeded with the same raw frame up front, see the
            // bottom of this function) -- match its playback to wherever
            // that seed left off, same idea as seedFrame above but the
            // other direction.
            const enteringNative = btn.dataset.type !== "TRAKE" && s.queryType === "TRAKE" && !s.keyframes
                && s.native.videoId && !s.native.videoEl;
            const nativeSeekFrame = enteringNative ? s.native.events[0] : null;
            s.queryType = btn.dataset.type;
            renderTypeVisibility();
            renderTrakeContent();
            renderNativeContent();
            renderAnswerContent();
            renderPreview(); // replaceable depends on queryType (TRAKE has no single answer frame)
            if (seedFrame) loadCurationVideo(seedFrame.video_id, "trake", { seekN: seedFrame.n });
            if (enteringNative) {
                loadCurationVideo(s.native.videoId, "native", nativeSeekFrame ? { seekFrameIdx: nativeSeekFrame.frame_idx } : {});
            }
        };
    });
    el("#exp-name").oninput = (e) => { s.name = e.target.value; };
    el("#exp-answer-text").oninput = (e) => { s.answerText = e.target.value; };
    el("#exp-confirmed").onchange = (e) => {
        s.confirmed = e.target.checked;
        // Native mode's list is shared storage between confirmed (exactly
        // one frame) and unconfirmed (several) -- collapse down to the
        // first entry on the way into confirmed, same idea as
        // applyChangedFrame's n-space equivalent below.
        if (s.confirmed && s.native.events.length > 1) s.native.events = [s.native.events[0]];
        renderTypeVisibility();
        renderAnswerContent();
        renderNativeContent();
        renderPreview();
        renderTrakeContent();
    };
    el("#exp-keyframes").checked = s.keyframes;
    el("#exp-keyframes").onchange = async (e) => {
        const next = e.target.checked;
        clearStatus();
        e.target.disabled = true;
        s.keyframes = next;
        renderTypeVisibility();
        renderNativeContent(); // ensures the native skeleton exists before loadCurationVideo below touches it
        renderAnswerContent();
        renderPreview();
        try {
            if (next && s.native.events.length) {
                // Re-checking: snap whatever native frame(s) are curated to
                // their nearest keyframe n -- best-effort per event, since a
                // raw playback frame rarely lands exactly on one.
                const resolved = await Promise.all(s.native.events.map((ev) =>
                    getExportNearestKeyframe(s.native.videoId, ev.frame_idx).catch(() => null)));
                const frames = resolved.filter(Boolean).map((r) => ({ video_id: s.native.videoId, n: r.n }));
                if (frames.length) {
                    s.answerFrame = frames[0];
                    s.answers = frames;
                    renderAnswerContent();
                    renderPreview();
                }
            } else if (!next && !s.native.events.length) {
                // Unchecking with nothing curated in the native panel yet:
                // seed it from whatever keyframe-space answer is already
                // set, so the two modes hand off smoothly instead of
                // starting from scratch. Skipped if the native panel
                // already has something (e.g. re-toggled back and forth)
                // -- never clobber curated work with a stale keyframe seed.
                const seeds = s.confirmed ? (s.answerFrame ? [s.answerFrame] : []) : s.answers;
                for (const f of seeds) {
                    try {
                        const info = await getExportFrame(f.video_id, f.n);
                        addEventToCuration("native", { video_id: f.video_id, frame_idx: info.frame_idx, thumbnail: info.thumbnail_url });
                    } catch (err) { /* unresolvable -- skip, not fatal */ }
                }
                if (seeds.length) await loadCurationVideo(seeds[0].video_id, "native", { seekN: seeds[0].n });
            }
        } finally {
            e.target.disabled = false;
        }
    };
    el("#exp-nbr-more").onclick = () => { s.neighboursShown += previewPage(); renderPreview(); };
    el("#exp-sim-more").onclick = () => { s.similarsShown += previewPage(); renderPreview(); };
    el("#exp-cancel").onclick = () => onDone("cancel");

    // Typed "Video ID" / "Frame ID" boxes + Change/Add event button --
    // KIS/VQA native mode (Keyframes unchecked) has no such row at all any
    // more (item 1.1: dropped entirely, VQA gets the answer box in its
    // place instead -- see renderTypeVisibility), so this only ever runs
    // for TRAKE or keyframe-mode KIS/VQA.
    // KIS/VQA keyframe mode: same destination as the preview-pick
    // (applyChangedFrame), but reaches an arbitrary frame not necessarily
    // in either preview list -- verifies the frame actually exists (via
    // /api/export/frame, n-based) before applying, so a typo lands as one
    // clear error rather than a broken export.
    // TRAKE: "Frame ID" is a raw native frame number, not a keyframe n,
    // added to whatever video the TRAKE curation panel below is already
    // on -- the (read-only) Video ID box is just a reminder of that, not
    // a second way to pick the video (see the panel's own Load/switch row
    // for that). No backend round-trip needed at all.
    el("#exp-change-btn").onclick = async () => {
        clearStatus();

        if (s.queryType === "TRAKE") {
            if (!s.trake.videoId) {
                showStatus("Load a video in the panel below first.");
                return;
            }
            const num = parseFrameIdInput(el("#exp-change-frame").value);
            if (!num) {
                showStatus("Enter a real frame number.");
                return;
            }
            if (addEventToCuration("trake", { video_id: s.trake.videoId, frame_idx: num })) {
                el("#exp-change-frame").value = "";
            }
            return;
        }

        const videoId = parseVideoIdInput(el("#exp-change-video").value);
        const num = parseFrameIdInput(el("#exp-change-frame").value);
        if (!videoId || !num) {
            showStatus("Enter a valid video id (e.g. L21_V001) and frame id (e.g. 001).");
            return;
        }

        const btn = el("#exp-change-btn");
        btn.disabled = true;
        try {
            await getExportFrame(videoId, num); // throws if that frame doesn't exist for that video
            applyChangedFrame({ video_id: videoId, n: num });
            el("#exp-change-video").value = "";
            el("#exp-change-frame").value = "";
        } catch (e) {
            showStatus(e.message);
        } finally {
            btn.disabled = false;
        }
    };

    el("#exp-export").onclick = async () => {
        clearStatus();

        if (!s.name) {
            showStatus("Enter a query number.");
            return;
        }

        if (s.queryType === "TRAKE") {
            const exportBtn = el("#exp-export");
            // Nothing generated at all yet (fresh cache): rather than make
            // the user click "Generate rows" first, generate the currently
            // curated video's rows on the fly -- only for this true "0
            // rows anywhere" case, not e.g. "generated but unchecked",
            // which stays today's explicit error below.
            if (!s.trake.cache.size) {
                if (!s.trake.videoId || !s.trake.events.length) {
                    showStatus("Nothing to export -- curate a video, click \"Generate rows\", then check it below.");
                    return;
                }
                exportBtn.disabled = true;
                try {
                    await generateRowsForCurationVideo();
                } finally {
                    exportBtn.disabled = false;
                }
                if (!s.trake.cache.size) return; // generation failed -- generateRowsForCurationVideo() already showed why
            }

            // Client-side merge of the per-video cache -- no candidates/
            // confirmed/answers body to build, unlike KIS/VQA below.
            const merged = mergeTrakeCache(99);
            if (!merged.length) {
                showStatus("Nothing to export -- curate a video, click \"Generate rows\", then check it below.");
                return;
            }
            const filename = queryFilename("TRAKE", s.name);
            exportBtn.disabled = true;
            try {
                await writeTrakeCsv(merged, filename);
                showStatus(`✓ Exported ${filename}.csv (${merged.length} rows) -- you can export again from here if needed.`, "info");
            } catch (e) {
                showStatus(e.message);
            } finally {
                exportBtn.disabled = false;
            }
            return;
        }

        // KIS/VQA, Keyframes unchecked: the answer is whatever's curated in
        // the native panel (native frame_idx space) rather than
        // s.answerFrame/s.answers -- candidates/neighbours-by-time still
        // get computed server-side (item 2: same backend logic, no
        // preview), just from generate_export()'s keyframes=false branch
        // instead. Confirmed mode's "similar" tier there is a fresh visual
        // search snapped to the curated frame's nearest keyframe
        // (similar_candidates_for_native_frame) -- computed on the
        // backend regardless of what `candidates` carries here, same as
        // keyframe-mode confirmed below.
        if (!s.keyframes) {
            if (!s.native.events.length) {
                showStatus(s.confirmed
                    ? "No chosen frame -- play the video and click \"Switch to this frame\"."
                    : "Add at least one answer frame from the video.");
                return;
            }
            const body = {
                query_type: s.queryType,
                mode: s.confirmed ? "confirmed" : "unconfirmed",
                keyframes: false,
                candidates: s.confirmed ? [] : getCandidates(),
                confirmed: s.confirmed ? { video_id: s.native.videoId, frame_idx: s.native.events[0].frame_idx } : null,
                answers: s.confirmed ? [] : s.native.events.map((e) => ({ video_id: s.native.videoId, frame_idx: e.frame_idx })),
                answer: s.answerText,
                neighbour_count: NEIGHBOUR_COUNT_EXPORT,
                filename: queryFilename(s.queryType, s.name),
            };
            const exportBtn = el("#exp-export");
            exportBtn.disabled = true;
            try {
                await exportCsv(body);
                showStatus(`✓ Exported ${body.filename}.csv -- you can export again from here if needed.`, "info");
            } catch (e) {
                showStatus(e.message);
            } finally {
                exportBtn.disabled = false;
            }
            return;
        }

        if (s.confirmed && !s.answerFrame) {
            showStatus("No confirmed frame -- open this from a result card.");
            return;
        }
        if (!s.confirmed && !s.answers.length) {
            showStatus("Add at least one answer frame from the preview.");
            return;
        }
        const body = {
            query_type: s.queryType,
            mode: s.confirmed ? "confirmed" : "unconfirmed",
            keyframes: true,
            candidates: getCandidates(),
            confirmed: s.confirmed ? s.answerFrame : null,
            answers: s.confirmed ? [] : s.answers,
            answer: s.answerText,
            neighbour_count: NEIGHBOUR_COUNT_EXPORT,
            filename: queryFilename(s.queryType, s.name),
        };

        const exportBtn = el("#exp-export");
        exportBtn.disabled = true;
        try {
            await exportCsv(body);
            // Left in place, not closed/torn down -- the form stays exactly
            // as it was, so the user can immediately re-export (a new query
            // #, a tweaked frame, ...) without reopening this tab.
            showStatus(`✓ Exported ${body.filename}.csv -- you can export again from here if needed.`, "info");
        } catch (e) {
            showStatus(e.message);
        } finally {
            exportBtn.disabled = false;
        }
    };

    // A "frame" trigger (from video playback) has no keyframe n at all --
    // all three query types are usable regardless (item 7): TRAKE and
    // native (Keyframes-unchecked) KIS/VQA work directly off the raw
    // frame_idx it carries; checking Keyframes back on for KIS/VQA snaps
    // to the nearest indexed keyframe (the #exp-keyframes handler above).

    renderTypeVisibility();
    renderAnswerContent();
    renderPreview();
    renderTrakeContent();
    renderNativeContent();

    // Seed the curation panel(s) straight from `trigger` when it carries a
    // video/frame of its own -- any signal's result card, a real TRAKE
    // candidate's own matched events, or a raw playback frame can all
    // start (or extend) a TRAKE sequence, not just a real TRAKE search
    // (see module docstring). Not limited to when queryType actually
    // starts on TRAKE -- switching to TRAKE later still finds the panel
    // already seeded, and likewise for KIS/VQA's native panel (a "frame"
    // trigger seeds both up front, below, since it has no way to know
    // which one the user will end up on).
    // loadCurationVideo is called right after kicking the event-seeding
    // off (not awaited first) so the video starts loading immediately
    // rather than waiting on the frame-info round trip(s) below; its own
    // videoId!==state.videoId check still resets state.events first, but
    // that's a no-op here since freshState() always starts empty.
    let seedVideoId = null;
    if (trigger.kind === "trake") {
        // Resolved in parallel but applied in original event order (matters
        // here, unlike a lone addEventFromN call elsewhere) -- several
        // concurrent fetches racing straight into addEventToCuration could
        // otherwise land E2 before E1 depending on which response arrives
        // first.
        seedVideoId = trigger.candidate.video_id;
        const matched = trigger.candidate.events.filter((e) => e.matched);
        Promise.all(matched.map((e) => getExportFrame(seedVideoId, e.n).catch(() => null))).then((infos) => {
            for (const info of infos) {
                if (info) addEventToCuration("trake", { video_id: seedVideoId, frame_idx: info.frame_idx, thumbnail: info.thumbnail_url });
            }
        });
    } else if (trigger.kind === "flat") {
        seedVideoId = trigger.video_id;
        addEventFromN("trake", trigger.video_id, trigger.n);
    } else if (trigger.kind === "frame") {
        seedVideoId = trigger.video_id;
        // thumbnail/current_time come from the playback dialog's own
        // canvas-snapshot + currentTime at the moment "Export this frame"
        // was clicked (dialogs/playback.js) -- gives this event a real preview
        // instead of "no preview", and lets the curation video below
        // resume from the same spot instead of restarting at 0:00. Seeds
        // both the TRAKE and native KIS/VQA panels with the same frame --
        // TRAKE starts active (queryType default above), but Keyframes
        // defaults unchecked for this trigger too (freshState), so
        // switching straight to KIS/VQA already has this frame ready.
        addEventToCuration("trake", { video_id: trigger.video_id, frame_idx: trigger.frame_idx, thumbnail: trigger.thumbnail ?? null });
        addEventToCuration("native", { video_id: trigger.video_id, frame_idx: trigger.frame_idx, thumbnail: trigger.thumbnail ?? null });
    }
    if (seedVideoId) {
        loadCurationVideo(seedVideoId, "trake",
            trigger.kind === "frame" ? { seekTime: trigger.current_time || 0 }
                : trigger.kind === "flat" ? { seekN: trigger.n }
                    : {});
    }
}
