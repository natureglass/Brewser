import { storagePathForOrigin } from '@switch-web/runtime';
import { BREWSER_APP_ROOT, DEFAULT_PROFILE_ROOT } from '../browser-config.js';

/**
 * Per-user profile container. Owns the on-disk storage root for cookies,
 * local-storage, cache, history, bookmarks, and (since the move) the
 * built-in HTML pages the shell serves at `brewser://` URLs.
 *
 * `ensure()` creates the profile directory tree if missing.
 * `seedBuiltinPages()` copies the romfs page defaults into the profile
 * directory on first run, but never overwrites — user edits persist.
 */

/** Page files seeded from `romfs:/pages/` into the profile on first
 * run. Each entry is a path relative to the romfs source's `pages/`
 * subdir, so `'home.html'` maps from `romfs:/pages/home.html` to
 * `<storageRoot>home.html`. The romfs source keeps a `pages/`
 * grouping (matches the historical layout), but the SDMC target sits
 * flat at the profile root (`<storageRoot>` directly) after the
 * 2026-06-02 hoist. Dev-only fixtures + the Khronos conformance
 * corpus live separately under `BUILTIN_DEV_PAGES` (app-root `dev/`)
 * after the 2026-06-02 dev-tree hoist. */
const BUILTIN_PAGES: readonly string[] = [
	'home.html',
	'about.html',
	'error.html',
	'settings.html',
	'apps.html',
	'bookmarks.html',
];

/** App pages — apps catalog entries listed on apps.html (the launcher).
 * Each entry is a path under `romfs:/apps/<rest>` mirrored to
 * `<appRoot>apps/<rest>`. Apps live at the **app root**, NOT under any
 * per-profile dir, so they're shared across profiles. The apps.html
 * launcher itself lives in BUILTIN_PAGES because it's a regular
 * per-profile page that just RENDERS the catalog. */
