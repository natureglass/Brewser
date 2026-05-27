// Pre-parse AnimatedMorphSphere.gltf + .bin into a single packed binary so
// the milestone #17 demo can load it without GLTFLoader. Run via:
//
//   node scripts/pack-morph-sphere.mjs
//
// Reads:
//   D:/Workspace/three-r162/examples/models/gltf/AnimatedMorphSphere/glTF/AnimatedMorphSphere.gltf
//   D:/Workspace/three-r162/examples/models/gltf/AnimatedMorphSphere/glTF/AnimatedMorphSphere.bin
//
// Writes:
//   romfs/pages/threejs-demos/webgl-morphtargets-sphere/assets/morph-sphere.bin
//
// Format (little-endian throughout):
//   [0..3]   magic "MRPH"
//   [4..7]   version (uint32) = 1
//   [8..11]  vertexCount (uint32)
//   [12..15] indexCount (uint32)
//   [16..19] morphTargetCount (uint32) = 2
//   [20..31] reserved (3 × uint32) = 0
//   [32..]   position    (vertexCount × VEC3 float32)
//            normal      (vertexCount × VEC3 float32)
//            morph0.pos  (vertexCount × VEC3 float32) — "Ship"
//            morph0.norm (vertexCount × VEC3 float32)
//            morph1.pos  (vertexCount × VEC3 float32) — "Blob"
//            morph1.norm (vertexCount × VEC3 float32)
//            indices     (indexCount × uint16)
//
// Skipped from upstream: TANGENT attributes (base + per-morph; not used
// by MeshPhongMaterial) + animation keyframes (the demo drives morph
// weights manually, ignoring the GLTF animation track).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SWB = resolve(HERE, '..');
const SRC_DIR = 'D:/Workspace/three-r162/examples/models/gltf/AnimatedMorphSphere/glTF';
const OUT_PATH = resolve(SWB, 'romfs/pages/threejs-demos/webgl-morphtargets-sphere/assets/morph-sphere.bin');

const gltf = JSON.parse(readFileSync(`${SRC_DIR}/AnimatedMorphSphere.gltf`, 'utf8'));
const bin = readFileSync(`${SRC_DIR}/AnimatedMorphSphere.bin`);

// Sanity-check the GLTF structure matches what we expect (single mesh,
// single primitive, two morph targets each with POSITION + NORMAL).
if (gltf.meshes.length !== 1) throw new Error('expected 1 mesh');
const prim = gltf.meshes[0].primitives[0];
if (!prim.targets || prim.targets.length !== 2) {
  throw new Error('expected exactly 2 morph targets');
}

// Each accessor entry: { bufferView, componentType, count, type }.
// componentType 5126 = FLOAT, 5123 = UNSIGNED_SHORT.
// type: VEC3 / VEC4 / SCALAR.
function bytesPerElement(componentType) {
  if (componentType === 5126) return 4;  // FLOAT
  if (componentType === 5123) return 2;  // UNSIGNED_SHORT
  throw new Error('unsupported componentType ' + componentType);
}
function componentsPerVertex(type) {
  if (type === 'VEC3') return 3;
  if (type === 'VEC4') return 4;
  if (type === 'SCALAR') return 1;
  throw new Error('unsupported accessor type ' + type);
}

function sliceAccessor(idx) {
  const acc = gltf.accessors[idx];
  const view = gltf.bufferViews[acc.bufferView];
  const offset = view.byteOffset || 0;
  const length = view.byteLength;
  return {
    accessor: acc,
    bytes: bin.subarray(offset, offset + length),
    elementCount: acc.count,
    components: componentsPerVertex(acc.type),
    bpe: bytesPerElement(acc.componentType),
  };
}

const posAcc = sliceAccessor(prim.attributes.POSITION);
const normAcc = sliceAccessor(prim.attributes.NORMAL);
const indexAcc = sliceAccessor(prim.indices);

const morph0PosAcc = sliceAccessor(prim.targets[0].POSITION);
const morph0NormAcc = sliceAccessor(prim.targets[0].NORMAL);
const morph1PosAcc = sliceAccessor(prim.targets[1].POSITION);
const morph1NormAcc = sliceAccessor(prim.targets[1].NORMAL);

const vertexCount = posAcc.elementCount;
const indexCount = indexAcc.elementCount;

// Sanity-check vertex counts line up across all attributes.
for (const a of [normAcc, morph0PosAcc, morph0NormAcc, morph1PosAcc, morph1NormAcc]) {
  if (a.elementCount !== vertexCount) {
    throw new Error('vertex count mismatch: expected ' + vertexCount + ', got ' + a.elementCount);
  }
}
if (indexAcc.bpe !== 2) {
  throw new Error('expected UNSIGNED_SHORT indices');
}

console.log(`vertices: ${vertexCount}`);
console.log(`indices: ${indexCount} (${indexCount / 3} triangles)`);
console.log(`morph targets: 2 ("${gltf.accessors[prim.targets[0].POSITION].name}" + "${gltf.accessors[prim.targets[1].POSITION].name}")`);

// Header.
const HEADER_BYTES = 32;
const positionBytes = vertexCount * 3 * 4;  // VEC3 float32
const normalBytes = vertexCount * 3 * 4;
const indexBytes = indexCount * 2;

const totalBytes = HEADER_BYTES
  + positionBytes + normalBytes
  + positionBytes + normalBytes  // morph0
  + positionBytes + normalBytes  // morph1
  + indexBytes;

const out = Buffer.alloc(totalBytes);
out.write('MRPH', 0, 'ascii');                   // magic
out.writeUInt32LE(1, 4);                          // version
out.writeUInt32LE(vertexCount, 8);
out.writeUInt32LE(indexCount, 12);
out.writeUInt32LE(2, 16);                         // morphTargetCount
// reserved: bytes 20..31 left zero

let cursor = HEADER_BYTES;
function writeSlice(name, src) {
  if (src.bytes.length !== src.elementCount * src.components * src.bpe) {
    throw new Error(`${name}: expected ${src.elementCount * src.components * src.bpe} bytes, got ${src.bytes.length}`);
  }
  src.bytes.copy(out, cursor);
  cursor += src.bytes.length;
}
writeSlice('position', posAcc);
writeSlice('normal', normAcc);
writeSlice('morph0.position', morph0PosAcc);
writeSlice('morph0.normal', morph0NormAcc);
writeSlice('morph1.position', morph1PosAcc);
writeSlice('morph1.normal', morph1NormAcc);
writeSlice('indices', indexAcc);

if (cursor !== totalBytes) {
  throw new Error(`cursor mismatch: ${cursor} vs ${totalBytes}`);
}

// Ensure output dir exists.
const outDir = dirname(OUT_PATH);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(OUT_PATH, out);

console.log(`wrote ${OUT_PATH} (${totalBytes} bytes)`);
