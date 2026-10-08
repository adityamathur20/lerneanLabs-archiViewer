/**
 * Gate: does cad-simple-viewer run under planto3d.in's production CSP, with
 * fonts and workers self-hosted and nothing fetched from a third party?
 *
 * Plan: lerneanLabs-archiAgent docs/superpowers/plans/2026-10-07-mlightcad-cad-viewer.md, Task 3a.
 *
 *   node csp-gate.mjs PLAN.dxf [--font FONT.ttf] [--out DIR]
 *
 * Builds csp-page/ with Vite, lays out what Stage A will serve (the MTEXT
 * worker, a fonts.json and its font), serves it with the CSP header read from
 * ../deploy/Caddyfile, opens it in headless Chrome and checks:
 *
 *   - the drawing opened (`openDocument` resolved true),
 *   - zero CSP violations,
 *   - zero requests to any other origin (the default font CDN included),
 *   - the font index and the font itself loaded,
 *   - the canvas actually drew something.
 *
 * It also reports the bundle size. Writes OUT/gate.json and OUT/gate.png.
 *
 * Chrome: $CHROME_PATH, else macOS Google Chrome, else the Playwright
 * Chromium in /opt/pw-browsers.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import puppeteer from "puppeteer-core";
import { build } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
}
const dxf = process.argv[2];
if (!dxf || dxf.startsWith("--") || !existsSync(dxf)) {
  console.error("usage: node csp-gate.mjs PLAN.dxf [--font FONT.ttf] [--out DIR]");
  process.exit(2);
}
const font = option("--font", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf");
if (!existsSync(font)) {
  console.error(`no font at ${font}: pass --font with an openly licensed .ttf (e.g. Liberation Sans, SIL OFL)`);
  process.exit(2);
}
const out = path.resolve(option("--out", path.join(here, ".gate-dist")));

// --- the production CSP, read from the deployed config so the two never drift
const caddyfile = readFileSync(path.join(here, "..", "deploy", "Caddyfile"), "utf8");
const viewerBlock = caddyfile.slice(caddyfile.indexOf("\nplanto3d.in {"));
const csp = viewerBlock.match(/header Content-Security-Policy "([^"]+)"/)?.[1];
if (!csp) throw new Error("could not find the viewer's Content-Security-Policy in deploy/Caddyfile");

// --- build and lay out what Stage A will serve --------------------------------
await build({
  root: path.join(here, "csp-page"),
  base: "./",
  logLevel: "warn",
  build: { outDir: out, emptyOutDir: true, target: "es2022" },
});
const simpleViewer = path.join(here, "node_modules", "@mlightcad", "cad-simple-viewer", "dist");
mkdirSync(path.join(out, "workers"), { recursive: true });
copyFileSync(path.join(simpleViewer, "mtext-renderer-worker.js"), path.join(out, "workers", "mtext-renderer-worker.js"));

// Our own font index. mlightcad's default index (mlightcad/cad-data) carries
// Autodesk SHX and Microsoft fonts with no licence to redistribute, so the
// names drawings ask for are aliased onto one openly licensed font instead.
const fonts = path.join(out, "cad-data", "fonts");
mkdirSync(fonts, { recursive: true });
copyFileSync(font, path.join(fonts, path.basename(font)));
writeFileSync(path.join(fonts, "fonts.json"), JSON.stringify([{
  file: path.basename(font),
  name: ["simplex", "romans", "txt", "standard", "arial", "amgdt", "simsun", "hztxt", path.parse(font).name],
  type: "mesh",
}]));
copyFileSync(dxf, path.join(out, "sample.dxf"));

// --- serve it with the production header --------------------------------------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf", ".woff": "font/woff",
  ".dxf": "application/octet-stream" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const file = path.join(out, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "content-security-policy": csp,
  });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- drive it -----------------------------------------------------------------
const chrome = process.env.CHROME_PATH ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].find(existsSync);
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const console_ = [];
const thirdParty = [];
const loaded = new Map();
page.on("console", (m) => console_.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console_.push(`[pageerror] ${e.message}`));
page.on("request", (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) thirdParty.push(r.url()); });
page.on("response", (r) => {
  loaded.set(r.url().replace(origin, ""), r.status());
  if (r.status() >= 400) console_.push(`[http ${r.status()}] ${r.url().replace(origin, "")}`);
});
// Violations are counted from the DOM event, not console text: it fires for
// every blocked load, including ones a library catches and hides.
await page.evaluateOnNewDocument(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "(inline)"}`));
});

await page.goto(`${origin}/`, { waitUntil: "load", timeout: 60_000 });
await page.waitForFunction(() => ["opened", "failed"].includes(window.__gate?.phase), { timeout: 120_000 })
  .catch(() => console_.push("[gate] timed out waiting for the drawing to open"));
await new Promise((r) => setTimeout(r, 4000)); // let the renderer and font loads settle

const gate = await page.evaluate(() => ({ ...window.__gate, csp: window.__csp }));
const shot = await page.screenshot({ path: path.join(out, "gate.png") });
// Non-background pixels, decoded in the page (img-src allows data:).
const drawn = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  // Only the drawing area: the toolbar (top right), command line (bottom) and
  // axis icon (bottom left) are UI chrome and draw even when the plan does not.
  const d = g.getImageData(Math.round(c.width * 0.2), Math.round(c.height * 0.1),
    Math.round(c.width * 0.6), Math.round(c.height * 0.75)).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 30) n += 1;
  return n;
}, Buffer.from(shot).toString("base64"));
await browser.close();
server.close();

// --- verdict -------------------------------------------------------------------
const assets = readdirSync(path.join(out, "assets")).filter((f) => f.endsWith(".js"));
const raw = assets.reduce((s, f) => s + statSync(path.join(out, "assets", f)).size, 0);
const gzip = assets.reduce((s, f) => s + zlib.gzipSync(readFileSync(path.join(out, "assets", f))).length, 0);
const fontIndex = loaded.get("/cad-data/fonts/fonts.json");
const fontFile = loaded.get(`/cad-data/fonts/${path.basename(font)}`);

const checks = {
  "drawing opened": gate.opened === true,
  "no CSP violations": gate.csp.length === 0,
  "no third-party requests": thirdParty.length === 0,
  "font index loaded": fontIndex === 200,
  "font file loaded": fontFile === 200,
  "drawing area shows the plan": drawn > 2000,
  "renderer went idle": gate.idle === true,
};
const report = { checks, entities: gate.entities, errors: gate.errors, csp: gate.csp, thirdParty,
  drawnPixels: drawn, bundle: { files: assets.length, rawBytes: raw, gzipBytes: gzip },
  fonts: { index: fontIndex ?? "not requested", file: fontFile ?? "not requested" },
  console: console_.slice(0, 60), policy: csp };
writeFileSync(path.join(out, "gate.json"), JSON.stringify(report, null, 2));

for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log(`  entities ${gate.entities ?? "?"}, drawn pixels ${drawn}, bundle ${assets.length} JS files ` +
  `${(raw / 1e6).toFixed(2)} MB raw / ${(gzip / 1e6).toFixed(2)} MB gzip`);
for (const v of gate.csp) console.log(`  CSP: ${v}`);
for (const u of thirdParty) console.log(`  third party: ${u}`);
for (const e of gate.errors ?? []) console.log(`  error: ${e.split("\n")[0]}`);
console.log(`report: ${path.join(out, "gate.json")}, screenshot: ${path.join(out, "gate.png")}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
