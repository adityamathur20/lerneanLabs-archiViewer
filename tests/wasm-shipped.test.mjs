/**
 * web-ifc's wasm must be served from our own origin in the production build.
 *
 * `wasmLocation()` returned "/node_modules/web-ifc/", a path that exists only
 * because `vite dev` serves node_modules over HTTP. A production build has no
 * node_modules, and because the viewer's Caddy block ends in
 * `try_files {path} /index.html`, the request does not even 404 — web-ifc
 * receives index.html and dies on the wasm magic word. Spec §8 makes
 * in-browser conversion the only rendering path, so nothing renders at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);

test("the browser wasm path is not node_modules", () => {
  // Comments stripped: this asserts on code, and the comment explaining what
  // the path USED to be must not be what trips it.
  const source = readFileSync(new URL("src/ifc-to-frag.js", root), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    source,
    /"\/node_modules\//,
    "node_modules is not served by a production build",
  );
});

test("the wasm web-ifc asks for is committed under public/", () => {
  // public/ is copied verbatim into dist/, and served at the same paths by the
  // dev server, so dev and production resolve identically.
  for (const name of ["web-ifc.wasm", "web-ifc-mt.wasm"]) {
    assert.ok(
      existsSync(new URL(`public/web-ifc/${name}`, root)),
      `public/web-ifc/${name} is missing; the viewer cannot parse an IFC without it`,
    );
  }
});

test("a built dist/ actually contains the wasm", (t) => {
  if (!existsSync(new URL("dist/", root))) {
    t.skip("no dist/ — run npm run build first");
    return;
  }
  const files = readdirSync(new URL("dist/web-ifc/", root));
  assert.ok(files.includes("web-ifc.wasm"), `dist/web-ifc/ holds ${files.join(", ")}`);
  const bytes = readFileSync(new URL("dist/web-ifc/web-ifc.wasm", root));
  // \0asm — if this is HTML, try_files served index.html instead.
  assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], "not a wasm module");
});
