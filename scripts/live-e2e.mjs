/**
 * Drives the DEPLOYED site in a real browser: enter key, upload a drawing,
 * wait for conversion, confirm it renders.
 *
 * This is the only test that exercises the whole chain at once — CSP, the
 * cross-origin API call with its preflight, the presigned PUT to the object
 * store, job polling, the 302 to a signed artifact URL, and web-ifc parsing
 * the result. Every piece of it has broken independently during this project
 * while curl stayed green.
 *
 *   node scripts/live-e2e.mjs <url> <apiKey> <dxfPath>
 */
import puppeteer from "puppeteer-core";

const [url, apiKey, dxfPath] = process.argv.slice(2);
if (!url || !apiKey || !dxfPath) {
  console.error("usage: node scripts/live-e2e.mjs <url> <apiKey> <dxfPath>");
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();

const cors = [];
const errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/CORS|Access-Control|Refused to|Content Security Policy/i.test(t)) cors.push(t);
  else if (m.type() === "error") errors.push(t);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// Seed the key before the app boots, the way a returning visitor would have it.
await page.evaluateOnNewDocument((k) => {
  try { localStorage.setItem("planto3d.apiKey", k); } catch {}
}, apiKey);

await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
console.log(`  loaded ${url}`);

await page.waitForSelector("#file", { timeout: 15000 });
const input = await page.$("#file");
await input.uploadFile(dxfPath);
await page.click("#convert");
console.log(`  uploaded ${dxfPath.split("/").pop()}, converting…`);

const deadline = Date.now() + 25 * 60 * 1000;
let progress = "";
while (Date.now() < deadline) {
  progress = await page.$eval("#progress", (el) => el.textContent).catch(() => "");
  if (/^done/.test(progress) || /^failed/.test(progress)) break;
  await new Promise((r) => setTimeout(r, 10000));
}
console.log(`  progress: ${progress}`);

// Did a model actually render? Boxes come from Fragments, not the scene graph.
const rendered = await page.evaluate(async () => {
  const v = window.__viewer;
  if (!v) return { viewer: false };
  const sel = document.getElementById("manifests");
  return {
    viewer: true,
    options: sel ? sel.options.length : 0,
    selected: sel?.selectedOptions?.[0]?.textContent ?? null,
    meshes: v.scene.children.filter((c) => c.type === "Group" || c.type === "Mesh").length,
  };
});
console.log(`  viewer: ${JSON.stringify(rendered)}`);
console.log(`  CORS/CSP violations: ${cors.length}`);
cors.slice(0, 5).forEach((c) => console.log(`    - ${c.slice(0, 160)}`));
console.log(`  other console errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log(`    - ${e.slice(0, 160)}`));

await page.screenshot({ path: "/tmp/live-e2e.png", fullPage: false });
console.log("  screenshot: /tmp/live-e2e.png");
await browser.close();
process.exit(cors.length === 0 && /^done/.test(progress) ? 0 : 1);
