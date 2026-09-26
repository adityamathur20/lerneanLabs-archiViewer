/**
 * Owns the Fragments runtime: the worker, the model list, culling and LOD.
 *
 * `FragmentsModels` needs to be told which camera to cull against and needs
 * `update()` on every camera change — that wiring is the whole reason this is
 * a module and not three lines in main.js.
 *
 * Keeping it behind this facade is also the seam Phase 7 attaches to: ifc-lite's
 * MCP viewer tools drive a scene through @ifc-lite/embed-protocol, and this
 * surface is what that handler will call. Do not inline it into main.js.
 */
import { FragmentsModels } from "@thatopen/fragments";
import { ifcToFrag } from "./ifc-to-frag.js";

export async function createFragViewer({ scene, camera, controls }) {
  // Fetches the worker matching this library version and returns a blob URL.
  const workerUrl = await FragmentsModels.getWorker();
  const fragments = new FragmentsModels(workerUrl);

  let current = null;
  const added = new Set();

  fragments.models.list.onItemSet.add(({ value: model }) => {
    model.useCamera(camera);
    scene.add(model.object);
    added.add(model.object);
    current = model;
    fragments.update(true);
  });

  controls.addEventListener("update", () => fragments.update());

  return {
    async loadIfc(bytes, modelId, onProgress) {
      const frag = await ifcToFrag(bytes, { onProgress });
      // `load` wants an ArrayBuffer; hand it exactly the converted range.
      const buffer = frag.buffer.slice(frag.byteOffset, frag.byteOffset + frag.byteLength);
      await fragments.load(buffer, { modelId });
      return current;
    },

    async loadFrag(buffer, modelId) {
      await fragments.load(buffer, { modelId });
      return current;
    },

    async clear() {
      // Snapshot the ids: disposeModel mutates the map we would be iterating.
      for (const id of Array.from(fragments.models.list.keys())) {
        await fragments.disposeModel(id);
      }
      // The objects were added here, so they are removed here — otherwise
      // switching models leaves a disposed Object3D in the scene each time.
      for (const object of added) scene.remove(object);
      added.clear();
      current = null;
    },

    update(force = false) {
      fragments.update(force);
    },

    raycast(mouse, dom) {
      if (!current) return null;
      return current.raycast({ camera, mouse, dom });
    },

    current() {
      return current;
    },
  };
}
