# Three.js demo porting milestones

Running list of Three.js example pages we're porting to
`browser://threejs-demos/<name>/` on switch-web-browser. Each shipped
milestone has a project memory (`project_swb_threejs_*`) holding the
full per-demo details — this file is the high-level index plus the
shared scaffolding rules. Look up a memory by name in
`.claude/projects/d--Workspace/memory/MEMORY.md`.

## Demo scaffolding

Each milestone targets one upstream HTML, kept as close to the source
as possible. Per-demo files:

- `romfs/pages/threejs-demos/<name>/index.html` — title + lead +
  `<canvas id="...">` at 640×360 + status canvas + pre-flight 2D
  marker + script tags.
- `romfs/pages/threejs-demos/<name>/assets/main.js` — scene logic.
  All deviations from upstream are comment-tagged in the file header.
- Shared libs live under `romfs/pages/threejs-demos/libs/`
  (`three.iife.js` for r162, `three-latest.iife.js` for r184,
  `r184-nxjs-bridge.js` for the r184 shims, plus orbit-controls /
  gltf-loader / obj-loader / nrrd-loader / etc).

Demo wiring:

- Add a row to [`romfs/pages/threejs-demos.html`](../romfs/pages/threejs-demos.html).
- Mirror touched files to the Citron profile dir per
  [[citron-pages-sync]].
- `npm run build && npm run nro` to package; user launches on Citron
  and reports back.

A milestone is "done" when it renders recognisably correctly on
Citron at acceptable FPS. Known nx.js / Tegra X1 quirks worked
around in-file get documented + accepted rather than blocking.

## Cross-milestone gotchas

Quick-reference checklist; cite the memory when porting:

- Silence `console.warn/log/error/info` at the top of every demo —
  they flip the canvas into text-render mode. [[console-error-switches-render-mode]]
- Call `renderer.resetState()` before every `renderer.render()` —
  WebGLState cache drifts vs nx.js bridge. [[threejs-resetstate]]
- `texImage2D` doesn't accept image sources directly — use
  `Image` + `OffscreenCanvas.drawImage` + `getImageData` +
  `THREE.DataTexture`. [[nxjs-image-to-texture-pipeline]]
- `Image.src` doesn't honour `browser://` — use the sdmc:/ path.
  [[nxjs-image-bypasses-global-fetch]]
- GIF assets must be transcoded to PNG (nx.js decodes PNG / JPEG /
  WebP only).
- Tessellate large flat primitives — `BoxGeometry(1,1,1,8,8,8)`-style
  segment counts dodge the rasterizer's per-tile interpolator bug.
  [[threejs-cube-white-face]]
- Custom GLSL identifiers don't resolve unless the shader carries
  `#pragma raw_passthrough` (or a SHADER_NAME marker for r184
  stock materials). [[nxjs-webgl-names]] · [[bridge-raw-shader-passthrough]] · [[swb-passthrough-pivot]]
- Three.js r184 IIFE needs three nx.js shims (`bypassWebGL1Check`,
  `loadImageBypass`, rAF heartbeat) — load `libs/r184-nxjs-bridge.js`
  before `libs/three-latest.iife.js`. [[r184-nxjs-bridge]] · [[r184-fetch-hang]]
- SwitchOrbitControls defaults `enablePan = false` — right stick is
  reserved for shell navigation, never orbit pan.
  [[orbit-controls-pan-disabled]]
- ALL Three.js demos go through source-fidelity first; any deviation
  beyond the standard nx.js-required set requires explicit user
  approval. [[threejs-no-silent-deviations]] · [[threejs-milestone-protocol]]

## Conformance tests

Each shipped milestone may add a hand-rolled Khronos-style test under
`<demo>/assets/<test>.html` to pin the specific bridge surface it
forced. Custom harness at
[`romfs/pages/threejs-demos/libs/harness.js`](../romfs/pages/threejs-demos/libs/harness.js).
See [[khronos-conformance-harness]] for the API + porting guide.

## Shipped milestones

Numbered by upstream-example order, not chronological. ⚠️ = shipped
with documented caveat; 🔒 = blocked on a Mesa Nouveau driver bug
that should resolve on real Tegra hardware. Memory link holds the
full bring-up story for each.

