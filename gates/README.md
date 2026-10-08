# Phase 0 gates for the mlightcad CAD viewer

Go/no-go checks from `lerneanLabs-archiAgent/docs/superpowers/plans/2026-10-07-mlightcad-cad-viewer.md`.
Results: `lerneanLabs-archiAgent/docs/superpowers/notes/2026-10-07-phase0-gates.md`.

This is its own npm package on purpose: mlightcad needs `three@0.172`, and the
IFC viewer at the repository root uses `three@0.182`. Nothing here is GPL.

```bash
npm ci
```

## Task 2 — handle join

Does the entity a user selects in mlightcad name the same entity in
archiAgent's pipeline?

```bash
# in lerneanLabs-archiAgent, per drawing:
python scripts/gates/dxf_entities.py PLAN.dxf PLAN.json
# here:
node handle-join.mjs PLAN.dxf PLAN.json [MORE.dxf MORE.json ...]
```

## Task 3a — production CSP

Does `cad-simple-viewer` open a drawing under the CSP in `../deploy/Caddyfile`,
with fonts and workers self-hosted and no third-party request?

```bash
node csp-gate.mjs PLAN.dxf [--font FONT.ttf] [--out DIR]
```

The font must be openly licensed (default: Liberation Sans, SIL OFL, from
`/usr/share/fonts/truetype/liberation/`). mlightcad's default font repository
has no licence to redistribute its fonts, so the gate writes its own
`fonts.json` that aliases the CAD font names onto that one font.

Chrome comes from `$CHROME_PATH`, else macOS Google Chrome, else
`/opt/pw-browsers`.
