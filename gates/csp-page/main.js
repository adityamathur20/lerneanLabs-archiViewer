/**
 * The smallest real use of cad-simple-viewer: open one DXF from our own
 * origin, with fonts and the MTEXT worker self-hosted. csp-gate.mjs serves it
 * under the production CSP and inspects what happened.
 */
import { AcApDocManager, MTEXT_RENDERER_WORKER_FILE } from "@mlightcad/cad-simple-viewer";

const gate = (window.__gate = { phase: "starting", errors: [] });

try {
  const manager = AcApDocManager.createInstance({
    container: document.getElementById("cad"),
    autoResize: true,
    // Never the default (cdn.jsdelivr.net): fonts come from this origin.
    baseUrl: new URL("cad-data/", location.href).href,
    webworkerFileUrls: { mtextRender: new URL(`workers/${MTEXT_RENDERER_WORKER_FILE}`, location.href).href },
  });
  gate.phase = "opening";
  const bytes = await (await fetch("./sample.dxf")).arrayBuffer();
  gate.opened = await manager.openDocument("sample.dxf", bytes, { readOnly: true });
  let entities = 0;
  for (const _ of manager.curDocument.database.tables.blockTable.modelSpace.newIterator()) entities += 1;
  gate.entities = entities;
  gate.phase = "opened";
} catch (error) {
  gate.errors.push(String(error?.stack ?? error));
  gate.phase = "failed";
}
