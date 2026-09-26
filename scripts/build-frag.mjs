/**
 * plan.ifc -> plan.frag, as a build step.
 *
 * This is the production conversion path: the cost is paid once per model at
 * job time instead of once per page load, and a mobile client never needs the
 * web-ifc WASM. The output is a pure function of the input, so it is a cache —
 * losing it is harmless (invariant I2).
 */
import { readFile, writeFile } from "node:fs/promises";
import { ifcToFrag, FRAG_MIN_BYTES } from "../src/ifc-to-frag.js";
import { writeSidecar } from "./frag-cache.mjs";

const [input, output] = process.argv.slice(2);

if (!input || !output) {
  console.error("usage: node scripts/build-frag.mjs <in.ifc> <out.frag>");
  process.exit(2);
}
if (!input.toLowerCase().endsWith(".ifc")) {
  console.error(`expected a .ifc input, got: ${input}`);
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(input));
const started = Date.now();
const frag = await ifcToFrag(bytes);

if (frag.byteLength <= FRAG_MIN_BYTES) {
  console.error(`FAIL: ${input} converted to ${frag.byteLength} bytes`);
  process.exit(1);
}

await writeFile(output, frag);
// The sidecar is what lets the server tell a current cache from a stale one.
await writeSidecar(output, input);
console.log(`OK ${input} (${bytes.byteLength} B) -> ${output} (${frag.byteLength} B) in ${Date.now() - started} ms`);
