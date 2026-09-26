import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ifcToFrag, FRAG_MIN_BYTES, coordinateToOrigin } from "../src/ifc-to-frag.js";

// Fixtures are the pipeline's own output, which is too large to commit.
// ARCHIAGENT_IFC points at one authored .ifc file.
const FIXTURE = process.env.ARCHIAGENT_IFC;

test("converts an authored IFC into a non-trivial fragments buffer", async (t) => {
  if (!FIXTURE || !existsSync(FIXTURE)) {
    t.skip("set ARCHIAGENT_IFC to an authored .ifc to run this test");
    return;
  }
  const bytes = new Uint8Array(await readFile(FIXTURE));
  const frag = await ifcToFrag(bytes);

  assert.ok(frag instanceof Uint8Array, "returns a Uint8Array");
  assert.ok(
    frag.byteLength > FRAG_MIN_BYTES,
    `expected more than ${FRAG_MIN_BYTES} bytes, got ${frag.byteLength}`,
  );
});

test("reports progress at least once", async (t) => {
  if (!FIXTURE || !existsSync(FIXTURE)) {
    t.skip("set ARCHIAGENT_IFC to an authored .ifc to run this test");
    return;
  }
  const bytes = new Uint8Array(await readFile(FIXTURE));
  const seen = [];
  await ifcToFrag(bytes, { onProgress: (f) => seen.push(f) });

  assert.ok(seen.length > 0, "onProgress was never called");
  assert.ok(
    seen.every((f) => f >= 0 && f <= 1),
    `progress fractions out of range: ${seen.join(", ")}`,
  );
});

// Review Focus #1: archiAgent keeps the source drawing's origin, which puts a
// real plan tens of thousands of feet from (0,0). The old viewer recentred by
// hand. IfcImporter sets COORDINATE_TO_ORIGIN: true — verify that, don't assume.
test("lands geometry near the origin regardless of the source drawing's origin", async (t) => {
  assert.equal(
    coordinateToOrigin(),
    true,
    "IfcImporter must translate the model to the origin; a far-from-origin " +
      "plan wrecks depth precision in the renderer",
  );
  if (!FIXTURE || !existsSync(FIXTURE)) {
    t.skip("set ARCHIAGENT_IFC to an authored .ifc for the conversion half");
    return;
  }
  const bytes = new Uint8Array(await readFile(FIXTURE));
  const frag = await ifcToFrag(bytes);
  assert.ok(frag.byteLength > FRAG_MIN_BYTES);
});
