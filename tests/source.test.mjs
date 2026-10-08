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


// --- creating a job from the browser ----------------------------------------

test("creating a job runs upload -> presigned PUT -> start, in that order", async () => {
  const seen = [];
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "k",
    fetchImpl: async (url, init = {}) => {
      seen.push(`${init.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/uploads")) {
        return jsonResponse({ job_id: "01JOB", key: "t/01JOB/source.dxf", upload_url: "https://s3.planto3d.in/signed" });
      }
      return jsonResponse({ status: "queued" });
    },
  });

  const jobId = await source.createJob(new Blob(["dxfbytes"]), "plan.dxf", { trust_extracted_scale: true });
  assert.equal(jobId, "01JOB");
  assert.deepEqual(seen, [
    "POST https://api.planto3d.in/v1/uploads",
    "PUT https://s3.planto3d.in/signed",
    "POST https://api.planto3d.in/v1/jobs/01JOB/start",
  ]);
});

test("the declared size is the real byte length", async () => {
  // The presigned PUT is signed against the declared ContentLength, so a
  // mismatch is rejected by the store and the job can never start.
  let declared;
  const bytes = new Blob(["0123456789"]);
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "k",
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/v1/uploads")) {
        declared = JSON.parse(init.body).size;
        return jsonResponse({ job_id: "J", upload_url: "https://s3/x" });
      }
      return jsonResponse({});
    },
  });
  await source.createJob(bytes, "plan.dxf", {});
  assert.equal(declared, 10);
});

test("the bearer token is never sent to the object store", async () => {
  // Browsers strip Authorization across an origin-changing redirect, but this
  // PUT is a direct request we construct — nothing would strip it. A bearer
  // token reaching Garage collides with its query-string signature.
  let storeInit;
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "ak_secret",
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/v1/uploads")) return jsonResponse({ job_id: "J", upload_url: "https://s3.planto3d.in/signed" });
      if (url.startsWith("https://s3.")) storeInit = init;
      return jsonResponse({});
    },
  });
  await source.createJob(new Blob(["x"]), "plan.dxf", {});
  const headers = storeInit.headers ?? {};
  assert.ok(!("authorization" in headers), "no authorization header may reach the store");
});

test("a rejected upload surfaces the API's own message", async () => {
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "k",
    fetchImpl: async () => jsonResponse({ detail: "unsupported format .txt; accepted: ['.dwg', '.dxf', '.pdf']" }, 400),
  });
  await assert.rejects(() => source.createJob(new Blob(["x"]), "notes.txt", {}), (error) => {
    assert.match(error.message, /unsupported format/);
    assert.equal(error.status, 400);
    return true;
  });
});

test("options with no value are not sent at all", async () => {
  // start accepts a body of {} and treats every field as optional; sending
  // nulls would fail validation.
  let startBody;
  const source = createApiSource({
    base: "https://api.planto3d.in",
    token: "k",
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/v1/uploads")) return jsonResponse({ job_id: "J", upload_url: "https://s3/x" });
      if (url.includes("/start")) startBody = JSON.parse(init.body);
      return jsonResponse({});
    },
  });
  await source.createJob(new Blob(["x"]), "plan.dxf", { trust_extracted_scale: null, height_ft: 10 });
  assert.deepEqual(startBody, { height_ft: 10 });
});

// --- the Drawing view (cad/) -------------------------------------------------

test("drawings include jobs that failed, because a failed job still has its plan.dxf", async () => {
  // A DXF refused for want of a scale is exactly the drawing a user opens to
  // measure a wall, so the Drawing view must list it; the 3D list must not.
  const jobs = [
    apiJob({ id: "OK", filename: "a.dwg", artifacts: ["plan.dxf", "plan.ifc"] }),
    apiJob({ id: "NOSCALE", status: "failed", filename: "b.dxf", artifacts: ["plan.dxf"] }),
    apiJob({ id: "PDF", filename: "c.pdf", artifacts: ["plan.ifc"] }),
  ];
  const source = createApiSource({ base: "https://api.planto3d.in", token: "k", fetchImpl: async () => jsonResponse({ jobs }) });

  const drawings = await source.listDrawings();
  assert.deepEqual(drawings.map((d) => [d.id, d.hasModel]), [["OK", true], ["NOSCALE", false]]);
  assert.match(drawings[1].label, /failed/);

  const models = await source.list();
  assert.deepEqual(models.map((m) => [m.id, m.hasDrawing]), [["OK", true], ["PDF", false]]);
});

test("the drawing is the job's plan.dxf, fetched with the bearer token", async () => {
  let seen;
  const source = createApiSource({
    base: "https://api.planto3d.in/",
    token: "ak_secret",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer, headers: new Map() };
    },
  });
  const bytes = await source.fetchDxf("01JOB");
  assert.equal(seen.url, "https://api.planto3d.in/v1/jobs/01JOB/artifacts/plan.dxf");
  assert.equal(seen.init.headers.authorization, "Bearer ak_secret");
  assert.equal(bytes.byteLength, 2);
});

test("disk source serves drawings through the dev server's confined routes", async () => {
  const urls = [];
  const source = createDiskSource({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === "/api/drawings") {
        return jsonResponse({ root: "/out", drawings: [{ path: "a/plan.dxf", name: "plan", hasModel: true }] });
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9]).buffer, headers: new Map() };
    },
  });
  const [drawing] = await source.listDrawings();
  assert.deepEqual([drawing.id, drawing.hasModel], ["a/plan.dxf", true]);
  await source.fetchDxf(drawing.id);
  assert.equal(urls[1], "/api/drawing?path=a%2Fplan.dxf");
});

// --- the scale gate ----------------------------------------------------------------

test("a drawing is uploaded and prepared, not started", async () => {
  const seen = [];
  const source = createApiSource({
    base: "https://api.planto3d.in", token: "k",
    fetchImpl: async (url, init = {}) => {
      seen.push(`${init.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/uploads")) return jsonResponse({ job_id: "J", upload_url: "https://s3.planto3d.in/signed" });
      return jsonResponse({ status: "preparing" });
    },
  });
  assert.equal(await source.prepareJob(new Blob(["dwg"]), "plan.dwg"), "J");
  assert.deepEqual(seen, [
    "POST https://api.planto3d.in/v1/uploads",
    "PUT https://s3.planto3d.in/signed",
    "POST https://api.planto3d.in/v1/jobs/J/prepare",
  ]);
});

