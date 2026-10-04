/**
 * Loads the production build behind the real deploy/Caddyfile headers and
 * fails if the CSP breaks the app or if anything reaches a third party.
 *
 * A CSP is only as good as the proof that the app still works under it, and
 * the only way to know is a real browser. Usage:
 *   docker run ... caddy  # serving dist/ with the Caddyfile's viewer block
 *   node scripts/csp-check.mjs [url]
 */
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();

const violations = [];
const errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/Content Security Policy|Refused to/i.test(t)) violations.push(t);
  else if (m.type() === "error") errors.push(t);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const target = process.argv[2] ?? "http://localhost:8080/";
await page.goto(target, { waitUntil: "networkidle2", timeout: 45000 });
await new Promise((r) => setTimeout(r, 4000));

// Did the Fragments runtime (worker + wasm) actually come up under CSP?
const viewerUp = await page.evaluate(() => Boolean(window.__viewer?.viewer));
const workerRequested = await page.evaluate(() =>
  performance.getEntriesByType("resource").some((e) => /assets\/worker-.*\.mjs/.test(e.name)),
);
const unpkgRequested = await page.evaluate(() =>
  performance.getEntriesByType("resource").some((e) => e.name.includes("unpkg.com")),
);

console.log(`  CSP violations:      ${violations.length}`);
violations.slice(0, 6).forEach((v) => console.log(`    - ${v.slice(0, 150)}`));
console.log(`  viewer initialised:  ${viewerUp}`);
console.log(`  local worker loaded: ${workerRequested}`);
console.log(`  unpkg.com requested: ${unpkgRequested}`);
console.log(`  other console errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log(`    - ${e.slice(0, 140)}`));

await browser.close();
process.exit(violations.length === 0 && viewerUp && !unpkgRequested ? 0 : 1);
