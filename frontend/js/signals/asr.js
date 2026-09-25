// frontend/js/signals/asr.js -- ASR signal panel. Defaults/order differ
// from the other text signals on purpose: the two text legs (Fuzzy, Exact)
// come first and are on by default, SigLIP2/RRF off. Exact is ASR-only --
// Caption/Summary use the factory's default three.

import { searchAsr } from "../core/api.js";
import { makeTextSignalPanel } from "./_text_signal.js";
import { settings } from "../core/settings.js";

const groupMode = () => settings.groupByVideo ? "video" : null;

export const { mount, run } = makeTextSignalPanel({
    prefix: "asr",
    siglipLabel: "SigLIP2 ASR",
    fuzzyLabel: "Fuzzy ASR",
    exactLabel: "Exact ASR",
    rrfLabel: "RRF ASR",
    searchFn: searchAsr,
    groupMode,
    order: ["fuzzy", "exact", "siglip", "rrf"],
    defaults: { fuzzy: true, exact: true, siglip: false, rrf: false },
});
