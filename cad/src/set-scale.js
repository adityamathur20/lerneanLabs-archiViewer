/**
 * Set scale from one wall: the user clicks a line and states its real length.
 *
 * The span comes from the picked entity's OWN vertices -- a LINE's endpoints,
 * or the straight LWPOLYLINE segment nearest the click -- never from where the
 * cursor landed, so click precision does not matter. Arcs are refused: a
 * chord is not a wall length. The result is exactly archiAgent's
 * `--scale-from-wall X1 Y1 X2 Y2 LENGTH`, in the drawing's own coordinates.
 *
 * Plan: lerneanLabs-archiAgent docs/superpowers/plans/2026-10-08-scale-tool-and-symbol-approval.md, A4.
 */

// --- lengths: a port of archiagent.scale.verify.parse_explicit_length --------
// Kept in step by tests/scale-tool.test.mjs against values archiAgent itself
// produced (tests/fixtures/lengths.json).

const VULGAR = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const FEET_INCHES = new RegExp(
  "^(\\d{1,3})\\s*'\\s*-?\\s*" +
  "(?:(\\d{1,2})\\s*)?" +
  `(?:([${Object.keys(VULGAR).join("")}])|(\\d{1,2})\\s*/\\s*(\\d{1,2}))?` +
  "\\s*[\"']?$",
  "u",
);
const MIN_FEET = 0.5;
const MAX_FEET = 500;
const UNIT_FEET = { mm: 1 / 304.8, cm: 1 / 30.48, m: 1 / 0.3048, ft: 1, in: 1 / 12 };

function parseDimension(text) {
  const t = text.trim().toUpperCase().replace(/X+$/, "").trim();
  const m = FEET_INCHES.exec(t);
  if (!m) return null;
  let feet = Number(m[1]);
  let inches = m[2] !== undefined ? Number(m[2]) : 0;
  if (m[3] !== undefined) inches += VULGAR[m[3]];
  else if (m[4] !== undefined) {
    const denominator = Number(m[5]);
    if (denominator === 0) return null;
    inches += Number(m[4]) / denominator;
  }
  if (inches >= 12) return null;
  feet += inches / 12;
  return feet >= MIN_FEET && feet <= MAX_FEET ? feet : null;
}

/** Feet, or null. A bare number such as `10` is refused: archiAgent needs a unit or a foot mark. */
export function parseLength(text) {
  if (typeof text !== "string") return null;
  const feet = parseDimension(text);
  if (feet !== null) return feet;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|ft|in)\s*$/i.exec(text);
  if (m) {
    const value = Number(m[1]) * UNIT_FEET[m[2].toLowerCase()];
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

/** archiAgent's wording for a ratio that looks like a unit confusion (cli._unit_factor_hint). */
export function unitFactorHint(ratio) {
  for (const [factor, text] of [[25.4, "millimetres read as inches"], [12, "feet read as inches"],
    [304.8, "millimetres read as feet"], [30.48, "centimetres read as feet"], [2.54, "centimetres read as inches"]]) {
    if (Math.abs(ratio - factor) / factor <= 0.01) return `that is ${factor}, which usually means ${text}`;
  }
  return "";
}

// --- geometry ---------------------------------------------------------------------

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * The straight segment of a polyline nearest `p`, or null when the nearest is
 * an arc (bulge != 0). `bulges[i]` belongs to the segment from vertex i.
 */
export function nearestStraightSegment(points, bulges, closed, p) {
  let best = null;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    const d = distanceToSegment(p, a, b);
    if (!best || d < best.d) best = { d, a, b, straight: !(bulges[i] ?? 0), index: i };
  }
  if (!best) return null;
  return best.straight ? { start: best.a, end: best.b, segment: best.index } : null;
}

/** The span to assert for a picked entity, or a reason it cannot be one. */
export function spanOf(entity, at) {
  const type = entity?.dxfTypeName;
  if (type === "LINE") {
    const { startPoint: a, endPoint: b } = entity;
    return { start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y } };
  }
  if (type === "LWPOLYLINE") {
    // mlightcad 1.7.4 exposes a vertex's bulge only through its private
    // geometry; pinned exactly. Unreadable -> refuse rather than risk an arc.
    const vertices = entity._geo?.vertices;
    if (!Array.isArray(vertices)) return { refused: "this polyline's segments cannot be read; pick a plain line" };
    const points = [];
    for (let i = 0; i < entity.numberOfVertices; i += 1) {
      const q = entity.getPoint2dAt(i);
      points.push({ x: q.x, y: q.y });
    }
    const seg = nearestStraightSegment(points, vertices.map((v) => v?.bulge ?? 0), entity.closed, at);
    return seg ?? { refused: "that is an arc; pick a straight wall line" };
  }
  return { refused: type ? `a ${type} is not a wall line; pick a LINE or polyline` : "nothing there" };
}

