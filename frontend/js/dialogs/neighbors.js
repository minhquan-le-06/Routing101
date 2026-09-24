// frontend/js/dialogs/neighbors.js -- "Nearby frames" (the result card's
// "Show more"): the keyframes around one frame, expandable both ways, each
// with its own export button.

import { getNeighbors } from "../api.js";
import { openExportDialog } from "../export/dialog.js";
import { tile } from "../settings.js";
import { getNeighborExtra } from "../state.js";
import { openDialog } from "./base.js";

export async function openNeighborsDialog(videoId, centerN) {
    // Columns, opening window and expand step all follow the tile-size
    // setting (settings.js's TILE_SIZES): the popup's grid is as wide in
    // tiles as the main result grid, and the counts are picked so it opens
    // three rows full (before + center + after) and expands by two.
    const { neighborsBefore, neighborsAfter, neighborStep: step } = tile();
    const body = document.createElement("div");
    body.innerHTML = `<div class="thumb-caption" style="margin-bottom:0.5rem;">${videoId} — around frame ${centerN}</div>
        <button class="btn" id="nbr-up" style="width:100%;margin-bottom:0.5rem;">▲ ${step} earlier</button>
        <div class="grid nbr-grid" id="nbr-grid"></div>
        <button class="btn" id="nbr-down" style="width:100%;margin-top:0.5rem;">▼ ${step} later</button>`;
    const { box } = openDialog("Nearby frames", body, { wide: true });

    async function refresh() {
        const extra = getNeighborExtra(videoId, centerN);
        const data = await getNeighbors(
            videoId, centerN, neighborsBefore + extra.before, neighborsAfter + extra.after);
        const grid = box.querySelector("#nbr-grid");
        grid.innerHTML = "";
        for (const f of data.frames) {
            const cell = document.createElement("div");
            cell.className = "thumb-cell";
            // thumb-wrap-static suppresses the normal hover-zoom (same
            // class TRAKE's low-count cards use) -- distracting in this
            // tightly packed nearby-frames grid.
            cell.innerHTML = f.exists
                ? `<div class="thumb-wrap thumb-wrap-static"><img src="${f.thumbnail_url}"></div>`
                : `<div class="thumb-missing">(missing)</div>`;
            const cap = document.createElement("div");
            cap.className = "thumb-caption";
            cap.innerHTML = f.is_center ? `<b>${f.n}</b>` : String(f.n);
            cell.append(cap);
            if (f.exists) {
                // Reuses .export-add-btn's CSS (top-right overlay corner,
                // same as the export screen's own preview cards) purely for
                // position/sizing -- unrelated to that button's add/replace
                // behavior elsewhere.
                const exportBtn = document.createElement("button");
                exportBtn.className = "icon-btn export-add-btn";
                exportBtn.title = "Export as AIC submission CSV";
                exportBtn.textContent = "★";
                exportBtn.onclick = () => openExportDialog({ kind: "flat", video_id: videoId, n: f.n });
                cell.append(exportBtn);
            }
            grid.append(cell);
        }
    }

    box.querySelector("#nbr-up").onclick = () => {
        getNeighborExtra(videoId, centerN).before += step;
        refresh();
    };
    box.querySelector("#nbr-down").onclick = () => {
        getNeighborExtra(videoId, centerN).after += step;
        refresh();
    };

    await refresh();
}
