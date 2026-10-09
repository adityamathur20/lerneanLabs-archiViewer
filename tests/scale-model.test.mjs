// The scale panel's decisions, with no DOM: which scale a run will use, whether
// Convert may be pressed, and what is sent. Agreement between several walls is
// pinned to archiAgent's own answers (tests/fixtures/agreement.json, generated
// by scale_from_reviewed), so the browser can never promise a scale the run
// then refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateScale, evaluateThickness, wallsAgree } from "../cad/src/scale-model.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/agreement.json", import.meta.url), "utf8"));

for (const [name, c] of Object.entries(fixture.cases)) {
  test(`walls agree exactly as archiAgent says: ${name}`, () => {
    const verdict = wallsAgree(c.walls, fixture.tolerance_in);
    if (c.refused) assert.equal(verdict.scale, null, `${name} should be refused`);
    else assert.ok(Math.abs(verdict.scale - c.scale) < 1e-9, `${verdict.scale} vs ${c.scale}`);
  });
}

const wall = (id, units, text) => ({ id, start: { x: 0, y: 0 }, end: { x: units, y: 0 }, text });
const dimensions = { header: { units_per_foot: 12 }, extracted: { units_per_foot: 12, support: 159 }, dimensions: 424 };
const noDimensions = { header: { units_per_foot: 12 }, extracted: null, dimensions: 37 };

test("with nothing chosen, Convert is not available and it says why", () => {
  const r = evaluateScale({ walls: [], dimsOn: false, evidence: noDimensions });
  assert.equal(r.canConvert, false);
  assert.match(r.message, /measure a wall/i);
});

test("the dimensions switch alone is enough when they establish a scale", () => {
  const r = evaluateScale({ walls: [], dimsOn: true, evidence: dimensions });
  assert.equal(r.canConvert, true);
  assert.deepEqual(r.options, { trust_extracted_scale: true });
  assert.equal(r.upf, 12);
});

test("the switch cannot be on when the dimensions establish nothing", () => {
  const r = evaluateScale({ walls: [], dimsOn: true, evidence: noDimensions });
  assert.equal(r.dimsAvailable, false);
  assert.equal(r.canConvert, false);
  assert.match(r.dimsReason, /no text|no dimensions|establish/i);
});

test("the switch explains itself when it is available", () => {
  const r = evaluateScale({ walls: [], dimsOn: false, evidence: dimensions });
  assert.equal(r.dimsAvailable, true);
  assert.match(r.dimsReason, /12 units per foot.*159/);
});

test("one measured wall sets the scale and sends exactly its vertices", () => {
  const r = evaluateScale({ walls: [wall("A", 1080, "90ft")], dimsOn: false, evidence: noDimensions });
  assert.equal(r.canConvert, true);
  assert.equal(r.upf, 12);
  assert.deepEqual(r.options, { scale_from_wall: [{ x1: 0, y1: 0, x2: 1080, y2: 0, length: "90ft" }] });
});

test("a wall with no length typed yet is not ready, and is not an error", () => {
  const r = evaluateScale({ walls: [wall("A", 1080, "")], dimsOn: false, evidence: noDimensions });
  assert.equal(r.canConvert, false);
  assert.equal(r.rows[0].problem, null);
  assert.match(r.message, /length/i);
});

test("a length that is not one is named, per row", () => {
  const r = evaluateScale({ walls: [wall("A", 1080, "ninety")], dimsOn: false, evidence: noDimensions });
  assert.equal(r.canConvert, false);
  assert.match(r.rows[0].problem, /not a length/);
});

test("two agreeing walls convert, and both are sent", () => {
  const r = evaluateScale({ walls: [wall("A", 1080, "90ft"), wall("B", 1440, "120ft")], dimsOn: false, evidence: noDimensions });
  assert.equal(r.canConvert, true);
  assert.equal(r.options.scale_from_wall.length, 2);
  assert.equal(r.agreement, "agree");
});

test("two disagreeing walls block Convert and name the factor", () => {
  const r = evaluateScale({ walls: [wall("A", 1080, "90ft"), wall("B", 27432, "90ft")], dimsOn: false, evidence: noDimensions });
  assert.equal(r.canConvert, false);
  assert.equal(r.agreement, "disagree");
  assert.match(r.message, /disagree/i);
  assert.match(r.message, /millimetres read as inches/);
});

