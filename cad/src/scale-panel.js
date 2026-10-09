/**
 * The Scale panel: the dimensions switch, a list of measured walls, and
 * Convert. All decisions come from scale-model.js; this file only reads the
 * page and draws.
 *
 * A wall is picked by clicking a line. Its span is the entity's own vertices
 * (set-scale.js), never the click. Each wall has its own length field; the
 * panel shows each wall's implied scale and whether several agree, before
 * Convert is pressed.
 *
 * Wall thicknesses are optional and typed: rows of [number][unit], plus "these
 * are the only ones". They ride along with the scale options; a wrong row
 * blocks Convert and names itself, exactly as a wrong wall length does.
 */
import { spanOf } from "./set-scale.js";
import { evaluateScale, evaluateThickness } from "./scale-model.js";

export function createScalePanel({ manager, el, submit, canSubmit, showPointer }) {
  const walls = [];                 // { id, start, end, text }
  const thicknesses = [];           // { text, unit }
  let exhaustive = false;
  let evidence = null;
  let dimsOn = false;
  let picking = false;
  let down = null;
  const view = () => manager.curView;

  const create = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  function setPicking(on) {
    picking = on;
    el("pickWall").classList.toggle("active", on);
    el("pickWall").textContent = on ? "Click a wall line…" : walls.length ? "Measure another wall" : "Measure a wall";
    if (on) showPointer();
  }

  /** Rebuilt only when walls are added or removed: rebuilding on every key would drop focus. */
  function buildRows() {
    el("wallRows").replaceChildren(...walls.map((wall, index) => {
      const remove = create("button", { type: "button", className: "remove", title: "Remove this wall", textContent: "×" });
      remove.addEventListener("click", () => {
        view().unhighlight([wall.id]);
        walls.splice(index, 1);
        buildRows();
        update();
      });
      const input = create("input", { type: "text", className: "wallLength", value: wall.text,
        placeholder: "its real length: 10'-6\", 12ft, 3.05m", autocomplete: "off" });
      input.addEventListener("input", () => { wall.text = input.value; update(); });
      return create("div", { className: "wallRow" },
        create("div", { className: "rowHead" }, create("span", { className: "rowTitle" }), remove),
        input,
        create("div", { className: "sub rowReadout" }));
    }));
    setPicking(picking);
  }

  function buildThicknessRows() {
    el("thicknessRows").replaceChildren(...thicknesses.map((row, index) => {
      const input = create("input", { type: "text", inputMode: "decimal", value: row.text,
        placeholder: "e.g. 9", autocomplete: "off", ariaLabel: `Wall thickness ${index + 1}` });
      input.addEventListener("input", () => { row.text = input.value; update(); });
      const unit = create("select", { ariaLabel: `Unit of thickness ${index + 1}` },
        ...["in", "mm", "cm"].map((u) => create("option", { value: u, textContent: u, selected: u === row.unit })));
      unit.addEventListener("change", () => { row.unit = unit.value; update(); });
      const remove = create("button", { type: "button", className: "remove", title: "Remove this thickness", textContent: "×" });
      remove.addEventListener("click", () => { thicknesses.splice(index, 1); buildThicknessRows(); update(); });
      return create("div", { className: "thicknessRow" }, input, unit, remove);
    }));
  }

  function update() {
    const r = evaluateScale({ walls, dimsOn, evidence });
    const t = evaluateThickness(thicknesses, exhaustive);
    // "Only these" means nothing without a valid thickness, so it clears itself.
    if (!t.exhaustiveAllowed && exhaustive) { exhaustive = false; return update(); }
    el("thicknessExhaustive").disabled = !t.exhaustiveAllowed;
    el("thicknessExhaustive").checked = exhaustive;
    el("thicknessReadout").textContent = t.problems.map((p) => p.message).join(" ");
    const sw = el("useDims");
    sw.disabled = !r.dimsAvailable;
    sw.checked = r.dimsAvailable && dimsOn;
    el("dimsReason").textContent = r.dimsReason;
    [...el("wallRows").children].forEach((row, i) => {
      const wall = walls[i], computed = r.rows[i];
      row.querySelector(".rowTitle").textContent =
        `Wall ${i + 1} · line ${wall.id} · ${computed.span.toFixed(1)} units`;
      row.querySelector(".rowReadout").textContent = computed.problem
        ?? (computed.upf ? `→ ${computed.upf.toFixed(4)} units per foot` : "");
    });
    const lines = [];
    if (r.message) lines.push(r.message);
    else if (r.upf) lines.push(`Scale: ${r.upf.toFixed(4)} units per foot${r.agreement === "agree" ? " — the walls agree" : ""}.`);
    lines.push(...r.notes);
    el("scaleReadout").textContent = lines.join(" ");
    el("convertScale").disabled = !(r.canConvert && !t.problems.length && canSubmit());
    state.result = r;
    state.thickness = t;
    return r;
  }

  function showEvidence(report) {
    evidence = report;
    const claim = report?.header?.units_per_foot;
    el("scaleEvidence").textContent = !report ? ""
      : claim ? `Its file header claims ${claim} units per foot, which is never trusted alone.`
        : "Its file header declares no units.";
    // The switch starts ON when the dimensions can carry the scale: that is
    // the one-click path, and measuring a wall still overrides it.
    dimsOn = Boolean(report?.extracted);
    update();
  }

  function reset() {
    walls.length = 0;
    thicknesses.length = 0;
    exhaustive = false;
    picking = false;
    buildRows();
    buildThicknessRows();
    showEvidence(null);
  }

  // Picking: capture-phase, so mlightcad's own selection does not also run.
  const canvas = el("cad");
  canvas.addEventListener("pointerdown", (e) => { if (picking) down = { x: e.clientX, y: e.clientY }; }, true);
  canvas.addEventListener("click", (e) => {
    if (!picking) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;   // a drag is a pan
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const at = view().screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const modelSpace = manager.curDocument.database.tables.blockTable.modelSpace;
    const reasons = [];
    for (const hit of view().pick(at, 6)) {
      if (walls.some((w) => w.id === hit.id)) { reasons.push("that wall is already measured"); continue; }
      const result = spanOf(modelSpace.getIdAt(hit.id), at);
      if (result.start) {
        walls.push({ id: hit.id, start: result.start, end: result.end, text: "" });
        view().highlight([hit.id]);
        setPicking(false);
        buildRows();
        update();
        el("wallRows").querySelector(".wallRow:last-child .wallLength").focus();
        return;
      }
      reasons.push(result.refused);
    }
    el("scaleReadout").textContent = reasons[0] ? `Not usable: ${reasons[0]}.` : "No line there; zoom in and click on a wall line.";
  }, true);

  el("pickWall").addEventListener("click", () => setPicking(!picking));
  el("useDims").addEventListener("change", () => { dimsOn = el("useDims").checked; update(); });
  el("addThickness").addEventListener("click", () => {
    thicknesses.push({ text: "", unit: "in" });
    buildThicknessRows();
    update();
    el("thicknessRows").querySelector(".thicknessRow:last-child input").focus();
  });
  el("thicknessExhaustive").addEventListener("change", () => { exhaustive = el("thicknessExhaustive").checked; update(); });
  el("convertScale").addEventListener("click", () => {
    const r = update();
    if (r.canConvert && state.thickness.options) submit({ ...r.options, ...state.thickness.options });
  });

  const state = { showEvidence, reset, update, walls, result: null, thickness: null };
  return state;
}
