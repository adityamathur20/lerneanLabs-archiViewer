# archiagent-viewer

Renders archiAgent's **authored IFC** in the browser with
[`@thatopen/fragments`](https://github.com/ThatOpen/engine_fragment). No
geometry is reconstructed here: archiAgent already resolved wall junctions,
split walls at openings and wrote `IfcRelVoidsElement`, and web-ifc meshes that
faithfully.

```
archiAgent (Python)                          this app (browser)
  DXF/PDF → classify → junctions → spaces      fetch plan.ifc
  → ifcopenshell → plan.ifc  ──────────────→   IfcImporter → .frag
                                               FragmentsModels → Three.js
```

## Run

```bash
npm install
ARCHIAGENT_OUT=/path/to/your/archiagent/outputDir npm run dev
# → http://localhost:5173
```

`ARCHIAGENT_OUT` defaults to the parent directory. The dev server scans it (3
levels deep) for `*.ifc` and lists what it finds; requests are confined to that
root and to `.ifc` files.

`npm install` also installs `cad/` (the Drawing view, below). Run its dev
server beside the one above:

```bash
npm run dev:cad          # → http://localhost:5174/cad/, proxies /api to :5173
```

It lists every `*.dxf` under `ARCHIAGENT_OUT`, through the same confined
routes (`/api/drawings`, `/api/drawing`).

Produce an IFC with archiAgent:

```bash
python -m archiagent --dxfFilePath plan.dxf --outputDir out
```

## Verify without a browser

```bash
npm test                                      # unit tests (node:test)
npm run smoke -- out/plan.ifc                 # full conversion under Node
```

Several tests need real fixtures and skip without them. Fixtures are the
pipeline's own output and too large to commit, so point the env vars at yours:

```bash
ARCHIAGENT_IFC="out/plan.ifc" \
ARCHIAGENT_IFC_2="out/another.ifc" \
ARCHIAGENT_IFC_FAR="out/far-from-origin.ifc" \
  npm test
```

- `ARCHIAGENT_IFC` — any authored plan: conversion, progress and build tests.
- `ARCHIAGENT_IFC_2` — a *different* plan, so the cache test can prove a `.frag`
  built from one IFC is rejected for another.
- `ARCHIAGENT_IFC_FAR` — a plan whose coordinates sit far from the origin, which
  is what makes the recentring test meaningful. **A plan already at the origin
  cannot fail that test**, so pick deliberately: in this corpus
  `wallUpdate_dxfBased_ifcOutput/M.r Premg Agarwal  Baglow 90x50.ifc` peaks
  around 10608, while `dxfBased_ifcOutput/Floor Plan.ifc` is already centred.

`smoke` reads the IFC, converts it to fragments and exits non-zero if the buffer
is empty. Useful in CI, where there is no WebGL.

To check the render itself (needs Google Chrome installed):

```bash
ARCHIAGENT_OUT=.. npm run dev &
npm run shot -- http://localhost:5173 /tmp/shot.png
```

`shot` fails the build unless the status overlay cleared and the canvas is
actually drawing geometry, so it catches a blank render that a screenshot alone
would hide.

## Dependency pins

- **`@thatopen/fragments` is pinned exactly.** The `.frag` format version is
  embedded in the files it writes.
- **`web-ifc` is pinned to `0.0.77` deliberately.** It is a *peer* dependency of
  fragments, so the pin is ours to hold. Version `0.0.78` ships a browser `.wasm`
  whose `StreamMeshes` binding takes 3 arguments while its own `web-ifc-api.js`
  calls it with 4, so conversion in the browser throws
  `BindingError: function StreamMeshes called with 4 arguments, expected 3`.
  Its Node wasm is built consistently — which is why the Node smoke test passes
  on 0.0.78 and only the browser breaks. Re-check when a later version ships.
- `three` must be `>=0.182.0`; fragments requires it as a peer.

## Precomputing fragments

Converting in the browser costs a few hundred milliseconds per page load. Build
the `.frag` once instead:

```bash
npm run build:frag -- out/plan.ifc out/plan.frag
```

That writes `plan.frag` plus a `plan.frag.json` sidecar recording the IFC's
SHA-256 and the fragments / web-ifc versions that produced it. The dev server
serves the cache from `/api/frag` **only when that sidecar still matches** the
`.ifc` beside it and the installed libraries; otherwise it returns 404 and the
viewer converts the IFC itself.

That check is the point, not bookkeeping. Without it a `.frag` left over from a
previous archiAgent run would be served in preference to the freshly authored
IFC, and you would review the wrong building with no warning — the cache would
have become the source of truth, which is exactly what invariant I2 forbids. A
corrupt or half-written `.frag` likewise falls back to the IFC rather than
failing the load.

## The Drawing view (`cad/`)

A job's `plan.dxf` in [mlightcad](https://github.com/mlightcad/cad-viewer)'s 2D
CAD viewer, at `/cad/`: pan, zoom, layers on/off, and distance measurement in
drawing units. The 3D view links to it per job ("Open drawing"), and it links
back ("Open 3D model"). It lists jobs that **failed** too: a DXF refused for
want of a scale still has its `plan.dxf`, and that is the drawing to measure.

- **The browser only ever opens DXF.** A DWG upload is converted on the server
  by the ODA File Converter (worker image); `plan.dxf` is its conversion.
- **Its own npm package**, because mlightcad needs `three@0.172` and this app
  uses `three@0.182`. `npm run build` builds both; `cad/` lands in `dist/cad/`.
- **MIT only.** mlightcad's DWG/DXF parsers (`@mlightcad/libredwg-*`,
  `dxf-json*`, `libdxfrw-*`) are GPL and must never be bundled:
  `tests/licence-boundary.test.mjs` fails the build if they appear.
