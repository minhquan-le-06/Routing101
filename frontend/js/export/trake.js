// frontend/js/export/trake.js -- TRAKE's curate -> cache -> merge panel:
// the curation video + event list (curation.js), "Generate rows" into a
// per-video client-side cache, and the client-side merge of the checked
// cached videos into one <=99-row CSV (see ui.js's header for the flow).

import { getTrakeRows } from "../api.js";
import { captureVideoThumbnail } from "../video-controls.js";

// `ctx`: buildExportUI()'s shared context plus curation.js's functions.
export function createTrake(ctx) {
    const { s, el, showStatus, loadCurationVideo, addEventToCuration, renderCurationEventList } = ctx;

    // POSTs this video's curated {video_id, frame_idxs} to
    // /api/export/trake-rows and stashes the <=99 returned candidate
    // sequences client-side, keyed by video_id -- repeatable for as many
    // candidate videos as the human wants to compare (each just adds/
    // overwrites its own cache entry, see module docstring). Newly cached
    // (or re-cached) videos default to checked-and-appended into the
    // merge priority order, last -- keeps a freshly regenerated video in
    // whatever priority slot it already had instead of bumping it to the
    // front.
    async function generateRowsForCurationVideo() {
        if (!s.trake.videoId || !s.trake.events.length) {
            showStatus("Add at least one event before generating rows.");
            return;
        }
        const btn = el("#trake-generate-btn");
        if (btn) btn.disabled = true;
        try {
            const frameIdxs = s.trake.events.map((e) => e.frame_idx);
            const thumbnails = s.trake.events.map((e) => e.thumbnail);
            const data = await getTrakeRows(s.trake.videoId, frameIdxs, 99);
            s.trake.cache.set(s.trake.videoId, { frameIdxs, thumbnails, rows: data.rows });
            if (!s.trake.mergeOrder.includes(s.trake.videoId)) s.trake.mergeOrder.push(s.trake.videoId);
            s.trake.mergeChecked.add(s.trake.videoId);
            showStatus(`✓ Cached ${data.rows.length} rows for ${s.trake.videoId}. Curate another video, or check it below and Export.`, "info");
            renderCacheList();
        } catch (e) {
            showStatus(e.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function removeFromCache(videoId) {
        s.trake.cache.delete(videoId);
        s.trake.mergeOrder = s.trake.mergeOrder.filter((v) => v !== videoId);
        s.trake.mergeChecked.delete(videoId);
        renderCacheList();
    }

    function wireCacheDnd(list) {
        for (const row of list.querySelectorAll(".trake-cache-row")) {
            const vid = row.dataset.videoId;
            row.addEventListener("dragstart", () => { s.trake.mergeDragIndex = s.trake.mergeOrder.indexOf(vid); });
            row.addEventListener("dragover", (e) => e.preventDefault());
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                const from = s.trake.mergeDragIndex;
                const to = s.trake.mergeOrder.indexOf(vid);
                if (from === null || from === to) return;
                const [moved] = s.trake.mergeOrder.splice(from, 1);
                s.trake.mergeOrder.splice(to, 0, moved);
                s.trake.mergeDragIndex = null;
                renderCacheList();
            });
        }
    }

    function renderCacheList() {
        const list = el("#trake-cache-list");
        if (!list) return;
        if (!s.trake.cache.size) {
            list.innerHTML = `<div class="status-banner info">Nothing cached yet -- curate a video above, then click "Generate rows".</div>`;
            return;
        }
        list.innerHTML = s.trake.mergeOrder.map((vid) => {
            const entry = s.trake.cache.get(vid);
            if (!entry) return "";
            const checked = s.trake.mergeChecked.has(vid);
            return `<div class="trake-cache-row" draggable="true" data-video-id="${vid}">
                <input type="checkbox" class="trake-cache-check" data-video-id="${vid}" ${checked ? "checked" : ""}>
                <span class="thumb-caption"><b>${vid}</b> <span class="muted">· ${entry.rows.length} rows · ${entry.frameIdxs.length} events</span></span>
                <button class="icon-btn export-remove-btn" title="Remove from cache" data-video-id="${vid}">✕</button>
            </div>`;
        }).join("");
        list.querySelectorAll(".trake-cache-check").forEach((cb) => {
            cb.onchange = () => {
                const vid = cb.dataset.videoId;
                if (cb.checked) s.trake.mergeChecked.add(vid); else s.trake.mergeChecked.delete(vid);
            };
        });
        list.querySelectorAll(".trake-cache-row .export-remove-btn").forEach((btn) => {
            btn.onclick = () => removeFromCache(btn.dataset.videoId);
        });
        wireCacheDnd(list);
    }

    // Client-side only -- "no CSV parsing, no re-reading files" per spec.
    // Each checked video's own row 1 (its curated pick) goes first, in
    // priority order, then row 2/row 3/... round-robin in that same
    // order until the cap is hit or every cached video's rows are spent.
    // This mirrors the rest of the app's export tiers (one clean row per
    // hypothesis first, hedges/fillers after) while keeping the highest-
    // priority video's own pick at rank 1, which is what R@1 rewards.
    function mergeTrakeCache(maxRows) {
        const selected = s.trake.mergeOrder.filter((vid) => s.trake.mergeChecked.has(vid) && s.trake.cache.has(vid));
        const rows = [];
        for (let k = 0; rows.length < maxRows; k++) {
            let any = false;
            for (const vid of selected) {
                const entry = s.trake.cache.get(vid);
                if (k < entry.rows.length) {
                    rows.push({ video_id: vid, frame_idxs: entry.rows[k] });
                    any = true;
                    if (rows.length >= maxRows) break;
                }
            }
            if (!any) break;
        }
        return rows;
    }

    let trakeSkeletonBuilt = false;

    // Builds the panel's static DOM once (the video element and cache
    // list are updated in place afterward, by renderCurationEventList()/
    // renderCacheList(), never rebuilt wholesale -- rebuilding on every
    // state change would tear down and restart the <video> mid-playback).
    function ensureTrakeSkeleton() {
        if (trakeSkeletonBuilt) return;
        trakeSkeletonBuilt = true;
        el("#exp-trake-content").innerHTML = `
            <div class="trake-curate-panel">
              <div class="trake-toprow">
                <input type="text" id="trake-load-video" class="curate-load-video" placeholder="Video ID e.g. L21_V001">
                <button class="btn curate-load-btn" id="trake-load-btn" type="button">Load / switch</button>
                <span id="trake-cur-timer" class="playback-timer">--:-- · frame --</span>
                <span id="trake-cur-speed" class="playback-speed" title="&lt; / , slower, &gt; / . faster, 0 resets to 1x">1x</span>
                <button class="btn btn-primary" id="trake-add-btn" type="button">+ Add current frame as event</button>
              </div>
              <div class="trake-main-row">
                <div class="trake-video-col" id="trake-video-wrap">
                  <div class="status-banner info">Load a video above, or open this tab from a result card's ★.</div>
                </div>
                <div class="trake-events-col">
                  <div class="thumb-caption muted" style="margin-bottom:0.4rem;">Events, in sequence order -- drag to reorder, ✕ to remove:</div>
                  <div class="trake-event-list" id="trake-event-list"></div>
                  <button class="btn btn-primary" id="trake-generate-btn" type="button" style="margin-top:0.6rem;">Generate rows for this video</button>
                </div>
              </div>
            </div>
            <hr class="divider">
            <div class="trake-cache-panel">
              <div class="thumb-caption" style="margin-bottom:0.4rem;"><b>Cached videos</b> <span class="muted">(check to include in the merged export, drag to set priority order)</span></div>
              <div id="trake-cache-list"></div>
            </div>`;

        el("#trake-load-btn").onclick = () => loadCurationVideo(el("#trake-load-video").value, "trake");
        el("#trake-add-btn").onclick = () => {
            if (!s.trake.videoEl) { showStatus("No video loaded to capture a frame from."); return; }
            const video = s.trake.videoEl;
            const frame_idx = Math.round(video.currentTime * s.trake.fps);
            addEventToCuration("trake", { video_id: s.trake.videoId, frame_idx, thumbnail: captureVideoThumbnail(video) });
        };
        el("#trake-generate-btn").onclick = generateRowsForCurationVideo;
    }

    function renderTrakeContent() {
        ensureTrakeSkeleton();
        renderCurationEventList("trake");
        renderCacheList();
    }

    return { generateRowsForCurationVideo, mergeTrakeCache, renderTrakeContent };
}
