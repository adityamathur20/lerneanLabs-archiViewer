import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createFragViewer } from "./frag-viewer.js";
import { createApiSource, createDiskSource, SourceError } from "./source.js";

// Unset means the dev server: local development keeps working untouched.
const API_BASE = import.meta.env?.VITE_API_BASE ?? "";
const KEY_STORAGE = "planto3d.apiKey";

function readKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return ""; // private mode, blocked storage: degrade, never throw
  }
}

function buildSource() {
  return API_BASE
    ? createApiSource({ base: API_BASE, token: readKey() })
    : createDiskSource({});
}

let source = buildSource();

const el = (id) => document.getElementById(id);
const status = el("status");

const main = document.querySelector("main");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 4000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
main.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdfe6f2, 0x2a2f38, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 60, 20);
scene.add(sun);

const grid = new THREE.GridHelper(200, 200, 0x2b3038, 0x21252b);
scene.add(grid);

function resize() {
  const { clientWidth: w, clientHeight: h } = main;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

const viewer = await createFragViewer({ scene, camera, controls });

// Handle for debugging and for headless render checks (scripts/shot.mjs).
window.__viewer = { THREE, scene, camera, renderer, controls, viewer };

function table(rows) {
  return rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}

/**
 * Frames the model from the boxes Fragments computed for it, not from the
 * scene graph: culling and LOD mean `model.object` may hold no resident
 * geometry at the moment the load resolves.
 */
async function frameCamera(model) {
  const box = new THREE.Box3();
  for (const item of await model.getBoxes()) box.union(item);
  if (box.isEmpty()) return false;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.z, size.y) || 10;
  camera.position.set(centre.x + radius * 0.8, centre.y + radius * 0.7, centre.z + radius * 0.9);
  camera.far = radius * 40;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();
  grid.position.set(centre.x, box.min.y, centre.z);
  viewer.update(true);
  return true;
}

function fail(message, detail = "") {
  status.textContent = message;
  status.style.display = "";
  el("notes").textContent = detail || message;
}

async function show(relativePath, name) {
  status.textContent = `loading ${name}…`;
  status.style.display = "";
  el("notes").textContent = "";
  await viewer.clear();

  let bytes;
  try {
    bytes = await source.fetchIfc(relativePath);
  } catch (error) {
    if (error instanceof SourceError && error.status === 401) {
      el("auth").style.display = "";
      fail("API key missing or rejected — enter a key and reload.");
    } else {
      fail(`failed: ${error.message}`);
    }
    return;
  }

  let model;
  try {
    // A multi-megabyte IFC takes seconds. Say so, or it reads as a hang.
    model = await viewer.loadIfc(bytes, name, (fraction) => {
      status.textContent = `converting ${name}… ${Math.round(fraction * 100)}%`;
    });
  } catch (error) {
    fail(`conversion failed: ${error.message}`, error.stack ?? String(error));
    return;
  }

  if (!model) {
    fail(`${name}: the IFC converted but produced no model`);
    return;
  }

  const framed = await frameCamera(model);
  const categories = await model.getItemsWithGeometryCategories();

  el("source").innerHTML = `<code>${relativePath}</code>`;
  el("stats").innerHTML = table([
    ["ifc bytes", bytes.byteLength.toLocaleString()],
    ["categories", Object.keys(categories).length],
    ["geometry", framed ? "present" : "none"],
  ]);

  if (!framed) {
    // A valid IFC with a spatial tree and no elements: a site-plan outlier, or
    // a run whose wall detection found nothing. Say which, rather than showing
    // an empty canvas that looks like a crash.
    fail(`${name}: no geometry in this IFC`, "The file parsed and has a spatial structure, but contains no building elements with geometry.");
    return;
  }
  status.style.display = "none";
}

// --- selection: the class and GUID are archiAgent's own, read back out of the
// --- IFC it authored, not a browser reconstruction's guesses.

const pointer = new THREE.Vector2();
renderer.domElement.addEventListener("click", async (event) => {
  const model = viewer.current();
  if (!model) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const hit = await viewer.raycast(pointer, renderer.domElement);
  if (!hit) {
    el("pick").innerHTML = "<span class='none'>Click an element</span>";
    return;
  }
  const [data] = await model.getItemsData([hit.localId]);
  el("pick").innerHTML = table([
    ["localId", hit.localId],
    ["category", data?._category?.value ?? "—"],
    ["GlobalId", data?._guid?.value ?? "—"],
    ["Name", data?.Name?.value ?? "—"],
  ]);
});

// --- model loading ----------------------------------------------------------

async function loadList() {
  const select = el("manifests");
  try {
    const models = await source.list();
    el("root").textContent = `reading ${source.describe()}`;
    if (models.length === 0) {
      select.innerHTML = "<option value=''>no models found</option>";
      fail(
        source.kind === "api"
          ? "No succeeded jobs yet. Upload a DXF or PDF to the API first."
          : "No IFC files found. Set ARCHIAGENT_OUT to your archiAgent --outputDir.",
      );
      return;
    }
    select.innerHTML = models
      .map((m) => `<option value="${encodeURIComponent(m.id)}" data-name="${m.name}">${m.label}</option>`)
      .join("");
    await show(models[0].id, models[0].name);
  } catch (error) {
    if (error instanceof SourceError && error.status === 401) {
      el("auth").style.display = "";
      fail("API key missing or rejected — enter a key below, then Save.");
      return;
    }
    fail(`Could not list models: ${error.message}`, error.stack ?? String(error));
  }
}

el("saveKey")?.addEventListener("click", () => {
  try {
    localStorage.setItem(KEY_STORAGE, el("apiKey").value.trim());
  } catch {
    /* storage blocked: the key lives for this page only */
  }
  source = buildSource();
  loadList();
});

el("manifests").addEventListener("change", (event) => {
  const option = event.target.selectedOptions[0];
  if (option?.value) show(decodeURIComponent(option.value), option.dataset.name ?? "model");
});
el("reload").addEventListener("click", loadList);
el("showGrid").addEventListener("change", () => {
  grid.visible = el("showGrid").checked;
});

await loadList();
