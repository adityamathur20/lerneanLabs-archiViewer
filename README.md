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

Produce an IFC with archiAgent:

```bash
python -m archiagent --dxfFilePath plan.dxf --outputDir out
```

## Verify without a browser

```bash
npm test                                      # unit tests (node:test)
ARCHIAGENT_IFC=out/plan.ifc npm test          # …including the conversion tests
npm run smoke -- out/plan.ifc                 # full conversion under Node
```

`npm test` skips the conversion tests unless `ARCHIAGENT_IFC` points at an
authored `.ifc`; fixtures are the pipeline's own output and too large to commit.
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

- **Conversion happens in the browser.** Fine for one plan at a time; Phase 2
  of the spec moves it to a server-side build step so the cost is paid once per
  model instead of once per page load.
- **`npm run build` is not wired for production.** The browser resolves web-ifc's
  wasm from `/node_modules/web-ifc/`, which Vite serves in dev but not in a
  production build. Copy the wasm into `public/` when a build is first shipped.
- **No editing.** See §8 of the spec for the seam it will attach to.
- **No STL export.** Removed: it existed only because the previous kernel could
  not export usable IFC. If you need a mesh, ask for glTF.
