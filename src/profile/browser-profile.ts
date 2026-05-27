import { storagePathForOrigin } from '@switch-web/runtime';
import { DEFAULT_PROFILE_ROOT } from '../browser-config.js';

/**
 * Per-user profile container. Owns the on-disk storage root for cookies,
 * local-storage, cache, history, bookmarks, and (since the move) the
 * built-in HTML pages the shell serves at `browser://` URLs.
 *
 * `ensure()` creates the profile directory tree if missing.
 * `seedBuiltinPages()` copies the romfs page defaults into the profile
 * directory on first run, but never overwrites — user edits persist.
 */

/** Page files seeded from `romfs:/pages/` into the profile on first
 * run. Each entry is a path relative to both the romfs source and the
 * profile's `pages/` subdir, so `'html-experiments/css.html'` maps
 * from `romfs:/pages/html-experiments/css.html` to
 * `<storageRoot>pages/html-experiments/css.html`. The on-disk
 * `pages/` grouping mirrors the romfs source layout and keeps the
 * profile root tidy alongside `config.json`, `history.jsonl`,
 * `assets/`, `Templates/`, etc. */
const BUILTIN_PAGES: readonly string[] = [
	'welcome.html',
	'about.html',
	'error.html',
	'library.html',
	'web-experiments.html',
	'threejs-demos.html',
	// DOM tests — canonical scripted reference page that exercises
	// the Phase 2 live-DOM surface end-to-end (cascade positioning +
	// var() + flex layout + form widgets + event bubbling + scrollable).
	'html-experiments/dom-tests/reference/index.html',
	'html-experiments/dom-tests/reference/assets/main.js',
	// Shared Three.js library + any addons (OrbitControls, OBJLoader, etc).
	// All demos load this single copy via
	// `browser://threejs-demos/libs/three.iife.js`. Saves ~1.2 MB per
	// extra demo over the prior per-demo copy.
	'threejs-demos/libs/three.iife.js',
	'threejs-demos/libs/harness.js',
	'threejs-demos/libs/orbit-controls.js',
	'threejs-demos/libs/first-person-controls.js',
	'threejs-demos/libs/obj-loader.js',
	'threejs-demos/libs/effect-composer.js',
	'threejs-demos/textured-rotating-cube/index.html',
	'threejs-demos/textured-rotating-cube/assets/main.js',
	'threejs-demos/textured-rotating-cube/assets/rendering-gl-drawelements.html',
	'threejs-demos/geometry-cube/index.html',
	'threejs-demos/geometry-cube/assets/main.js',
	'threejs-demos/geometry-cube/assets/crate.png',
	'threejs-demos/geometry-cube/assets/rendering-gl-drawelements.html',
	'threejs-demos/webgl-lines-dashed/index.html',
	'threejs-demos/webgl-lines-dashed/assets/main.js',
	'threejs-demos/webgl-lines-dashed/assets/state-gl-initial-state.html',
	'threejs-demos/webgl-lines-colors/index.html',
	'threejs-demos/webgl-lines-colors/assets/main.js',
	'threejs-demos/webgl-lines-colors/assets/attribs-gl-bindAttribLocation-aliasing.html',
	'threejs-demos/webgl-geometry-colors/index.html',
	'threejs-demos/webgl-geometry-colors/assets/main.js',
	'threejs-demos/webgl-geometry-colors/assets/programs-gl-get-active-attribute.html',
	'threejs-demos/webgl-layers/index.html',
	'threejs-demos/webgl-layers/assets/main.js',
	'threejs-demos/webgl-layers/assets/programs-program-infolog.html',
	'threejs-demos/misc-controls-orbit/index.html',
	'threejs-demos/misc-controls-orbit/assets/main.js',
	'threejs-demos/misc-controls-orbit/assets/uniforms-gl-uniformmatrix4fv.html',
	'threejs-demos/webgl-camera/index.html',
	'threejs-demos/webgl-camera/assets/main.js',
	'threejs-demos/webgl-camera/assets/rendering-gl-drawarrays.html',
	'threejs-demos/webgl-geometry-shapes/index.html',
	'threejs-demos/webgl-geometry-shapes/assets/main.js',
	'threejs-demos/webgl-geometry-shapes/assets/uv_grid_opengl.jpg',
	'threejs-demos/webgl-sprites/index.html',
	'threejs-demos/webgl-sprites/assets/main.js',
	'threejs-demos/webgl-sprites/assets/sprite0.png',
	'threejs-demos/webgl-sprites/assets/sprite1.png',
	'threejs-demos/webgl-sprites/assets/sprite2.png',
	'threejs-demos/webgl-sprites/assets/rendering-gl-drawelements.html',
	'threejs-demos/webgl-geometry-dynamic/index.html',
	'threejs-demos/webgl-geometry-dynamic/assets/main.js',
	'threejs-demos/webgl-geometry-dynamic/assets/water.jpg',
	'threejs-demos/webgl-geometry-dynamic/assets/buffers-buffer-data-and-buffer-sub-data.html',
	'threejs-demos/webgl-points-sprites/index.html',
	'threejs-demos/webgl-points-sprites/assets/main.js',
	'threejs-demos/webgl-points-sprites/assets/snowflake1.png',
	'threejs-demos/webgl-points-sprites/assets/snowflake2.png',
	'threejs-demos/webgl-points-sprites/assets/snowflake3.png',
	'threejs-demos/webgl-points-sprites/assets/snowflake4.png',
	'threejs-demos/webgl-points-sprites/assets/snowflake5.png',
	'threejs-demos/webgl-points-sprites/assets/uniforms-null-uniform-location.html',
	'threejs-demos/webgl-geometries/index.html',
	'threejs-demos/webgl-geometries/assets/main.js',
	'threejs-demos/webgl-geometries/assets/uv_grid_opengl.jpg',
	'threejs-demos/webgl-geometries/assets/state-gl-enable-enum-test.html',
	'threejs-demos/webgl-materials-blending/index.html',
	'threejs-demos/webgl-materials-blending/assets/main.js',
	'threejs-demos/webgl-materials-blending/assets/uv_grid_opengl.jpg',
	'threejs-demos/webgl-materials-blending/assets/sprite0.jpg',
	'threejs-demos/webgl-materials-blending/assets/sprite0.png',
	'threejs-demos/webgl-materials-blending/assets/lensflare0.png',
	'threejs-demos/webgl-materials-blending/assets/lensflare0_alpha.png',
	'threejs-demos/webgl-materials-blending/assets/state-gl-blend-state.html',
	'threejs-demos/webgl-interactive-cubes/index.html',
	'threejs-demos/webgl-interactive-cubes/assets/main.js',
	'threejs-demos/webgl-interactive-cubes/assets/uniforms-emissive-uniform.html',
	'threejs-demos/webgl-materials-wireframe/index.html',
	'threejs-demos/webgl-materials-wireframe/assets/main.js',
	'threejs-demos/webgl-materials-wireframe/assets/WaltHeadLo_buffergeometry.json',
	'threejs-demos/webgl-materials-wireframe/assets/rendering-triangle.html',
	'threejs-demos/webgl-instancing-dynamic/index.html',
	'threejs-demos/webgl-instancing-dynamic/assets/main.js',
	'threejs-demos/webgl-instancing-dynamic/assets/suzanne_buffergeometry.json',
	'threejs-demos/webgl-instancing-dynamic/assets/extensions-angle-instanced-arrays.html',
	'threejs-demos/webgl-loader-obj/index.html',
	'threejs-demos/webgl-loader-obj/assets/main.js',
	'threejs-demos/webgl-loader-obj/assets/male02.obj',
	'threejs-demos/webgl-loader-obj/assets/male02.mtl',
	'threejs-demos/webgl-loader-obj/assets/01_-_Default1noCulling.JPG',
	'threejs-demos/webgl-loader-obj/assets/male-02-1noCulling.JPG',
	'threejs-demos/webgl-loader-obj/assets/orig_02_-_Defaul1noCulling.JPG',
	'threejs-demos/webgl-loader-obj/assets/uv_grid_opengl.jpg',
	'threejs-demos/webgl-loader-obj/assets/extensions-oes-standard-derivatives.html',
	'threejs-demos/webgl-postprocessing/index.html',
	'threejs-demos/webgl-postprocessing/assets/main.js',
	'threejs-demos/webgl-postprocessing/assets/renderbuffers-framebuffer-object-attachment.html',
	'threejs-demos/webgl-depth-texture/index.html',
	'threejs-demos/webgl-depth-texture/assets/main.js',
	'threejs-demos/webgl-depth-texture/assets/extensions-webgl-depth-texture.html',
	'threejs-demos/webgl-shadowmap/index.html',
	'threejs-demos/webgl-shadowmap/assets/main.js',
	'threejs-demos/webgl-buffergeometry-indexed/index.html',
	'threejs-demos/webgl-buffergeometry-indexed/assets/main.js',
	'threejs-demos/webgl-custom-attributes/index.html',
	'threejs-demos/webgl-custom-attributes/assets/main.js',
	'threejs-demos/webgl-custom-attributes/assets/passthrough-cpu-data-texture-sample.html',
	'threejs-demos/webgl-morphtargets-sphere/index.html',
	'threejs-demos/webgl-morphtargets-sphere/assets/main.js',
	'threejs-demos/webgl-morphtargets-sphere/assets/morph-sphere.bin',
	'threejs-demos/webgl-morphtargets-sphere/assets/disc.png',
	'threejs-demos/webgl-shader/index.html',
	'threejs-demos/webgl-shader/assets/main.js',
	'threejs-demos/webgl-materials-texture-filters/index.html',
	'threejs-demos/webgl-materials-texture-filters/assets/main.js',
	'threejs-demos/webgl-materials-texture-filters/assets/caravaggio.jpg',
	'threejs-demos/webgl-materials-texture-filters/assets/textures-mipmap-filter-and-generate.html',
	// Full WebGL 1 conformance runner page. The Khronos test corpus
	// itself (sdk/tests/{conformance,js}/...) lives in romfs and is
	// fetched at runtime via `romfs:/pages/full-webgl1-conformance/...`,
	// so the ~860 individual test files don't need to be seeded into the
	// profile dir. Only the runner shell + its assets do.
	'full-webgl1-conformance/index.html',
	'full-webgl1-conformance/assets/runner.js',
	'full-webgl1-conformance/assets/tests.json',
	'nxjs-webgl-demo/index.html',
	'nxjs-webgl-demo/assets/main.js',
	'nxjs-webgl-demo/assets/logo.png',
	'html-experiments/two.html',
	'html-experiments/images.html',
	'html-experiments/pre.html',
	'html-experiments/css.html',
	'html-experiments/external-css.html',
	'html-experiments/inherit.html',
	'html-experiments/selectors.html',
	'html-experiments/align.html',
	'html-experiments/display-none.html',
	'html-experiments/line-height.html',
	'html-experiments/list-style.html',
	'html-experiments/border.html',
	'html-experiments/canvas.html',
	'html-experiments/canvas-script.html',
	'html-experiments/canvas-responsive.html',
	'html-experiments/canvas-webgl.html',
	'html-experiments/benchmark.html',
	'html-experiments/widgets.html',
	'html-experiments/tables.html',
	'html-experiments/svg.html',
	'html-experiments/rounded.html',
];

