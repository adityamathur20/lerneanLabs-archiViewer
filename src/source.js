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
        }));
    },

    async fetchIfc(id) {
      const response = await fetchImpl(`${trimmed}/v1/jobs/${id}/artifacts/plan.ifc`, init());
      if (!response.ok) throw new SourceError(await detail(response), response.status);
      return new Uint8Array(await response.arrayBuffer());
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
  };
}
