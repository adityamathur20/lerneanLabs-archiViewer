/**
 * archiAgent's authored IFC -> a Fragments buffer.
 *
 * This is the whole browser-side geometry story now. archiAgent already
 * resolved junctions, split walls at openings and wrote IfcRelVoidsElement;
 * web-ifc (inside IfcImporter) meshes that faithfully, including the opening
 * booleans. Nothing here reconstructs geometry.
 */
import { IfcImporter } from "@thatopen/fragments";

/** A fragments buffer smaller than this is an empty or failed conversion. */
export const FRAG_MIN_BYTES = 1024;

/**
 * Where web-ifc's .wasm lives, which differs by environment: Vite serves
 * node_modules over HTTP in dev, while Node needs a real filesystem path.
 * One module serves both tiers, so it resolves this itself rather than making
 * every call site pass it.
 */
function wasmLocation() {
  if (typeof window !== "undefined") {
    return { path: "/node_modules/web-ifc/", absolute: false };
  }
  return {
    path: new URL("../node_modules/web-ifc/", import.meta.url).pathname,
    absolute: true,
  };
}

/**
 * IfcImporter translates the model to the origin by default. archiAgent keeps
 * the source drawing's origin, so without this a real plan sits tens of
 * thousands of feet out and depth precision collapses. Exposed so a test can
 * assert it rather than trust the library's default.
 */
export function coordinateToOrigin() {
  return new IfcImporter().webIfcSettings.COORDINATE_TO_ORIGIN === true;
}

export async function ifcToFrag(bytes, { onProgress = null } = {}) {
  const serializer = new IfcImporter();
  serializer.wasm = wasmLocation();
  if (onProgress) onProgress(0);
  const frag = await serializer.process({ bytes, raw: false });
  if (onProgress) onProgress(1);
  return frag;
}
