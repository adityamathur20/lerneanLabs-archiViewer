/**
 * Where the viewer's models come from.
 *
 * Two implementations, one interface. `createDiskSource` is the dev server's
 * disk scan (vite.config.js middleware); `createApiSource` is the deployed
 * service. main.js picks one and never learns which.
 *
 * There is deliberately no `.frag` path here: the worker produces none
 * (`ARTIFACT_PATTERNS` has no `*.frag`, and the converter is Node), so the
 * browser converts the IFC itself. With no server-side cache, invariant I2
 * holds for want of a cache to go stale.
 */

export class SourceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SourceError";
    this.status = status;
  }
}

async function detail(response) {
  try {
    const body = await response.json();
    return body?.detail ?? body?.error ?? response.statusText;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

export function createApiSource({ base, token, fetchImpl = globalThis.fetch }) {
  if (!base) throw new Error("createApiSource needs a base URL");
  const trimmed = base.replace(/\/$/, "");
  // The token goes to the API only. Browsers strip Authorization across an
  // origin-changing redirect, which is what keeps it away from Garage — a
  // forwarded bearer would collide with the query-string signature.
  const init = () => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

  return {
    kind: "api",
    describe: () => trimmed,

    async list() {
      const response = await fetchImpl(`${trimmed}/v1/jobs?limit=200`, init());
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      const { jobs = [] } = await response.json();
      return jobs
        .filter((job) => job.status === "succeeded" && (job.artifacts ?? []).includes("plan.ifc"))
        // Field names come from job_json() in api.py: `job_id`, and the
        // filename nested under `source`. Not `id`/`source_filename`.
        .map((job) => ({
          id: job.job_id,
          name: job.source?.filename ?? job.job_id,
          label: `${job.source?.filename ?? job.job_id} — ${job.job_id}`,
          hasDrawing: (job.artifacts ?? []).includes("plan.dxf"),
        }));
    },

    /**
     * Every job with a drawing to show, whatever its outcome: a job that
     * failed because its scale could not be established still has its
     * plan.dxf, and that is exactly the drawing a user opens to measure a wall.
     */
    async listDrawings() {
      const response = await fetchImpl(`${trimmed}/v1/jobs?limit=200`, init());
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      const { jobs = [] } = await response.json();
      return jobs
        .filter((job) => (job.artifacts ?? []).includes("plan.dxf"))
        .map((job) => ({
          id: job.job_id,
          name: job.source?.filename ?? job.job_id,
          label: `${job.source?.filename ?? job.job_id} — ${job.status}`,
          hasModel: (job.artifacts ?? []).includes("plan.ifc"),
        }));
    },

    /** The DXF the viewer opens: the upload itself, or ODA's conversion of a DWG. */
    async fetchDxf(id) {
      const response = await fetchImpl(`${trimmed}/v1/jobs/${id}/artifacts/plan.dxf`, init());
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      return new Uint8Array(await response.arrayBuffer());
    },

    async fetchIfc(id) {
      const response = await fetchImpl(`${trimmed}/v1/jobs/${id}/artifacts/plan.ifc`, init());
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      return new Uint8Array(await response.arrayBuffer());
    },

    /**
     * Uploads a drawing and queues it. Three steps, in this order, because
     * the service will not start a job whose bytes are not in the store yet.
     *
     * Returns the job id so the caller can poll it.
     */
    async createJob(blob, filename, options = {}) {
      // The presigned PUT is signed against this exact byte count, so it must
      // be the real one — a mismatch is refused by the store, and `start`
      // refuses again by comparing the stored object to the declaration.
      const size = blob.size;

      const created = await fetchImpl(`${trimmed}/v1/uploads`, {
        method: "POST",
        headers: { ...init().headers, "content-type": "application/json" },
        body: JSON.stringify({ filename, size }),
      });
      if (!created.ok) throw new SourceError(await detail(created), created.status);
      const { job_id: jobId, upload_url: uploadUrl } = await created.json();

      // Deliberately NO authorization header: the credential for this request
      // is the signature in the URL, and a bearer token would collide with it.
      const stored = await fetchImpl(uploadUrl, { method: "PUT", body: blob });
      if (!stored.ok) {
        throw new SourceError(`uploading to the object store failed (${stored.status})`, stored.status);
      }

      // Every field of StartRequest is optional, but the body itself is not,
      // and a null would fail validation — so empty values are omitted.
      const body = Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== null && value !== undefined && value !== ""),
      );
      const started = await fetchImpl(`${trimmed}/v1/jobs/${jobId}/start`, {
        method: "POST",
        headers: { ...init().headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!started.ok) throw new SourceError(await detail(started), started.status);
      return jobId;
    },

    /** One status poll, for the caller's own loop. */
    async jobStatus(id) {
      const response = await fetchImpl(`${trimmed}/v1/jobs/${id}`, init());
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      const job = await response.json();
      return {
        id: job.job_id,
        status: job.status,
        acceptance: job.acceptance,
        error: job.error,
        artifacts: job.artifacts ?? [],
      };
    },
  };
}

export function createDiskSource({ fetchImpl = globalThis.fetch } = {}) {
  return {
    kind: "disk",
    describe: () => "local disk (dev server)",

    async list() {
      const response = await fetchImpl("/api/models");
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      const { models = [] } = await response.json();
      return models.map((model) => ({
        id: model.path,
        name: model.name,
        label: `${model.name} — ${model.path}`,
      }));
    },

    async fetchIfc(id) {
      const response = await fetchImpl(`/api/model?path=${encodeURIComponent(id)}`);
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      return new Uint8Array(await response.arrayBuffer());
    },

    async listDrawings() {
      const response = await fetchImpl("/api/drawings");
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      const { drawings = [] } = await response.json();
      return drawings.map((d) => ({ id: d.path, name: d.name, label: `${d.name} — ${d.path}`, hasModel: d.hasModel }));
    },

    async fetchDxf(id) {
      const response = await fetchImpl(`/api/drawing?path=${encodeURIComponent(id)}`);
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