// --- the tool ---------------------------------------------------------------------

/**
 * Wires the "Set scale" panel. `evidence` is plan.scale.json (or null);
 * `submit(options)` starts the job with archiAgent StartRequest options.
 */
export function createScaleTool({ manager, el, submit, canSubmit }) {
  let picking = false;
  let picked = null;          // { id, start, end }
  let evidence = null;
  let down = null;

  const view = () => manager.curView;
  const span = () => (picked ? Math.hypot(picked.end.x - picked.start.x, picked.end.y - picked.start.y) : 0);

  function setPicking(on) {
    picking = on;
    el("pickWall").classList.toggle("active", on);
    el("pickWall").textContent = on ? "Click a wall line…" : "Measure a wall";
  }

  function render() {
    const feet = parseLength(el("wallLength").value);
    const parts = [];
    if (picked) parts.push(`Selected line ${picked.id}: ${span().toFixed(3)} drawing units long.`);
    let upf = null;
    if (picked && feet) {
      upf = span() / feet;
      parts.push(`→ ${upf.toFixed(4)} drawing units per foot.`);
      const header = evidence?.header?.units_per_foot;
      const dims = evidence?.extracted?.units_per_foot;
      for (const [name, other] of [["the drawing's dimensions", dims], ["the file header", header]]) {
        if (!other) continue;
        const ratio = Math.max(upf, other) / Math.min(upf, other);
        if (ratio > 1.02) {
          const hint = unitFactorHint(ratio);
          parts.push(`Differs from ${name} (${other}) by ×${ratio.toFixed(3)}${hint ? ` — ${hint}` : ""}.`);
        }
      }
    } else if (picked && el("wallLength").value.trim()) {
      parts.push(`"${el("wallLength").value}" is not a length. Try 10'-6", 12ft, 3.05m or 3050mm.`);
    }
    el("scaleReadout").textContent = parts.join(" ");
    el("useWall").disabled = !(picked && feet && canSubmit());
    state.scale = { picked, feet, upf };
  }

  function showEvidence(report) {
    evidence = report;
    const header = report?.header;
    const ex = report?.extracted;
    el("scaleEvidence").textContent = !report ? "" : [
      ex ? `This drawing's own dimensions imply ${ex.units_per_foot} units per foot (${ex.support} agree).`
        : `This drawing has no dimensions that establish a scale (${report.dimensions} found). Measure a wall.`,
      header?.units_per_foot ? `Its header claims ${header.units_per_foot} units per foot, which is never trusted alone.`
        : "Its header declares no units.",
    ].join(" ");
    el("useDims").hidden = !ex;
    el("useDims").disabled = !(ex && canSubmit());
    render();
  }

  // Picking: capture-phase, so mlightcad's own selection does not also run.
  const canvas = el("cad");
  canvas.addEventListener("pointerdown", (e) => {
    if (picking) down = { x: e.clientX, y: e.clientY };
  }, true);
  canvas.addEventListener("click", (e) => {
    if (!picking) return;
    // A drag is a pan, not a pick.
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const at = view().screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const modelSpace = manager.curDocument.database.tables.blockTable.modelSpace;
    const reasons = [];
    for (const hit of view().pick(at, 6)) {
      const entity = modelSpace.getIdAt(hit.id);
      const result = spanOf(entity, at);
      if (result.start) {
        if (picked) view().unhighlight([picked.id]);
        picked = { id: hit.id, ...result };
        view().highlight([hit.id]);
        setPicking(false);
        render();
        el("wallLength").focus();
        return;
      }
      reasons.push(result.refused);
    }
    el("scaleReadout").textContent = reasons[0] ? `Not usable: ${reasons[0]}.` : "No line there; zoom in and click on a wall line.";
  }, true);

  el("pickWall").addEventListener("click", () => setPicking(!picking));
  el("wallLength").addEventListener("input", render);
  el("useWall").addEventListener("click", () => {
    const { start, end } = picked;
    submit({ scale_from_wall: [{ x1: start.x, y1: start.y, x2: end.x, y2: end.y, length: el("wallLength").value.trim() }] });
  });
  el("useDims").addEventListener("click", () => submit({ trust_extracted_scale: true }));

  const state = { showEvidence, render, get picked() { return picked; } };
  return state;
}
