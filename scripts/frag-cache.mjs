/**
 * Cache validity for `.frag` files.
 *
 * Spec invariant I2 says `.frag` is a render cache, never a source of truth.
 * Serving one without checking it against the IFC inverts that: archiAgent
 * re-runs and overwrites plan.ifc, the previous run's plan.frag stays on disk,
 * and the user reviews yesterday's building believing it is today's.
 *
 * The cache key is the one spec §3.1 settles on — sha256(plan.ifc) plus the
 * library versions — and NOT the hash of the .frag, because conversion is not
 * byte-deterministic (measured: 222702 vs 222701 bytes for the same input).
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const pkg = async (name) =>
  JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"));

export async function libraryVersions() {
  const [fragments, webIfc] = await Promise.all([pkg("@thatopen/fragments"), pkg("web-ifc")]);
  return { fragments: fragments.version, webIfc: webIfc.version };
}

export async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** The sidecar that records what a `.frag` was built from. */
export const sidecarPath = (fragPath) => `${fragPath}.json`;

export async function writeSidecar(fragPath, ifcPath) {
  const [ifcSha256, versions] = await Promise.all([sha256(ifcPath), libraryVersions()]);
  await writeFile(
    sidecarPath(fragPath),
    JSON.stringify({ schema: 1, ifcSha256, builtAt: new Date().toISOString(), ...versions }, null, 2),
  );
}

/**
 * True only when `fragPath` was built from exactly this `ifcPath`, by exactly
 * the libraries installed now. Anything else — missing file, missing sidecar,
 * changed IFC, upgraded library — is false, and the caller must fall back to
 * converting the IFC.
 */
export async function fragIsCurrent(fragPath, ifcPath) {
  let sidecar;
  try {
    sidecar = JSON.parse(await readFile(sidecarPath(fragPath), "utf8"));
    await readFile(fragPath);
  } catch {
    return false;
  }
  const versions = await libraryVersions();
  if (sidecar.fragments !== versions.fragments || sidecar.webIfc !== versions.webIfc) return false;
  try {
    return sidecar.ifcSha256 === (await sha256(ifcPath));
  } catch {
    return false;
  }
}
