import * as THREE from "three";

/**
 * Merges the kernel's tessellation for every solid into one binary STL, in
 * world coordinates.
 *
 * `AnalyticSolid.exportStl()` is per-solid and would need 170+ files stitched
 * together; the rendered BufferGeometry already *is* the kernel tessellation,
 * so walking it gives the same triangles in one pass.
 */
export function solidsToBinaryStl(solids) {
  const triangles = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (const solid of solids) {
    const mesh = solid.surface;
    if (!mesh?.geometry) continue;
    solid.updateMatrixWorld(true);
    const matrix = mesh.matrixWorld;
    const position = mesh.geometry.getAttribute("position");
    if (!position) continue;
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;

    for (let i = 0; i < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
      b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
      c.fromBufferAttribute(position, i2).applyMatrix4(matrix);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      normal.crossVectors(ab, ac);
      if (normal.lengthSq() > 0) normal.normalize();
      triangles.push([normal.x, normal.y, normal.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
    }
  }

  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  const header = "archiAgent via OpenGeometry";
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triangles.length, true);

  let offset = 84;
  for (const t of triangles) {
    for (const value of t) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}
