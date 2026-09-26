/**
 * archiAgent plan -> OpenGeometry analytic solids.
 *
 * Coordinate contract, fixed by OpenGeometry's `linearExtrusion`: the profile
 * lives in a 2D (u, v) plane and extrudes from y = 0 to y = height. A plan
 * point (x, y) therefore maps to world (x, *, -y) and "up" is +Y, matching the
 * `[point.x, -point.z]` convention in the kernel's own Three.js examples.
 *
 * Openings are resolved by decomposing each wall along its own axis rather
 * than by boolean subtraction. archiAgent splits walls at opening boundaries,
 * so a door's host wall is usually *exactly* the door gap — a cutter built
 * there is coextensive with the wall's end faces, and OpenGeometry's exact
 * kernel rightly rejects it ("cuboid arrangement contains sub-tolerance
 * features"). Decomposition is also cheaper, and it yields the pier / apron /
 * lintel pieces that an IFC wall + IfcOpeningElement pair needs anyway.
 */

import { FT_TO_M } from "./manifest.js";

/** Pieces thinner than this (metres) are dropped rather than built. */
const MIN_PIECE_M = 0.002;

/**
 * Consecutive ring vertices closer than this (metres) are collapsed. Traced
 * footprints routinely carry duplicate or near-duplicate points, and the exact
 * kernel rejects the whole profile over one of them ("edge below geometric
 * resolution") rather than silently healing it.
 */
const MIN_EDGE_M = 0.001;

/** Collapses near-duplicate consecutive vertices, including the wrap-around. */
function cleanRing(ring) {
  const out = [];
  for (const point of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < MIN_EDGE_M) continue;
    out.push(point);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < MIN_EDGE_M) out.pop();
    else break;
  }
  return out.length >= 3 ? out : null;
}

function signedArea(ring) {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** The kernel wants outer rings counter-clockwise and holes clockwise. */
function orient(dirty, wantPositive) {
  const ring = cleanRing(dirty);
  if (!ring) return null;
  const area = signedArea(ring);
  if (area === 0) return null;
  return area > 0 === wantPositive ? ring : [...ring].reverse();
}

function direction(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  return { unit: [dx / length, dy / length], length };
}

/** Plan feet -> centred model metres. */
function project(point, shiftFt) {
  return [(point[0] + shiftFt[0]) * FT_TO_M, (point[1] + shiftFt[1]) * FT_TO_M];
}

/** Distance of `point` along the axis from `origin`, in metres. */
function station(point, origin, unit) {
  return (point[0] - origin[0]) * unit[0] + (point[1] - origin[1]) * unit[1];
}

/**
 * A box spanning [t0, t1] along the wall axis, centred on the wall centreline,
 * as a profile ring in plan metres.
 */
function pieceRing(origin, unit, t0, t1, halfWidth) {
  const nx = -unit[1];
  const ny = unit[0];
  const at = (t, w) => [
    origin[0] + unit[0] * t + nx * w,
    origin[1] + unit[1] * t + ny * w,
  ];
  return orient([at(t0, -halfWidth), at(t1, -halfWidth), at(t1, halfWidth), at(t0, halfWidth)], true);
}

/**
 * Merges overlapping opening intervals. Where two openings overlap, the union
 * takes the lowest sill and highest head: removing slightly too much beats
 * leaving a sliver of wall inside a door.
 */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.t0 - b.t0);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.t0 <= last.t1 + MIN_PIECE_M) {
      last.t1 = Math.max(last.t1, interval.t1);
      last.sill = Math.min(last.sill, interval.sill);
      last.head = Math.max(last.head, interval.head);
      last.ids.push(...interval.ids);
      last.merged = true;
    } else {
      merged.push({ ...interval, ids: [...interval.ids] });
    }
  }
  return merged;
}

/**
 * Builds wall solids for one model, plus the void volumes the openings occupy.
 *
 * `deps` is `{ AnalyticSolid }` from the `opengeometry` package, injected so
 * this module runs under Node for smoke tests as well as in the browser.
 */
