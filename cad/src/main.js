/**
 * The Drawing view: a job's plan.dxf in mlightcad's 2D CAD viewer.
 *
 * Stage A of docs/superpowers/plans/2026-10-07-mlightcad-cad-viewer.md (in
 * lerneanLabs-archiAgent): cad-simple-viewer with a deliberately small sidebar
 * (fit, measure, layers). Stage B replaces this sidebar with the full
 * cad-viewer UI on the same engine, so keep it thin.
 *
 * The browser only ever opens DXF. A DWG upload is converted on the server by
 * the ODA File Converter, and its plan.dxf is what arrives here.
 */
import {
  AcApDocManager,
  AcApSettingManager,
  MTEXT_RENDERER_WORKER_FILE,
  collectMeasurementRecords,
} from "@mlightcad/cad-simple-viewer";
import { createApiSource, createDiskSource, SourceError } from "../../src/source.js";
import { createScaleTool } from "./set-scale.js";

// Same key and same API as the 3D view: one sign-in for both.
const API_BASE = import.meta.env?.VITE_API_BASE ?? "";
const KEY_STORAGE = "planto3d.apiKey";

function readKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

const source = API_BASE
  ? createApiSource({ base: API_BASE, token: readKey() })
  : createDiskSource({});

const el = (id) => document.getElementById(id);
const status = el("status");
const params = new URLSearchParams(location.search);

// For headless checks (scripts/shot.mjs --cad) and debugging.
const state = (window.__cad = { phase: "starting", errors: [], timeline: [] });
const mark = (what) => state.timeline.push([what, Math.round(performance.now())]);

function say(message) {
  status.textContent = message;
  status.style.display = message ? "" : "none";
}

function fail(message, detail = "") {
  say(message);
  el("notes").textContent = detail || message;
  state.phase = "failed";
  state.errors.push(detail || message);
}

// mlightcad persists its UI preferences in localStorage; keep ours apart from
// any other mlightcad app on the origin. The command line stays: measuring
// prompts through it.
AcApSettingManager.configure({ storageKey: "planto3d.cad-viewer" });
AcApSettingManager.instance.apply({ isShowStats: false }, { persist: false });

// The app's own base ("/cad/"), not the page URL: served as /cad (no slash),
// "." would resolve to "/", and the fonts and the MTEXT worker 404 silently,
// leaving text rendering, and mlightcad's progress overlay, stuck.
const here = new URL(import.meta.env.BASE_URL, location.origin);
const manager = AcApDocManager.createInstance({
  container: el("cad"),
  autoResize: true,
  // Never mlightcad's default (cdn.jsdelivr.net): its fonts are unlicensed for
  // redistribution, and the CSP would refuse the request anyway. See FONTS.md.
  baseUrl: new URL("cad-data/", here).href,
  webworkerFileUrls: { mtextRender: new URL(`workers/${MTEXT_RENDERER_WORKER_FILE}`, here).href },
});
state.manager = manager;
// mlightcad's own record of what was measured, and a wait for the renderer:
// a large drawing re-renders after a layer change, and clicks made meanwhile
// are lost.
state.measurements = () => collectMeasurementRecords(manager.curView);

// mlightcad's open-progress overlay ("Parsing entities …") swallows clicks,
// and on a large drawing it outlives waitUntilIdle by tens of seconds
// (measured: ~23 s on a four-sheet 4,763-entity plan). It hides through
// onOpenProgressHidden, which has no public event. mlightcad is pinned
// exactly, and scripts/cad-check.mjs measures on a large drawing, so a
// version that renames this fails that check rather than the user.
let progressHidden = () => {};
const onHidden = manager.onOpenProgressHidden?.bind(manager);
if (onHidden) {
  manager.onOpenProgressHidden = () => {
    mark("progress hidden");
    onHidden();
    progressHidden();
  };
}
function whenProgressHidden(timeoutMs) {
  return new Promise((resolve) => {
    progressHidden = resolve;
    setTimeout(resolve, timeoutMs);
  });
}

