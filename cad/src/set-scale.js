/**
 * Picking a wall for the scale: the user clicks a line and states its real length.
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
