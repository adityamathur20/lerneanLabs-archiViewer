import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fragIsCurrent } from "../vite.config.js";

const run = promisify(execFile);
const BUILD = path.resolve("scripts/build-frag.mjs");
const FIXTURE = process.env.ARCHIAGENT_IFC;
const OTHER = process.env.ARCHIAGENT_IFC_2;

/**
 * A `.frag` is a cache, never a source of truth (spec invariant I2). Serving a
 * stale one in preference to the authored IFC inverts that: archiAgent re-runs,
 * overwrites plan.ifc, and the user reviews yesterday's building believing it
 * is today's. These tests pin the validation that prevents it.
 */

test("a freshly built .frag is current for the IFC it came from", async (t) => {
  if (!FIXTURE || !existsSync(FIXTURE)) {
    t.skip("set ARCHIAGENT_IFC to an authored .ifc to run this test");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "cache-"));
  const ifc = path.join(dir, "plan.ifc");
  const frag = path.join(dir, "plan.frag");
  await copyFile(FIXTURE, ifc);
  await run("node", [BUILD, ifc, frag]);

  assert.equal(await fragIsCurrent(frag, ifc), true);
});

test("a .frag built from a DIFFERENT IFC is not current", async (t) => {
  if (!FIXTURE || !OTHER || !existsSync(FIXTURE) || !existsSync(OTHER)) {
    t.skip("set ARCHIAGENT_IFC and ARCHIAGENT_IFC_2 to two different .ifc files");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "cache-"));
  const ifc = path.join(dir, "plan.ifc");
  const frag = path.join(dir, "plan.frag");

  // Build the cache from OTHER, then put FIXTURE in place as plan.ifc. This is
  // the real-world shape: the .ifc was regenerated, the .frag was not.
  const otherCopy = path.join(dir, "other.ifc");
  await copyFile(OTHER, otherCopy);
  await run("node", [BUILD, otherCopy, frag]);
  await copyFile(FIXTURE, ifc);

  assert.equal(await fragIsCurrent(frag, ifc), false);
});

test("a .frag with no sidecar is not current", async (t) => {
  if (!FIXTURE || !existsSync(FIXTURE)) {
    t.skip("set ARCHIAGENT_IFC to an authored .ifc to run this test");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "cache-"));
  const ifc = path.join(dir, "plan.ifc");
  const frag = path.join(dir, "plan.frag");
  await copyFile(FIXTURE, ifc);
  await run("node", [BUILD, ifc, frag]);
  await rm(`${frag}.json`);

  assert.equal(await fragIsCurrent(frag, ifc), false);
});

test("a .frag written by a different library version is not current", async (t) => {
  if (!FIXTURE || !existsSync(FIXTURE)) {
    t.skip("set ARCHIAGENT_IFC to an authored .ifc to run this test");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "cache-"));
  const ifc = path.join(dir, "plan.ifc");
  const frag = path.join(dir, "plan.frag");
  await copyFile(FIXTURE, ifc);
  await run("node", [BUILD, ifc, frag]);

  const sidecar = JSON.parse(await readFile(`${frag}.json`, "utf8"));
  sidecar.fragments = "0.0.0-not-this-one";
  await writeFile(`${frag}.json`, JSON.stringify(sidecar));

  assert.equal(await fragIsCurrent(frag, ifc), false);
});

test("a missing .frag is not current", async () => {
  assert.equal(await fragIsCurrent("/nonexistent/plan.frag", "/nonexistent/plan.ifc"), false);
});
