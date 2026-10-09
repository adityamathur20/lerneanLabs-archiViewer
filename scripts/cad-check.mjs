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
  if (url.pathname === "/api/scale") {
    // <name>.scale.json beside the drawing, as `archiagent --prepare` writes it.
    const hit = listed.find((d) => d.path === url.searchParams.get("path"));
    const evidence = hit && hit.file.replace(/\.dxf$/i, ".scale.json");
    if (!evidence || !existsSync(evidence)) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readFileSync(evidence));
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

  // --- the Scale panel -------------------------------------------------------
  const evidenceFile = d.file.replace(/\.dxf$/i, ".scale.json");
  const evidence = existsSync(evidenceFile) ? JSON.parse(readFileSync(evidenceFile, "utf8")) : null;
  const sw = await page.$eval("#useDims", (e) => ({ disabled: e.disabled, checked: e.checked }));
  const reason = await page.$eval("#dimsReason", (e) => e.textContent);
  if (evidence?.extracted) {
    check("switch: dimensions establish a scale, so it is enabled and on", !sw.disabled && sw.checked, reason);
    check("switch: Convert is available with no wall measured", !(await page.$eval("#convertScale", (e) => e.disabled)));
  } else {
    check("switch: no usable dimensions, so it is off and disabled, with the reason", sw.disabled && !sw.checked && reason.length > 10, reason);
    check("switch: Convert is not available with nothing chosen", await page.$eval("#convertScale", (e) => e.disabled));
  }

  // Pick the two longest visible LINEs, each at its midpoint.
  const targets = await page.evaluate(() => {
    const m = window.__cad.manager, v = m.curView, box = document.getElementById("cad").getBoundingClientRect(); const found = [];
    for (const e of m.curDocument.database.tables.blockTable.modelSpace.newIterator()) {
      if (e.dxfTypeName !== "LINE") continue; const a = e.startPoint, b = e.endPoint;
      const mid = v.worldToScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      if (mid.x < 20 || mid.y < 20 || mid.x > box.width - 20 || mid.y > box.height - 60) continue;
      found.push({ id: e.objectId, len: Math.hypot(b.x - a.x, b.y - a.y), mid, left: box.left, top: box.top });
    }
    found.sort((p, q) => q.len - p.len);
    const chosen = [];
    for (const f of found) if (chosen.every((c) => Math.hypot(c.mid.x - f.mid.x, c.mid.y - f.mid.y) > 30)) chosen.push(f);
    return chosen.slice(0, 2);
  });
  if (targets.length < 2) { check("walls: two lines to pick", false, `${targets.length} found`); continue; }
  for (const [n, t] of targets.entries()) {
    await page.click("#pickWall");
    await page.mouse.click(t.left + t.mid.x, t.top + t.mid.y);
    await settle(400);
    check(`walls: wall ${n + 1} is picked and listed`, (await page.evaluate(() => window.__cad.scale.walls.length)) === n + 1);
    // The length comes from the wall actually picked: a click can land on a
    // different overlapping entity than the one aimed at.
    const span = await page.evaluate((k) => { const w = window.__cad.scale.walls[k]; return Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y); }, n);
    await page.type(`.wallRow:nth-child(${n + 1}) .wallLength`, `${(span / 12).toFixed(4)}ft`);
  }
  const first = await page.evaluate(() => ({ ids: window.__cad.scale.walls.map((w) => w.id), r: window.__cad.scale.result }));
  check("walls: two different lines were picked", new Set(first.ids).size === 2, first.ids.join(","));
  check("walls: they agree, and Convert is available", first.r.agreement === "agree" && !(await page.$eval("#convertScale", (e) => e.disabled)),
    await page.$eval("#scaleReadout", (e) => e.textContent));
  await page.screenshot({ path: path.join(out, `${i}-two-walls.png`) });

  await page.click("#convertScale"); await settle(300);
  const cli = await page.evaluate(() => window.__cad.cli ?? "");
  const spans = [...cli.matchAll(/--scale-from-wall (\S+) (\S+) (\S+) (\S+) "/g)].map((m) => m.slice(1).map(Number));
  const picked = await page.evaluate(() => window.__cad.scale.walls.map((w) => [w.start.x, w.start.y, w.end.x, w.end.y]));
  check("walls: both spans sent are the entities' own vertices", spans.length === 2 && spans.every((s, k) => s.join() === picked[k].join()), cli.slice(0, 80));

  // A second wall that disagrees must stop Convert before the run does.
  const second = await page.evaluate(() => { const w = window.__cad.scale.walls[1]; return Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y); });
  await page.$eval(".wallRow:nth-child(2) .wallLength", (e) => { e.value = ""; });
  await page.type(".wallRow:nth-child(2) .wallLength", `${(second / 12 / 2).toFixed(4)}ft`);
  const disagree = await page.evaluate(() => window.__cad.scale.result);
  check("walls: a disagreeing second length blocks Convert and says why",
    disagree.agreement === "disagree" && await page.$eval("#convertScale", (e) => e.disabled), disagree.message.slice(0, 70));
  await page.click(".wallRow:nth-child(2) button.remove"); await settle(200);
  check("walls: removing the second wall restores Convert", (await page.evaluate(() => window.__cad.scale.walls.length)) === 1
    && !(await page.$eval("#convertScale", (e) => e.disabled)));

  // --- Wall thickness: typed, optional ---------------------------------------
  const convertOff = () => page.$eval("#convertScale", (e) => e.disabled);
  check("thickness: 'only these' is disabled while no thickness is given", await page.$eval("#thicknessExhaustive", (e) => e.disabled && !e.checked));
  await page.click("#addThickness");
  await page.type(".thicknessRow:nth-child(1) input", "9");
  await page.click("#addThickness");
  await page.type(".thicknessRow:nth-child(2) input", "11.43");
  await page.select(".thicknessRow:nth-child(2) select", "cm");
  check("thickness: 'only these' becomes available with a valid thickness", await page.$eval("#thicknessExhaustive", (e) => !e.disabled));
  await page.click("#thicknessExhaustive");
  await page.click("#addThickness");
  await page.type(".thicknessRow:nth-child(3) input", "abc");
  const wrong = await page.$eval("#thicknessReadout", (e) => e.textContent);
  check("thickness: a wrong row blocks Convert and names itself", (await convertOff()) && /Thickness 3/.test(wrong), wrong);
  await page.click(".thicknessRow:nth-child(3) button.remove"); await settle(200);
  check("thickness: removing the wrong row restores Convert", !(await convertOff()));
  await page.evaluate(() => { window.__cad.cli = ""; });
  await page.click("#convertScale"); await settle(300);
  const thicknessCli = await page.evaluate(() => window.__cad.cli ?? "");
  check("thickness: 9 in and 11.43 cm are sent as 4.5 and 9 inches, with 'only these'",
    /--wall-thickness 4\.5 9(\s|$)/.test(thicknessCli) && /--wall-thickness-exhaustive/.test(thicknessCli), thicknessCli.slice(0, 120));
  await page.screenshot({ path: path.join(out, `${i}-thickness.png`) });
  await page.click(".thicknessRow:nth-child(2) button.remove");
  await page.click(".thicknessRow:nth-child(1) button.remove"); await settle(200);
  check("thickness: with every row removed, 'only these' clears and disables itself",
    await page.$eval("#thicknessExhaustive", (e) => e.disabled && !e.checked));

  // --- Pointer / Hand: mlightcad's own selection and pan modes ----------------
  const world = () => page.evaluate(() => { const p = window.__cad.manager.curView.screenToWorld({ x: 400, y: 300 }); return [p.x, p.y]; });
  const dragBy = async (dx, dy) => {
    const b = await page.$eval("#cad", (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top]; });
    await page.mouse.move(b[0] + 420, b[1] + 320); await page.mouse.down();
    await page.mouse.move(b[0] + 420 + dx / 2, b[1] + 320 + dy / 2, { steps: 4 }); await page.mouse.move(b[0] + 420 + dx, b[1] + 320 + dy, { steps: 4 });
    await page.mouse.up(); await settle(500);
  };
  const strip = await page.evaluate(() => { const r = document.getElementById("toolstrip").getBoundingClientRect(), m = document.querySelector("main").getBoundingClientRect(); return { right: m.right - r.right, top: r.top }; });
  check("tools: the strip sits on the right edge of the drawing", strip.right < 40 && strip.right >= 0, `${Math.round(strip.right)}px from the edge`);
  await page.click("#toolHand"); await settle(300);
  check("tools: Hand sets mlightcad's PAN mode", (await page.evaluate(() => window.__cad.manager.curView.mode)) === 1
    && await page.$eval("#toolHand", (e) => e.classList.contains("active")));
  const before = await world(); await dragBy(120, 60); const after = await world();
  check("tools: dragging with Hand pans the view", Math.hypot(after[0] - before[0], after[1] - before[1]) > 1e-6, `moved ${Math.round(Math.hypot(after[0] - before[0], after[1] - before[1]))} units`);
  await page.click("#toolPointer"); await settle(300);
  check("tools: Pointer sets SELECTION mode", (await page.evaluate(() => window.__cad.manager.curView.mode)) === 0
    && await page.$eval("#toolPointer", (e) => e.classList.contains("active")));
  const b2 = await world(); await dragBy(120, 60); const a2 = await world();
  check("tools: dragging with Pointer does not pan", Math.hypot(a2[0] - b2[0], a2[1] - b2[1]) < 1e-6);
  await page.click("#measure"); await settle(300);
  check("tools: starting a measurement leaves the strip on Pointer", await page.$eval("#toolPointer", (e) => e.classList.contains("active")));
  await page.keyboard.press("Escape"); await settle(200);

  const commandLine = await page.evaluate(() => [...document.querySelectorAll("input,textarea")].filter((e) => /type command/i.test(e.placeholder) && e.offsetParent).length);
  check("the command-line box is gone", commandLine === 0);
  await page.screenshot({ path: path.join(out, `${i}-panel.png`) });
}

const csp_ = await page.evaluate(() => window.__csp);
check("no CSP violations", csp_.length === 0, csp_.slice(0, 3).join("; "));
check("no third-party requests", thirdParty.length === 0, thirdParty.slice(0, 3).join(", "));
await browser.close();
server.close();
console.log(ok ? "PASS" : "FAIL", `screenshots in ${out}`);
process.exit(ok ? 0 : 1);
