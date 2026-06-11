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

/** Page files seeded from `romfs:/webprofiles/default/` into the
 * profile on first run. Each entry is a path under the romfs source's
 * per-profile template dir, so `'home.html'` maps from
 * `romfs:/webprofiles/default/home.html` to `<storageRoot>home.html`.
 * After the 2026-06-04 mirror refactor the romfs source layout now
 * mirrors the SD-card runtime layout 1:1 — every romfs path maps to
 * the same relative path under `brewser/` at runtime. Dev-only
 * fixtures + the Khronos conformance corpus live separately under
 * `BUILTIN_DEV_PAGES` (app-root `dev/`). */
const BUILTIN_PAGES: readonly string[] = [
	'home.html',
	'about.html',
	'error.html',
	'settings.html',
	'apps.html',
	'bookmarks.html',
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
	// Diagnostic ladder for CSS-only tab UIs (2026-06-10). Four
	// progressive variations isolate which layer breaks: bare radio
	// routing → `~` sibling combinator → `+` adjacent sibling →
	// inline-flex pill labels (the apps.html shape). Each variation
	// uses different colors so the broken layer is obvious at a glance.
	'tabs.html',
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
	// WebAssembly probe (itch.io compat roadmap A1). 9 slices verifying
	// instantiate / instantiateStreaming / Memory / Table / imports +
	// exports reflection against the MDN simple.wasm fixture below.
	'wasm-probe.html',
	// MutationObserver probe (itch.io compat roadmap A2). 10 slices
	// verifying childList / attributes / characterData / subtree /
	// attributeFilter / disconnect / takeRecords / async delivery.
	'mutation-observer-probe.html',
	// CSS variables + calc() probe (itch.io compat roadmap A3). 10
	// slices verifying :root cascade, var() resolution + fallback,
	// inheritance, calc() arithmetic, calc(var()), inline-style var(),
	// el.style.setProperty/getPropertyValue for --foo, getComputedStyle.
	'css-vars-probe.html',
	// Binary WASM fixture — 78 bytes, exports `exported_func()` which
	// calls imported `imports.imported_func(42)`. Copy of nx.js's
	// apps/wasm/src/simple.wasm; corresponds to the .wat at
	// https://github.com/mdn/webassembly-examples/blob/main/js-api-examples/simple.wat
	'wasm-probe.wasm',
];

/** Chrome-toolbar icons + the unified per-profile-page stylesheet
 * seeded from `romfs:/webprofiles/default/assets/` into
 * `<storageRoot>assets/`. Mirrors
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
	// Generic "download" glyph the apps launcher paints on cards whose
	// app folder isn't on disk yet. Served at
	// `brewser://assets/download.png` once seeded into `<storageRoot>assets/`.
	'download.png',
	// Page-side script driving the missing-app detail modal. Shared by
	// apps.html and home.html via `<script src="brewser://assets/missing-app-modal.js">`,
	// so it only ships in one place. Toggles `.app-modal-overlay--open`
	// (NOT `style.display` — that doesn't invalidate the live-DOM paint
	// cache, leaving stale modal pixels on screen across opens).
	'missing-app-modal.js',
	// Audio feedback for link/button presses. Played by the shell's
	// click-sound module when `config.json clickSounds` is true.
	'click.wav',
];

/** Design-config + template files seeded from `romfs:/` into the
 * profile root. `config.json` names the active template; `templates.json`
 * is the catalog the Settings page lists; each `templates/<name>.json`
 * is one named theme. Users add their own by dropping a new JSON in
 * `templates/`, listing it in `templates.json`, and pointing
 * `config.json`'s `template` field at it. (Lowercase `templates/`
 * since the 2026-06-03 rename — existing installs with the old
 * `Templates/` dir auto-migrate via `loadConfig` normalization; the
 * legacy folder can be deleted manually.) */
const BUILTIN_TEMPLATE_FILES: readonly string[] = [
	'config.json',
	'templates.json',
	'search_engines.json',
	// Unified app catalog (2026-06-10) — replaced apps.json + featured.json.
	// Three top-level arrays (featured / community / experimental); each
	// drives one tab on apps.html, and `featured` also seeds home.html's
	// Featured Apps grid. See `loadCatalogGroup` in browser-template.ts.
	'catalog.json',
	'templates/default.json',
	'templates/light.json',
	'templates/bottom-bar.json',
	'templates/amber.json',
];

