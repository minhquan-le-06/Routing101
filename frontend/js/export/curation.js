// frontend/js/export/curation.js -- the shared video-curation panel
// machinery: one video, an ordered native frame_idx list, played and
// captured from a live <video>. Used by TRAKE's per-video event list
// (trake.js) and KIS/VQA's native, Keyframes-unchecked answer frames
// (answers.js); `kind` ("trake" | "native") picks the state bucket and DOM
// ids a call operates on.

import { getExportFrame, getPlayback } from "../api.js";
import { fmtTime } from "../util.js";
import { applyVideoPrefs, bindSpeedShortcut } from "../video-controls.js";

// `ctx` is buildExportUI()'s shared context (see ui.js): the state `s`, the
// `el` DOM lookup, the status banner, and renderTypeVisibility.
export function createCuration(ctx) {
    const { s, el, showStatus, clearStatus, renderTypeVisibility } = ctx;

    // --- Shared curation-panel machinery: TRAKE's per-video event list
    // (curate -> cache its generated rows -> merge several cached videos)
    // and KIS/VQA's native (Keyframes-unchecked) answer-frame curation
    // both boil down to "one video, an ordered native frame_idx list,
    // played and captured from a live <video>" -- `kind` ("trake" |
    // "native") picks which state bucket (s.trake / s.native) and DOM ids
    // a call operates on. TRAKE layers its own cache/merge panel on top
    // (generateRowsForCurationVideo() etc. below, unaffected by this) --
    // "native" has no such extra step, the curated list goes straight
    // into the export payload. ---------------------------------------

    function curationTarget(kind) {
        return kind === "trake"
            ? { state: s.trake, wrapId: "#trake-video-wrap", timerId: "#trake-cur-timer", speedId: "#trake-cur-speed", listId: "#trake-event-list" }
            : { state: s.native, wrapId: "#native-video-wrap", timerId: "#native-cur-timer", speedId: "#native-cur-speed", listId: "#native-event-list" };
    }

    // Loads (or switches the curation panel to) a video: fetches playback
    // info and builds a fresh <video>. Switching to a *different* video
    // than the one currently being curated starts a clean event list --
    // any TRAKE cache entry already generated for either video is
    // untouched (cache entries persist independently of what's in the
    // live curation panel, see generateRowsForCurationVideo()).
    // `seekTime` (seconds) picks up video playback exactly where the user
    // left it in whatever dialog they hit "Export this frame" from (see
    // dialogs/playback.js's current_time handoff). `seekN` is the alternative for a
    // keyframe-backed frame (a KIS/VQA confirmed/answer frame, switched to
    // TRAKE, or a "flat" trigger's own seed): rather than convert n to a
    // time ourselves, /api/playback already resolves a keyframe's own
    // timestamp server-side (same lookup a KIS/VQA playback dialog uses),
    // so passing it as `n` here gets the exact same start_time. `seekFrameIdx`
    // is the native-space equivalent, for handing a raw frame_idx (no n)
    // off between the two curation panels -- computed from the freshly
    // fetched fps once it's known. None given (all default) starts at
    // 0:00, same as before, for every other way a panel gets loaded/
    // switched (typed Video ID, a plain video switch, a "trake" trigger's
    // own multi-event seeding).
    async function loadCurationVideo(videoId, kind, { seekTime = 0, seekN = null, seekFrameIdx = null } = {}) {
        const { state, wrapId, timerId, speedId } = curationTarget(kind);
        videoId = (videoId || "").trim().toUpperCase();
        if (!videoId) return;
        if (videoId !== state.videoId) {
            state.videoId = videoId;
            state.events = [];
            renderCurationEventList(kind);
        }
        clearStatus();
        renderTypeVisibility(); // keeps the topbar's locked Video ID display in sync
        const wrap = el(wrapId);
        if (wrap) wrap.innerHTML = `<div class="status-banner info">Loading…</div>`;
        try {
            const data = await getPlayback(videoId, seekN ?? undefined);
            if (el(wrapId) !== wrap) return; // panel torn down mid-fetch (query type switched away)
            state.fps = data.fps;
            wrap.innerHTML = "";
            const video = document.createElement("video");
            let t = seekTime;
            if (seekN != null) t = data.start_time;
            else if (seekFrameIdx != null) t = seekFrameIdx / (data.fps || 25);
            video.src = data.video_url + (t > 0 ? `#t=${t}` : "");
            video.controls = true;
            wrap.append(video);
            applyVideoPrefs(video);
            if (state.unbindSpeedShortcut) state.unbindSpeedShortcut(); // drop the outgoing <video>'s listener before binding the new one
            state.unbindSpeedShortcut = bindSpeedShortcut(video, wrap, el(speedId));
            state.videoEl = video;
            const timer = el(timerId);
            video.addEventListener("timeupdate", () => {
                timer.textContent = `${fmtTime(video.currentTime)} · frame ${Math.round(video.currentTime * state.fps)}`;
            });
        } catch (e) {
            state.videoEl = null;
            if (wrap) wrap.innerHTML = `<div class="status-banner error">${e.message}</div>`;
        }
    }

    // Adds one event to the video currently being curated -- from the
    // inline "Add current frame" button (f.thumbnail already captured) or
    // the repurposed Frame ID/Change row (raw frame_idx, no thumbnail).
    // Enforces the one hard constraint: a TRAKE export row (or a native
    // KIS/VQA answer list) is exactly one video, so a frame from a
    // different video is rejected rather than silently starting a second,
    // unrepresentable sequence.
    //
    // TRAKE inserts in temporal order (by frame_idx) rather than always
    // appending -- adding an earlier frame after later ones (e.g.
    // scrubbing back, or the Frame ID box) lands it in the right spot
    // immediately instead of needing a manual drag to fix the sequence.
    // Assumes the list is already ordered, which holds as long as every
    // addition goes through here; drag-to-reorder can still freely
    // override this after the fact.
    // Native (KIS/VQA, Keyframes unchecked) is different in kind, not
    // just order: confirmed mode is exactly one answer frame, so a new
    // pick there replaces the list instead of inserting into it (its "one
    // frame, whatever's live" caption doesn't have a rank to preserve);
    // unconfirmed mode is a plain append, no temporal sort at all -- each
    // pick becomes the next "Cand N" in whatever order the human added
    // them, not sorted by frame_idx (item 1.3).
    function addEventToCuration(kind, f) {
        const { state } = curationTarget(kind);
        if (state.videoId && f.video_id !== state.videoId) {
            showStatus(`Currently curating ${state.videoId} -- this frame is from a different video. Switch videos above first if you meant to add it there.`);
            return false;
        }
        if (!state.videoId) state.videoId = f.video_id;
        const entry = { frame_idx: f.frame_idx, thumbnail: f.thumbnail ?? null };
        if (kind === "native") {
            if (s.confirmed) state.events = [entry];
            else state.events.push(entry);
        } else {
            const insertAt = state.events.findIndex((e) => e.frame_idx > entry.frame_idx);
            if (insertAt === -1) state.events.push(entry);
            else state.events.splice(insertAt, 0, entry);
        }
        clearStatus();
        renderCurationEventList(kind);
        return true;
    }

    // Resolves a keyframe n (not a raw frame_idx) to its real frame_idx +
    // thumbnail before adding -- used to seed a curation panel from a
    // "flat" trigger (any non-TRAKE signal's ★, which only carries n, no
    // frame_idx) via the same lookup the rest of the app already does.
    function addEventFromN(kind, videoId, n) {
        const { state } = curationTarget(kind);
        if (state.videoId && videoId !== state.videoId) {
            showStatus(`Currently curating ${state.videoId} -- this frame is from a different video. Switch videos above first if you meant to add it there.`);
            return;
        }
        getExportFrame(videoId, n).then((info) => {
            addEventToCuration(kind, { video_id: videoId, frame_idx: info.frame_idx, thumbnail: info.thumbnail_url });
        }).catch((e) => showStatus(e.message));
    }

    function removeCurationEvent(kind, i) {
        const { state } = curationTarget(kind);
        state.events.splice(i, 1);
        renderCurationEventList(kind);
    }
    function moveCurationEvent(kind, from, to) {
        const { state } = curationTarget(kind);
        const [ev] = state.events.splice(from, 1);
        state.events.splice(to, 0, ev);
        renderCurationEventList(kind);
    }
    function wireCurationEventDnd(kind, list) {
        const { state } = curationTarget(kind);
        for (const row of list.querySelectorAll(".trake-event-row")) {
            const i = Number(row.dataset.index);
            row.addEventListener("dragstart", () => { state.dragIndex = i; });
            row.addEventListener("dragover", (e) => e.preventDefault());
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                if (state.dragIndex === null || state.dragIndex === i) return;
                moveCurationEvent(kind, state.dragIndex, i);
                state.dragIndex = null;
            });
            const removeBtn = row.querySelector(".export-remove-btn");
            if (removeBtn) removeBtn.onclick = () => removeCurationEvent(kind, i);
        }
    }

    // Only the event list -- never the video element or the TRAKE cache
    // panel -- so adding/removing/reordering an event never interrupts
    // playback.
    //
    // Caption differs by kind/mode (items 1.2/1.3): TRAKE keeps "E1, E2,
    // ..." (a sequence of events within one video). Native confirmed mode
    // is exactly one frame with no rank to show, so its label is the
    // video_id instead of "E1". Native unconfirmed mode is a pool of
    // candidate answer frames, not a sequence -- "Cand 1, Cand 2, ..."
    // instead of "E1, E2, ...", with the video_id shown too (all
    // candidates share state.videoId, same one-video-per-curation-session
    // constraint as TRAKE, but it's less obviously implied here since
    // there's no "sequence" framing to carry it).
    function renderCurationEventList(kind) {
        const { state, listId } = curationTarget(kind);
        const list = el(listId);
        if (!list) return;
        if (!state.events.length) {
            const msg = kind === "trake"
                ? `No events yet -- play the video and click "Add current frame as event", or add one via the Frame ID box above.`
                : s.confirmed
                    ? `No frame chosen yet -- play the video and click "Switch to this frame".`
                    : `No candidates yet -- play the video and click "+ Add current frame".`;
            list.innerHTML = `<div class="status-banner info">${msg}</div>`;
            return;
        }
        list.innerHTML = state.events.map((e, i) => {
            const caption = kind === "trake"
                ? `<b>E${i + 1}</b> <span class="muted">· frame ${e.frame_idx}</span>`
                : s.confirmed
                    ? `<b>${state.videoId}</b> <span class="muted">· frame ${e.frame_idx}</span>`
                    : `<b>Cand ${i + 1}</b> <span class="muted">· ${state.videoId} · frame ${e.frame_idx}</span>`;
            return `
            <div class="trake-event-row" draggable="true" data-index="${i}">
                ${e.thumbnail
                    ? `<div class="thumb-wrap thumb-wrap-static"><img src="${e.thumbnail}" loading="lazy"></div>`
                    : `<div class="thumb-missing">no preview</div>`}
                <div class="trake-event-fields">
                    <div class="thumb-caption">${caption}</div>
                </div>
                <button class="icon-btn export-remove-btn" title="Remove" data-index="${i}">✕</button>
            </div>`;
        }).join("");
        wireCurationEventDnd(kind, list);
    }

    return { loadCurationVideo, addEventToCuration, addEventFromN, renderCurationEventList };
}
