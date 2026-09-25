// frontend/js/dialogs/weights.js -- Mixed signal weights + legs editor
// (the shared mixedConfig TRAKE's "Mixed" event option uses).

import {
    MIXED_DEFAULT_LEGS, MIXED_DEFAULT_WEIGHTS, MIXED_LEG_DEFS, MIXED_SIGNAL_NAMES,
    mixedConfig, saveMixedConfig,
} from "../core/state.js";
import { openDialog } from "./base.js";

// "Change weights" dialog. Edits a staged copy so Cancel discards changes;
// Save commits into the one shared mixedConfig (state.js) and persists it.
// `onSave` lets the caller (a TRAKE "Mixed" event row) re-run its search
// after a Save.
export function openWeightsDialog(onSave) {
    const staged = {
        weights: { ...mixedConfig.weights },
        legs: { ...mixedConfig.legs },
    };

    const body = document.createElement("div");
    body.innerHTML = `<div class="thumb-caption muted" style="margin-bottom:0.5rem;">Weight per signal (0 = off) with that signal's legs alongside</div>
        <div id="weights-rows"></div>
        <hr class="divider">
        <div style="display:flex;gap:0.5rem;">
          <button class="btn" id="weights-default">Default</button>
          <button class="btn" id="weights-cancel">Cancel</button>
          <button class="btn btn-primary" id="weights-save">Save</button>
        </div>`;
    const { overlay, box } = openDialog("Change weights", body);
    const rows = box.querySelector("#weights-rows");

    function renderRows() {
        rows.innerHTML = "";
        for (const name of MIXED_SIGNAL_NAMES) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:1rem;margin:0.5rem 0;";
            const label = document.createElement("label");
            label.style.cssText = "flex:0 0 90px;margin:0;";
            label.textContent = `${name} (${staged.weights[name]})`;
            const slider = document.createElement("input");
            slider.type = "range";
            slider.min = "0"; slider.max = "3"; slider.step = "1";
            slider.value = staged.weights[name];
            slider.style.flex = "1 1 auto";
            slider.oninput = () => {
                staged.weights[name] = parseInt(slider.value, 10);
                label.textContent = `${name} (${staged.weights[name]})`;
            };
            row.append(label, slider);

            const legsBox = document.createElement("div");
            legsBox.style.cssText = "flex:0 0 200px;display:flex;flex-direction:column;gap:0.15rem;";
            if (MIXED_LEG_DEFS[name]) {
                for (const [legKey, legLabel] of MIXED_LEG_DEFS[name]) {
                    const cbRow = document.createElement("label");
                    cbRow.style.cssText = "display:flex;align-items:center;gap:0.3rem;font-size:0.85rem;margin:0;";
                    const cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = staged.legs[legKey];
                    cb.onchange = () => { staged.legs[legKey] = cb.checked; };
                    cbRow.append(cb, document.createTextNode(legLabel));
                    legsBox.append(cbRow);
                }
            } else {
                legsBox.innerHTML = `<span class="thumb-caption muted">Detailed legs</span>`;
            }
            row.append(legsBox);
            rows.append(row);
        }
    }
    renderRows();

    box.querySelector("#weights-default").onclick = () => {
        staged.weights = { ...MIXED_DEFAULT_WEIGHTS };
        staged.legs = { ...MIXED_DEFAULT_LEGS };
        renderRows();
    };
    box.querySelector("#weights-cancel").onclick = () => overlay.remove();
    box.querySelector("#weights-save").onclick = () => {
        mixedConfig.weights = staged.weights;
        mixedConfig.legs = staged.legs;
        saveMixedConfig();
        overlay.remove();
        if (onSave) onSave();
    };
}