const BUILTIN_APP_PAGES: readonly string[] = [
	'mediaplayer/index.html',
	'mediaplayer/assets/audioplayer_logo.png',
	'mediaplayer/config.json',
	// ThreeJSDemos — the launcher page lives at index.html (was
	// formerly threejs-demos.html at the per-profile root); each demo
	// subdir holds its own index.html + assets. Shared three.js + addon
	// libs live under libs/. Demos that exist in romfs but aren't seeded
	// here are still reachable via the romfs:/ fallback in the resource
	// loader; only the curated set below is mirrored to SDMC on first run.
	'ThreeJSDemos/index.html',
	'ThreeJSDemos/assets/threejsdemos_logo.png',
	'ThreeJSDemos/libs/three.iife.js',
	'ThreeJSDemos/libs/harness.js',
	'ThreeJSDemos/libs/orbit-controls.js',
	'ThreeJSDemos/libs/first-person-controls.js',
	'ThreeJSDemos/libs/obj-loader.js',
	'ThreeJSDemos/libs/effect-composer.js',
	'ThreeJSDemos/textured-rotating-cube/index.html',
	'ThreeJSDemos/textured-rotating-cube/assets/main.js',
	'ThreeJSDemos/textured-rotating-cube/assets/rendering-gl-drawelements.html',
	'ThreeJSDemos/geometry-cube/index.html',
	'ThreeJSDemos/geometry-cube/assets/main.js',
	'ThreeJSDemos/geometry-cube/assets/crate.png',
	'ThreeJSDemos/geometry-cube/assets/rendering-gl-drawelements.html',
	'ThreeJSDemos/webgl-lines-dashed/index.html',
	'ThreeJSDemos/webgl-lines-dashed/assets/main.js',
	'ThreeJSDemos/webgl-lines-dashed/assets/state-gl-initial-state.html',
	'ThreeJSDemos/webgl-lines-colors/index.html',
	'ThreeJSDemos/webgl-lines-colors/assets/main.js',
	'ThreeJSDemos/webgl-lines-colors/assets/attribs-gl-bindAttribLocation-aliasing.html',
	'ThreeJSDemos/webgl-geometry-colors/index.html',
	'ThreeJSDemos/webgl-geometry-colors/assets/main.js',
	'ThreeJSDemos/webgl-geometry-colors/assets/programs-gl-get-active-attribute.html',
	'ThreeJSDemos/webgl-layers/index.html',
	'ThreeJSDemos/webgl-layers/assets/main.js',
	'ThreeJSDemos/webgl-layers/assets/programs-program-infolog.html',
	'ThreeJSDemos/misc-controls-orbit/index.html',
	'ThreeJSDemos/misc-controls-orbit/assets/main.js',
	'ThreeJSDemos/misc-controls-orbit/assets/uniforms-gl-uniformmatrix4fv.html',
	'ThreeJSDemos/webgl-camera/index.html',
	'ThreeJSDemos/webgl-camera/assets/main.js',
	'ThreeJSDemos/webgl-camera/assets/rendering-gl-drawarrays.html',
	'ThreeJSDemos/webgl-geometry-shapes/index.html',
	'ThreeJSDemos/webgl-geometry-shapes/assets/main.js',
	'ThreeJSDemos/webgl-geometry-shapes/assets/uv_grid_opengl.jpg',
	'ThreeJSDemos/webgl-sprites/index.html',
	'ThreeJSDemos/webgl-sprites/assets/main.js',
	'ThreeJSDemos/webgl-sprites/assets/sprite0.png',
	'ThreeJSDemos/webgl-sprites/assets/sprite1.png',
	'ThreeJSDemos/webgl-sprites/assets/sprite2.png',
	'ThreeJSDemos/webgl-sprites/assets/rendering-gl-drawelements.html',
	'ThreeJSDemos/webgl-geometry-dynamic/index.html',
	'ThreeJSDemos/webgl-geometry-dynamic/assets/main.js',
	'ThreeJSDemos/webgl-geometry-dynamic/assets/water.jpg',
	'ThreeJSDemos/webgl-geometry-dynamic/assets/buffers-buffer-data-and-buffer-sub-data.html',
	'ThreeJSDemos/webgl-points-sprites/index.html',
	'ThreeJSDemos/webgl-points-sprites/assets/main.js',
	'ThreeJSDemos/webgl-points-sprites/assets/snowflake1.png',
	'ThreeJSDemos/webgl-points-sprites/assets/snowflake2.png',
	'ThreeJSDemos/webgl-points-sprites/assets/snowflake3.png',
	'ThreeJSDemos/webgl-points-sprites/assets/snowflake4.png',
	'ThreeJSDemos/webgl-points-sprites/assets/snowflake5.png',
	'ThreeJSDemos/webgl-points-sprites/assets/uniforms-null-uniform-location.html',
	'ThreeJSDemos/webgl-geometries/index.html',
	'ThreeJSDemos/webgl-geometries/assets/main.js',
	'ThreeJSDemos/webgl-geometries/assets/uv_grid_opengl.jpg',
	'ThreeJSDemos/webgl-geometries/assets/state-gl-enable-enum-test.html',
	'ThreeJSDemos/webgl-materials-blending/index.html',
	'ThreeJSDemos/webgl-materials-blending/assets/main.js',
	'ThreeJSDemos/webgl-materials-blending/assets/uv_grid_opengl.jpg',
	'ThreeJSDemos/webgl-materials-blending/assets/sprite0.jpg',
	'ThreeJSDemos/webgl-materials-blending/assets/sprite0.png',
	'ThreeJSDemos/webgl-materials-blending/assets/lensflare0.png',
	'ThreeJSDemos/webgl-materials-blending/assets/lensflare0_alpha.png',
	'ThreeJSDemos/webgl-materials-blending/assets/state-gl-blend-state.html',
	'ThreeJSDemos/webgl-interactive-cubes/index.html',
	'ThreeJSDemos/webgl-interactive-cubes/assets/main.js',
	'ThreeJSDemos/webgl-interactive-cubes/assets/uniforms-emissive-uniform.html',
	'ThreeJSDemos/webgl-materials-wireframe/index.html',
	'ThreeJSDemos/webgl-materials-wireframe/assets/main.js',
	'ThreeJSDemos/webgl-materials-wireframe/assets/WaltHeadLo_buffergeometry.json',
	'ThreeJSDemos/webgl-materials-wireframe/assets/rendering-triangle.html',
	'ThreeJSDemos/webgl-instancing-dynamic/index.html',
	'ThreeJSDemos/webgl-instancing-dynamic/assets/main.js',
	'ThreeJSDemos/webgl-instancing-dynamic/assets/suzanne_buffergeometry.json',
	'ThreeJSDemos/webgl-instancing-dynamic/assets/extensions-angle-instanced-arrays.html',
	'ThreeJSDemos/webgl-loader-obj/index.html',
	'ThreeJSDemos/webgl-loader-obj/assets/main.js',
	'ThreeJSDemos/webgl-loader-obj/assets/male02.obj',
	'ThreeJSDemos/webgl-loader-obj/assets/male02.mtl',
	'ThreeJSDemos/webgl-loader-obj/assets/01_-_Default1noCulling.JPG',
	'ThreeJSDemos/webgl-loader-obj/assets/male-02-1noCulling.JPG',
	'ThreeJSDemos/webgl-loader-obj/assets/orig_02_-_Defaul1noCulling.JPG',
	'ThreeJSDemos/webgl-loader-obj/assets/uv_grid_opengl.jpg',
	'ThreeJSDemos/webgl-loader-obj/assets/extensions-oes-standard-derivatives.html',
	'ThreeJSDemos/webgl-postprocessing/index.html',
	'ThreeJSDemos/webgl-postprocessing/assets/main.js',
	'ThreeJSDemos/webgl-postprocessing/assets/renderbuffers-framebuffer-object-attachment.html',
	'ThreeJSDemos/webgl-depth-texture/index.html',
	'ThreeJSDemos/webgl-depth-texture/assets/main.js',
	'ThreeJSDemos/webgl-depth-texture/assets/extensions-webgl-depth-texture.html',
	'ThreeJSDemos/webgl-shadowmap/index.html',
	'ThreeJSDemos/webgl-shadowmap/assets/main.js',
	'ThreeJSDemos/webgl-buffergeometry-indexed/index.html',
	'ThreeJSDemos/webgl-buffergeometry-indexed/assets/main.js',
	'ThreeJSDemos/webgl-custom-attributes/index.html',
	'ThreeJSDemos/webgl-custom-attributes/assets/main.js',
	'ThreeJSDemos/webgl-custom-attributes/assets/passthrough-cpu-data-texture-sample.html',
	'ThreeJSDemos/webgl-morphtargets-sphere/index.html',
	'ThreeJSDemos/webgl-morphtargets-sphere/assets/main.js',
	'ThreeJSDemos/webgl-morphtargets-sphere/assets/morph-sphere.bin',
	'ThreeJSDemos/webgl-morphtargets-sphere/assets/disc.png',
	'ThreeJSDemos/webgl-shader/index.html',
	'ThreeJSDemos/webgl-shader/assets/main.js',
	'ThreeJSDemos/webgl-materials-texture-filters/index.html',
	'ThreeJSDemos/webgl-materials-texture-filters/assets/main.js',
	'ThreeJSDemos/webgl-materials-texture-filters/assets/caravaggio.jpg',
	'ThreeJSDemos/webgl-materials-texture-filters/assets/textures-mipmap-filter-and-generate.html',
];

