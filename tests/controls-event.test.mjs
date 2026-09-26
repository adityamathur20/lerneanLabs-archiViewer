import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Regression guard for a defect that shipped in the plan: the viewer listened
 * for an OrbitControls "update" event, which OrbitControls does not dispatch.
 * `fragments.update()` then ran only at load time, so Fragments' culling and
 * LOD never refreshed while the user navigated — geometry culled at load never
 * streamed in. It is invisible to the screenshot gate, because the screenshot
 * is taken from the load-time camera, the one pose where the stale state looks
 * correct.
 */
test("the camera listener uses an event OrbitControls actually dispatches", async () => {
  const controls = await readFile(
    "node_modules/three/examples/jsm/controls/OrbitControls.js",
    "utf8",
  );
  const dispatched = new Set(
    [...controls.matchAll(/\{\s*type:\s*'([a-z]+)'/g)].map((m) => m[1]),
  );
  assert.ok(dispatched.size > 0, "could not read OrbitControls' event types");

  const viewer = await readFile("src/frag-viewer.js", "utf8");
  const listener = viewer.match(/controls\.addEventListener\(\s*"([a-z]+)"/);
  assert.ok(listener, "frag-viewer.js no longer registers a controls listener");

  assert.ok(
    dispatched.has(listener[1]),
    `frag-viewer.js listens for "${listener[1]}", but OrbitControls only ` +
      `dispatches: ${[...dispatched].sort().join(", ")}`,
  );
});