- **Self-hosted fonts and worker.** mlightcad's default font CDN serves fonts
  with no redistribution licence and the CSP blocks it anyway; see
  `cad/FONTS.md`.
- **Stage A** of `lerneanLabs-archiAgent/docs/superpowers/plans/2026-10-07-mlightcad-cad-viewer.md`:
  `cad-simple-viewer` with a thin sidebar. Stage B swaps in the full
  `cad-viewer` UI on the same engine.

Check a production build of it in real Chrome, under the CSP and routing from
`deploy/Caddyfile` (build without `VITE_API_BASE`):

```bash
npm run build && npm run check:cad -- plan.dxf [more.dxf …]
```

It fails unless each drawing opens and shows, layers toggle, a measurement
completes, and nothing violates the CSP or leaves the origin.

## Architecture

See `lerneanLabs-archiAgent/docs/superpowers/specs/2026-09-26-webapp-three-tier-design.md`.
The rule is: **Fragments in the browser, ifc-lite as a server-side library,
ifcopenshell stays canonical, and they never meet at runtime.** In particular:

- `plan.ifc` has exactly one writer, ifcopenshell in Python. This app never writes IFC.
- `.frag` is a render cache derived from `plan.ifc` by a pure function. Losing it is harmless.
- The interpretation manifest is *not* read by this app at all any more. When it
  returns it will be for provenance only — never as geometry input.
- The Fragments runtime stays behind `src/frag-viewer.js`. That facade is the
  seam Phase 7 attaches to, when ifc-lite's MCP viewer tools drive this scene
  over `@ifc-lite/embed-protocol`. Do not inline it into `main.js`.

## Known gaps

- **Conversion falls back to the browser** when no current `.frag` exists. Fine
  for one plan at a time; precompute with `npm run build:frag` (above) to pay
  the cost once per model instead of once per page load.
- **Conversion runs on the main thread.** A large IFC will freeze the UI while
  it converts, and the progress percentage may not repaint. Moving it to a
  worker is the real fix.
- **`npm run build` is not wired for production.** The browser resolves web-ifc's
  wasm from `/node_modules/web-ifc/`, which Vite serves in dev but not in a
  production build. Copy the wasm into `public/` when a build is first shipped.
- **No editing.** See §8 of the spec for the seam it will attach to.
- **No STL export.** Removed: it existed only because the previous kernel could
  not export usable IFC. If you need a mesh, ask for glTF.
