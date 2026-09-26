import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveWithinRoot } from "../vite.config.js";

const ROOT = path.resolve("/tmp/archiagent-out");

test("resolves a normal relative path inside the root", () => {
  assert.equal(
    resolveWithinRoot(ROOT, "run-1/plan.ifc"),
    path.join(ROOT, "run-1/plan.ifc"),
  );
});

test("rejects a parent-directory escape", () => {
  assert.equal(resolveWithinRoot(ROOT, "../../etc/passwd"), null);
});

test("rejects an absolute path outside the root", () => {
  assert.equal(resolveWithinRoot(ROOT, "/etc/passwd"), null);
});

test("rejects a sibling directory that merely shares the root's prefix", () => {
  assert.equal(resolveWithinRoot(ROOT, "../archiagent-out-evil/x.ifc"), null);
});

test("rejects a file that is not a .ifc", () => {
  assert.equal(resolveWithinRoot(ROOT, "run-1/plan.interpretation.json"), null);
});

test("serves a .frag when asked for that suffix", () => {
  assert.equal(
    resolveWithinRoot(ROOT, "run-1/plan.frag", ".frag"),
    path.join(ROOT, "run-1/plan.frag"),
  );
});

test("still rejects a traversal when the suffix is .frag", () => {
  assert.equal(resolveWithinRoot(ROOT, "../../etc/passwd.frag", ".frag"), null);
});

test("rejects a .ifc when .frag was requested", () => {
  assert.equal(resolveWithinRoot(ROOT, "run-1/plan.ifc", ".frag"), null);
});
