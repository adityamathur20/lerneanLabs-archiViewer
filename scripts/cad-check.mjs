/**
 * Checks the BUILT Drawing view (dist/cad) in real Chrome, the way production
 * serves it: the CSP and the try_files routing are read from deploy/Caddyfile.
 *
 *   npm run build            # without VITE_API_BASE: the disk source
 *   node scripts/cad-check.mjs PLAN.dxf [MORE.dxf ...] [--out DIR]
 *
 * The drawings are served through the dev server's disk routes
 * (/api/drawings, /api/drawing), so no API or key is needed. For each drawing
 * it fails unless:
 *
 *   - /cad (no trailing slash) reaches the Drawing view, not the 3D view;
 *   - the drawing opens and the drawing AREA shows it (the toolbar and command
 *     line draw even when the plan does not, so they are excluded);
 *   - "All off" empties the drawing area and "All on" restores it;
 *   - a distance measurement, two clicks, completes and draws;
 *   - there is no CSP violation and no request to any other origin.
 *
 * Writes OUT/<n>.png per drawing. Chrome: $CHROME_PATH, else macOS Google
 * Chrome, else the Playwright Chromium in /opt/pw-browsers.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = path.resolve(outAt >= 0 ? args.splice(outAt, 2)[1] : path.join(root, ".cad-check"));
const drawings = args;
if (!drawings.length || !drawings.every(existsSync)) {
  console.error("usage: node scripts/cad-check.mjs PLAN.dxf [MORE.dxf ...] [--out DIR]");
  process.exit(2);
}
if (!existsSync(path.join(dist, "cad", "index.html"))) {
  console.error("no dist/cad: run `npm run build` first (without VITE_API_BASE)");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

// --- production headers and routing, from the deployed config ---------------
const caddyfile = readFileSync(path.join(root, "deploy", "Caddyfile"), "utf8");
const viewer = caddyfile.slice(caddyfile.indexOf("\nplanto3d.in {"));
const csp = viewer.match(/header Content-Security-Policy "([^"]+)"/)?.[1];
if (!csp) throw new Error("no Content-Security-Policy in the viewer block of deploy/Caddyfile");
const tryFiles = viewer.match(/^\s*try_files (.+)$/m)?.[1].trim().split(/\s+/);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf", ".svg": "image/svg+xml" };

/** Caddy's try_files: the first candidate that exists; "x/" must be a directory. */
function resolveStatic(urlPath) {
  for (const candidate of tryFiles) {
    const p = candidate.replaceAll("{path}", urlPath);
    let file = path.join(dist, decodeURIComponent(p));
    if (!file.startsWith(dist) || !existsSync(file)) continue;
    const isDir = statSync(file).isDirectory();
    if (p.endsWith("/") !== isDir) continue;
    if (isDir) file = path.join(file, "index.html");
    if (existsSync(file)) return file;
  }
  return null;
}

const listed = drawings.map((file, i) => ({ path: `d${i}/${path.basename(file)}`, name: path.basename(file, ".dxf"), hasModel: false, file }));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/drawings") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ root: "check", drawings: listed.map(({ file, ...d }) => d) }));
    return;
  }
  if (url.pathname === "/api/drawing") {
    const hit = listed.find((d) => d.path === url.searchParams.get("path"));
    res.writeHead(hit ? 200 : 404, { "content-type": "application/octet-stream" });
    res.end(hit ? readFileSync(hit.file) : "");
    return;
  }
  const file = resolveStatic(url.pathname);
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "content-security-policy": csp });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- drive it -----------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  ].find(existsSync),
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const thirdParty = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:")) thirdParty.push(u);
});
await page.evaluateOnNewDocument(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "(inline)"}`));
});

/** Non-background pixels inside the drawing area: right of the sidebar, clear of mlightcad's chrome. */
async function drawnPixels() {
  const shot = await page.screenshot({ encoding: "base64" });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const main = document.querySelector("main").getBoundingClientRect();
    const x = Math.round(main.left + main.width * 0.1), y = Math.round(main.height * 0.1);
    const d = g.getImageData(x, y, Math.round(main.width * 0.8), Math.round(main.height * 0.75)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 30) n += 1;
    return n;
  }, shot);
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = true;
const check = (name, pass, detail = "") => {
  ok &&= pass;
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

for (const [i, d] of listed.entries()) {
  console.log(`== ${d.name}`);
  // /cad with no slash on the first drawing: the routing check.
  await page.goto(`${origin}/cad${i === 0 ? "" : "/"}?id=${encodeURIComponent(d.path)}`, { waitUntil: "load", timeout: 60_000 });
  if (i === 0) check("/cad routes to the Drawing view", (await page.title()).includes("Drawing"), await page.title());
  await page.waitForFunction(() => ["opened", "failed"].includes(window.__cad?.phase), { timeout: 180_000 }).catch(() => {});
  const phase = await page.evaluate(() => window.__cad?.phase);
  // "opened" is set only after mlightcad's own progress overlay is gone: it
  // swallows clicks, and the measurement below would silently not happen.
  check("drawing opened", phase === "opened", phase === "failed" ? await page.evaluate(() => window.__cad.errors.join("; ")) : phase);
  await settle(2000);
  const shown = await drawnPixels();
  check("drawing area shows the plan", shown > 2000, `${shown} px`);
  await page.screenshot({ path: path.join(out, `${i}.png`) });

  await page.click("#allOff");
  await page.evaluate(() => window.__cad.idle());
  await settle(500);
  const off = await drawnPixels();
  await page.click("#allOn");
  await page.evaluate(() => window.__cad.idle());
  await settle(500);
  const on = await drawnPixels();
  check("layers: all off empties it, all on restores it", off < shown * 0.2 && on > shown * 0.8, `${shown} → ${off} → ${on} px`);

  await page.click("#measure");
  await settle(500);
  const box = await page.$eval("#cad", (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w * 0.35, box.y + box.h * 0.45);
  await settle(400);
  await page.mouse.click(box.x + box.w * 0.65, box.y + box.h * 0.45);
  await settle(1500);
  // From mlightcad's own record, not pixels: a 16-pixel change once passed
  // here while the command was still waiting for its first point.
  const records = await page.evaluate(() => window.__cad.measurements().map((m) => ({ type: m.type, geometry: m.geometry })));
  const distance = records.find((m) => m.type === "distance");
  check("a distance measurement completes", Boolean(distance), distance ? JSON.stringify(distance.geometry).slice(0, 120) : `${records.length} records`);
  await page.screenshot({ path: path.join(out, `${i}-measured.png`) });
  await page.click("#clearMeasures");
}

const csp_ = await page.evaluate(() => window.__csp);
check("no CSP violations", csp_.length === 0, csp_.slice(0, 3).join("; "));
check("no third-party requests", thirdParty.length === 0, thirdParty.slice(0, 3).join(", "));
await browser.close();
server.close();
console.log(ok ? "PASS" : "FAIL", `screenshots in ${out}`);
process.exit(ok ? 0 : 1);