/** Dev / test-fixture pages seeded from `romfs:/dev/` into the
 * app-level `dev/` tree (shared across profiles). Each entry is a
 * path relative to `romfs:/dev/` and mirrors to `<appRoot>dev/<rel>`.
 * Moved here from BUILTIN_PAGES 2026-06-02 — the surface formerly
 * lived under `webprofiles/default/html-experiments/`; the `html-
 * experiments` segment was dropped during the hoist so URLs are
 * `brewser://dev/<page>` instead of the older
 * `brewser://html-experiments/<page>`. Same never-overwrite semantics
 * as the other seeders. Khronos conformance test corpora live in
 * romfs only (read on demand via `romfs:/dev/full-webgl{1,2}-
 * conformance/...`), so the ~860 individual test files don't need
 * seeding — only the runner shell + its assets do. */
const BUILTIN_DEV_PAGES: readonly string[] = [
	// Dev-fixtures launcher page (formerly `web-experiments.html` at
	// the per-profile root; relocated 2026-06-02 so `brewser://dev/`
	// lands on it). Lists every test fixture under dev/.
	'index.html',
	// Full WebGL 1 conformance runner page. The Khronos test corpus
	// itself (sdk/tests/{conformance,js}/...) lives in romfs and is
	// fetched at runtime via `romfs:/dev/full-webgl1-conformance/...`,
	// so the ~860 individual test files don't need to be seeded into
	// the app dir. Only the runner shell + its assets do.
	'full-webgl1-conformance/index.html',
	'full-webgl1-conformance/assets/runner.js',
	'full-webgl1-conformance/assets/tests.json',
	'nxjs-webgl-demo/index.html',
	'nxjs-webgl-demo/assets/main.js',
	'nxjs-webgl-demo/assets/logo.png',
	'two.html',
	'images.html',
	'pre.html',
	'css.html',
	'external-css.html',
	'inherit.html',
	'selectors.html',
	'align.html',
	'display-none.html',
	'line-height.html',
	'list-style.html',
	'border.html',
	'canvas.html',
	'canvas-script.html',
	'canvas-responsive.html',
	'canvas-webgl.html',
	'benchmark.html',
	'widgets.html',
	'tables.html',
	'svg.html',
	'rounded.html',
	'perf-image-stress.html',
	'perf-latency-probe.html',
	'perf-img-dom-stress.html',
	// API surface probe page + its TTF for the @font-face sub-test.
	// The font is loaded via @font-face url(sdmc:/switch/brewser/dev/
	// api-probe-font.ttf), so the file must be seeded next to the page.
	'api-probe.html',
	'api-probe-font.ttf',
	// Web Audio Tier-1 verification — exercises the AudioContext +
	// Oscillator + Gain + BufferSource + decodeAudioData wrappers shipped
	// in nxjs-source/packages/runtime/src/web-audio.ts. Audible test
	// page; reuses brewser://assets/click.wav for decodeAudioData.
	'web-audio-tone.html',
	// First "real game" smoke test — Breakout that exercises every Web
	// API shipped this week (Canvas 2D, Web Audio multi-voice,
	// localStorage high score, @keyframes title pulse, @font-face,
	// requestAnimationFrame, tap input). Heavy diagnostic logging to
	// logs/demo-breakout.log so any issue is debuggable from the trace.
	'demo-breakout.html',
	// Tier-0 Web Workers verification — spawns a real OS-thread worker,
	// sends a few `postMessage` strings, expects echoes back. Validates
	// the QuickJS-in-pthread foundation before committing to Tier-1.
	// See [[project-swb-web-workers-milestone]].
	'workers-tier0.html',
	// Helper script loaded by workers-tier0.html via importScripts() to
	// verify Tier-1 Pass C. Defines `self.__importedAdd` + sentinel.
	'workers-helper.js',
	// Self-running worker script loaded by `new Worker(url)` in the
	// Pass D test. Validates that sdmc:/ and brewser:// URL constructor
	// paths work, and that messages posted before the async fetch
	// resolves get buffered + delivered in order.
	'workers-pass-d.js',
	// Worker source for the Pass E (fetch proxy) test. Handles 'fetch',
	// 'parallel', 'mixed', and 'echo' commands; reports results via
	// kind-tagged postMessage payloads.
	'workers-pass-e.js',
	// Worker source for the Pass F (ArrayBuffer transfer) test. Handles
	// 'inspect', 'inspectMixed', 'echoTransfer', 'multi' commands; the
	// fixture verifies sender-side detach + receiver-side bytes intact.
	'workers-pass-f.js',
];

