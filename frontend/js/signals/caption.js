// frontend/js/signals/caption.js -- Caption signal panel (the factory's default legs).

import { searchCaption } from "../api.js";
import { makeTextSignalPanel } from "./_text_signal.js";
import { settings } from "../settings.js";

const groupMode = () => settings.groupByVideo ? "video" : null;

export const { mount, run } = makeTextSignalPanel({
    prefix: "cap",
    siglipLabel: "SigLIP2 Caption",
    fuzzyLabel: "Fuzzy Caption",
    rrfLabel: "RRF Caption",
    searchFn: searchCaption,
    groupMode,
});
