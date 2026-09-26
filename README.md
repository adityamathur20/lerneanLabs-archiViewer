# archiagent-viewer

Rebuilds an archiAgent **frozen interpretation** as OpenGeometry solids in the
browser, and renders it with Three.js. No Rust toolchain: the published
`opengeometry` npm package ships the prebuilt `.wasm`.

```
archiAgent (Python)                           this app (browser)
  DXF/PDF → classify → walls, openings          readManifest()
  → *.interpretation.json  ────────────────→    buildWalls()  → AnalyticSolid
                                                buildSlabs()  → AnalyticSolid
                                                Three.js scene + STL download
```

## Run

```bash
npm install
ARCHIAGENT_OUT=/path/to/your/archiagent/outputDir npm run dev
# → http://localhost:5173
```

`ARCHIAGENT_OUT` defaults to the parent directory. The dev server scans it (3
levels deep) for `*.interpretation.json` and lists what it finds; requests are
confined to that root.

Produce a manifest with archiAgent's freeze step:

```bash
python -m archiagent --dxfFilePath plan.dxf --outputDir out --freeze-only
```

## Verify without a browser

```bash
npm run smoke -- "out/plan.interpretation.json"
```

Builds the whole model through the kernel under Node — extrusions, opening
decomposition, extents, mesh counts, STL byte layout — and exits non-zero on
failure. Useful in CI, where there is no WebGL.

To check the render itself (needs Google Chrome installed):

```bash
npm run dev &
npm run shot -- http://localhost:5173 /tmp/shot.png [manifestIndex]
```

## How it maps

| manifest | becomes |
|---|---|
| `walls[]` (centreline, `thickness_ft`) | one `linearExtrusion` per wall piece |
| `openings[]` (`host_wall_index`, extent, `sill_ft`, `height_ft`) | wall split into pier / apron / lintel, plus a void solid |
| `footprints[]` | floor slab, 150 mm |
| `wall_height_ft`, `elevation_ft` | extrusion height and base |

Coordinates are converted from plan feet to metres and recentred on the model's
own bounding box — archiAgent keeps the source drawing's origin, which puts a
real plan tens of thousands of feet from (0,0) and wrecks depth precision.

**Openings are resolved by decomposition, not boolean subtraction.** archiAgent
splits walls at opening boundaries, so a door's host wall is usually *exactly*
the door gap. A cutter built there is coextensive with the wall's end faces and
OpenGeometry's exact kernel rejects it (`cuboid arrangement contains
sub-tolerance features`). Splitting the wall along its axis instead is exact,
faster, and produces the pieces an IFC wall + `IfcOpeningElement` pair needs.

## Known gaps

- **Wall junctions butt, they do not join.** Each segment is an independent box,
  so L/T/X corners show a seam. Resolving these needs the junction rules from
  `archiagent/geometry/junctions.py` applied here.
- **No IFC export.** `AnalyticSolid.exportIfc()` writes a single
  `IfcBuildingElementProxy` with no spatial hierarchy, and `WorldGraph.exportIfc()`
  — which does write a proper spatial tree — rejects analytic solids. Keep
  archiAgent's ifcopenshell output as the canonical IFC for now. STL export works
  and is wired up.
- **One model per manifest is rendered** (`models[0]` plus the picker); a
  multi-region manifest shows one region at a time.
- Wall openings are assumed rectangular and vertical.
