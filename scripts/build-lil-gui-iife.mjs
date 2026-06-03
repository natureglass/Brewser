#!/usr/bin/env node
// Patch lil-gui.module.min.js into a switch-friendly IIFE.
//
// Source: three.js's bundled lil-gui (v0.17). Transforms:
//   1. Replace ES module exports with `globalThis.lilGui = { GUI, ... }`
//   2. Wrap the whole thing in an IIFE so it can be loaded via plain
//      `<script src>` instead of `<script type=module>`.
//   3. Patch the embedded CSS string:
//      - Icon glyph substitution per [[nxjs-font-glyph-coverage]]:
//          `▾` U+25BE → `▼` U+25BC (folder-open triangle)
//          `▸` U+25B8 → `▶` U+25B6 (folder-closed triangle)
//          `↕` U+2195 → `▼` U+25BC (dropdown arrow)
//          `✓` U+2713 stays — in font.
//      - `width:100%` → `flex:1` (no percent-width support in
//        switch-web-browser's M2.3 layout; flex:1 inside lil-gui's
//        flex containers gives the same visual fill).
//      - VAR percentage refs replaced with px equivalents:
//          `min-width:var(--name-width)` → `min-width:90px`
//          `width:var(--slider-input-width)` → `width:60px`
//          `width:var(--color-input-width)` → `width:60px`
//          `var(--width,245px)` → `245px`
//      - font-family fallback lists collapsed to a single token nx.js
//        will accept (per [[nxjs-font-no-bold-italic]] — the parser
//        is strict about multi-family lists):
//          `--font-family: ...,sans-serif` → `--font-family:sans-serif`
//          `--font-family-mono: ...,monospace` → `--font-family-mono:monospace`

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', '..', 'three-latest', 'examples', 'jsm', 'libs', 'lil-gui.module.min.js');
const DST = resolve(__dirname, '..', 'romfs', 'apps', 'ThreeJSDemos', 'libs', 'lil-gui.iife.js');

const HEADER = `/**
 * lil-gui (v0.17) IIFE conversion for switch-web-browser.
 * Original: three-latest/examples/jsm/libs/lil-gui.module.min.js
 * Build script: scripts/build-lil-gui-iife.mjs
 *
 * Patches applied (see build script header for the rationale):
 *   - ES module exports → globalThis.lilGui = { GUI, ... }
 *   - Icon glyph substitution for the Switch font (▾→▼, ▸→▶, ↕→▼)
 *   - width:100% → flex:1 inside flex containers
 *   - CSS var() percentage refs → fixed px values
 *   - font-family fallback lists → single token (nx.js strict parser)
 */
`;

const original = readFileSync(SRC, 'utf8');

// Strip the upstream header comment + the `export default ...; export {...};`
// tail. Then wrap the body in an IIFE that assigns to globalThis.lilGui.
const STRIPPED_HEADER_END = original.indexOf('class t{');
if (STRIPPED_HEADER_END < 0) throw new Error('lil-gui parser: class t{ not found');
const EXPORT_TAIL = 'export default g;export{i as BooleanController,a as ColorController,t as Controller,h as FunctionController,g as GUI,d as NumberController,c as OptionController,u as StringController};';
const exportIndex = original.indexOf(EXPORT_TAIL);
if (exportIndex < 0) throw new Error('lil-gui parser: export tail not found');

let body = original.slice(STRIPPED_HEADER_END, exportIndex);

// Apply CSS patches. The CSS is the long string literal inside the
// inline function call `!function(t){...}('CSS_STRING_HERE')`. Find
// the opening `('.lil-gui{` and the closing `'),p=!0)`.
// Find the opening `'` of the CSS literal: it's right after `(`. The
// closing `'` precedes `),p=!0`.
const CSS_OPEN = "('.lil-gui{";
const CSS_CLOSE = "'),p=!0";
const openIdx = body.indexOf(CSS_OPEN);
const closeIdx = body.indexOf(CSS_CLOSE, openIdx);
if (openIdx < 0 || closeIdx < 0) {
	throw new Error('lil-gui parser: CSS string boundaries not found');
}
// CSS literal content starts AFTER the `(` + `'` (so + 2) and ends
// AT the closing `'` (closeIdx). slice end is exclusive.
const cssBodyStart = openIdx + 2;
const cssBodyEnd = closeIdx;
const before = body.slice(0, cssBodyStart); // ends with `('`
let css = body.slice(cssBodyStart, cssBodyEnd);
const after = body.slice(cssBodyEnd); // starts with `'),p=!0`

// === Patches ===
const before_len = css.length;
// Icon glyphs
css = css.replaceAll('▾', '▼');
css = css.replaceAll('▸', '▶');
css = css.replaceAll('↕', '▼');
// width:100% → flex:1
css = css.replaceAll('width:100%', 'flex:1');
// VAR percentage refs → fixed px
css = css.replaceAll('min-width:var(--name-width)', 'min-width:90px');
css = css.replaceAll('width:var(--slider-input-width)', 'width:60px');
css = css.replaceAll('width:var(--color-input-width)', 'width:60px');
css = css.replaceAll('var(--width,245px)', '245px');
// Font family collapse
css = css.replace(
	'--font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
	'--font-family:sans-serif',
);
css = css.replace(
	'--font-family-mono:Menlo,Monaco,Consolas,"Droid Sans Mono",monospace',
	'--font-family-mono:monospace',
);

// Reassemble — `before` ends at the opening `'`, `after` starts at
// the closing `'`. Just concatenate.
body = before + css + after;

// Append the globalThis assignment in place of the exports.
const exportAssign =
	'globalThis.lilGui={GUI:g,BooleanController:i,ColorController:a,Controller:t,FunctionController:h,NumberController:d,OptionController:c,StringController:u};';

const out = HEADER + '\n(function(){\n' + body + exportAssign + '\n})();\n';

mkdirSync(dirname(DST), { recursive: true });
writeFileSync(DST, out, 'utf8');

console.log(`wrote ${DST} (${out.length} bytes, css patched ${before_len - css.length} bytes shorter)`);