test("a chosen scale starts a ready job, or retries a finished one", async () => {
  const seen = [];
  const source = createApiSource({
    base: "https://api.planto3d.in", token: "k",
    fetchImpl: async (url, init = {}) => {
      seen.push([url, JSON.parse(init.body)]);
      return jsonResponse(url.endsWith("/retry") ? { job_id: "NEW", status: "queued" } : { status: "queued" });
    },
  });
  const wall = { scale_from_wall: [{ x1: 0, y1: 0, x2: 144, y2: 0, length: "12ft" }] };
  await source.startJob("READY", wall);
  assert.equal(await source.retryJob("FAILED", { trust_extracted_scale: true }), "NEW");
  assert.deepEqual(seen, [
    ["https://api.planto3d.in/v1/jobs/READY/start", wall],
    ["https://api.planto3d.in/v1/jobs/FAILED/retry", { trust_extracted_scale: true }],
  ]);
});

test("scale evidence is plan.scale.json, and its absence is not an error", async () => {
  const evidence = { schema_version: 1, extracted: null };
  const source = createApiSource({
    base: "https://api.planto3d.in", token: "k",
    fetchImpl: async (url) => (url.includes("/HAS/") ? jsonResponse(evidence) : jsonResponse({ detail: "no" }, 404)),
  });
  assert.deepEqual(await source.fetchScaleEvidence("HAS"), evidence);
  assert.equal(await source.fetchScaleEvidence("NONE"), null);
});
