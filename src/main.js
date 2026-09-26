import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AnalyticSolid, OpenGeometry } from "opengeometry";
import wasmURL from "opengeometry/opengeometry_bg.wasm?url";
import { readManifest, FT_TO_M } from "./manifest.js";
import { buildWalls, buildSlabs } from "./build-model.js";
import { solidsToBinaryStl } from "./export-stl.js";

const el = (id) => document.getElementById(id);
const status = el("status");

await OpenGeometry.create({ wasmURL });

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

const groups = {
  walls: new THREE.Group(),
  voids: new THREE.Group(),
  slabs: new THREE.Group(),
};
groups.voids.visible = false;
for (const group of Object.values(groups)) scene.add(group);

let built = [];

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

// Handle for debugging and for headless render checks (scripts/shot.mjs).
window.__viewer = { THREE, scene, camera, renderer, controls, groups, get built() { return built; } };

function clearScene() {
  for (const solid of built) {
    solid.removeFromParent();
    solid.dispose();
  }
  built = [];
}

function frameCamera() {
  const box = new THREE.Box3();
  for (const solid of built) box.expandByObject(solid);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.z, size.y) || 10;
  camera.position.set(centre.x + radius * 0.8, centre.y + radius * 0.7, centre.z + radius * 0.9);
  camera.far = radius * 40;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();
  grid.position.set(centre.x, box.min.y, centre.z);
}

function table(rows) {
  return rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}

function render(manifest) {
  clearScene();
  const model = manifest.models[0];

  const t0 = performance.now();
  const { solids, voids, stats } = buildWalls({ AnalyticSolid }, model);
  const { solids: slabs, skipped } = buildSlabs({ AnalyticSolid }, model);
  const elapsed = performance.now() - t0;

  for (const solid of solids) groups.walls.add(solid);
  for (const solid of voids) {
    solid.surface.material.transparent = true;
    solid.surface.material.opacity = 0.35;
    groups.voids.add(solid);
  }
  for (const solid of slabs) groups.slabs.add(solid);
  built = [...solids, ...voids, ...slabs];

  applyDisplay();
  frameCamera();

  el("source").innerHTML = `<code>${manifest.sourcePath.split("/").pop()}</code><table>` + table([
    ["interpretation", manifest.contentSha256.slice(0, 12) + "…"],
    ["region", model.regionId],
    ["storey", model.storeyName],
    ["wall height", `${model.wallHeightFt} ft`],
    ["plan span", `${model.spanFt[0].toFixed(1)} × ${model.spanFt[1].toFixed(1)} ft`],
    ["scale", `${model.unitsPerFoot} u/ft`],
    ["scale verified", model.scaleVerified ? "yes" : "<b style='color:var(--warn)'>no</b>"],
  ]) + "</table>";

  el("stats").innerHTML = table([
    ["walls in", model.walls.length],
    ["wall solids", stats.pieces],
    ["skipped", stats.skippedWalls],
    ["openings", `${stats.openingsPlaced} / ${stats.openingsRequested}`],
    ["voids", voids.length],
    ["slabs", `${slabs.length} / ${model.footprints.length}`],
    ["build time", `${elapsed.toFixed(0)} ms`],
  ]);

  const notes = [];
  if (!model.scaleVerified) notes.push(`Scale unverified (${model.scaleConvention}) — dimensions are provisional.`);
  if (stats.openingsDropped) notes.push(`${stats.openingsDropped} openings dropped as degenerate.`);
  if (stats.mergedOpenings) notes.push(`${stats.mergedOpenings} overlapping opening groups merged.`);
  for (const s of skipped) notes.push(`Footprint ${s.index} skipped: ${s.message}`);
  for (const n of stats.notes.slice(0, 5)) notes.push(`${n.stage} wall ${n.wall}: ${n.message}`);
  if (manifest.unresolved.length) notes.push(`${manifest.unresolved.length} unresolved issues recorded by archiAgent.`);
  el("notes").textContent = notes.join("\n") || "none";

  el("exportStl").disabled = built.length === 0;
  status.style.display = "none";
}

function applyDisplay() {
  groups.walls.visible = el("showWalls").checked;
  groups.voids.visible = el("showVoids").checked;
  groups.slabs.visible = el("showSlabs").checked;
  grid.visible = el("showGrid").checked;
  const edges = el("showEdges").checked;
  for (const solid of built) solid.outline = edges;
}
for (const id of ["showWalls", "showVoids", "showSlabs", "showEdges", "showGrid"]) {
  el(id).addEventListener("change", applyDisplay);
}

// --- picking: a wall carries the provenance archiAgent recorded for it -------

const raycaster = new THREE.Raycaster();
let highlighted = null;

renderer.domElement.addEventListener("pointerdown", (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects([groups.walls, groups.slabs, groups.voids], true);

  if (highlighted) {
    highlighted.material.emissive.setHex(0x000000);
    highlighted = null;
  }
  const hit = hits.find((h) => h.object.isMesh);
  if (!hit) {
    el("pick").innerHTML = "<span class='none'>Click a wall</span>";
    return;
  }
  highlighted = hit.object;
  highlighted.material.emissive.setHex(0x334466);

  const solid = hit.object.parent;
  const d = solid.userData ?? {};
  el("pick").innerHTML = table([
    ["name", solid.name ?? "—"],
    ["ifc class", d.ifcClass ?? "—"],
    ["part", d.part ?? "—"],
    ["source layer", d.layer ?? "—"],
    ["detector", d.detector ?? "—"],
    ["thickness", d.thicknessFt ? `${d.thicknessFt} ft (${d.thicknessSource})` : "—"],
    ["dxf handles", (d.sourceIds ?? []).join(", ") || "—"],
    ["openings", (d.openings ?? []).join(", ") || "—"],
  ]);
});

// --- manifest loading -------------------------------------------------------

async function loadList() {
  const select = el("manifests");
  try {
    const { root, manifests } = await (await fetch("/api/manifests")).json();
    el("root").textContent = `scanning ${root}`;
    if (manifests.length === 0) {
      select.innerHTML = "<option value=''>no *.interpretation.json found</option>";
      status.textContent = "No manifests found. Set ARCHIAGENT_OUT to your archiAgent --outputDir.";
      status.style.display = "";
      return;
    }
    select.innerHTML = manifests
      .map((m) => `<option value="${encodeURIComponent(m.path)}">${m.name} — ${m.path}</option>`)
      .join("");
    await load(manifests[0].path);
  } catch (error) {
    status.textContent = `Could not list manifests: ${error.message}`;
    status.style.display = "";
  }
}

async function load(relativePath) {
  status.textContent = "building…";
  status.style.display = "";
  try {
    const raw = await (await fetch(`/api/manifest?path=${encodeURIComponent(relativePath)}`)).json();
    if (raw.error) throw new Error(raw.error);
    render(readManifest(raw));
  } catch (error) {
    clearScene();
    status.textContent = error.message;
    status.style.display = "";
    el("notes").textContent = error.stack ?? String(error);
  }
}

el("manifests").addEventListener("change", (event) => {
  if (event.target.value) load(decodeURIComponent(event.target.value));
});
el("reload").addEventListener("click", loadList);

el("exportStl").addEventListener("click", () => {
  const bytes = solidsToBinaryStl(built.filter((s) => s.parent?.visible));
  const url = URL.createObjectURL(new Blob([bytes], { type: "model/stl" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "archiagent-model.stl";
  a.click();
  URL.revokeObjectURL(url);
});

await loadList();
