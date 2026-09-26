/**
 * Verifies the whole browser model path under Node, where there is no WebGL:
 * read an authored IFC, convert it to fragments, assert the buffer is real.
 *
 * The old version of this script exercised OpenGeometry's extrusions and
 * opening decomposition. None of that exists any more — archiAgent's IFC is
 * the input and web-ifc does the meshing.
 */
import { readFile } from "node:fs/promises";
import { ifcToFrag, FRAG_MIN_BYTES } from "../src/ifc-to-frag.js";

const target = process.argv[2];
if (!target) {
  console.error("usage: npm run smoke -- <path-to.ifc>");
  process.exit(2);
}
if (!target.toLowerCase().endsWith(".ifc")) {
  console.error(`expected a .ifc file, got: ${target}`);
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(target));
console.log(`ifc      ${target}  ${bytes.byteLength} bytes`);

const started = Date.now();
const frag = await ifcToFrag(bytes, {
  onProgress: (f) => process.stdout.write(`\rconvert  ${Math.round(f * 100)}%`),
});
process.stdout.write("\n");

console.log(`frag     ${frag.byteLength} bytes in ${Date.now() - started} ms`);

if (frag.byteLength <= FRAG_MIN_BYTES) {
  console.error(`FAIL: fragments buffer is ${frag.byteLength} bytes; the conversion produced nothing`);
  process.exit(1);
}
console.log("OK");
