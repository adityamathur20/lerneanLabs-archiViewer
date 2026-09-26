/**
 * Loads the running viewer in real Chrome, waits for the build to finish, and
 * writes a screenshot plus every console message. Verifies the WebGL path that
 * scripts/smoke.mjs cannot reach.
 *
 *   node scripts/shot.mjs http://localhost:5199 /tmp/shot.png
 */
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5173";
const out = process.argv[3] ?? "/tmp/shot.png";

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const log = [];
page.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => log.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 });

// The status overlay hides itself only once a model is on screen.
await page.waitForFunction(
  () => document.getElementById("status")?.style.display === "none",
  { timeout: 90_000 },
).catch(() => log.push("[warn] status overlay never cleared"));

const pick = Number(process.argv[4] ?? 0);
if (pick > 0) {
  await page.evaluate((index) => {
    const select = document.getElementById("manifests");
    select.selectedIndex = index;
    select.dispatchEvent(new Event("change"));
  }, pick);
  await page.waitForFunction(
    () => document.getElementById("status")?.style.display === "none",
    { timeout: 90_000 },
  ).catch(() => log.push("[warn] status overlay never cleared after switch"));
}

const report = await page.evaluate(() => {
  const rows = {};
  for (const tr of document.querySelectorAll("#stats tr")) {
    rows[tr.children[0].textContent] = tr.children[1].textContent;
  }
  const canvas = document.querySelector("canvas");
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  return {
    stats: rows,
    notes: document.getElementById("notes")?.textContent ?? "",
    status: document.getElementById("status")?.textContent ?? "",
    statusHidden: document.getElementById("status")?.style.display === "none",
    canvas: canvas ? [canvas.width, canvas.height] : null,
    renderer: gl ? gl.getParameter(gl.VERSION) : "no webgl context",
    options: [...document.querySelectorAll("#manifests option")].map((o) => o.textContent),
  };
});

await page.screenshot({ path: out });

// Are non-background pixels actually being drawn? The canvas has no
// preserveDrawingBuffer, so drawImage() after the frame reads back empty --
// force a render and pull the pixels straight out of the same GL context.
const coverage = await page.evaluate(() => {
  const v = window.__viewer;
  if (!v) return null;
  v.renderer.render(v.scene, v.camera);
  const gl = v.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    // Background is #14161a; anything materially brighter is geometry or grid.
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 0x14 + 0x16 + 0x1a + 40) lit += 1;
  }
  return { sampled: w * h, lit, fraction: lit / (w * h) };
});

console.log(JSON.stringify({ ...report, coverage, log }, null, 2));
await browser.close();

const ok = report.statusHidden && coverage && coverage.fraction > 0.01;
console.log(ok ? "RENDER OK" : "RENDER FAIL");
process.exit(ok ? 0 : 1);