/** Chrome-toolbar icons seeded from `romfs:/assets/` into
 * `<storageRoot>assets/`. Mirrors `BUILTIN_PAGES` exactly: copy on
 * first run, never overwrite, deleting restores the default next
 * launch. The browser loads them from sdmc so the user can swap a
 * PNG in place to re-skin the toolbar. */
const BUILTIN_ASSETS: readonly string[] = [
	'home.png',
	'library.png',
	'left.png',
	'right.png',
	'bookmark_true.png',
	'bookmark_false.png',
	'toolbar_back.png',
	'keyboard_back.png',
];

/** Design-config + template files seeded from `romfs:/` into the
 * profile root. `config.json` names the active template; `templates.json`
 * is the catalog the Library page lists; each `Templates/<name>.json`
 * is one named theme. Users add their own by dropping a new JSON in
 * `Templates/`, listing it in `templates.json`, and pointing
 * `config.json`'s `template` field at it. */
const BUILTIN_TEMPLATE_FILES: readonly string[] = [
	'config.json',
	'templates.json',
	'Templates/default.json',
	'Templates/light.json',
	'Templates/bottom-bar.json',
	'Templates/amber.json',
];

export class BrowserProfile {
	readonly name: string;
	readonly storageRoot: string;

	constructor(name = 'default', profileRoot = DEFAULT_PROFILE_ROOT) {
		this.name = name;
		this.storageRoot = `${profileRoot}${name}/`;
	}