export function buildWalls(deps, model, options = {}) {
  const { AnalyticSolid } = deps;
  const {
    deflection = 0.02,
    wallColor = 0xb8c1cc,
    voidColor = 0xe8833a,
    buildVoids = true,
    onProgress = null,
  } = options;

  const wallHeightM = model.wallHeightFt * FT_TO_M;
  const baseM = model.elevationFt * FT_TO_M;
  const shift = model.shiftFt;

  const byHost = new Map();
  for (const opening of model.openings) {
    const list = byHost.get(opening.hostWallIndex);
    if (list) list.push(opening);
    else byHost.set(opening.hostWallIndex, [opening]);
  }

  const solids = [];
  const voids = [];
  const stats = {
    walls: 0,
    pieces: 0,
    skippedWalls: 0,
    openingsRequested: model.openings.length,
    openingsPlaced: 0,
    openingsDropped: 0,
    fullHeightOpenings: 0,
    mergedOpenings: 0,
    notes: [],
  };

  const make = (ring, bottomM, topM, meta, color) => {
    const height = topM - bottomM;
    if (!(height > MIN_PIECE_M) || !ring) return null;
    let solid;
    try {
      solid = new AnalyticSolid({
        kind: "linearExtrusion",
        outer: ring,
        holes: [],
        height,
        color,
        deflection,
      });
    } catch (error) {
      stats.notes.push({ ...meta, stage: "extrude", message: String(error?.message ?? error) });
      return null;
    }
    solid.position.y = baseM + bottomM;
    solid.updateMatrixWorld(true);
    Object.assign(solid.userData, meta);
    return solid;
  };

  for (const wall of model.walls) {
    const start = project(wall.start, shift);
    const end = project(wall.end, shift);
    const axis = direction(start, end);
    if (!axis || axis.length < MIN_PIECE_M) {
      stats.skippedWalls += 1;
      continue;
    }

    const halfWidth = (wall.thicknessFt * FT_TO_M) / 2;
    const openings = byHost.get(wall.index) ?? [];

    const intervals = [];
    for (const opening of openings) {
      const a = station(project(opening.start, shift), start, axis.unit);
      const b = station(project(opening.end, shift), start, axis.unit);
      const t0 = Math.max(0, Math.min(a, b));
      const t1 = Math.min(axis.length, Math.max(a, b));
      const sill = Math.max(0, opening.sillFt * FT_TO_M);
      const head = Math.min(wallHeightM, sill + opening.heightFt * FT_TO_M);
      if (!(t1 - t0 > MIN_PIECE_M) || !(head - sill > MIN_PIECE_M)) {
        stats.openingsDropped += 1;
        stats.notes.push({ wall: wall.index, opening: opening.id, stage: "interval", message: "degenerate extent" });
        continue;
      }
      intervals.push({ t0, t1, sill, head, ids: [opening.id], kind: opening.kind, merged: false });
      stats.openingsPlaced += 1;
    }

    const merged = mergeIntervals(intervals);
    for (const interval of merged) if (interval.merged) stats.mergedOpenings += 1;

    const base = {
      ifcClass: "IFCWALL",
      wallIndex: wall.index,
      layer: wall.layer,
      detector: wall.detector,
      thicknessFt: wall.thicknessFt,
      thicknessSource: wall.thicknessSource,
      sourceIds: wall.sourceIds,
      openings: openings.map((o) => o.id),
    };

    const pieces = [];

    // Full-height piers: the wall axis minus the opening intervals.
    let cursor = 0;
    for (const interval of merged) {
      if (interval.t0 - cursor > MIN_PIECE_M) {
        pieces.push({ t0: cursor, t1: interval.t0, bottom: 0, top: wallHeightM, part: "pier" });
      }
      cursor = Math.max(cursor, interval.t1);
    }
    if (axis.length - cursor > MIN_PIECE_M) {
      pieces.push({ t0: cursor, t1: axis.length, bottom: 0, top: wallHeightM, part: "pier" });
    }

    // Apron below each opening and lintel above it.
    for (const interval of merged) {
      if (interval.sill > MIN_PIECE_M) {
        pieces.push({ t0: interval.t0, t1: interval.t1, bottom: 0, top: interval.sill, part: "apron", ids: interval.ids });
      }
      if (wallHeightM - interval.head > MIN_PIECE_M) {
        pieces.push({ t0: interval.t0, t1: interval.t1, bottom: interval.head, top: wallHeightM, part: "lintel", ids: interval.ids });
      } else if (interval.sill <= MIN_PIECE_M) {
        stats.fullHeightOpenings += 1;
      }
    }

    let built = 0;
    for (const [i, piece] of pieces.entries()) {
      const ring = pieceRing(start, axis.unit, piece.t0, piece.t1, halfWidth);
      const solid = make(ring, piece.bottom, piece.top, { ...base, part: piece.part, hostOpenings: piece.ids ?? [] }, wallColor);
      if (!solid) continue;
      solid.name = `wall-${wall.index}${pieces.length > 1 ? `-${piece.part}-${i}` : ""}`;
      solids.push(solid);
      built += 1;
    }

    stats.pieces += built;
    if (built > 0) stats.walls += 1;
    else stats.skippedWalls += 1;

    if (buildVoids) {
      for (const interval of merged) {
        const ring = pieceRing(start, axis.unit, interval.t0, interval.t1, halfWidth);
        const solid = make(
          ring,
          interval.sill,
          interval.head,
          { ifcClass: "IFCOPENINGELEMENT", wallIndex: wall.index, openings: interval.ids, kind: interval.kind },
          voidColor,
        );
        if (!solid) continue;
        solid.name = `void-${interval.ids.join("+")}`;
        voids.push(solid);
      }
    }

    if (onProgress) onProgress(stats.walls, model.walls.length);
  }

  return { solids, voids, stats };
}

/** Footprints as thin slabs, so the plan reads as a building and not floating walls. */
export function buildSlabs(deps, model, options = {}) {
  const { AnalyticSolid } = deps;
  const { thicknessM = 0.15, color = 0x8d9199, deflection = 0.05 } = options;
  const shift = model.shiftFt;
  const solids = [];
  const skipped = [];

  for (const [index, footprint] of model.footprints.entries()) {
    const raw = footprint.boundary.map((p) => project(p, shift));
    const outer = orient(raw, true);
    if (!outer) {
      skipped.push({ index, message: `boundary collapsed to fewer than 3 usable points (from ${raw.length})` });
      continue;
    }
    const dropped = raw.length - outer.length;
    const holes = footprint.holes
      .map((hole) => orient(hole.map((p) => project(p, shift)), false))
      .filter((hole) => hole && hole.length >= 3);
    try {
      const slab = new AnalyticSolid({
        kind: "linearExtrusion",
        outer,
        holes,
        height: thicknessM,
        color,
        deflection,
      });
      slab.position.y = model.elevationFt * FT_TO_M - thicknessM;
      slab.updateMatrixWorld(true);
      slab.name = `slab-${index}`;
      slab.userData = { ifcClass: "IFCSLAB", areaSqft: footprint.areaSqft, droppedVertices: dropped };
      solids.push(slab);
    } catch (error) {
      // A self-intersecting footprint ring is a plan-interpretation problem,
      // not something to paper over here.
      skipped.push({ index, message: String(error?.message ?? error) });
    }
  }
  return { solids, skipped };
}