test("a measured wall that contradicts the dimensions is reported, not hidden", () => {
  const r = evaluateScale({ walls: [wall("A", 1080, "90ft")], dimsOn: true, evidence: { ...dimensions, extracted: { units_per_foot: 304.8, support: 5 } } });
  assert.equal(r.canConvert, true);
  assert.ok(r.notes.some((n) => /dimensions/.test(n) && /×25\.4/.test(n)), r.notes.join("|"));
});

test("with both given, both are sent: the wall sets the scale, the dimensions are the check", () => {
  const r = evaluateScale({ walls: [wall("A", 1080, "90ft")], dimsOn: true, evidence: dimensions });
  assert.equal(r.options.trust_extracted_scale, true);
  assert.equal(r.options.scale_from_wall.length, 1);
  assert.equal(r.upf, 12);
});

test("the header is compared too, and never trusted alone", () => {
  const r = evaluateScale({ walls: [wall("A", 25.4 * 1080, "90ft")], dimsOn: false, evidence: noDimensions });
  assert.ok(r.notes.some((n) => /header/.test(n)), r.notes.join("|"));
});

// --- wall thickness (optional, typed) ----------------------------------------

const row = (text, unit = "in") => ({ text, unit });

test("no thickness rows send nothing and block nothing", () => {
  const r = evaluateThickness([], false);
  assert.deepEqual(r.options, {});
  assert.deepEqual(r.problems, []);
  assert.equal(r.exhaustiveAllowed, false);
});

test("an empty row is ignored, not an error", () => {
  const r = evaluateThickness([row(""), row("   "), row("9")], false);
  assert.deepEqual(r.inches, [9]);
  assert.deepEqual(r.problems, []);
});

test("inches are the default and are sent as they are, sorted", () => {
  const r = evaluateThickness([row("9"), row("4.5")], false);
  assert.deepEqual(r.options, { wall_thickness_in: [4.5, 9] });
});

test("4.5 in, 114.3 mm and 11.43 cm are one thickness", () => {
  const r = evaluateThickness([row("4.5"), row("114.3", "mm"), row("11.43", "cm")], false);
  assert.deepEqual(r.inches, [4.5]);
  assert.deepEqual(r.problems, []);
});

test("values within 0.01 in are one thickness; 0.02 in apart are two", () => {
  assert.deepEqual(evaluateThickness([row("4.5"), row("4.505")], false).inches, [4.5]);
  assert.deepEqual(evaluateThickness([row("4.5"), row("4.52")], false).inches, [4.5, 4.52]);
});

test("a row that is not a number, is not above zero, or exceeds 48 in names its row", () => {
  for (const [text, unit] of [["thick", "in"], ["0", "in"], ["-4", "in"], ["48.5", "in"], ["1220", "mm"], ["1e1", "in"]]) {
    const r = evaluateThickness([row("9"), row(text, unit)], false);
    assert.equal(r.problems.length, 1, `${text} ${unit}`);
    assert.equal(r.problems[0].index, 1);
    assert.match(r.problems[0].message, /thickness 2/i);
  }
});

test("48 in is the largest accepted", () => {
  assert.deepEqual(evaluateThickness([row("48")], false).inches, [48]);
  assert.deepEqual(evaluateThickness([row("1219.2", "mm")], false).inches, [48]);
});

test("a problem row keeps the options out of the way, so Convert cannot send half a set", () => {
  const r = evaluateThickness([row("9"), row("x")], true);
  assert.equal(r.options, null);
});

test("more than six distinct thicknesses is refused with the limit named", () => {
  const r = evaluateThickness(["1", "2", "3", "4", "5", "6", "7"].map((t) => row(t)), false);
  assert.match(r.problems[0].message, /at most 6/i);
});

test("exhaustive is available only once a valid thickness exists, and only sent then", () => {
  assert.equal(evaluateThickness([row("")], true).exhaustiveAllowed, false);
  assert.deepEqual(evaluateThickness([row("")], true).options, {});
  const r = evaluateThickness([row("9")], true);
  assert.equal(r.exhaustiveAllowed, true);
  assert.deepEqual(r.options, { wall_thickness_in: [9], wall_thickness_exhaustive: true });
  assert.deepEqual(evaluateThickness([row("9")], false).options, { wall_thickness_in: [9] });
});

test("a typo in one row does not take 'only these' away from the valid ones", () => {
  const r = evaluateThickness([row("9"), row("x")], true);
  assert.equal(r.exhaustiveAllowed, true);
  assert.equal(r.options, null);          // but nothing is sent until the row is fixed
});
