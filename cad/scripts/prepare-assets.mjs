/**
 * Copies the MTEXT layout worker out of node_modules into public/workers, so
 * it is served from our own origin under the production CSP
 * (worker-src 'self'). Generated, so public/workers is gitignored.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, "..", "node_modules", "@mlightcad", "cad-simple-viewer", "dist", "mtext-renderer-worker.js");
const to = path.join(here, "..", "public", "workers");
mkdirSync(to, { recursive: true });
copyFileSync(from, path.join(to, "mtext-renderer-worker.js"));