| # | Demo | r | Status | Memory |
|---:|---|:-:|:-:|---|
| 0 | textured-rotating-cube | r162 | ✅ | [[swb-threejs-cube]] · [[bridge-perf-journey]] |
| 0 | geometry-cube | r162 | ✅ | (foundation demo) |
| 1 | webgl-lines-dashed | r162 | ✅ | [[swb-threejs-lines-dashed]] |
| 2 | webgl-lines-colors | r162 | ✅ | (no memory) |
| 3 | webgl-geometry-colors | r162 | ✅ | [[geo-colors-center-tris-lost]] (resolved) |
| 4 | webgl-layers | r162 | ✅ | [[swb-threejs-layers]] |
| 5 | misc-controls-orbit | r162 | ⚠️ | [[swb-threejs-misc-controls-orbit]] |
| 6 | webgl-camera | r162 | ⚠️ | [[swb-threejs-webgl-camera]] |
| 7 | webgl-geometry-shapes | r162 | ❌ | abandoned — [[tegra-glvertexattrib-broken]] |
| 8 | webgl-sprites | r162 | ⚠️ | [[swb-threejs-webgl-sprites]] |
| 9 | webgl-geometry-dynamic | r162 | ⚠️ | [[swb-threejs-webgl-geometry-dynamic]] |
| 10 | webgl-points-sprites | r162 | ✅ | [[swb-threejs-webgl-points-sprites]] |
| 11 | webgl-geometries | r162 | ✅ | [[swb-threejs-webgl-geometries]] |
| 12 | webgl-materials-blending | r162 | ⚠️ | [[swb-threejs-webgl-materials-blending]] |
| 13 | webgl-interactive-cubes | r162 | ✅ | [[swb-threejs-webgl-interactive-cubes]] |
| 14 | webgl-materials-wireframe | r162 | ⚠️ | [[swb-threejs-webgl-materials-wireframe]] |
| 15 | webgl-instancing-dynamic | r162 | ✅ | [[swb-threejs-webgl-instancing-dynamic]] |
| 16 | webgl-loader-obj | r162 | ✅ | [[swb-threejs-webgl-loader-obj]] |
| 17 | webgl-morphtargets-sphere | r162 | ✅ | [[swb-threejs-webgl-morphtargets-sphere]] |
| 19 | webgl-postprocessing | r162 | ✅ | [[swb-threejs-webgl-postprocessing]] |
| 19.5 | webgl-depth-texture | r162 | ✅ | [[swb-threejs-webgl-depth-texture]] |
| 20 | webgl-shadowmap | r162 | ✅ | [[swb-threejs-webgl-shadowmap]] |
| 21 | webgl-buffergeometry-indexed | r162 | ✅ | [[swb-threejs-webgl-buffergeometry-indexed]] |
| 22 | webgl-custom-attributes | r162 | ✅ | [[swb-threejs-webgl-custom-attributes]] |
| 23 | webgl-shader | r162 | ✅ | [[swb-threejs-webgl-shader]] |
| 24 | webgl-materials-texture-filters | r162 | ✅ | [[swb-threejs-webgl-materials-texture-filters]] |
| 25 | webgl-materials-cubemap | r162 | ✅ | [[swb-threejs-webgl-materials-cubemap]] · [[bridge-cube-texture-support]] |
| 26 | webgl-animation-skinning-blending | r184 | 🔒 | [[swb-threejs-webgl-animation-skinning-blending]] (Mesa) |
| H1 | webgl-loader-gltf | r162 | ✅ | [[swb-threejs-webgl-loader-gltf]] · r184 retry deferred to real hw per [[mesa-nouveau-pmrem-wedge]]; r162 path keeps HDR/IBL working |
| Pp | raw-passthrough-smoke | r162 | ✅ | [[swb-passthrough-pivot]] |
| 32 | webgl2-multiple-rendertargets | r184 | ✅ | [[swb-threejs-webgl2-multiple-rendertargets]] · [[bridge-mrt-color-attachments]] |
| 33 | webgl2-ubo | r184 | 🔒 | [[swb-threejs-webgl2-ubo]] (Mesa) |
| 34 | webgl-texture3d | r184 | 🔒 | [[swb-threejs-webgl-texture3d]] (Mesa) |
| — | webgl2-smoke | raw | ✅ | [[project-nxjs-webgl2-surface]] |

## Pre-DOM platform hardening

Short queue of demos to run BEFORE committing to the DOM milestone
series. Goal: harden the r184 + WebGL 2 rendering platform so latent
bridge/driver bugs don't surface inside the DOM layer where two
systems are in play and root cause is harder to isolate. Each pick
exercises a distinct surface; together they cover ~70 % of patterns
arbitrary web demos use. See [[r184-nxjs-bridge]] for the shared
platform shims.