export class BrowserProfile {
	readonly name: string;
	/** Per-profile storage: seeded pages (home.html etc.) sit flat
	 * at the root, plus `assets/` and per-origin dirs. */
	readonly storageRoot: string;
	/** App-level storage shared across profiles: `config.json`, the
	 * other top-level JSON config files, `templates/`, `logs/`,
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
			console.debug(`[brewser] failed to create profile dir ${this.storageRoot}: ${error}`);
		}
		// Subdirectories the seeders will write into; create them now so
		// writeFileSync below doesn't fail on missing parents.
		try { Switch.mkdirSync(`${this.storageRoot}assets/`); } catch (_) { /* exists */ }
		// App-level dirs shared across profiles.
		try { Switch.mkdirSync(this.appRoot); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}logs/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}templates/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}screenshots/`); } catch (_) { /* exists */ }
		// `apps/` itself is intentionally NOT pre-created here. Apps live
		// in arbitrary subtrees (e.g. `apps/<channel>/<reverse-dns>/...`)
		// that are deployed via robocopy; the structure changes over time
		// and the shell must not assume any particular shape.
		// App-level dev surface: HTML/CSS/canvas/WebGL test fixtures +
		// Khronos conformance corpora. Mirrors `BUILTIN_DEV_PAGES`.
		try { Switch.mkdirSync(`${this.appRoot}dev/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}dev/full-webgl1-conformance/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}dev/full-webgl1-conformance/assets/`); } catch (_) { /* exists */ }
	}

	/** Absolute SD-card path to a seeded HTML page. The browser's
	 * resource loader resolves `brewser://X/Y/` to `<storageRoot>X/Y.html`.
	 * Centralised so the on-disk layout lives in one place. */
	pagePath(filename: string): string {
		return `${this.storageRoot}${filename}`;
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
	 * references (typically `templates/<name>.json`). */
	templatesRegistryPath(): string {
		return `${this.appRoot}templates.json`;
	}

	/** Copy the templates registry + every shipped template JSON
	 * (`romfs:/templates.json`, `romfs:/templates/<name>.json`) into the
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
				console.debug(`[brewser] seed ${rel} failed: ${error}`);
			}
		}
	}

	/**
	 * Copy each `romfs:/webprofiles/default/<rel>` into
	 * `<storageRoot><rel>` if the target file is missing. After the
	 * 2026-06-04 mirror refactor the romfs source layout matches the
	 * SD-card runtime 1:1: pages live in romfs at the same relative
	 * path they'll occupy on the SD card. Never overwrites — once
	 * seeded, the user's edits on disk are authoritative. Deleting a
	 * file restores it next launch (lets the user "reset" a page).
	 * Reads bytes so binary page assets survive the round-trip; text
	 * files are preserved bit-exact since we never re-encode them.
	 */
	async seedBuiltinPages(): Promise<void> {
		for (const rel of BUILTIN_PAGES) {
			const target = this.pagePath(rel);
			if (fileExists(target)) continue;
			try {
				const response = await fetch(`romfs:/webprofiles/default/${rel}`);
				if (!response.ok) continue;
				const bytes = new Uint8Array(await response.arrayBuffer());
				Switch.writeFileSync(target, bytes);
			} catch (error) {
				console.debug(`[brewser] seed ${rel} failed: ${error}`);
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
				console.debug(`[brewser] seed dev ${rel} failed: ${error}`);
			}
		}
	}

	/** Copy each `romfs:/webprofiles/default/assets/<rel>` into
	 * `<storageRoot>assets/<rel>` if the target file is missing. Same
	 * never-overwrite semantics as the page seeder. PNG bodies are
	 * binary, so we read as `ArrayBuffer` and write the bytes back
	 * directly. */
	async seedBuiltinAssets(): Promise<void> {
		for (const rel of BUILTIN_ASSETS) {
			const target = this.assetPath(rel);
			if (fileExists(target)) continue;
			try {
				const response = await fetch(`romfs:/webprofiles/default/assets/${rel}`);
				if (!response.ok) continue;
				const bytes = new Uint8Array(await response.arrayBuffer());
				Switch.writeFileSync(target, bytes);
			} catch (error) {
				console.debug(`[brewser] seed asset ${rel} failed: ${error}`);
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