	/** Returns the absolute file path for this profile's history journal. */
	historyPath(): string {
		return `${this.storageRoot}history.jsonl`;
	}

	/** Returns the absolute file path for this profile's bookmarks file. */
	bookmarksPath(): string {
		return `${this.storageRoot}bookmarks.json`;
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
		try { Switch.mkdirSync(`${this.storageRoot}pages/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/html-experiments/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/html-experiments/dom-tests/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/html-experiments/dom-tests/reference/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/html-experiments/dom-tests/reference/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/libs/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/textured-rotating-cube/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/textured-rotating-cube/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/geometry-cube/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/geometry-cube/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-lines-dashed/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-lines-dashed/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-lines-colors/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-lines-colors/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-geometry-colors/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-geometry-colors/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-layers/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-layers/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/misc-controls-orbit/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/misc-controls-orbit/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-camera/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-camera/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-geometry-shapes/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-geometry-shapes/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-sprites/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-sprites/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-geometry-dynamic/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-geometry-dynamic/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-points-sprites/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-points-sprites/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-geometries/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-geometries/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-materials-blending/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-materials-blending/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-interactive-cubes/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-interactive-cubes/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-materials-wireframe/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-materials-wireframe/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-instancing-dynamic/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-instancing-dynamic/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-loader-obj/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-loader-obj/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-postprocessing/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-postprocessing/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-depth-texture/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-depth-texture/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-shadowmap/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-shadowmap/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-buffergeometry-indexed/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-buffergeometry-indexed/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-custom-attributes/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-custom-attributes/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-morphtargets-sphere/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-morphtargets-sphere/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-shader/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-shader/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-materials-texture-filters/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/threejs-demos/webgl-materials-texture-filters/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/full-webgl1-conformance/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/full-webgl1-conformance/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/nxjs-webgl-demo/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}pages/nxjs-webgl-demo/assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}khronos-logs/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}assets/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.storageRoot}Templates/`); } catch (_) { /* exists */ }
	}

