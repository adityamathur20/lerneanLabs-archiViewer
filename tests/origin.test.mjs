import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as WebIFC from "web-ifc";
import { webIfcSettings, wasmLocation } from "../src/ifc-to-frag.js";

/**
 * Review Focus #1, verified by behaviour rather than by reading a flag.
 *
 * archiAgent keeps the source drawing's origin, which puts a real plan tens of
 * thousands of feet from (0,0) and wrecks depth precision. The old viewer
 * recentred by hand; we deleted that code on the strength of IfcImporter's
 * COORDINATE_TO_ORIGIN default. This measures where the geometry actually
 * lands, using the same settings the importer uses.
 *
 * Point ARCHIAGENT_IFC_FAR at a far-from-origin plan. In this corpus:
 *   wallUpdate_dxfBased_ifcOutput/MR RAJEEV JI TWANI JI.ifc      (~9414)
 *   wallUpdate_dxfBased_ifcOutput/M.r Premg Agarwal  Baglow 90x50.ifc (~10608)
 * dxfBased_ifcOutput/Floor Plan.ifc is ALREADY at the origin and cannot fail
 * this test, which is why it is not the default here.
 */
const FAR = process.env.ARCHIAGENT_IFC_FAR;

/** Largest absolute X/Z element placement in the model, in metres. */
async function maxPlacement(bytes, coordinateToOrigin) {
  const api = new WebIFC.IfcAPI();
  const { path: wasmPath, absolute } = wasmLocation();
  api.SetWasmPath(wasmPath, absolute);
  await api.Init();
  const modelID = api.OpenModel(bytes, { ...webIfcSettings(), COORDINATE_TO_ORIGIN: coordinateToOrigin });
  let max = 0;
  api.StreamAllMeshes(modelID, (mesh) => {
    for (let i = 0; i < mesh.geometries.size(); i++) {
      const t = mesh.geometries.get(i).flatTransformation;
      max = Math.max(max, Math.abs(t[12]), Math.abs(t[14]));
    }
  });
  api.CloseModel(modelID);
  return max;
}

test("a far-from-origin plan is recentred before it reaches the renderer", async (t) => {
  if (!FAR || !existsSync(FAR)) {
    t.skip("set ARCHIAGENT_IFC_FAR to a plan that is far from the origin");
    return;
  }
  const bytes = new Uint8Array(await readFile(FAR));

  const raw = await maxPlacement(bytes, false);
  assert.ok(
    raw > 1000,
    `ARCHIAGENT_IFC_FAR must actually be far from the origin to test anything; ` +
      `this one peaks at ${raw.toFixed(0)}. Pick a different fixture.`,
  );

  const recentred = await maxPlacement(bytes, true);
  assert.ok(
    recentred < raw / 10,
    `geometry was not recentred: ${raw.toFixed(0)} -> ${recentred.toFixed(0)}`,
  );
});
