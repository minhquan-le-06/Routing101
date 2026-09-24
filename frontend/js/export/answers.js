// frontend/js/export/answers.js -- KIS/VQA answer curation, two ways:
//   Keyframes checked -- answer cards in keyframe-n space (one confirmed
//     frame, or an ordered unconfirmed list) plus the Neighbours/Similars
//     preview grids to pick from.
//   Keyframes unchecked ("native") -- the shared curation panel
//     (curation.js) over a raw video, in frame_idx space.

import { getExportNeighbors, getExportSimilar } from "../api.js";
import { captureVideoThumbnail } from "../video-controls.js";
import { ensureFrameInfo, frameKey, previewPage } from "./state.js";

// `ctx`: buildExportUI()'s shared context plus curation.js's functions.
export function createAnswers(ctx) {
    const { s, el, box, getCandidates, showStatus, loadCurationVideo, addEventToCuration, renderCurationEventList } = ctx;

    function frameCardHtml(f, info, { removable = false, index = null } = {}) {
        const thumb = info && info !== "pending"
            ? `<img src="${info.thumbnail_url}" loading="lazy">`
            : `<div class="thumb-missing">…</div>`;
        const frameIdx = info && info !== "pending" ? info.frame_idx : "…";
        const removeBtn = removable ? `<button class="icon-btn export-remove-btn" title="Remove" data-index="${index}">✕</button>` : "";
        return `<div class="export-answer-card" ${removable ? `draggable="true" data-index="${index}"` : ""}>
            <div class="thumb-wrap thumb-wrap-static">${thumb}</div>
            <div class="thumb-caption"><b>${f.video_id}</b> · keyframe ${f.n}</div>
            <div class="thumb-caption muted">real frame ${frameIdx}</div>
            ${removeBtn}
        </div>`;
    }

    function renderAnswerContent() {
        const content = el("#exp-answer-content");
        // Native (Keyframes-unchecked) KIS/VQA uses the curation panel in
        // #exp-native-content instead (hidden along with this whole area,
        // see renderTypeVisibility) -- nothing to fetch/render here, and
        // skipping avoids a wasted ensureFrameInfo() round trip for a
        // stale s.answerFrame/s.answers left over from keyframe mode.
        if (!s.keyframes) {
            content.innerHTML = "";
            return;
        }
        if (s.confirmed) {
            if (!s.answerFrame) {
                content.innerHTML = `<div class="status-banner info">No frame selected -- open this from a result card's ★ button.</div>`;
                return;
            }
            const info = s.frameInfo.get(frameKey(s.answerFrame));
            content.innerHTML = `<div class="export-answer-list">${frameCardHtml(s.answerFrame, info)}</div>`;
            ensureFrameInfo(s, s.answerFrame, () => renderAnswerContent());
        } else {
            if (!s.answers.length) {
                content.innerHTML = `<div class="status-banner info">Add at least one frame from the preview below.</div>`;
            } else {
                content.innerHTML = `<div class="export-answer-list">${s.answers.map((f, i) => {
                    const info = s.frameInfo.get(frameKey(f));
                    return frameCardHtml(f, info, { removable: true, index: i });
                }).join("")}</div>`;
                s.answers.forEach((f) => ensureFrameInfo(s, f, () => renderAnswerContent()));
            }
            wireAnswerDnd();
        }
    }

    function wireAnswerDnd() {
        for (const card of el("#exp-answer-content").querySelectorAll(".export-answer-card")) {
            const i = Number(card.dataset.index);
            card.addEventListener("dragstart", () => { s.dragIndex = i; });
            card.addEventListener("dragover", (e) => e.preventDefault());
            card.addEventListener("drop", (e) => {
                e.preventDefault();
                if (s.dragIndex === null || s.dragIndex === i) return;
                const [moved] = s.answers.splice(s.dragIndex, 1);
                s.answers.splice(i, 0, moved);
                s.dragIndex = null;
                renderAnswerContent();
            });
            const removeBtn = card.querySelector(".export-remove-btn");
            if (removeBtn) removeBtn.onclick = () => {
                s.answers.splice(i, 1);
                renderAnswerContent();
            };
        }
    }

    function isInAnswers(f) {
        return s.answers.some((a) => a.video_id === f.video_id && a.n === f.n);
    }

    function addToAnswers(f) {
        if (isInAnswers(f)) return;
        s.answers.push({ video_id: f.video_id, n: f.n });
        // Mirror into the confirmed single-frame slot only while there's
        // still exactly one frame in the unconfirmed list -- once a second
        // is added, "the" answer frame is ambiguous, so stop syncing
        // rather than guess which one confirmed mode should show.
        if (s.answers.length === 1) s.answerFrame = s.answers[0];
        renderAnswerContent();
        renderPreview();
    }

    function previewCardHtml(f, { addable, replaceable }) {
        const already = addable && isInAnswers(f);
        const isCurrent = replaceable && s.answerFrame && s.answerFrame.video_id === f.video_id && s.answerFrame.n === f.n;
        const addBtn = addable
            ? `<button class="icon-btn export-add-btn${already ? " added" : ""}" title="${already ? "Already added" : "Add to answer(s)"}" data-video-id="${f.video_id}" data-n="${f.n}">${already ? "✓" : "+"}</button>`
            : "";
        // Confirmed mode: picking a preview frame replaces the single
        // answer frame instead of adding to a list. Reuses .export-add-btn's
        // CSS (same corner position, same .added accent) and is told apart
        // from the add button by data-replace, not class.
        const replaceBtn = replaceable
            ? `<button class="icon-btn export-add-btn${isCurrent ? " added" : ""}" title="${isCurrent ? "Current answer frame" : "Use as answer frame"}" data-video-id="${f.video_id}" data-n="${f.n}" data-replace="1"${isCurrent ? " disabled" : ""}>${isCurrent ? "✓" : "⇄"}</button>`
            : "";
        return `<div class="thumb-cell">
            <div class="thumb-wrap thumb-wrap-static"><img src="${f.thumbnail_url}" loading="lazy"></div>
            <div class="thumb-caption"><b>${f.video_id}</b> · frame ${f.n}</div>
            ${addBtn}${replaceBtn}
        </div>`;
    }

    // KIS/VQA only -- TRAKE has no Neighbours/Similars preview at all (see
    // renderTypeVisibility's #exp-preview-area toggle and module
    // docstring: a TRAKE pick's only "similar" pool is what row generation
    // already computes server-side, not something to browse here).
    async function renderPreview() {
        // No Neighbours/Similars preview for TRAKE, or for native
        // (Keyframes-unchecked) KIS/VQA -- see renderTypeVisibility's
        // #exp-preview-area toggle and module docstring.
        if (s.queryType === "TRAKE" || !s.keyframes) return;

        const addable = !s.confirmed;
        const replaceable = s.confirmed;

        // Re-labelled every render, not just at build time: the tile-size
        // setting these counts come from can change in the search tab while
        // this one is open (settings.js's storage listener), and the buttons'
        // own handlers already step by the current previewPage().
        el("#exp-nbr-more").textContent = `Show ${previewPage()} more`;
        el("#exp-sim-more").textContent = `Show ${previewPage()} more`;

        // Neighbours -- nearest keyframes by time to the trigger frame.
        const nbrGrid = el("#exp-nbr-grid");
        if (s.trigger.kind !== "flat") {
            nbrGrid.innerHTML = `<div class="status-banner info">No source frame to find neighbours of.</div>`;
        } else {
            if (!s.neighbourFrames || s.neighbourFrames.length < s.neighboursShown) {
                nbrGrid.innerHTML = `<div class="status-banner info">Loading…</div>`;
                try {
                    const data = await getExportNeighbors(s.trigger.video_id, s.trigger.n, s.neighboursShown);
                    s.neighbourFrames = data.frames;
                } catch (e) {
                    nbrGrid.innerHTML = `<div class="status-banner error">${e.message}</div>`;
                    return;
                }
            }
            const frames = s.neighbourFrames.slice(0, s.neighboursShown).map((f) => ({ ...f, video_id: s.trigger.video_id }));
            nbrGrid.innerHTML = frames.map((f) => previewCardHtml(f, { addable, replaceable })).join("") || `<div class="status-banner info">No neighbours found.</div>`;
            el("#exp-nbr-more").style.display = s.neighbourFrames.length >= s.neighboursShown ? "block" : "none";
        }

        // Similars. Confirmed mode: a fresh visual search seeded by the
        // confirmed frame itself (getExportSimilar, see backend/export.py's
        // similar_candidates_for_frame) -- "similar to the picked image",
        // not whatever the opener tab's last query happened to find.
        // Unconfirmed mode has no single confirmed frame to re-query from,
        // so it still shows the opener tab's own already-fetched, already-
        // ranked results (getCandidates()); those may be TRAKE-shaped
        // ({video_id, events}, no .n) if the opener tab's last search was a
        // real TRAKE search -- previewCardHtml needs a flat {video_id, n}
        // shape, so fall back to a plain message rather than rendering
        // broken cards.
        const simGrid = el("#exp-sim-grid");
        el("#exp-sim-caption").textContent = replaceable ? "(visual search from the confirmed frame)" : "(this query's ranked results)";
        if (replaceable) {
            if (!s.answerFrame) {
                simGrid.innerHTML = `<div class="status-banner info">No confirmed frame to search similar images from.</div>`;
                el("#exp-sim-more").style.display = "none";
            } else {
                const key = frameKey(s.answerFrame);
                if (s.similarFramesKey !== key || !s.similarFrames || s.similarFrames.length < s.similarsShown) {
                    simGrid.innerHTML = `<div class="status-banner info">Loading…</div>`;
                    try {
                        const data = await getExportSimilar(s.answerFrame.video_id, s.answerFrame.n, s.similarsShown);
                        s.similarFrames = data.results;
                        s.similarFramesKey = key;
                    } catch (e) {
                        simGrid.innerHTML = `<div class="status-banner error">${e.message}</div>`;
                        return;
                    }
                }
                const similars = s.similarFrames.slice(0, s.similarsShown);
                simGrid.innerHTML = similars.map((c) => previewCardHtml(c, { addable, replaceable }))
                    .join("") || `<div class="status-banner info">No similar frames found.</div>`;
                el("#exp-sim-more").style.display = s.similarFrames.length >= s.similarsShown ? "block" : "none";
            }
        } else {
            const candidates = getCandidates();
            if (candidates.length && !("n" in candidates[0])) {
                simGrid.innerHTML = `<div class="status-banner info">Last search wasn't a flat-result signal -- no Similars to preview.</div>`;
                el("#exp-sim-more").style.display = "none";
            } else {
                const similars = candidates.slice(0, s.similarsShown);
                simGrid.innerHTML = similars.map((c) => previewCardHtml(c, { addable, replaceable }))
                    .join("") || `<div class="status-banner info">No results from the last search.</div>`;
                el("#exp-sim-more").style.display = candidates.length > s.similarsShown ? "block" : "none";
            }
        }

        if (addable) {
            box.querySelectorAll(".export-add-btn:not([data-replace])").forEach((btn) => {
                btn.onclick = () => addToAnswers({ video_id: btn.dataset.videoId, n: Number(btn.dataset.n) });
            });
        }
        if (replaceable) {
            box.querySelectorAll(".export-add-btn[data-replace]").forEach((btn) => {
                btn.onclick = () => applyChangedFrame({ video_id: btn.dataset.videoId, n: Number(btn.dataset.n) });
            });
        }
    }

    // Item 4 (pick a preview frame to replace) and item 5 (type a video/
    // frame id and hit Change) both funnel through here: confirmed mode
    // replaces the single answer frame, unconfirmed mode adds to the answer
    // list (same as the preview's own "+" button).
    //
    // Confirmed's answerFrame and unconfirmed's answers list also get
    // synced here -- a confirmed-mode edit collapses the answers list down
    // to that one frame, since at that point there's exactly one frame in
    // play and both views should agree on it (otherwise toggling Confirmed
    // off would silently revert to whatever the tab was originally seeded
    // with instead of the just-changed frame).
    function applyChangedFrame(f) {
        if (s.confirmed) {
            if (s.answerFrame && frameKey(s.answerFrame) === frameKey(f)) return;
            s.answerFrame = f;
            s.answers = [f];
            renderAnswerContent();
            renderPreview();
        } else {
            addToAnswers(f);
        }
    }

    // --- KIS/VQA native (Keyframes-unchecked) curation: same video-
    // playback panel as TRAKE's, minus the Generate-rows/cache/merge step
    // -- the curated list (capped at one frame in confirmed mode) goes
    // straight into the export payload, see the export handler's native
    // branch below. ------------------------------------------------------

    let nativeSkeletonBuilt = false;

    function ensureNativeSkeleton() {
        if (nativeSkeletonBuilt) return;
        nativeSkeletonBuilt = true;
        el("#exp-native-content").innerHTML = `
            <div class="trake-curate-panel">
              <div class="trake-toprow">
                <input type="text" id="native-load-video" class="curate-load-video" placeholder="Video ID e.g. L21_V001">
                <button class="btn curate-load-btn" id="native-load-btn" type="button">Load / switch</button>
                <span id="native-cur-timer" class="playback-timer">--:-- · frame --</span>
                <span id="native-cur-speed" class="playback-speed" title="&lt; / , slower, &gt; / . faster, 0 resets to 1x">1x</span>
                <button class="btn btn-primary" id="native-add-btn" type="button">+ Add current frame</button>
              </div>
              <div class="trake-main-row">
                <div class="trake-video-col" id="native-video-wrap">
                  <div class="status-banner info">Load a video above, or open this tab from a result card's ★.</div>
                </div>
                <div class="trake-events-col">
                  <div class="thumb-caption muted" id="native-events-label" style="margin-bottom:0.4rem;"></div>
                  <div class="trake-event-list" id="native-event-list"></div>
                </div>
              </div>
            </div>`;

        el("#native-load-btn").onclick = () => loadCurationVideo(el("#native-load-video").value, "native");
        el("#native-add-btn").onclick = () => {
            if (!s.native.videoEl) { showStatus("No video loaded to capture a frame from."); return; }
            const video = s.native.videoEl;
            const frame_idx = Math.round(video.currentTime * s.native.fps);
            addEventToCuration("native", { video_id: s.native.videoId, frame_idx, thumbnail: captureVideoThumbnail(video) });
        };
    }

    function renderNativeContent() {
        ensureNativeSkeleton();
        const label = el("#native-events-label");
        if (label) {
            label.textContent = s.confirmed
                ? "Chosen frame:"
                : "Candidate answer frames, in the order added -- drag to reorder, ✕ to remove:";
        }
        // Confirmed mode is exactly one answer frame -- clicking Add again
        // doesn't add a second one, it swaps to whatever's playing now
        // (item 1.2), so the button reads that way instead of "Add".
        // Unconfirmed keeps the plain "add" phrasing (item 1.3 only asked
        // to rename the confirmed-mode button).
        const addBtn = el("#native-add-btn");
        if (addBtn) addBtn.textContent = s.confirmed ? "Switch to this frame" : "+ Add current frame";
        renderCurationEventList("native");
    }

    return { renderAnswerContent, renderPreview, applyChangedFrame, renderNativeContent };
}
