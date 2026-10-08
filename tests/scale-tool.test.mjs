// The Drawing view's scale tool must read lengths exactly as archiAgent does,
// or the browser would show a scale the run then refuses (or worse, computes
// differently). Expected values were produced by archiAgent itself; regenerate
// tests/fixtures/lengths.json from parse_explicit_length when it changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nearestStraightSegment, parseLength, spanOf, unitFactorHint } from "../cad/src/set-scale.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/lengths.json", import.meta.url), "utf8"));

for (const [text, feet] of Object.entries(fixture.feet)) {
  test(`parseLength(${JSON.stringify(text)}) matches archiAgent`, () => {
    const got = parseLength(text);
    if (feet === null) assert.equal(got, null);
    else assert.ok(Math.abs(got - feet) < 1e-9, `${got} vs ${feet}`);
  });
}

test("a LINE's span is its own endpoints, wherever the click landed", () => {
  const line = { dxfTypeName: "LINE", startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 144, y: 0, z: 0 } };
  assert.deepEqual(spanOf(line, { x: 50.3, y: 2.1 }), { start: { x: 0, y: 0 }, end: { x: 144, y: 0 } });
});

test("a polyline gives the straight segment nearest the click", () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
  assert.deepEqual(nearestStraightSegment(pts, [0, 0, 0, 0], true, { x: 99, y: 30 }),
    { start: { x: 100, y: 0 }, end: { x: 100, y: 50 }, segment: 1 });
  // The closing segment of a closed polyline is a candidate too.
  assert.equal(nearestStraightSegment(pts, [0, 0, 0, 0], true, { x: 1, y: 25 }).segment, 3);
});

test("an arc segment is refused, not measured as its chord", () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  assert.equal(nearestStraightSegment(pts, [0.5, 0], false, { x: 50, y: 1 }), null);
  const poly = { dxfTypeName: "LWPOLYLINE", numberOfVertices: 2, closed: false,
    getPoint2dAt: (i) => pts[i], _geo: { vertices: [{ bulge: 0.5 }, { bulge: 0 }] } };
  assert.match(spanOf(poly, { x: 50, y: 1 }).refused, /arc/);
});

test("a polyline whose segments cannot be read is refused rather than guessed", () => {
  const poly = { dxfTypeName: "LWPOLYLINE", numberOfVertices: 2, closed: false, getPoint2dAt: () => ({ x: 0, y: 0 }) };
  assert.match(spanOf(poly, { x: 0, y: 0 }).refused, /plain line/);
});

test("anything else is not a wall line", () => {
  assert.match(spanOf({ dxfTypeName: "CIRCLE" }, { x: 0, y: 0 }).refused, /CIRCLE/);
  assert.match(spanOf(undefined, { x: 0, y: 0 }).refused, /nothing/);
});

test("a unit-sized disagreement is named as archiAgent names it", () => {
  assert.match(unitFactorHint(12.01), /feet read as inches/);
  assert.match(unitFactorHint(25.4), /millimetres read as inches/);
  assert.equal(unitFactorHint(3), "");
});