	/** Absolute SD-card path to a seeded HTML page. The browser's
	 * resource loader resolves `browser://X/Y/` to `pages/X/Y.html`
	 * relative to `storageRoot`. Centralised so the on-disk layout
	 * lives in one place. */
	pagePath(filename: string): string {
		return `${this.storageRoot}pages/${filename}`;
	}

	/** Absolute SD-card path to a seeded asset. Used by the chrome
	 * code to construct `Image.src` URLs for toolbar icons. */
	assetPath(filename: string): string {
		return `${this.storageRoot}assets/${filename}`;
	}

	/** Absolute SD-card path to this profile's `templates.json` — the
	 * registry of available design templates the shell reads at launch.
	 * The active template lives at one of the paths the registry
	 * references (typically `Templates/<name>.json`). */
	templatesRegistryPath(): string {
		return `${this.storageRoot}templates.json`;
	}

	/** Copy the templates registry + every shipped template JSON
	 * (`romfs:/templates.json`, `romfs:/Templates/<name>.json`) into the
	 * profile dir if the targets are missing. Same never-overwrite
	 * semantics as the page + asset seeders. */
	async seedTemplates(): Promise<void> {
		for (const rel of BUILTIN_TEMPLATE_FILES) {
			const target = `${this.storageRoot}${rel}`;
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
	 * Copy each `romfs:/pages/<rel>` into `<storageRoot>pages/<rel>` if
	 * the target file is missing. Never overwrites — once seeded, the
	 * user's edits on disk are authoritative. Deleting a file restores
	 * it next launch, which is intentional (lets the user "reset" a
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
