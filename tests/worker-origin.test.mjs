/**
 * The fragments worker must be served from our own origin.
 *
 * `FragmentsModels.getWorker()` fetches the worker from unpkg.com at runtime
 * and returns a blob URL. That is third-party JavaScript executing in the page
 * that holds the user's API key in localStorage — a supply-chain hole, an
 * availability dependency on a CDN we do not control, and a request to a third
 * party from every visitor's browser. The worker ships inside the package, so
 * none of that is necessary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../src/frag-viewer.js", import.meta.url), "utf8");
// Strip comments: this asserts on code, and the comment explaining WHY we avoid
// getWorker() must not be what trips the assertion.
const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the fragments worker is not fetched from a CDN at runtime", () => {
  assert.ok(
    !/getWorker\s*\(/.test(source),
    "FragmentsModels.getWorker() fetches from unpkg.com — import the bundled worker instead",
  );
});

test("the fragments worker is imported as a local build asset", () => {
  assert.match(
    source,
    /@thatopen\/fragments\/worker\?url/,
    "the package exports the worker at ./worker; ?url emits it beside the bundle",
  );
});
