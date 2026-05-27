// One-shot GLB → folder extractor for our in-house GLTFLoader, which
// only accepts uri-referenced buffers + images (no embedded base64,
// no GLB container).
//
// Usage:
//   node scripts/extract-glb.mjs <input.glb> <out-dir> [<basename>]
//
// Writes:
//   <out-dir>/<basename>.gltf       JSON, rewritten to uri-reference
//                                   external .bin + image files
//   <out-dir>/<basename>.bin        Compacted binary buffer (image
//                                   bufferViews stripped, remaining
//                                   bufferViews tightly repacked)
//   <out-dir>/<basename>_img<N>.<ext>  One file per embedded image
//
// Accessor bufferView references are remapped to the compacted layout.
// Images keep their original index but switch from bufferView to uri.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename as pathBasename, extname, join, dirname } from 'node:path';

const [, , inputPath, outDir, explicitBasename] = process.argv;
if (!inputPath || !outDir) {
  console.error('usage: node scripts/extract-glb.mjs <input.glb> <out-dir> [<basename>]');
  process.exit(1);
}

const basename = explicitBasename || pathBasename(inputPath, extname(inputPath));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const data = readFileSync(inputPath);
if (data.readUInt32LE(0) !== 0x46546c67) {
  // 'glTF' as little-endian uint32
  throw new Error('not a GLB (bad magic): ' + inputPath);
}
const version = data.readUInt32LE(4);
const totalLen = data.readUInt32LE(8);
if (version !== 2) throw new Error('only GLB v2 supported');
if (totalLen !== data.length) throw new Error('GLB length mismatch');

// Chunk 0: JSON
const jsonLen = data.readUInt32LE(12);
const jsonType = data.readUInt32LE(16);
if (jsonType !== 0x4e4f534a) throw new Error('first chunk is not JSON');
const json = JSON.parse(data.subarray(20, 20 + jsonLen).toString('utf-8'));

// Chunk 1: BIN (optional in spec; required here)
let bin = Buffer.alloc(0);
const binChunkStart = 20 + jsonLen;
if (binChunkStart < data.length) {
  const binLen = data.readUInt32LE(binChunkStart);
  const binType = data.readUInt32LE(binChunkStart + 4);
  if (binType !== 0x004e4942) throw new Error('second chunk is not BIN');
  bin = data.subarray(binChunkStart + 8, binChunkStart + 8 + binLen);
}

const bufferViews = json.bufferViews || [];

// Decide which bufferViews are image-only (used by image entries; no
// accessor references them). For Khronos sample assets that's typically
// the case — images don't share bufferViews with vertex data.
const imageBVs = new Set();
const imgExtForBV = new Map();
const imgNumForBV = new Map();
let imgCounter = 0;
for (const im of json.images || []) {
  if (im.bufferView === undefined) continue;
  imageBVs.add(im.bufferView);
  const mt = im.mimeType || 'image/png';
  const ext = mt === 'image/jpeg' ? 'jpg' : mt === 'image/png' ? 'png' : 'bin';
  imgExtForBV.set(im.bufferView, ext);
  imgNumForBV.set(im.bufferView, imgCounter++);
}

// Sanity: confirm no accessor references an image-only bufferView.
for (const acc of json.accessors || []) {
  if (acc.bufferView !== undefined && imageBVs.has(acc.bufferView)) {
    throw new Error(
      'bufferView ' + acc.bufferView +
      ' is shared between an image and an accessor; extractor would corrupt'
    );
  }
}

// Extract image bytes to separate files.
const imageUris = new Map(); // image index → uri filename
for (let i = 0; i < (json.images || []).length; i++) {
  const im = json.images[i];
  if (im.bufferView === undefined) continue; // already uri-referenced
  const bv = bufferViews[im.bufferView];
  const start = bv.byteOffset || 0;
  const imgBytes = bin.subarray(start, start + bv.byteLength);
  const ext = imgExtForBV.get(im.bufferView);
  const n = imgNumForBV.get(im.bufferView);
  const fname = `${basename}_img${n}.${ext}`;
  writeFileSync(join(outDir, fname), imgBytes);
  imageUris.set(i, fname);
}

// Build a tightly-packed new BIN containing only non-image bufferViews,
// in their original order. Track index remap (old → new).
const oldToNew = new Map();
const newBVs = [];
const newChunks = [];
let cursor = 0;
function alignTo(n) {
  while (cursor % n !== 0) {
    newChunks.push(Buffer.alloc(1));
    cursor++;
  }
}
for (let i = 0; i < bufferViews.length; i++) {
  if (imageBVs.has(i)) continue;
  const bv = bufferViews[i];
  alignTo(4);
  const slice = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  newChunks.push(slice);
  const newBV = { ...bv, byteOffset: cursor };
  oldToNew.set(i, newBVs.length);
  newBVs.push(newBV);
  cursor += slice.length;
}
const newBin = Buffer.concat(newChunks);

// Reindex accessors that point at bufferViews.
for (const acc of json.accessors || []) {
  if (acc.bufferView !== undefined) {
    const mapped = oldToNew.get(acc.bufferView);
    if (mapped === undefined) {
      throw new Error('accessor references stripped image bufferView ' + acc.bufferView);
    }
    acc.bufferView = mapped;
  }
}

// Replace image bufferView refs with uri.
for (let i = 0; i < (json.images || []).length; i++) {
  const im = json.images[i];
  if (imageUris.has(i)) {
    delete im.bufferView;
    im.uri = imageUris.get(i);
  }
}

json.bufferViews = newBVs;
json.buffers = [{ uri: `${basename}.bin`, byteLength: newBin.length }];

writeFileSync(join(outDir, `${basename}.gltf`), JSON.stringify(json, null, 2) + '\n');
writeFileSync(join(outDir, `${basename}.bin`), newBin);

console.log(`extracted ${inputPath} → ${outDir}/`);
console.log(`  ${basename}.gltf  (${json.bufferViews.length} bufferViews, ${(json.accessors || []).length} accessors)`);
console.log(`  ${basename}.bin   (${newBin.length} bytes)`);
for (const [i, uri] of imageUris) console.log(`  ${uri}  (image ${i})`);