/** Chrome-toolbar icons + the unified per-profile-page stylesheet
 * seeded from `romfs:/assets/` into `<storageRoot>assets/`. Mirrors
 * `BUILTIN_PAGES` exactly: copy on first run, never overwrite,
 * deleting restores the default next launch. The browser loads icons
 * from sdmc so the user can swap a PNG in place to re-skin the
 * toolbar; `main.css` is loaded by each built-in page via
 * `<link rel="stylesheet" href="brewser://assets/main.css">`. */
const BUILTIN_ASSETS: readonly string[] = [
	'home.png',
	'refresh.png',
	'settings.png',
	'left.png',
	'right.png',
	'bookmark_true.png',
	'bookmark_false.png',
	'toolbar_back.png',
	'keyboard_back.png',
	'main.css',
];

/** Design-config + template files seeded from `romfs:/` into the
 * profile root. `config.json` names the active template; `templates.json`
 * is the catalog the Settings page lists; each `Templates/<name>.json`
 * is one named theme. Users add their own by dropping a new JSON in
 * `Templates/`, listing it in `templates.json`, and pointing
 * `config.json`'s `template` field at it. */
const BUILTIN_TEMPLATE_FILES: readonly string[] = [
	'config.json',
	'templates.json',
	'search_engines.json',
	'apps.json',
	'featured.json',
	'Templates/default.json',
	'Templates/light.json',
	'Templates/bottom-bar.json',
	'Templates/amber.json',
];

