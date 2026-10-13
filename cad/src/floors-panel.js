/**
 * The Floors panel: one row per detected floor, to approve or disapprove, with
 * its name and elevation editable. All decisions come from floors-model.js;
 * this file only reads the page and draws.
 *
 * Detection proposes. Nothing is built until every floor has been decided and
 * one is approved; then one run per approved floor starts, in parallel.
 */
import { evaluateFloors } from "./floors-model.js";

const SOURCE_NOTE = {
  assumed: "elevation assumed: one wall height above the floor below",
  "level-marker": "elevation read from a level mark in the drawing",
  edited: "elevation set by you",
};

export function createFloorsPanel({ el, zoomTo, start }) {
  let floors = [];
  let decisions = {};
  let edits = {};
  let unit = 1;                 // drawing units per foot, to zoom the right box

  const create = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  function build() {
    el("floorRows").replaceChildren(...floors.map((floor) => {
      const name = create("input", { type: "text", value: floor.name, ariaLabel: `Name of ${floor.name}`, autocomplete: "off" });
      name.addEventListener("input", () => { (edits[floor.id] ??= {}).name = name.value; update(); });
      const elevation = create("input", { type: "text", inputMode: "decimal", value: "", autocomplete: "off",
        placeholder: String(floor.elevation_ft), ariaLabel: `Elevation of ${floor.name}, feet` });
      elevation.addEventListener("input", () => { (edits[floor.id] ??= {}).elevation = elevation.value; update(); });
      const approve = create("button", { type: "button", textContent: "Approve", className: "approve" });
      approve.addEventListener("click", () => { decisions[floor.id] = true; update(); });
      const disapprove = create("button", { type: "button", textContent: "Disapprove", className: "disapprove" });
      disapprove.addEventListener("click", () => { decisions[floor.id] = false; update(); });
      const show = create("button", { type: "button", textContent: "Show", title: "Zoom to this plan" });
      show.addEventListener("click", () => zoomTo(floor.bounds));
      const row = create("div", { className: "floorRow" },
        create("div", { className: "fields" }, name, elevation),
        create("div", { className: "why" }),
        create("div", { className: "decide" }, approve, disapprove, show),
        create("div", { className: "problem" }));
      row.dataset.floor = floor.id;          // `dataset` is read-only: it cannot go through Object.assign
      return row;
    }));
  }

  function update() {
    const r = evaluateFloors(floors, decisions, edits);
    [...el("floorRows").children].forEach((row, i) => {
      const f = r.rows[i];
      row.classList.toggle("approved", f.decision === true);
      row.classList.toggle("disapproved", f.decision === false);
      row.querySelector(".approve").classList.toggle("chosen", f.decision === true);
      row.querySelector(".disapprove").classList.toggle("chosen", f.decision === false);
      const note = f.unnamed ? "No caption was found for this plan: name it, or disapprove it if it is not a floor."
        : SOURCE_NOTE[f.source] ?? "";
      row.querySelector(".why").textContent = `${f.elevation} ft — ${note}`;
      row.querySelector(".problem").textContent = f.problem ?? "";
    });
    el("startFloors").disabled = !r.canStart;
    el("floorsReadout").textContent = r.message;
    state.result = r;
    return r;
  }

  el("startFloors").addEventListener("click", async () => {
    const r = update();
    if (!r.canStart) return;
    el("startFloors").disabled = true;
    try {
      await start(r.payload);
    } catch (error) {
      update();
      el("floorsReadout").textContent = `Could not start: ${error.message}`;
    }
  });

  const state = {
    result: null,
    show(proposed, unitsPerFoot = 1) {
      floors = proposed;
      unit = unitsPerFoot;
      decisions = {};
      edits = {};
      el("floorsSection").hidden = false;
      el("scaleSection").hidden = true;
      build();
      update();
    },
    hide() {
      el("floorsSection").hidden = true;
      el("scaleSection").hidden = false;
    },
    update,
  };
  void unit;
  return state;
}
