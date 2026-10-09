/**
 * What the Scale panel decides, with no DOM: which scale a run will use,
 * whether Convert may be pressed, what is sent, and what to tell the user.
 *
 * Walls agree by archiAgent's own rule (verify.scale_from_reviewed), pinned by
 * tests/fixtures/agreement.json, so the panel never promises a scale the run
 * then refuses.
 */
import { parseLength, unitFactorHint } from "./set-scale.js";

/** archiAgent's --scale-tolerance-in default. */
export const TOLERANCE_IN = 2.0;

/**
 * Median of the spans' implied scales; every span must reproduce its stated
 * length within the tolerance at that scale. `scale` is null on disagreement.
 */
export function wallsAgree(walls, toleranceIn = TOLERANCE_IN) {
  const ratios = walls.map((w) => w.span / w.feet).sort((a, b) => a - b);
  if (!ratios.length) return { scale: null, median: null };
  const median = ratios[Math.floor(ratios.length / 2)];
  const consistent = walls.every((w) => Math.abs(w.span / median - w.feet) * 12 <= toleranceIn);
  return { scale: consistent ? median : null, median };
}

const spread = (values) => Math.max(...values) / Math.min(...values);

function comparison(upf, name, other) {
  if (!other) return null;
  const ratio = Math.max(upf, other) / Math.min(upf, other);
  if (ratio <= 1.02) return null;
  const hint = unitFactorHint(ratio);
  return `Differs from ${name} (${other} units per foot) by ×${ratio.toFixed(3)}${hint ? ` — ${hint}` : ""}.`;
}

/**
 * @param {{walls: {id: string, start: {x,y}, end: {x,y}, text: string}[],
 *          dimsOn: boolean, evidence: object|null}} input  `evidence` is plan.scale.json.
 */
export function evaluateScale({ walls, dimsOn, evidence }) {
  const extracted = evidence?.extracted ?? null;
  const dimsAvailable = Boolean(extracted);
  const dimsReason = extracted
    ? `Its own dimensions imply ${extracted.units_per_foot} units per foot (${extracted.support} agree).`
    : evidence?.dimensions
      ? `Its ${evidence.dimensions} dimensions carry no readable length, so they establish no scale.`
      : "This drawing has no dimensions.";

  const rows = walls.map((w) => {
    const span = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    const text = (w.text ?? "").trim();
    const feet = text ? parseLength(text) : null;
    return {
      id: w.id, span, text, feet,
      upf: feet && span > 0 ? span / feet : null,
      problem: text && feet === null ? `"${text}" is not a length. Try 10'-6", 12ft, 3.05m or 3050mm.` : null,
    };
  });

  const result = { rows, dimsAvailable, dimsReason, upf: null, options: null, canConvert: false,
    agreement: null, notes: [], message: "" };
  const useDims = dimsOn && dimsAvailable;

  if (!rows.length) {
    if (useDims) {
      Object.assign(result, { upf: extracted.units_per_foot, options: { trust_extracted_scale: true }, canConvert: true });
    } else {
      result.message = dimsAvailable
        ? "Use the drawing's dimensions, or measure a wall: click it, then type its real length."
        : "Measure a wall: click it, then type its real length.";
    }
    return result;
  }

  const bad = rows.findIndex((r) => r.problem);
  const missing = rows.findIndex((r) => !r.feet);
  if (bad >= 0) result.message = `Fix the length of wall ${bad + 1}.`;
  else if (missing >= 0) result.message = `Type the real length of wall ${missing + 1}.`;
  if (missing >= 0) return result;

  const verdict = wallsAgree(rows.map((r) => ({ span: r.span, feet: r.feet })));
  if (rows.length > 1) result.agreement = verdict.scale === null ? "disagree" : "agree";
  if (verdict.scale === null) {
    const factor = spread(rows.map((r) => r.upf));
    const hint = unitFactorHint(factor);
    result.message = `The measured walls disagree on the scale by ×${factor.toFixed(3)}${hint ? ` — ${hint}` : ""}. Check the lengths or the units.`;
    return result;
  }

  result.upf = verdict.scale;
  result.options = {
    scale_from_wall: rows.map((r, i) => ({
      x1: walls[i].start.x, y1: walls[i].start.y, x2: walls[i].end.x, y2: walls[i].end.y, length: r.text,
    })),
    ...(useDims ? { trust_extracted_scale: true } : {}),
  };
  result.canConvert = true;
  for (const note of [comparison(verdict.scale, "the drawing's dimensions", extracted?.units_per_foot),
    comparison(verdict.scale, "the file header", evidence?.header?.units_per_foot)]) {
    if (note) result.notes.push(note);
  }
  return result;
}