export class BrowserProfile {
	readonly name: string;
	/** Per-profile storage: seeded pages (home.html etc.) sit flat
	 * at the root, plus `assets/` and per-origin dirs. */
	readonly storageRoot: string;
	/** App-level storage shared across profiles: `config.json`, the
	 * other top-level JSON config files, `Templates/`, `logs/`,
	 * `screenshots/`, `history.jsonl`, `bookmarks.json`. */
	readonly appRoot: string;

	constructor(name = 'default', profileRoot = DEFAULT_PROFILE_ROOT, appRoot = BREWSER_APP_ROOT) {
		this.name = name;
		this.storageRoot = `${profileRoot}${name}/`;
		this.appRoot = appRoot;
	}

	/** Returns the absolute file path for the (app-level) history journal. */
	historyPath(): string {
		return `${this.appRoot}history.jsonl`;
	}

	/** Returns the absolute file path for the (app-level) bookmarks file. */
	bookmarksPath(): string {
		return `${this.appRoot}bookmarks.json`;
	}

	/** Per-origin path inside this profile (used by future cookie/local-storage stores). */
	pathForOrigin(origin: string): string {
		return storagePathForOrigin(origin, this.storageRoot);
	}

	/**
	 * Create the profile directory tree on the SD card if it doesn't exist.
	 * Wraps `Switch.mkdirSync`; swallows errors to keep the shell alive on
	 * read-only or missing-card situations (history just won't persist).
	 */
	ensure(): void {
		try {
			Switch.mkdirSync(this.storageRoot);
		} catch (error) {
			console.debug(`[switch-web-browser] failed to create profile dir ${this.storageRoot}: ${error}`);
		}
		// Subdirectories the seeders will write into; create them now so
		// writeFileSync below doesn't fail on missing parents.
		try { Switch.mkdirSync(`${this.storageRoot}assets/`); } catch (_) { /* exists */ }
		// App-level dirs shared across profiles.
		try { Switch.mkdirSync(this.appRoot); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}logs/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}Templates/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}screenshots/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/mediaplayer/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/mediaplayer/assets/`); } catch (_) { /* exists */ }
		// App-level dev surface: HTML/CSS/canvas/WebGL test fixtures +
		// Khronos conformance corpora. Mirrors `BUILTIN_DEV_PAGES`.
		try { Switch.mkdirSync(`${this.appRoot}dev/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}dev/full-webgl1-conformance/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}dev/full-webgl1-conformance/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}dev/nxjs-webgl-demo/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}dev/nxjs-webgl-demo/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/libs/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/textured-rotating-cube/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/textured-rotating-cube/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/geometry-cube/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/geometry-cube/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-lines-dashed/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-lines-dashed/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-lines-colors/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-lines-colors/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-geometry-colors/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-geometry-colors/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-layers/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-layers/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/misc-controls-orbit/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/misc-controls-orbit/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-camera/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-camera/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-geometry-shapes/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-geometry-shapes/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-sprites/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-sprites/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-geometry-dynamic/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-geometry-dynamic/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-points-sprites/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-points-sprites/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-geometries/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-geometries/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-materials-blending/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-materials-blending/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-interactive-cubes/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-interactive-cubes/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-materials-wireframe/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-materials-wireframe/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-instancing-dynamic/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-instancing-dynamic/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-loader-obj/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-loader-obj/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-postprocessing/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-postprocessing/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-depth-texture/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-depth-texture/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-shadowmap/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-shadowmap/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-buffergeometry-indexed/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-buffergeometry-indexed/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-custom-attributes/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-custom-attributes/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-morphtargets-sphere/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-morphtargets-sphere/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-shader/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-shader/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-materials-texture-filters/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}apps/ThreeJSDemos/webgl-materials-texture-filters/assets/`); } catch (_) { /* exists */ }
	}

	/** Absolute SD-card path to a seeded HTML page. The browser's
	 * resource loader resolves `brewser://X/Y/` to `<storageRoot>X/Y.html`.
	 * Centralised so the on-disk layout lives in one place. */
	pagePath(filename: string): string {
		return `${this.storageRoot}${filename}`;
	}

	/** Absolute SD-card path to a seeded app page or asset. Apps live
	 * at the (app-level) `apps/` dir — see BUILTIN_APP_PAGES. */
	appPagePath(filename: string): string {
		return `${this.appRoot}apps/${filename}`;
	}

	/** Absolute SD-card path to a seeded dev/test-fixture page or
	 * asset. Dev pages live at the (app-level) `dev/` dir, shared
	 * across profiles — see BUILTIN_DEV_PAGES. */
	devPagePath(filename: string): string {
		return `${this.appRoot}dev/${filename}`;
	}

	/** Absolute SD-card path to a seeded asset. Used by the chrome
	 * code to construct `Image.src` URLs for toolbar icons. */
	assetPath(filename: string): string {
		return `${this.storageRoot}assets/${filename}`;
	}

	/** Absolute SD-card path to the (app-level) `templates.json` — the
	 * registry of available design templates the shell reads at launch.
	 * The active template lives at one of the paths the registry
	 * references (typically `Templates/<name>.json`). */
	templatesRegistryPath(): string {
		return `${this.appRoot}templates.json`;
	}

	/** Copy the templates registry + every shipped template JSON
	 * (`romfs:/templates.json`, `romfs:/Templates/<name>.json`) into the
	 * app-level dir if the targets are missing. Same never-overwrite
	 * semantics as the page + asset seeders. */
	async seedTemplates(): Promise<void> {
		for (const rel of BUILTIN_TEMPLATE_FILES) {
			const target = `${this.appRoot}${rel}`;
			if (fileExists(target)) continue;
			try {
				const response = await fetch(`romfs:/${rel}`);
				if (!response.ok) continue;
				const text = await response.text();
				Switch.writeFileSync(target, text);
			} catch (error) {
				console.debug(`[switch-web-browser] seed ${rel} failed: ${error}`);
			}
		}
	}

	/**
	 * Copy each `romfs:/pages/<rel>` into `<storageRoot><rel>` if the
	 * target file is missing. The source tree keeps a `pages/` prefix
	 * (the romfs layout is unchanged), but the SDMC target sits flat
	 * at the profile root. Never overwrites — once seeded, the user's
	 * edits on disk are authoritative. Deleting a file restores it
	 * next launch, which is intentional (lets the user "reset" a
	 * page). Reads bytes so binary page assets (e.g. textures bundled
	 * with a Three.js demo) survive the round-trip; text files are
	 * preserved bit-exact since we never re-encode them.
	 */
	async seedBuiltinPages(): Promise<void> {
		for (const rel of BUILTIN_PAGES) {
			const target = this.pagePath(rel);
			if (fileExists(target)) continue;
			try {
				const response = await fetch(`romfs:/pages/${rel}`);
				if (!response.ok) continue;
				const bytes = new Uint8Array(await response.arrayBuffer());
				Switch.writeFileSync(target, bytes);
			} catch (error) {
				console.debug(`[switch-web-browser] seed ${rel} failed: ${error}`);
			}
		}
	}

	/** Copy each `romfs:/apps/<rel>` into `<appRoot>apps/<rel>` if the
	 * target file is missing. App pages live at the app-level root,
	 * shared across profiles; seeding semantics otherwise match
	 * `seedBuiltinPages`. */
	async seedBuiltinAppPages(): Promise<void> {
		for (const rel of BUILTIN_APP_PAGES) {
			const target = this.appPagePath(rel);
			if (fileExists(target)) continue;
			try {
				const response = await fetch(`romfs:/apps/${rel}`);
				if (!response.ok) continue;
				const bytes = new Uint8Array(await response.arrayBuffer());
				Switch.writeFileSync(target, bytes);
			} catch (error) {
				console.debug(`[switch-web-browser] seed app ${rel} failed: ${error}`);
			}
		}
	}

	/** Copy each `romfs:/dev/<rel>` into `<appRoot>dev/<rel>` if the
	 * target file is missing. Dev/test pages live at the app-level
	 * root, shared across profiles; seeding semantics otherwise match
	 * `seedBuiltinPages`. */
	async seedBuiltinDevPages(): Promise<void> {
		for (const rel of BUILTIN_DEV_PAGES) {
			const target = this.devPagePath(rel);
			if (fileExists(target)) continue;
			try {
				const response = await fetch(`romfs:/dev/${rel}`);
				if (!response.ok) continue;
				const bytes = new Uint8Array(await response.arrayBuffer());
				Switch.writeFileSync(target, bytes);
			} catch (error) {
				console.debug(`[switch-web-browser] seed dev ${rel} failed: ${error}`);
			}
		}
	}

	/** Copy each `romfs:/assets/<rel>` into `<storageRoot>assets/<rel>`
	 * if the target file is missing. Same never-overwrite semantics as
	 * the page seeder. PNG bodies are binary, so we read as
	 * `ArrayBuffer` and write the bytes back directly. */
	async seedBuiltinAssets(): Promise<void> {
		for (const rel of BUILTIN_ASSETS) {
			const target = this.assetPath(rel);
			if (fileExists(target)) continue;
			try {
				const response = await fetch(`romfs:/assets/${rel}`);
				if (!response.ok) continue;
				const bytes = new Uint8Array(await response.arrayBuffer());
				Switch.writeFileSync(target, bytes);
			} catch (error) {
				console.debug(`[switch-web-browser] seed asset ${rel} failed: ${error}`);
			}
		}
	}
}

function fileExists(path: string): boolean {
	try {
		Switch.readFileSync(path);
		return true;
	} catch (_) {
		return false;
	}
}
