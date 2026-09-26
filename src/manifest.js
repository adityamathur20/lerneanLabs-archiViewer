/**
 * Reads an archiAgent frozen-interpretation manifest
 * (`<outputDir>/<name>.interpretation.json`) and normalises it into a
 * build-ready plan: metres, origin-centred, walls indexed so that
 * `opening.host_wall_index` still resolves.
 */

export const FT_TO_M = 0.3048;

const KIND = "archiagent.frozen-interpretation";

function fail(message) {
  throw new Error(`manifest: ${message}`);
}

function finitePair(value, where) {
  if (!Array.isArray(value) || value.length !== 2) fail(`${where} must be [x, y]`);
  const [x, y] = value;
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`${where} must be finite`);
  return [x, y];
}

/**
 * archiAgent writes plan coordinates in feet but keeps the source drawing's
 * origin, so a real plan sits tens of thousands of feet from (0,0). Three.js
 * depth precision and OrbitControls both degrade badly there, and IFC files
 * with that offset baked in are painful downstream — so recentre once, here,
 * and keep the shift for anyone who needs to map back to source coordinates.
 */
function planBounds(model) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = ([x, y]) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const wall of model.walls) {
    visit(wall.start);
    visit(wall.end);
  }
  for (const region of [...model.footprints, ...model.spaces]) {
    for (const point of region.boundary) visit(point);
  }
  if (!Number.isFinite(minX)) fail("model has no coordinates to bound");
  return { minX, minY, maxX, maxY };
}

export function readManifest(raw) {
  if (!raw || typeof raw !== "object") fail("not an object");
  if (raw.kind !== KIND) fail(`unexpected kind ${JSON.stringify(raw.kind)}`);
  if (raw.coordinate_system !== "model-feet") {
    fail(`unsupported coordinate_system ${JSON.stringify(raw.coordinate_system)}`);
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) fail("no models");

  const models = raw.models.map((model, index) => readModel(model, index));

  return {
    sourcePath: String(raw.models[0].source_path ?? ""),
    sourceSha256: String(raw.source_sha256 ?? ""),
    contentSha256: String(raw.content_sha256 ?? ""),
    schemaVersion: raw.schema_version,
    accuracy: String(raw.accuracy ?? ""),
    unresolved: Array.isArray(raw.unresolved) ? raw.unresolved : [],
    models,
  };
}

function readModel(model, index) {
  const walls = (model.walls ?? []).map((wall, i) => ({
    index: i,
    start: finitePair(wall.start, `wall[${i}].start`),
    end: finitePair(wall.end, `wall[${i}].end`),
    thicknessFt: Number(wall.thickness_ft),
    layer: String(wall.source_layer ?? ""),
    detector: String(wall.detector ?? ""),
    thicknessSource: String(wall.thickness_source ?? ""),
    sourceIds: wall.source_ids ?? [],
  }));

  for (const wall of walls) {
    if (!(wall.thicknessFt > 0)) fail(`wall[${wall.index}] thickness must be positive`);
  }

  const openings = (model.openings ?? [])
    .map((opening, i) => ({
      id: String(opening.id ?? `opening-${i}`),
      kind: String(opening.kind ?? "opening"),
      subtype: String(opening.subtype ?? "unknown"),
      hostWallIndex: Number(opening.host_wall_index),
      start: finitePair(opening.start, `opening[${i}].start`),
      end: finitePair(opening.end, `opening[${i}].end`),
      heightFt: Number(opening.height_ft),
      sillFt: Number(opening.sill_ft ?? 0),
      assumedHeight: Boolean(opening.assumed_height),
      evidence: String(opening.evidence ?? ""),
    }))
    // A manifest can carry an opening whose host was dropped by a later
    // repair pass; skipping beats throwing away the whole plan.
    .filter((opening) => walls[opening.hostWallIndex] !== undefined);

  const region = (r, i, what) => ({
    boundary: (r.boundary ?? []).map((p, j) => finitePair(p, `${what}[${i}].boundary[${j}]`)),
    holes: (r.holes ?? []).map((hole, h) =>
      hole.map((p, j) => finitePair(p, `${what}[${i}].holes[${h}][${j}]`))),
    areaSqft: Number(r.area_sqft ?? 0),
  });

  const normalised = {
    regionId: String(model.region_id ?? `plan-${index + 1}`),
    storeyName: String(model.storey_name ?? "Unassigned plan"),
    elevationFt: Number(model.elevation_ft ?? 0) || 0,
    wallHeightFt: Number(model.wall_height_ft ?? 10),
    unitsPerFoot: Number(model.scale?.units_per_foot ?? 1),
    scaleVerified: Boolean(model.scale_verified),
    scaleConvention: String(model.scale?.convention ?? ""),
    walls,
    openings,
    spaces: (model.spaces ?? []).map((r, i) => region(r, i, "space")),
    footprints: (model.footprints ?? []).map((r, i) => region(r, i, "footprint")),
    issues: model.issues ?? [],
  };

  const bounds = planBounds(normalised);
  normalised.bounds = bounds;
  normalised.shiftFt = [
    -(bounds.minX + bounds.maxX) / 2,
    -(bounds.minY + bounds.maxY) / 2,
  ];
  normalised.spanFt = [bounds.maxX - bounds.minX, bounds.maxY - bounds.minY];
  return normalised;
}
