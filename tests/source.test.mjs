import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiSource, createDiskSource, SourceError } from "../src/source.js";

/**
 * A job exactly as `job_json()` in service/archiagent_service/api.py emits it.
 * The previous fixtures were hand-written as {id, source_filename}, which the
 * API never emits — so the tests passed while the viewer read undefined for
 * every field. Fixtures for a contract you do not own must mirror the producer.
 */
const apiJob = ({ id, status = "succeeded", filename, artifacts = ["plan.ifc"] }) => ({
  schema_version: 1,
  job_id: id,
  tenant_id: "01TENANT",
  status,
  source: { filename, bytes: 1234, converted_from_dwg: false },
  options: {},
  exit_code: 0,
  acceptance: "checks-passed",
  archiagent_version: "0.1.0",
  artifacts,
  timings_ms: {},
  error: null,
  created_at: "2026-10-04T00:00:00+00:00",
  finished_at: "2026-10-04T00:01:00+00:00",
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
  headers: new Map(),
});

test("api source sends the bearer token", async () => {
  let seen;
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "ak_secret",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return jsonResponse({ jobs: [] });
    },
  });
  await source.list();
  assert.equal(seen.url, "https://api.planto3d.in/v1/jobs?limit=200");
  assert.equal(seen.init.headers.authorization, "Bearer ak_secret");
});

test("api source lists only succeeded jobs that have a plan.ifc", async () => {
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "k",
    fetchImpl: async () =>
      jsonResponse({
        jobs: [
          apiJob({ id: "A", filename: "a.dxf" }),
          apiJob({ id: "B", status: "running", filename: "b.dxf", artifacts: [] }),
          apiJob({ id: "C", filename: "c.pdf", artifacts: ["plan.report.json"] }),
        ],
      }),
  });
  const listed = await source.list();
  assert.deepEqual(listed.map((m) => m.id), ["A"]);
  assert.equal(listed[0].name, "a.dxf");
});

test("api source raises a typed error when the key is rejected", async () => {
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "",
    fetchImpl: async () => jsonResponse({ detail: "missing bearer token" }, 401),
  });
  await assert.rejects(() => source.list(), (error) => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.status, 401);
    return true;
  });
});

test("api source downloads plan.ifc for a job id", async () => {
  let seen;
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "k",
    fetchImpl: async (url) => {
      seen = url;
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Map() };
    },
  });
  const bytes = await source.fetchIfc("A");
  assert.equal(seen, "https://api.planto3d.in/v1/jobs/A/artifacts/plan.ifc");
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
});

test("disk source preserves the dev server contract", async () => {
  const urls = [];
  const source = createDiskSource({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === "/api/models") return jsonResponse({ root: "/out", models: [{ path: "a/plan.ifc", name: "plan" }] });
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9]).buffer, headers: new Map() };
    },
  });
  const listed = await source.list();
  assert.equal(listed[0].id, "a/plan.ifc");
  await source.fetchIfc("a/plan.ifc");
  assert.equal(urls[1], "/api/model?path=a%2Fplan.ifc");
});

test("api source reads the field names job_json actually emits", () => {
  // Regression: the viewer read job.id and job.source_filename. job_json emits
  // job_id and nests the filename under source.filename, so every list entry
  // rendered "undefined — undefined" and then fetched /jobs/undefined/...
  const job = apiJob({ id: "01JOB", filename: "plan.dxf" });
  assert.equal(job.id, undefined, "the API does not emit `id`");
  assert.equal(job.source_filename, undefined, "the API does not emit `source_filename`");
  assert.equal(job.job_id, "01JOB");
  assert.equal(job.source.filename, "plan.dxf");
});
