// frontend/js/dialogs/base.js -- the generic modal every dialog is built
// on: overlay + box + close button, mounted into #dialog-root.

const root = document.getElementById("dialog-root");

// `title` may be falsy (null/"") to omit the heading entirely -- used by
// the playback dialogs, which put video_id/frame/timer info beside the
// video instead of needing a heading above it. The close button is
// absolutely positioned (not floated) specifically so it works the same
// way whether or not a title/h3 is present.
export function openDialog(title, bodyEl, { wide = false } = {}) {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    const box = document.createElement("div");
    box.className = "dialog-box" + (wide ? " wide" : "");
    const closeBtn = document.createElement("button");
    closeBtn.className = "dialog-close";
    closeBtn.textContent = "✕";
    closeBtn.onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    box.append(closeBtn);
    if (title) {
        const h3 = document.createElement("h3");
        h3.textContent = title;
        box.append(h3);
    }
    box.append(bodyEl);
    overlay.append(box);
    root.append(overlay);
    return { overlay, box };
}
