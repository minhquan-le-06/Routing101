// frontend/js/dialogs/playback.js -- video playback dialogs: single-frame
// playback (a result card's play button; one-tick marker bar at the chosen
// keyframe) and TRAKE's multi-event playback (one tick per matched event,
// plus coverage gaps). Both have a live time/frame readout and an "Export
// this frame" button that hands the exact playing frame to the Export tab.

import { getPlayback } from "../api.js";
import { openExportDialog } from "../export/dialog.js";
import { fmtTime } from "../util.js";
import { applyVideoPrefs, bindSpeedShortcut, captureVideoThumbnail } from "../video-controls.js";
import { openDialog } from "./base.js";

export async function openPlaybackDialog(videoId, n) {
    const body = document.createElement("div");
    body.innerHTML = `<div class="playback-layout">
        <div class="playback-main">
          <div id="playback-video-wrap">Loading…</div>
          <div id="playback-marker-bar"></div>
        </div>
        <div class="playback-info">
          <div class="thumb-caption">${videoId} — frame ${n}</div>
          <div id="playback-timer" class="playback-timer">--:-- · frame --</div>
          <div id="playback-speed" class="playback-speed" title="&lt; / , slower, &gt; / . faster, 0 resets to 1x">1x</div>
          <button class="btn" id="playback-export-btn" style="margin-top:0.5rem;" title="Export the exact frame currently playing">★ Export this frame</button>
        </div>
      </div>`;
    const { box } = openDialog(null, body);

    try {
        const data = await getPlayback(videoId, n);
        const wrap = box.querySelector("#playback-video-wrap");
        wrap.innerHTML = "";
        const video = document.createElement("video");
        video.src = data.video_url + `#t=${data.start_time}`;
        video.controls = true;
        video.autoplay = false;
        wrap.append(video);
        applyVideoPrefs(video);
        bindSpeedShortcut(video, box, box.querySelector("#playback-speed"));

        // Live realtime frame timer -- same fps*currentTime readout TRAKE's
        // marker-bar playback uses.
        const timer = box.querySelector("#playback-timer");
        video.addEventListener("timeupdate", () => {
            timer.textContent = `${fmtTime(video.currentTime)} · frame ${Math.round(video.currentTime * data.fps)}`;
        });

        // Single-tick marker bar, same layout/click-to-seek mechanics as
        // TRAKE's #trake-marker-bar, just with exactly one tick: the
        // keyframe (`n`) that was chosen before opening this dialog, at
        // data.start_time.
        const bar = box.querySelector("#playback-marker-bar");
        function layoutMarker() {
            if (!video.duration || !isFinite(video.duration)) return;
            bar.innerHTML = "";
            const pct = Math.max(0, Math.min(100, (data.start_time / video.duration) * 100));
            const tick = document.createElement("div");
            tick.className = "trake-marker-tick";
            tick.title = `frame ${n} @ ${data.start_time.toFixed(2)}s`;
            tick.textContent = `frame ${n}`;
            tick.style.left = pct + "%";
            tick.addEventListener("click", () => { video.currentTime = data.start_time; });
            bar.append(tick);
        }
        video.addEventListener("loadedmetadata", layoutMarker);
        if (video.readyState >= 1) layoutMarker();

        // Exports whatever real frame the video is currently at (paused or
        // not), computed fresh at click time -- not read off the timer's
        // text, which is just a display of the same arithmetic. No
        // keyframe n involved at all, so this always opens as a TRAKE
        // export (see export/ui.js's {kind:"frame"} handling). Carries the
        // current playback position (seconds) and a thumbnail snapshot
        // across the tab handoff too: the Export tab's curation video
        // seeks to the same spot instead of restarting at 0:00, and the
        // seeded TRAKE event gets a real preview instead of "no preview"
        // (see export/ui.js's addTrakeEventFromTrigger/loadCurationVideo).
        box.querySelector("#playback-export-btn").onclick = () => {
            openExportDialog({
                kind: "frame", video_id: videoId,
                frame_idx: Math.round(video.currentTime * data.fps),
                current_time: video.currentTime,
                thumbnail: captureVideoThumbnail(video),
            });
        };
    } catch (e) {
        box.querySelector("#playback-video-wrap").innerHTML =
            `<div class="status-banner error">${e.message}</div>`;
    }
}

