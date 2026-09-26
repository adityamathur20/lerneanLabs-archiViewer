import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Serves archiAgent output straight from disk so the viewer reads the same
 * files the pipeline just wrote — no copy step, no build. Point it at your
 * `--outputDir` (or a parent of several) with ARCHIAGENT_OUT.
 */
const OUT_ROOT = path.resolve(process.env.ARCHIAGENT_OUT ?? path.resolve(process.cwd(), ".."));
const SUFFIX = ".interpretation.json";

async function findManifests(dir, depth = 0) {
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
    if (entry.isDirectory()) found.push(...(await findManifests(full, depth + 1)));
    else if (entry.name.endsWith(SUFFIX)) {
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

function archiagentOutput() {
  return {
    name: "archiagent-output",
    configureServer(server) {
      server.middlewares.use("/api/manifests", async (_req, res) => {
        const manifests = (await findManifests(OUT_ROOT)).sort((a, b) => b.modified.localeCompare(a.modified));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ root: OUT_ROOT, manifests }));
      });

      server.middlewares.use("/api/manifest", async (req, res) => {
        const requested = new URL(req.url, "http://localhost").searchParams.get("path");
        if (!requested) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "missing ?path=" }));
          return;
        }
        // Resolve and confine to OUT_ROOT: this is a dev server reading local
        // files, and a traversal here would read anything on the machine.
        const resolved = path.resolve(OUT_ROOT, requested);
        if (resolved !== OUT_ROOT && !resolved.startsWith(OUT_ROOT + path.sep)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "path outside ARCHIAGENT_OUT" }));
          return;
        }
        if (!resolved.endsWith(SUFFIX)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: `only ${SUFFIX} files are served` }));
          return;
        }
        try {
          const body = await readFile(resolved, "utf8");
          res.setHeader("content-type", "application/json");
          res.end(body);
        } catch (error) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        }
      });
    },
  };
}

export default {
  plugins: [archiagentOutput()],
  server: { port: 5173, open: false },
  // The kernel ships a .wasm that must not be inlined or transformed.
  assetsInclude: ["**/*.wasm"],
  // `OpenGeometry.create()` is awaited at module top level, which needs es2022.
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
};
