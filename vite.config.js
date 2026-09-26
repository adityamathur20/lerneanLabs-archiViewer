import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fragIsCurrent } from "./scripts/frag-cache.mjs";

export { fragIsCurrent };

/**
 * Serves archiAgent output straight from disk so the viewer reads the same
 * files the pipeline just wrote. Point it at your `--outputDir` (or a parent of
 * several) with ARCHIAGENT_OUT.
 *
 * This used to serve `*.interpretation.json` for the browser to rebuild
 * geometry from. It now serves the authored `*.ifc` — the model is the
 * pipeline's own output, not a reconstruction of it.
 */
const OUT_ROOT = path.resolve(process.env.ARCHIAGENT_OUT ?? path.resolve(process.cwd(), ".."));
const SUFFIX = ".ifc";

export async function findModels(dir, depth = 0) {
  if (depth > 3) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findModels(full, depth + 1)));
    else if (entry.name.toLowerCase().endsWith(SUFFIX)) {
      const info = await stat(full);
      found.push({
        path: path.relative(OUT_ROOT, full),
        name: entry.name.slice(0, -SUFFIX.length),
        bytes: info.size,
        modified: info.mtime.toISOString(),
      });
    }
  }
  return found;
}

/**
 * Confines a requested path to `root` and to `.ifc` files. Returns the absolute
 * path, or null if the request escapes the root or asks for anything else.
 *
 * A traversal here would read any file on the machine, so this is a named,
 * tested function rather than an inline check.
 */
export function resolveWithinRoot(root, requested, suffix = SUFFIX) {
  if (!requested) return null;
  const resolved = path.resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  if (!resolved.toLowerCase().endsWith(suffix)) return null;
  return resolved;
}

function archiagentOutput() {
  return {
    name: "archiagent-output",
    configureServer(server) {
      server.middlewares.use("/api/models", async (_req, res) => {
        const models = (await findModels(OUT_ROOT)).sort((a, b) =>
          b.modified.localeCompare(a.modified),
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ root: OUT_ROOT, models }));
      });

      server.middlewares.use("/api/model", async (req, res) => {
        const requested = new URL(req.url, "http://localhost").searchParams.get("path");
        const resolved = resolveWithinRoot(OUT_ROOT, requested);
        if (!resolved) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: `only ${SUFFIX} files inside ARCHIAGENT_OUT are served` }));
          return;
        }
        try {
          const body = await readFile(resolved);
          res.setHeader("content-type", "application/octet-stream");
          res.end(body);
        } catch (error) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        }
      });

      server.middlewares.use("/api/frag", async (req, res) => {
        const requested = new URL(req.url, "http://localhost").searchParams.get("path");
        const resolved = resolveWithinRoot(OUT_ROOT, requested, ".frag");
        if (!resolved) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "only .frag files inside ARCHIAGENT_OUT are served" }));
          return;
        }
        // A cache that cannot be shown to match its input must not be served:
        // otherwise a stale .frag silently outranks the authored IFC (I2).
        const ifcPath = resolved.replace(/\.frag$/i, ".ifc");
        if (!(await fragIsCurrent(resolved, ifcPath))) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "no current precomputed fragments" }));
          return;
        }
        try {
          const body = await readFile(resolved);
          res.setHeader("content-type", "application/octet-stream");
          // Provenance, so the panel can say WHICH build this came from.
          const sidecar = JSON.parse(await readFile(`${resolved}.json`, "utf8"));
          if (sidecar.builtAt) res.setHeader("x-frag-built-at", sidecar.builtAt);
          res.end(body);
        } catch {
          // Absent is normal: not every model has been precomputed.
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "no precomputed fragments" }));
        }
      });
    },
  };
}

export default {
  plugins: [archiagentOutput()],
  server: { port: 5173, open: false },
  // web-ifc's .wasm arrives through @thatopen/fragments and must not be inlined.
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: { exclude: ["@thatopen/fragments"] },
};
