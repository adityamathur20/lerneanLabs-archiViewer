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
export function wasmLocation() {
  if (typeof window !== "undefined") {
    // Served from public/web-ifc/, which Vite copies verbatim into dist/ and
    // the dev server serves at the same path, so dev and production resolve
    // identically. This was previously a node-modules path, which only works
    // under `vite dev` (it serves that directory over HTTP). In a production
    // build the viewer's `try_files {path} /index.html` then handed web-ifc
    // index.html instead of a module, and nothing could render at all.
    return { path: "/web-ifc/", absolute: false };
  }
  return {
    path: new URL("../node_modules/web-ifc/", import.meta.url).pathname,
    absolute: true,
  };
}

/**
 * The web-ifc loader settings the importer will actually use. Exported so a
 * test can drive web-ifc with the same settings rather than a copy that could
 * drift from them.
 */
export function webIfcSettings() {
  return new IfcImporter().webIfcSettings;
}

/**
 * IfcImporter translates the model to the origin by default. archiAgent keeps
 * the source drawing's origin, so without this a real plan sits tens of
 * thousands of feet out and depth precision collapses. Exposed so a test can
 * assert it rather than trust the library's default.
 *
 * Whether it has the claimed EFFECT is measured in tests/origin.test.mjs;
 * this only reports the setting.
 */
export function coordinateToOrigin() {
  return webIfcSettings().COORDINATE_TO_ORIGIN === true;
}

export async function ifcToFrag(bytes, { onProgress = null } = {}) {
  const serializer = new IfcImporter();
  serializer.wasm = wasmLocation();
  if (onProgress) onProgress(0);
  const frag = await serializer.process({
    bytes,
    raw: false,
    // The importer's own callback, so a multi-megabyte conversion reports real
    // intermediate progress instead of sitting at 0% until it finishes — which
    // is indistinguishable from a hang.
    progressCallback: onProgress
      ? (progress) => onProgress(Math.min(Math.max(progress, 0), 1))
      : undefined,
  });
  if (onProgress) onProgress(1);
  return frag;
}