const TOOLS = ["fit", "measure", "clearMeasures", "allOn", "allOff", "pickWall"];
function setToolsEnabled(enabled) {
  for (const id of TOOLS) el(id).disabled = !enabled;
}
state.idle = (ms = 60_000) => manager.curView.waitUntilIdle(ms);

// --- layers -----------------------------------------------------------------

function renderLayers() {
  const store = manager.curDocument?.layerStore;
  const layers = store?.getLayers() ?? [];
  if (!layers.length) {
    el("layers").innerHTML = "<span class='sub'>—</span>";
    return;
  }
  // Built as nodes, not innerHTML: layer names come from an uploaded file.
  el("layers").replaceChildren(
    ...layers
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((layer) => {
        const row = document.createElement("label");
        row.className = "row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = layer.isOn && !layer.isFrozen;
        box.disabled = layer.isFrozen;
        box.addEventListener("change", () => {
          store.setLayerOn(layer.name, box.checked);
          renderLayers();
        });
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = layer.cssColor || "#888";
        const name = document.createElement("span");
        name.textContent = layer.isFrozen ? `${layer.name} (frozen)` : layer.name;
        row.append(box, swatch, name);
        return row;
      }),
  );
}

el("allOn").addEventListener("click", () => {
  manager.curDocument?.layerStore.setAllLayersOn();
  renderLayers();
});
el("allOff").addEventListener("click", () => {
  const store = manager.curDocument?.layerStore;
  for (const layer of store?.getLayers() ?? []) store.setLayerOn(layer.name, false);
  renderLayers();
});

// --- tools --------------------------------------------------------------------

el("fit").addEventListener("click", () => manager.curView?.zoomToFitDrawing());
el("measure").addEventListener("click", () => {
  // mlightcad's own command: two picks with object snap, then the distance is
  // drawn on the canvas. In drawing units, which is the point: archiAgent's
  // scale is a ratio of drawing units to feet.
  el("hint").textContent = "Click two points. Esc cancels.";
  manager.sendStringToExecute("measuredistance");
});
el("clearMeasures").addEventListener("click", () => {
  manager.sendStringToExecute("clearmeasurements");
  el("hint").textContent = "";
});

// --- scale ----------------------------------------------------------------------

let drawings = [];
let current = null;

/** A job that is ready waits for this; a finished one is retried with it. */
function convertible(drawing) {
  return source.kind === "api" && ["ready", "succeeded", "failed"].includes(drawing?.status);
}

const scale = createScaleTool({
  manager,
  el,
  canSubmit: () => source.kind !== "api" || convertible(current),
  async submit(options) {
    if (source.kind !== "api") {
      // The dev server has no jobs; give the flags the CLI takes.
      const w = options.scale_from_wall?.[0];
      el("scaleReadout").textContent = w
        ? `CLI: --scale-from-wall ${w.x1} ${w.y1} ${w.x2} ${w.y2} "${w.length}"`
        : "CLI: --trust-extracted-scale";
      state.cli = el("scaleReadout").textContent;
      return;
    }
    el("useWall").disabled = el("useDims").disabled = true;
    try {
      const id = current.status === "ready"
        ? await source.startJob(current.id, options)
        : await source.retryJob(current.id, options);
      location.href = `/?wait=${encodeURIComponent(id)}`;
    } catch (error) {
      el("scaleReadout").textContent = `Could not start the conversion: ${error.message}`;
      scale.render();
    }
  },
});
state.scale = scale;

// --- loading ------------------------------------------------------------------

function updateModelLink(id) {
  const drawing = drawings.find((d) => d.id === id);
  const link = el("toModel");
  if (drawing?.hasModel) {
    link.href = `/?id=${encodeURIComponent(id)}`;
    link.removeAttribute("aria-disabled");
    link.textContent = "Open 3D model";
  } else {
    link.href = "/";
    link.setAttribute("aria-disabled", "true");
    link.textContent = "No 3D model for this drawing";
  }
}