// TRAKE's play-icon action: opens the source video seeked near the first
// matched event, with a click-to-seek marker row for every matched event
// and a live timestamp/frame readout.
export async function openTrakePlaybackDialog(videoId, events) {
    const matched = events.filter((e) => e.matched && e.timestamp !== null);
    const gaps = events.filter((e) => !e.matched);

    const body = document.createElement("div");
    body.innerHTML = `<div class="playback-layout">
        <div class="playback-main">
          <div id="trake-video-wrap">Loading…</div>
          <div id="trake-marker-bar"></div>
        </div>
        <div class="playback-info">
          <div class="thumb-caption">${videoId}</div>
          <div id="trake-timer" class="playback-timer">--:-- · frame --</div>
          <div id="trake-speed" class="playback-speed" title="&lt; / , slower, &gt; / . faster, 0 resets to 1x">1x</div>
          <button class="btn" id="trake-export-btn" style="margin-top:0.5rem;" title="Export the exact frame currently playing">★ Export this frame</button>
          <div id="trake-gaps"></div>
        </div>
      </div>`;
    const { box } = openDialog(null, body, { wide: true });

    if (gaps.length) {
        const gapsEl = box.querySelector("#trake-gaps");
        gapsEl.innerHTML = `<hr class="divider"><div class="thumb-caption muted" style="margin-bottom:0.4rem;">Coverage gaps — scrub manually between the nearest matched anchors:</div>`;
        for (const e of gaps) {
            const before = matched.filter((m) => m.event_index < e.event_index).at(-1);
            const after = matched.find((m) => m.event_index > e.event_index);
            const lo = before ? `${before.timestamp.toFixed(2)}s (${before.label})` : "start";
            const hi = after ? `${after.timestamp.toFixed(2)}s (${after.label})` : "end";
            const line = document.createElement("div");
            line.className = "thumb-caption";
            line.innerHTML = `${e.label}: no direct match — between <b>${lo}</b> and <b>${hi}</b>`;
            gapsEl.append(line);
        }
    }

    if (!matched.length) {
        box.querySelector("#trake-video-wrap").innerHTML = `<div class="status-banner info">No matched events to seek to.</div>`;
        const exportBtn = box.querySelector("#trake-export-btn");
        exportBtn.disabled = true;
        exportBtn.title = "No video loaded to read a frame from";
        return;
    }

    try {
        const data = await getPlayback(videoId, matched[0].n);
        const wrap = box.querySelector("#trake-video-wrap");
        wrap.innerHTML = "";
        const video = document.createElement("video");
        video.src = data.video_url + `#t=${matched[0].timestamp}`;
        video.controls = true;
        wrap.append(video);
        applyVideoPrefs(video);
        bindSpeedShortcut(video, box, box.querySelector("#trake-speed"));

        const bar = box.querySelector("#trake-marker-bar");
        const timer = box.querySelector("#trake-timer");

        function layoutMarkers() {
            if (!video.duration || !isFinite(video.duration)) return;
            bar.innerHTML = "";
            for (const m of matched) {
                const pct = Math.max(0, Math.min(100, (m.timestamp / video.duration) * 100));
                const tick = document.createElement("div");
                tick.className = "trake-marker-tick";
                tick.title = `${m.label} @ ${m.timestamp.toFixed(2)}s`;
                tick.textContent = m.label;
                tick.style.left = pct + "%";
                tick.addEventListener("click", () => { video.currentTime = m.timestamp; });
                bar.append(tick);
            }
        }
        video.addEventListener("loadedmetadata", layoutMarkers);
        if (video.readyState >= 1) layoutMarkers();
        video.addEventListener("timeupdate", () => {
            timer.textContent = `${fmtTime(video.currentTime)} · frame ${Math.round(video.currentTime * data.fps)}`;
        });

        // Same "capture the real frame fresh at click time" pattern as
        // openPlaybackDialog's own export button, including the current-
        // time/thumbnail handoff (see its comment above).
        box.querySelector("#trake-export-btn").onclick = () => {
            openExportDialog({
                kind: "frame", video_id: videoId,
                frame_idx: Math.round(video.currentTime * data.fps),
                current_time: video.currentTime,
                thumbnail: captureVideoThumbnail(video),
            });
        };
    } catch (e) {
        box.querySelector("#trake-video-wrap").innerHTML = `<div class="status-banner error">${e.message}</div>`;
    }
}
