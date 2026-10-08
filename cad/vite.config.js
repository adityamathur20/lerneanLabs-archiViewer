import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Drawing view, served at /cad/. Built into ../dist/cad AFTER the IFC
 * viewer's build, which empties ../dist.
 */
export default {
  root: here,
  base: "/cad/",
  // VITE_API_BASE, like the IFC viewer, from the repository root's env.
  envDir: path.resolve(here, ".."),
  build: {
    outDir: path.resolve(here, "../dist/cad"),
    emptyOutDir: true,
    // Top-level await, as in the IFC viewer.
    target: "es2022",
    // mlightcad is one ~3.9 MB chunk; the warning says nothing actionable.
    chunkSizeWarningLimit: 5000,
  },
  server: {
    port: 5174,
    // The IFC viewer's dev server (5173) owns the /api disk routes.
    proxy: { "/api": "http://localhost:5173" },
    // src/source.js is shared with the IFC viewer, one level up.
    fs: { allow: [path.resolve(here, "..")] },
  },
};