async function show(id, name) {
  current = drawings.find((d) => d.id === id) ?? null;
  state.phase = "opening";
  say(`loading ${name}…`);
  el("notes").textContent = "";
  updateModelLink(id);
  const url = new URL(location.href);
  url.searchParams.set("id", id);
  history.replaceState(null, "", url);

  let bytes;
  try {
    bytes = await source.fetchDxf(id);
  } catch (error) {
    fail(`${name}: could not fetch the drawing`, error.message);
    return;
  }

  say(`reading ${name} (${(bytes.byteLength / 1e6).toFixed(1)} MB)…`);
  // openDocument takes an ArrayBuffer of exactly the file, not a view into a
  // larger buffer.
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  setToolsEnabled(false);
  const overlayGone = whenProgressHidden(180_000);
  mark("open start");
  const opened = await manager.openDocument(`${name}.dxf`, buffer, { readOnly: true });
  mark("openDocument resolved");
  if (!opened) {
    fail(`${name}: the drawing could not be opened`, String(manager.curDocument?.database?.lastOpenError?.message ?? ""));
    return;
  }
  // A real plan renders progressively and is often far from the origin:
  // frame it only once the scene is complete, or the view is empty.
  say(`drawing ${name}… a large drawing takes a while`);
  await manager.curView.waitUntilIdle(120_000);
  mark("idle");
  await overlayGone;
  mark("overlay gone");
  manager.curView.zoomToFitDrawing();
  renderLayers();
  scale.showEvidence(await source.fetchScaleEvidence(id).catch(() => null));
  setToolsEnabled(true);
  say("");
  state.phase = "opened";
  state.name = name;
}

/**
 * Arriving straight from an upload, the job is still being prepared (ODA
 * converting a DWG, the scale evidence being read): wait for it.
 */
async function waitUntilPrepared(id) {
  // Preparing is ODA plus one read: 6-51 s on the corpus. Ten minutes means
  // something is wrong, and saying so beats a spinner that never stops.
  const giveUp = Date.now() + 10 * 60_000;
  for (;;) {
    if (Date.now() > giveUp) throw new Error("still not prepared after 10 minutes; try uploading again");
    const job = await source.jobStatus(id);
    if (job.status === "failed") throw new Error(String(job.error ?? "preparation failed").split("\n")[0]);
    if (job.artifacts.includes("plan.dxf")) return;
    say(job.status === "preparing" ? "preparing the drawing (converting a DWG takes up to a minute)…" : `${job.status}…`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function loadList() {
  const select = el("drawings");
  try {
    const wantedId = params.get("id");
    if (source.kind === "api" && wantedId) {
      try {
        await waitUntilPrepared(wantedId);
      } catch (error) {
        fail(`This drawing could not be prepared: ${error.message}`);
        return;
      }
    }
    drawings = await source.listDrawings();
    el("root").textContent = `reading ${source.describe()}`;
    if (!drawings.length) {
      select.innerHTML = "<option value=''>no drawings yet</option>";
      fail(
        source.kind === "api"
          ? "No drawings yet. Upload a DXF or DWG in the 3D view."
          : "No .dxf files found. Set ARCHIAGENT_OUT to a folder holding drawings.",
      );
      return;
    }
    select.replaceChildren(
      ...drawings.map((d) => {
        const option = document.createElement("option");
        option.value = d.id;
        option.dataset.name = d.name;
        option.textContent = d.label;
        return option;
      }),
    );
    const wanted = drawings.find((d) => d.id === params.get("id")) ?? drawings[0];
    select.value = wanted.id;
    await show(wanted.id, wanted.name);
  } catch (error) {
    if (error instanceof SourceError && error.status === 401) {
      el("auth").style.display = "";
      fail("API key missing or rejected.");
      return;
    }
    fail(`Could not list drawings: ${error.message}`, error.stack ?? String(error));
  }
}

el("drawings").addEventListener("change", (event) => {
  const option = event.target.selectedOptions[0];
  if (option?.value) show(option.value, option.dataset.name ?? "drawing");
});
el("reload").addEventListener("click", loadList);

await loadList();
