// frontend/js/util.js -- tiny shared helpers with no state/dependencies of
// their own.

// Playback timer text ("mm:ss.ss"), shared by every video surface (the
// playback dialogs and the Export tab's curation video).
export function fmtTime(t) {
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = (t % 60).toFixed(2).padStart(5, "0");
    return `${mm}:${ss}`;
}

// A per-row signal <select>, used by both TRAKE's event rows and Mixed's
// sub-query rows (each passes its own option list).
export function signalSelectHtml(id, current, options) {
    const opts = options.map((s) => `<option value="${s}"${s === current ? " selected" : ""}>${s}</option>`).join("");
    return `<select id="${id}" style="width:100%;padding:0.35rem;border:1px solid var(--border);border-radius:6px;">${opts}</select>`;
}
