// frontend/js/dialogs/settings.js -- the ⚙ Settings dialog (display
// preferences from ../settings.js, the sidebar's Top-K/V/G boxes, and the
// backend's long-query chunking strategy).

import { getSearchSettings, setSearchSettings } from "../api.js";
import {
    groupByUi, HOVER_ZOOM_MAX, HOVER_ZOOM_MIN, HOVER_ZOOM_STEP,
    QUERY_CHUNK_DEFAULT, QUERY_CHUNK_LABELS, queryChunk, setQueryChunkCache,
    SETTINGS_DEFAULTS, saveSettings, settings, TILE_SIZE_KEYS,
    TILE_SIZES, TOP_K_DEFAULT, TOP_V_DEFAULT,
} from "../settings.js";
import { openDialog } from "./base.js";

// Display settings dialog -- the ⚙ button in the sidebar's signal rows.
// Same staged-copy/Defaults/Cancel/Save shape as openWeightsDialog (weights.js):
// nothing is committed (or persisted) until Save, so Cancel really does
// discard. `onSave` re-runs the current search -- every control here can
// change what a search returns or how it's grouped.
//
// Three kinds of control share the form: the saved settings themselves
// (settings.js); mirrors of the sidebar's Top-K/Top-V/Top-G boxes, which stay
// on the sidebar and stay session state -- the dialog reads them on open and
// writes back only the ones actually changed, so it never clobbers a
// hand-typed value it didn't touch; and one backend setting, query chunking,
// which is fetched on open and POSTed on Save.
export function openSettingsDialog(onSave) {
    const staged = { ...settings };
    // Drawn from the cached value immediately, then corrected by the fetch
    // below -- the dialog must never present a chunking mode the backend
    // isn't actually using. `loadedChunk` is what the backend said, so Save
    // can tell a real change from a no-op and skip the POST.
    let stagedChunk = queryChunk.strategy;
    let loadedChunk = queryChunk.strategy;
    let chunkTouched = false;

    const TOP_BOXES = [
        { id: "top-k", label: "Top-K", title: "Candidates fetched per search." },
        { id: "top-v", label: "Top-V", title: "Videos kept (TRAKE)." },
        { id: "top-g", label: "Top-G", title: "Frames kept per video after per-video drill-down (Hierarchy)." },
    ];
    const sidebarInput = (id) => document.getElementById(id);
    // All three are always offered here, even though the sidebar shows Top-V
    // only on TRAKE and Top-G only on Hierarchy: the inputs (and their
    // values) exist either way, so this is the one place to set them up
    // before switching to the signal that uses them.
    const initialTops = Object.fromEntries(TOP_BOXES.map((b) => [b.id, sidebarInput(b.id).value]));
    const stagedTops = { ...initialTops };
    // A hand-typed Top-G outranks the tile size's default below.
    let topGTouched = false;

    const body = document.createElement("div");
    body.innerHTML = `<div class="settings-row">
          <label for="set-zoom" title="How far a result thumbnail scales up while hovered.">Hover zoom</label>
          <input type="range" id="set-zoom" min="${HOVER_ZOOM_MIN}" max="${HOVER_ZOOM_MAX}" step="${HOVER_ZOOM_STEP}">
          <span class="settings-value" id="set-zoom-value"></span>
        </div>
        <div class="settings-row">
          <label title="Thumbnail size everywhere: fewer, bigger tiles per row (and matching &quot;show more&quot; steps) at Large.">Tiles display size</label>
          <div class="segmented" id="set-tile">
            ${TILE_SIZE_KEYS.map((key) => `<button type="button" data-tile="${key}">${TILE_SIZES[key].label}</button>`).join("")}
          </div>
        </div>
        <div class="settings-row">
          <label title="The same boxes as the sidebar's -- changed here, they change there.">Result counts</label>
          <div class="settings-tops">
            ${TOP_BOXES.map((b) => `<div class="settings-top-box">
              <label for="set-${b.id}" title="${b.title}">${b.label}</label>
              <input type="number" id="set-${b.id}" min="1" step="1">
            </div>`).join("")}
          </div>
        </div>
        <div class="settings-row">
          <label title="SigLIP2's text tower reads at most 64 tokens. A longer query has to be split -- this is what happens to the pieces. Applies to the backend behind this tab, not just this browser.">Long-query chunking</label>
          <div class="segmented" id="set-chunk">
            ${Object.entries(QUERY_CHUNK_LABELS).map(([key, v]) =>
              `<button type="button" data-chunk="${key}" title="${v.title}">${v.label}</button>`).join("")}
          </div>
        </div>
        <div class="settings-row">
          <label>Result display</label>
          <div class="settings-checks">
            <label class="settings-check" id="set-group-row">
              <input type="checkbox" id="set-group"> <span id="set-group-label"></span>
            </label>
            <label class="settings-check">
              <input type="checkbox" id="set-fulltext"> Show full text
            </label>
          </div>
        </div>
        <hr class="divider">
        <div class="settings-actions">
          <button class="btn" id="set-defaults">Set to defaults</button>
          <button class="btn" id="set-cancel">Cancel</button>
          <button class="btn btn-primary" id="set-save">Save</button>
        </div>`;
    const { overlay, box } = openDialog("Settings", body);

    const zoom = box.querySelector("#set-zoom");
    const zoomValue = box.querySelector("#set-zoom-value");
    const groupCheck = box.querySelector("#set-group");
    const fullTextCheck = box.querySelector("#set-fulltext");

    // Hierarchy/TRAKE don't offer a group-by toggle at all, and Summary
    // relabels it -- one shared toggle, presented per the mounted signal
    // (settings.js's groupByUi).
    box.querySelector("#set-group-row").style.display = groupByUi.visible ? "flex" : "none";
    box.querySelector("#set-group-label").textContent = groupByUi.label;

    function renderStaged() {
        zoom.value = staged.hoverZoom;
        zoomValue.textContent = `${Number(staged.hoverZoom).toFixed(1)}×`;
        // Exactly one tile size active at a time -- clicking one clears its
        // siblings (unlike the sidebar's scope segmented control, this one
        // can't drop to zero selected).
        box.querySelectorAll("#set-tile button").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.tile === staged.tileSize);
        });
        box.querySelectorAll("#set-chunk button").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.chunk === stagedChunk);
        });
        groupCheck.checked = staged.groupByVideo;
        fullTextCheck.checked = staged.showFullText;
        for (const b of TOP_BOXES) box.querySelector(`#set-${b.id}`).value = stagedTops[b.id];
    }
    renderStaged();

    zoom.oninput = () => {
        staged.hoverZoom = Math.round(parseFloat(zoom.value) * 10) / 10;
        zoomValue.textContent = `${staged.hoverZoom.toFixed(1)}×`;
    };
    // The live backend value, in case another tab (or a restart) moved it
    // since this page loaded. Silent on failure: an unreachable /api/settings
    // leaves the cached value showing rather than blocking the whole dialog.
    getSearchSettings().then(({ query_chunk_strategy }) => {
        loadedChunk = setQueryChunkCache(query_chunk_strategy);
        // Don't stomp a choice already clicked while the fetch was in flight.
        if (!chunkTouched) stagedChunk = loadedChunk;
        renderStaged();
    }).catch(() => { /* keep showing the cached value */ });

    box.querySelectorAll("#set-chunk button").forEach((btn) => {
        btn.onclick = () => { stagedChunk = btn.dataset.chunk; chunkTouched = true; renderStaged(); };
    });
    box.querySelectorAll("#set-tile button").forEach((btn) => {
        btn.onclick = () => {
            staged.tileSize = btn.dataset.tile;
            // Top-G's default is a property of the tile size, so picking a
            // size moves the box with it -- unless the user typed their own.
            if (!topGTouched) stagedTops["top-g"] = String(TILE_SIZES[staged.tileSize].topG);
            renderStaged();
        };
    });
    for (const b of TOP_BOXES) {
        box.querySelector(`#set-${b.id}`).oninput = (e) => {
            stagedTops[b.id] = e.target.value;
            if (b.id === "top-g") topGTouched = true;
        };
    }
    groupCheck.onchange = () => { staged.groupByVideo = groupCheck.checked; };
    fullTextCheck.onchange = () => { staged.showFullText = fullTextCheck.checked; };

    box.querySelector("#set-defaults").onclick = () => {
        Object.assign(staged, SETTINGS_DEFAULTS);
        stagedChunk = QUERY_CHUNK_DEFAULT;
        chunkTouched = true;
        const topDefaults = {
            "top-k": TOP_K_DEFAULT,
            "top-v": TOP_V_DEFAULT,
            "top-g": TILE_SIZES[staged.tileSize].topG,
        };
        for (const b of TOP_BOXES) stagedTops[b.id] = String(topDefaults[b.id]);
        topGTouched = false;
        renderStaged();
    };
    box.querySelector("#set-cancel").onclick = () => overlay.remove();
    box.querySelector("#set-save").onclick = () => {
        saveSettings(staged);
        // Only the boxes actually changed are written back -- including
        // Top-G when a new tile size moved it (see the size buttons above),
        // whether or not the current signal shows Top-G in the sidebar.
        for (const b of TOP_BOXES) {
            if (stagedTops[b.id] !== initialTops[b.id]) sidebarInput(b.id).value = stagedTops[b.id];
        }
        overlay.remove();
        // The chunking mode is the one setting that has to reach the backend
        // before the re-run, or the search would still use the old one. On a
        // failed POST the cache is left alone and the search runs unchanged,
        // rather than the UI claiming a mode the backend never took.
        if (stagedChunk !== loadedChunk) {
            setSearchSettings({ query_chunk_strategy: stagedChunk })
                .then(({ query_chunk_strategy }) => setQueryChunkCache(query_chunk_strategy))
                .catch(() => { /* backend kept its old mode; so do we */ })
                .then(() => { if (onSave) onSave(); });
            return;
        }
        if (onSave) onSave();
    };
}
