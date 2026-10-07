/**
 * Gate: does an entity the user selects in mlightcad name the same entity in
 * archiAgent's pipeline?
 *
 * Plan: lerneanLabs-archiAgent docs/superpowers/plans/2026-10-07-mlightcad-cad-viewer.md, Task 2.
 *
 *   # in lerneanLabs-archiAgent, once per drawing:
 *   python scripts/gates/dxf_entities.py PLAN.dxf PLAN.json
 *   # here:
 *   node handle-join.mjs PLAN.dxf PLAN.json [MORE.dxf MORE.json ...]
 *
 * PLAN.json lists archiAgent's top-level SourceEntity ids (DXF handles). This
 * loads the same DXF with mlightcad's own reader (@mlightcad/data-model, the
 * one the viewer uses) and checks every LINE and LWPOLYLINE, the entities a
 * user selects to set scale:
 *
 *   - the id exists in mlightcad's model space,
 *   - it is the same kind of entity,
 *   - on the same layer,
 *   - with the same vertices (within 1e-6 of the drawing's extent; an arc
 *     segment archiAgent flattened must still pass through every vertex).
 *
 * Exits 1 if any selectable entity fails to join.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// The package's ESM build imports directories, which Node refuses; its CJS
// bundle is the same code.
const { AcDbDatabase } = createRequire(import.meta.url)("@mlightcad/data-model");

const SELECTABLE = new Set(["LINE", "LWPOLYLINE"]);

function vertices(entity) {
  if (entity.dxfTypeName === "LINE") {
    const { startPoint: a, endPoint: b } = entity;
    return [[a.x, a.y], [b.x, b.y]];
  }
  const points = [];
  for (let i = 0; i < entity.numberOfVertices; i += 1) {
    const p = entity.getPoint2dAt(i);
    points.push([p.x, p.y]);
  }
  // archiAgent repeats the first vertex to close a ring; mlightcad flags it.
  if (entity.closed && points.length) points.push(points[0]);
  return points;
}

/**
 * The viewer's vertices must appear, in order, among archiAgent's points, with
 * the same first and last point. Equal for straight segments; for a bulged
 * (arc) segment archiAgent flattens the arc into many points between the same
 * two vertices, which a strict comparison would misreport as a mismatch.
 */
function sameVertices(viewer, pipeline, tolerance) {
  const near = (a, b) => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
  if (!viewer.length || !pipeline.length) return viewer.length === pipeline.length;
  if (!near(viewer[0], pipeline[0]) || !near(viewer.at(-1), pipeline.at(-1))) return false;
  let j = 0;
  for (const v of viewer) {
    while (j < pipeline.length && !near(v, pipeline[j])) j += 1;
    if (j === pipeline.length) return false;
  }
  return true;
}

async function check(dxfPath, jsonPath) {
  const expected = JSON.parse(readFileSync(jsonPath, "utf8"));
  const bytes = readFileSync(dxfPath);
  const db = new AcDbDatabase();
  await db.read(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { readOnly: true });
  if (db.lastOpenError) throw new Error(`mlightcad could not open ${dxfPath}: ${db.lastOpenError.message}`);

  const viewer = new Map();
  for (const entity of db.tables.blockTable.modelSpace.newIterator()) viewer.set(entity.objectId, entity);

  const all = Object.values(expected.entities).flatMap((e) => e.coords);
  const span = all.length
    ? Math.max(...all.map(([x]) => x)) - Math.min(...all.map(([x]) => x)) +
      Math.max(...all.map(([, y]) => y)) - Math.min(...all.map(([, y]) => y))
    : 1;
  const tolerance = Math.max(span, 1) * 1e-6;

  const result = { file: expected.file, pipelineTop: 0, viewerTop: viewer.size, nested: expected.nested,
    anyKind: { joined: 0, missing: [] }, selectable: { total: 0, joined: 0, failures: [] } };
  for (const [id, want] of Object.entries(expected.entities)) {
    result.pipelineTop += 1;
    const got = viewer.get(id);
    if (got) result.anyKind.joined += 1;
    else result.anyKind.missing.push(`${id} ${want.kind}`);
    if (!SELECTABLE.has(want.kind)) continue;

    result.selectable.total += 1;
    const why = !got ? "absent in viewer"
      : got.dxfTypeName !== want.kind ? `viewer says ${got.dxfTypeName}`
      : got.layer !== want.layer ? `layer ${got.layer} vs ${want.layer}`
      : !sameVertices(vertices(got), want.coords, tolerance) ? "vertices differ"
      : null;
    if (why) result.selectable.failures.push(`${id} ${want.kind}: ${why}`);
    else result.selectable.joined += 1;
  }
  return result;
}

const args = process.argv.slice(2);
if (!args.length || args.length % 2) {
  console.error("usage: node handle-join.mjs PLAN.dxf PLAN.json [MORE.dxf MORE.json ...]");
  process.exit(2);
}
let failed = false;
for (let i = 0; i < args.length; i += 2) {
  const r = await check(args[i], args[i + 1]);
  const ok = r.selectable.failures.length === 0;
  failed ||= !ok;
  console.log(`${ok ? "PASS" : "FAIL"} ${r.file}: selectable ${r.selectable.joined}/${r.selectable.total} joined; ` +
    `all top-level ${r.anyKind.joined}/${r.pipelineTop} (viewer holds ${r.viewerTop}); nested excluded ${r.nested}`);
  for (const f of r.selectable.failures.slice(0, 10)) console.log(`  ✗ ${f}`);
  if (r.anyKind.missing.length) {
    console.log(`  not in viewer (non-selectable, informational): ${r.anyKind.missing.slice(0, 10).join(", ")}`);
  }
}
process.exit(failed ? 1 : 0);
