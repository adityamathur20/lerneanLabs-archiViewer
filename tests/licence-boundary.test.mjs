// Nothing GPL may reach the browser. mlightcad's viewer packages are MIT, but
// its DWG/DXF parsers are not: @mlightcad/libredwg-* and dxf-json* are GPL-3,
// libdxfrw-* GPL-2. Anything the viewer bundles is conveyed to every visitor,
// which would put the whole bundle under the GPL's source obligations. DWG is
// converted on the server by the ODA File Converter instead, and the browser
// only ever receives DXF, which mlightcad's MIT data model reads itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = /@mlightcad\/(libredwg|dxf-json|libdxfrw)|libredwg-web\.wasm|libredwg-parser-worker/;

// Everything that is, or builds, what a browser downloads. gates/ is a test
// harness, never served, and holds no GPL package either; it is checked too.
const lockfiles = ["package-lock.json", "cad/package-lock.json", "gates/package-lock.json"];

test("no browser-side lockfile resolves a GPL mlightcad package", () => {
  for (const file of lockfiles) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    const match = readFileSync(full, "utf8").match(FORBIDDEN);
    assert.equal(match, null, `${file} pulls in ${match?.[0]}`);
  }
});

test("the Drawing view declares only the MIT mlightcad packages", () => {
  const { dependencies } = JSON.parse(readFileSync(path.join(root, "cad/package.json"), "utf8"));
  const offending = Object.keys(dependencies).filter((name) => FORBIDDEN.test(name));
  assert.deepEqual(offending, []);
});

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

test("a built dist/ contains no GPL parser", { skip: !existsSync(path.join(root, "dist")) && "no dist/; run npm run build" }, () => {
  for (const file of files(path.join(root, "dist"))) {
    assert.doesNotMatch(path.relative(root, file), FORBIDDEN);
    if (/\.(js|mjs|html|json)$/.test(file)) {
      const match = readFileSync(file, "utf8").match(/@mlightcad\/(libredwg|dxf-json|libdxfrw)[a-z-]*/);
      // The MIT viewer names the opt-in GPL package in a constant
      // (LIBREDWG_CONVERTER_PACKAGE) without importing it. A name is not code;
      // an import of it would also bring its wasm, which the path check catches.
      if (match) assert.ok(!/(?:import|require)\s*\(?\s*["']@mlightcad\/(libredwg|dxf-json|libdxfrw)/.test(readFileSync(file, "utf8")), `${file} imports ${match[0]}`);
    }
  }
});
