/**
 * Headless check: build a real archiAgent manifest through the OpenGeometry
 * kernel in Node, with no browser. Verifies the manifest contract, the
 * extrusions, the opening booleans and the resulting meshes.
 *
 *   node scripts/smoke.mjs <path-to.interpretation.json>
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { readManifest } from "../src/manifest.js";
import { buildWalls, buildSlabs } from "../src/build-model.js";
import { solidsToBinaryStl } from "../src/export-stl.js";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("opengeometry/opengeometry_bg.wasm");

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/smoke.mjs <path-to.interpretation.json>");
  process.exit(2);
}

const { OpenGeometry, AnalyticSolid } = await import("opengeometry");

// wasm-bindgen's web target takes a URL, a Response or raw bytes. Node has no
// fetch for file:// URLs, so hand it the bytes directly.
await OpenGeometry.create({ wasmURL: await readFile(wasmPath) });

const manifest = readManifest(JSON.parse(await readFile(target, "utf8")));
console.log(`source      ${manifest.sourcePath}`);
console.log(`content     ${manifest.contentSha256.slice(0, 16)}…`);
console.log(`models      ${manifest.models.length}`);

let exitCode = 0;

for (const model of manifest.models) {
  console.log(`\n── ${model.regionId} · ${model.storeyName}`);
  console.log(`   span        ${model.spanFt[0].toFixed(1)} × ${model.spanFt[1].toFixed(1)} ft`);
  console.log(`   shift       ${model.shiftFt.map((v) => v.toFixed(1)).join(", ")} ft`);
  console.log(`   height      ${model.wallHeightFt} ft`);
  console.log(`   scale       ${model.unitsPerFoot} units/ft · verified=${model.scaleVerified} · ${model.scaleConvention}`);
  console.log(`   input       ${model.walls.length} walls, ${model.openings.length} openings, ${model.footprints.length} footprints`);

  const t0 = performance.now();
  const { solids, voids, stats } = buildWalls({ AnalyticSolid }, model);
  const { solids: slabs, skipped: slabsSkipped } = buildSlabs({ AnalyticSolid }, model);
  const elapsed = performance.now() - t0;

  const { Box3 } = await import("three");
  const world = new Box3();
  let vertices = 0;
  let triangles = 0;
  let empty = 0;
  for (const solid of [...solids, ...slabs]) {
    const geometry = solid.surface.geometry;
    const position = geometry.getAttribute("position");
    if (!position || position.count === 0) { empty += 1; continue; }
    vertices += position.count;
    triangles += (geometry.index ? geometry.index.count : position.count) / 3;
    // The kernel centres render geometry and carries placement on
    // `surface.position`, so only a world-space Box3 gives the real extent.
    solid.updateMatrixWorld(true);
    world.expandByObject(solid);
  }

  console.log(`   built       ${stats.walls} walls as ${stats.pieces} solids (${stats.skippedWalls} skipped), ${slabs.length} slabs, ${voids.length} voids in ${elapsed.toFixed(0)} ms`);
  console.log(`   openings    ${stats.openingsPlaced}/${stats.openingsRequested} placed, ${stats.openingsDropped} dropped, ${stats.fullHeightOpenings} full-height, ${stats.mergedOpenings} merged`);
  console.log(`   meshes      ${vertices} verts, ${triangles} tris, ${empty} empty`);
  console.log(`   bbox (m)    x ${world.min.x.toFixed(2)}..${world.max.x.toFixed(2)}  y ${world.min.y.toFixed(2)}..${world.max.y.toFixed(2)}  z ${world.min.z.toFixed(2)}..${world.max.z.toFixed(2)}`);

  for (const note of stats.notes.slice(0, 8)) {
    console.log(`   ! ${note.stage} wall ${note.wall}${note.opening ? ` / ${note.opening}` : ""}: ${note.message}`);
  }
  if (stats.notes.length > 8) console.log(`   … ${stats.notes.length - 8} more`);
  for (const note of slabsSkipped) console.log(`   ! slab ${note.index}: ${note.message}`);

  // A build that produced no geometry, or lost every opening, is a failure —
  // not a warning to scroll past.
  if (stats.walls === 0) { console.log("   FAIL: no wall solids"); exitCode = 1; }
  if (empty > 0) { console.log(`   FAIL: ${empty} solids tessellated to nothing`); exitCode = 1; }
  if (stats.openingsRequested > 0 && stats.openingsPlaced !== stats.openingsRequested) {
    console.log(`   FAIL: ${stats.openingsRequested - stats.openingsPlaced} openings not placed`); exitCode = 1;
  }

  const expectedY = (model.wallHeightFt + model.elevationFt) * 0.3048;
  if (Math.abs(world.max.y - expectedY) > 0.02) {
    console.log(`   FAIL: top of model is ${world.max.y.toFixed(3)} m, expected ${expectedY.toFixed(3)} m`);
    exitCode = 1;
  }
  // Solids extend half a wall thickness past the extreme centreline points.
  const maxThicknessM = Math.max(...model.walls.map((w) => w.thicknessFt)) * 0.3048;
  const expectedX = model.spanFt[0] * 0.3048;
  if (Math.abs((world.max.x - world.min.x) - expectedX) > maxThicknessM / 2 + 0.05) {
    console.log(`   FAIL: x span is ${(world.max.x - world.min.x).toFixed(2)} m, expected ${expectedX.toFixed(2)} m`);
    exitCode = 1;
  }

  // Binary STL: 80-byte header + uint32 count + 50 bytes per triangle.
  const stl = solidsToBinaryStl([...solids, ...slabs]);
  const declared = new DataView(stl.buffer).getUint32(80, true);
  const expectedBytes = 84 + declared * 50;
  console.log(`   stl         ${declared} triangles, ${(stl.byteLength / 1024).toFixed(0)} KiB`);
  if (stl.byteLength !== expectedBytes) {
    console.log(`   FAIL: STL is ${stl.byteLength} bytes, header declares ${expectedBytes}`);
    exitCode = 1;
  }
  if (declared !== Math.round(triangles)) {
    console.log(`   FAIL: STL has ${declared} triangles, meshes have ${triangles}`);
    exitCode = 1;
  }

  for (const solid of [...solids, ...voids, ...slabs]) solid.dispose();
}

console.log(exitCode === 0 ? "\nPASS" : "\nFAIL");
process.exit(exitCode);
