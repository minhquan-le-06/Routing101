// frontend/js/signals/summary.js -- Summary signal panel. Video-level, not
// frame-level: one result per video, so its "group by" groups by
// collection (lot) instead of by video.

import { searchSummary } from "../core/api.js";
import { makeTextSignalPanel } from "./_text_signal.js";
import { settings, setGroupByUi } from "../core/settings.js";

const groupMode = () => settings.groupByVideo ? "collection" : null;

export const { mount: baseMount, run } = makeTextSignalPanel({
    prefix: "sum",
    siglipLabel: "SigLIP2 Summary",
    fuzzyLabel: "Fuzzy Summary",
    rrfLabel: "RRF Summary",
    searchFn: searchSummary,
    groupMode,
});

// Same group-by toggle everywhere (now in the Settings dialog), but its
// label/meaning flips to "Group by collection" for Summary specifically --
// the same toggle relabeled on mount/unmount rather than a Summary-only
// setting.
const SUMMARY_LABEL = "Group by collection";

export function mount(controlsEl) {
    setGroupByUi({ label: SUMMARY_LABEL });
    baseMount(controlsEl);
}

export function unmount() {
    setGroupByUi();
}
