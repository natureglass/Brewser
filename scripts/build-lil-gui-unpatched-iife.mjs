#!/usr/bin/env node
// UNPATCHED variant of build-lil-gui-iife.mjs.
//
// Same IIFE-wrap + globalThis.lilGui assignment, BUT applies NO CSS
// substitutions. The lil-gui stylesheet that runs on Switch is
// byte-identical to upstream lil-gui 0.17.
//
// Purpose: stress-test the live-DOM stack (M2.0–M2.5) against an
// unmodified real-world lil-gui consumer (e.g. the webgl-shaders-sky
// Three.js demo). The patched build (build-lil-gui-iife.mjs) papers
// over a known-broken set of CSS features (percent widths, icon
// glyphs, multi-family font fallbacks); this build skips all of that
// so the gaps surface in Citron screenshots.
//
// Output: romfs/apps/ThreeJSDemos/libs/lil-gui-unpatched.iife.js

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', '..', 'three-latest', 'examples', 'jsm', 'libs', 'lil-gui.module.min.js');
const DST = resolve(__dirname, '..', 'romfs', 'apps', 'ThreeJSDemos', 'libs', 'lil-gui-unpatched.iife.js');

const HEADER = `/**
 * lil-gui (v0.17) UNPATCHED IIFE conversion for switch-web-browser.
 * Original: three-latest/examples/jsm/libs/lil-gui.module.min.js
 * Build script: scripts/build-lil-gui-unpatched-iife.mjs
 *
 * No CSS patches applied — stylesheet is byte-identical to upstream.
 * Only transforms: strip ES module header/exports + wrap body in IIFE
 *                  + assign globalThis.lilGui = { GUI, ... }.
 *
 * For the patched-for-Switch variant (icon glyph + width:100% → flex:1
 * + var() percent → px + font-family collapse), see lil-gui.iife.js.
 */
`;

const original = readFileSync(SRC, 'utf8');

// Strip the upstream header comment + the `export default ...; export {...};`
// tail. Same anchors as the patched build script — keep in sync.
const STRIPPED_HEADER_END = original.indexOf('class t{');
if (STRIPPED_HEADER_END < 0) throw new Error('lil-gui parser: class t{ not found');
const EXPORT_TAIL = 'export default g;export{i as BooleanController,a as ColorController,t as Controller,h as FunctionController,g as GUI,d as NumberController,c as OptionController,u as StringController};';
const exportIndex = original.indexOf(EXPORT_TAIL);
if (exportIndex < 0) throw new Error('lil-gui parser: export tail not found');

const body = original.slice(STRIPPED_HEADER_END, exportIndex);

const exportAssign =
	'globalThis.lilGui={GUI:g,BooleanController:i,ColorController:a,Controller:t,FunctionController:h,NumberController:d,OptionController:c,StringController:u};';

const out = HEADER + '\n(function(){\n' + body + exportAssign + '\n})();\n';

mkdirSync(dirname(DST), { recursive: true });
writeFileSync(DST, out, 'utf8');

console.log(`wrote ${DST} (${out.length} bytes, no CSS patches applied)`);