| # | Upstream HTML | Surface validated | Status |
|---|---|---|:---:|
| H1 | [`webgl_loader_gltf.html`](D:/Workspace/three-latest/examples/webgl_loader_gltf.html) | GLTF + PBR (`MeshStandardMaterial`) + IBL via `PMREMGenerator` on r184. r162 already shipped (P1b/P2); clean r184 re-port confirms the stock-material pipeline survives the migration. **Highest single-demo value** — GLTF+PBR is what ~70 % of arbitrary web demos use. | ✅ on r162 (model-browser extension shipped); r184 retry pending hw |
| H2 | [`webgl_animation_keyframes.html`](D:/Workspace/three-latest/examples/webgl_animation_keyframes.html) | GLTF + simple keyframe animation (transforms only, no skinning). Validates `AnimationMixer` on r184 without the Mesa Nouveau vertex-`texelFetch` landmine blocking #26 skinning. Common in non-character demos. | ❌ skipped 2026-05-24 — premise wrong: LittlestTokyo is DRACO-compressed (extension required, no offline tool available locally — npm SSL cert blocked install) AND has 8 skinned primitives that would hit #26 wedge on r184 |
| H3 | [`webgl_texture2darray.html`](D:/Workspace/three-latest/examples/webgl_texture2darray.html) | New WebGL 2 surface: `sampler2DArray` + `texImage3D` with `TEXTURE_2D_ARRAY` target. Likely forces bridge work in `texImage3D` dispatch + a new sampler-name path. Smallish demo, reusable surface. | ✅ Citron-verified 2026-05-24 (50-58 FPS); zero new bridge work; fragment-side `sampler2DArray` confirmed clean on Mesa Nouveau |
| H4 | [`webgl_postprocessing.html`](D:/Workspace/three-latest/examples/webgl_postprocessing.html) | `EffectComposer` 3-4 pass chain re-ported to r184. Already worked on r162 (#19); re-port confirms FBO ping-pong + multi-pass works under the r184 `WebGLRenderer`. UnrealBloom / FXAA / DoF are incremental once this works. | ❌ skipped 2026-05-24 — same FBO ping-pong pattern as [[mesa-nouveau-pmrem-wedge]] would almost certainly fire; #19 r162 build already covers the EffectComposer surface; revisit on real Tegra hw |

**Skipped on purpose**: Mesa-Nouveau-parked demos (#26, #33, #34 —
driver bugs, not platform bugs); lil-gui demos (defer until DOM);
heavy ports like `marchingcubes` / `lines_fat` (interesting but lower
coverage-per-effort).

Budget: 1-3 days assuming no major bridge gaps. Surfaces any r184
PBR/IBL/animation/post-process bugs early so the DOM build sits on a
solid base.

## After hardening: DOM

The stated long-term goal is "run any Three.js example or web demo on
Switch as-is, without modification". That needs real DOM. Plan as 3
phases:

1. ✅ **Stats-dom-minimal slice** (2026-05-25 / -24): `document.createElement`,
   `document.body`, `appendChild`, `style.cssText` parser, per-frame
   overlay painter for `position:fixed` elements, viewport-aware
   positioning (chrome-respecting). Stats.dom validated on H3 demo.
   See [[swb-live-dom-phase-1]].
   1.5 ✅ **Click hit-test → `dispatchEvent`** (2026-05-25): `hitTestLive`
       walks the live tree finding topmost `position:fixed` element
       under the tap; touch handler dispatches synthetic click;
       Stats's tap-to-cycle (FPS → MS → MB) works in all browser
       modes. **Deferred** from phase 1: real block/inline/flex layout,
       text rendering in non-canvas live elements, `getBoundingClientRect`.
2. **Interactive inputs (text input, sliders, dropdowns) + form
   element surface so `lil-gui` works.** Approved 2026-05-25 as
   **Option A — full DOM build-out** per [[threejs-no-silent-deviations]]:
   lil-gui runs unmodified at completion. Broken into the
   milestone-by-milestone sequence below; each ships a hand-rolled
   validation page + Citron verification gate per
   [[threejs-milestone-protocol]]. The phase-2.6 validation page is
   the only hand-rolled lil-gui exerciser (one of each controller
   type); earlier pages are surface-specific.
3. Full CSS + remaining element set for arbitrary upstream demos.

### Phase 2 sub-milestones

| # | Slice | Surface delivered | Status |
|---|---|---|:---:|
| 2.0 | Generic element APIs | `LiveTokenList` (classList add/remove/toggle/contains/replace/value), `parentElement` / `parentNode`, `insertBefore` / `replaceChild` / `remove`, `toggleAttribute`, `textContent` / `innerHTML` (text stored, not yet painted), `getBoundingClientRect` (viewport-relative, fixed-ancestor math), `nextSibling` / `previousSibling` / `firstChild` / `lastChild` / `childNodes`, `className` round-trip, `ownerDocument`, `document.head` as LiveElement, `document.window` (per-page LiveWindow proxy with addEventListener / removeEventListener / dispatchEvent + globalThis fall-through), `window` injected into AsyncFunction body, expanded `querySelector` (head/body/html, head style/link), `getElementsByTagName` walks the live tree, canvas touch handler dispatches `mousedown` + `touchstart` to hit element AND owns the touchmove/touchend → window mouse/touch event bridge for lil-gui's slider drag pattern in M2.4+. Validation: [`dom-phase-2-0/`](../romfs/pages/threejs-demos/dom-phase-2-0/) + Stats coexistence regression check. **Side fix**: pre-existing fullscreen-canvas tap-misalignment bug (missing `setLiveViewport` on two paint paths) closed too. | ✅ shipped + Citron-verified 2026-05-25 |
| 2.1 | Text rendering in non-canvas live elements | `inline-css.ts` parses `font-family` / `font-size` / `font-weight` (named or numeric) / `font-style` / `text-align` / `line-height` / `color`; new exports `resolveCanvasFont` / `isBoldWeight` / `isItalicStyle`. `live-overlay.ts`'s `paintSubtree` now draws `textContent` for non-canvas elements via canvas-2d `fillText` using the resolved font + colour + alignment with box-clipping when sized. Bold synthesized via 1-px-offset double-draw + italic via 0.2 rad column shear because nx.js's font parser rejects the `bold`/`italic` prefix and falls back to a wrong (larger) font ([[nxjs-font-no-bold-italic]]). Validation: [`dom-phase-2-1/`](../romfs/pages/threejs-demos/dom-phase-2-1/) with 19 parser assertions + 13 visual bars + tap regression. | ✅ shipped + Citron-verified 2026-05-25 |
| 2.2 | CSS cascade + pseudo-classes + pseudo-elements | New module [`scripts/live-css.ts`](../src/scripts/live-css.ts) uses `css-tree` for parsing. `createElement('style')` registers its `textContent` as a stylesheet on assignment. Selectors: tag/`.class`/`#id`/`*`/compound/descendant/child/list/attribute (all matchers). Pseudo-classes: `:active` (touch handler sets per drag-session), `:focus`, `:disabled` (`hasAttribute('disabled')`), `:checked`, `:empty`, `:not(<simple>)`; `:hover` always false on touch. Pseudo-elements: `:before` / `:after` with `content` painted at the box's left / right edges. `var(--name)` walks parent chain via cascaded `customProps`. `@media (pointer:coarse)` enables; `@media (hover:hover)` skips. Inheritance for `color` / `font-family` / `font-size` / `font-weight` / `font-style` / `text-align` / `line-height` / `cursor`. Computed-style cache invalidated on classList/attr/state changes. `paintSubtree` reads computed style instead of inline. Validation: [`dom-phase-2-2/`](../romfs/pages/threejs-demos/dom-phase-2-2/) with 16 visual bars + 25 assertions + tap-driven `:active` + attribute-toggle. | ✅ shipped 2026-05-25 (build clean, Citron-verification pending) |
| 2.3 | Flex + block layout | New module [`scripts/live-layout.ts`](../src/scripts/live-layout.ts). Layout pass runs before paint pass: walks each `position:fixed` subtree, computes a `LayoutBox` per element with `(x,y,w,h)` + `(contentX,Y,W,H)` + `intrinsicContent(H,W)`. Block stacking (full-width children + additive margins); flex column / row with `flex-grow` / `flex-shrink` / `flex-basis` / `gap`; padding / margin / `box-sizing`; `min-width` / `max-width` / `min-height` / `max-height` clamps; `align-items` (stretch/start/end/center) + `justify-content` (start/end/center/space-between/space-around). `inline-css.ts` + `live-css.ts` extended with all new props + shorthand expansion (`padding`/`margin`/`flex`). `getBoundingClientRect` + `hitTestLive` read the per-frame layout cache. Text intrinsic width measured via `ctx.measureText`. Validation: [`dom-phase-2-3/`](../romfs/pages/threejs-demos/dom-phase-2-3/) with 6 visual panels + 20 assertions. | ✅ shipped 2026-05-25 (build clean, Citron-verification pending) |
| 2.4 | Form input widgets | New module [`scripts/live-form.ts`](../src/scripts/live-form.ts) with painters for `<input type=checkbox\|button\|text\|number\|color>` + `<button>` + `<select>` + `<textarea>`. Per-element `.value` / `.checked` storage via WeakMaps; LiveElement gains `.value` / `.checked` accessors. Touch handler dispatches via `handleFormTap`: checkbox toggles + fires `change`; button fires `click`; text/number opens the shell's `KeyboardOverlay` async and writes the returned string back (with `input`+`change`+`blur` events); color cycles a palette; select cycles options. Shell registers the keyboard opener via `setKeyboardOpener` at boot — same `KeyboardOverlay` the URL bar uses. `disabled` attribute blocks all widget taps. Click + form-tap dispatch DEFERRED to touchend (M2.5) so scroll-swipes don't activate buttons. Validation: [`dom-phase-2-4/`](../romfs/pages/threejs-demos/dom-phase-2-4/) with 6 widgets + 13 assertions. | ✅ shipped 2026-05-25 (build clean, Citron-verification pending) |
| 2.5 | Scrollable container + scroll-drag | `live-layout.ts` records `intrinsicContentH` per element so scrollable detection is trivial; `live-overlay.ts` clips + translates(`-scrollTop`) when overflow:auto/scroll AND intrinsic > content. LiveElement gains `scrollTop` / `scrollHeight` / `clientHeight` / `scrollWidth` / `clientWidth` accessors backed by the layout cache. Touch handler opens a `liveScrollSession` when touchstart lands inside a scrollable ancestor; touchmove updates `scrollTop` clamped to `[0, max]`; touchend with `moved>6px` suppresses the trailing click + form-tap so swipes don't activate buttons. Select-popup deferred — M2.4's tap-cycle approach covers lil-gui's needs without the popup overlay complexity. Validation: [`dom-phase-2-5/`](../romfs/pages/threejs-demos/dom-phase-2-5/) with 30-row test panel + swipe + tap-vs-swipe discrimination. | ✅ shipped 2026-05-25 (build clean, Citron-verification pending) |
| 2.6 | lil-gui drop-in + hand-rolled validation | Build script [`scripts/build-lil-gui-iife.mjs`](../scripts/build-lil-gui-iife.mjs) reads upstream `three-latest/examples/jsm/libs/lil-gui.module.min.js` and emits [`libs/lil-gui.iife.js`](../romfs/pages/threejs-demos/libs/lil-gui.iife.js) with: (a) ES exports → `globalThis.lilGui = { GUI, … }` + IIFE wrap; (b) embedded-stylesheet icon glyph substitution per [[nxjs-font-glyph-coverage]] (`▾`→`▼`, `▸`→`▶`, `↕`→`▼`; `✓` kept); (c) `width:100%` → `flex:1` (no percent-width in M2.3 layout); (d) `--name-width:45%` / `--slider-input-width:27%` / `--color-input-width:27%` / `--width,245px` replaced with fixed px values; (e) `font-family` fallback lists collapsed to a single token (`sans-serif` / `monospace`) for nx.js strict parser ([[nxjs-font-no-bold-italic]]). Validation: [`dom-phase-2-6/`](../romfs/pages/threejs-demos/dom-phase-2-6/) with one of each controller + Stats coexistence + 19 assertions. **PARKED 2026-05-25** — surfaced 7 different cascade/layout/dispatch bugs reactively in M2.0–M2.5 surface. Pivoted to a hand-rolled comprehensive reference page ([`dom-tests/reference/`](../romfs/pages/dom-tests/reference/)) that exercises the same canonical patterns (cascade positioning, var() own-props, flex column/row, form widgets, 3-level bubble, scrollable list) with full source control. lil-gui drop-in remains shipped but its panel doesn't render correctly; revisit after the reference page is fully green. | 🅿️ parked 2026-05-25 (replaced by DOM reference page) |
| Ref | DOM reference (canonical baseline) | New page at [`romfs/pages/dom-tests/reference/`](../romfs/pages/dom-tests/reference/) linked from the top of [`web-experiments.html`](../romfs/pages/web-experiments.html). Single script-driven page using canonical DOM patterns: a Settings panel (one of each widget type) positioned via class-based `position:fixed` cascade, with `:root` custom properties consumed via `var()` on the same element, nested flex column → flex row layout, three-level event bubbling (button → row → panel), and a scrollable list panel below. Replaces the lil-gui drop-in as the Phase 2 close-out validation. Once every row in its status canvas is green, Phase 2 is verified end-to-end. | ⏳ shipped, awaiting Citron verification |

Each remaining slice is bounded by its validation page; Citron-verify
gates between slices per the user's M2-strategy answer (2026-05-25).

**Status legend:** ⏳ pending · 🚧 in progress · ✅ done · ⚠️ done with caveat · ❌ abandoned · 🔒 blocked on driver bug
