// What the Floors panel decides, with no DOM: whether every floor has been
// decided, what is sent, and what is wrong. Convert stays closed until then.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFloors } from "../cad/src/floors-model.js";

const floors = [
  { id: "floor-01", name: "Ground floor", elevation_ft: 0, elevation_source: "assumed", confidence: 0.9 },
  { id: "floor-02", name: "First floor", elevation_ft: 10, elevation_source: "assumed", confidence: 0.8 },
  { id: "floor-03", name: "Unnamed plan 3", elevation_ft: 20, elevation_source: "assumed", confidence: 0.2 },
];

test("nothing decided: not startable, and every floor is named as waiting", () => {
  const r = evaluateFloors(floors, {}, {});
  assert.equal(r.canStart, false);
  assert.deepEqual(r.undecided, ["floor-01", "floor-02", "floor-03"]);
  assert.match(r.message, /decide/i);
  assert.equal(r.payload, null);
});

test("every floor decided with one approved: startable, and the payload says so", () => {
  const r = evaluateFloors(floors, { "floor-01": true, "floor-02": true, "floor-03": false }, {});
  assert.equal(r.canStart, true);
  assert.equal(r.approved, 2);
  assert.deepEqual(r.payload, { floors: [
    { id: "floor-01", approved: true }, { id: "floor-02", approved: true }, { id: "floor-03", approved: false }] });
});

test("all disapproved is not startable: at least one floor is needed", () => {
  const r = evaluateFloors(floors, { "floor-01": false, "floor-02": false, "floor-03": false }, {});
  assert.equal(r.canStart, false);
  assert.match(r.message, /approve at least one/i);
});

test("a changed name or elevation is sent; an unchanged one is not", () => {
  const r = evaluateFloors(floors, { "floor-01": true, "floor-02": true, "floor-03": false },
    { "floor-01": { name: "Stilt", elevation: "-1.5" }, "floor-02": { name: "First floor", elevation: "10" } });
  assert.deepEqual(r.payload.floors[0], { id: "floor-01", approved: true, name: "Stilt", elevation_ft: -1.5 });
  assert.deepEqual(r.payload.floors[1], { id: "floor-02", approved: true });
});

test("a blank elevation means 'as detected', not zero", () => {
  const r = evaluateFloors(floors, { "floor-01": true, "floor-02": false, "floor-03": false },
    { "floor-01": { elevation: "" } });
  assert.deepEqual(r.payload.floors[0], { id: "floor-01", approved: true });
});

test("a bad name or elevation blocks starting and names the floor", () => {
  const decided = { "floor-01": true, "floor-02": true, "floor-03": false };
  const badElevation = evaluateFloors(floors, decided, { "floor-02": { elevation: "high" } });
  assert.equal(badElevation.canStart, false);
  assert.match(badElevation.rows[1].problem, /elevation/i);
  const outOfRange = evaluateFloors(floors, decided, { "floor-02": { elevation: "5000" } });
  assert.match(outOfRange.rows[1].problem, /-100.*2000/);
  const emptyName = evaluateFloors(floors, decided, { "floor-01": { name: "   " } });
  assert.match(emptyName.rows[0].problem, /name/i);
  const longName = evaluateFloors(floors, decided, { "floor-01": { name: "x".repeat(81) } });
  assert.match(longName.rows[0].problem, /80/);
});

test("a problem on a disapproved floor does not block the others", () => {
  const r = evaluateFloors(floors, { "floor-01": true, "floor-02": false, "floor-03": false },
    { "floor-02": { elevation: "nonsense" } });
  assert.equal(r.canStart, true);
});

test("an unnamed plan is flagged for the user to name or disapprove", () => {
  const r = evaluateFloors(floors, {}, {});
  assert.equal(r.rows[2].unnamed, true);
  assert.equal(r.rows[0].unnamed, false);
});

test("where each elevation came from is carried to the row", () => {
  const r = evaluateFloors([{ ...floors[0], elevation_source: "level-marker" }], {}, {});
  assert.equal(r.rows[0].source, "level-marker");
});
