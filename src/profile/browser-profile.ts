import { storagePathForOrigin } from '@switch-web/runtime';
import { BREWSER_APP_ROOT, DEFAULT_PROFILE_ROOT } from '../browser-config.js';

/**
 * Per-user profile container. Owns the on-disk storage root for cookies,
 * local-storage, cache, history, bookmarks, and (since the move) the
 * built-in HTML pages the shell serves at `brewser://` URLs.
 *
 * `ensure()` creates the profile directory tree if missing.
 * `seedRomfs()` recursively mirrors the romfs tree into the SD-card
 * dir on first run, but never overwrites — user edits persist.
 */

/** Filenames at the romfs root that the seeder must NEVER mirror to
 * the SD card. `main.js` + `main.js.map` are the runtime bundle — they
 * live INSIDE the NRO and are read by nxjs at boot, not by the resource
 * loader, so copying them to sdmc would just produce a stale duplicate. */
const SEED_SKIP_ROOT_FILES: ReadonlySet<string> = new Set([
	'main.js',
	'main.js.map',
]);

/** Romfs subtrees the seeder must NOT recurse into. Each entry is a
 * directory path relative to `romfs:/` with a trailing slash. The
 * Khronos WebGL conformance test corpora (~2350 files each) live
 * under `romfs:/dev/full-webgl{1,2}-conformance/sdk/` and are read
 * on-demand by the runner from romfs at runtime, so seeding them to
 * sdmc would be slow + wasteful (and quietly fills the SD card with
 * test-vector duplicates). Anything else under `dev/` is small enough
 * to seed normally. */
const SEED_SKIP_DIRS: ReadonlySet<string> = new Set([
	'dev/full-webgl1-conformance/sdk/',
	'dev/full-webgl2-conformance/sdk/',
]);

export class BrowserProfile {
	readonly name: string;
	/** Per-profile storage: seeded pages (home.html etc.) sit flat
	 * at the root, plus `assets/` and per-origin dirs. */
	readonly storageRoot: string;
	/** App-level storage shared across profiles: `config.json`, the
	 * other top-level JSON config files, `templates/`, `logs/`,
	 * `screenshots/`, `history.jsonl`, `bookmarks.json`. */
	readonly appRoot: string;

	constructor(name = 'shell', profileRoot = DEFAULT_PROFILE_ROOT, appRoot = BREWSER_APP_ROOT) {
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
		try { Switch.mkdirSync(`${this.appRoot}keyboards/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}styles/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}screenshots/`); } catch (_) { /* exists */ }
		// `apps/` itself is intentionally NOT pre-created here. Apps live
		// in arbitrary subtrees (e.g. `apps/<channel>/<reverse-dns>/...`)
		// that are deployed via robocopy; the structure changes over time
		// and the shell must not assume any particular shape.
		// App-level dev surface: HTML/CSS/canvas/WebGL test fixtures +
		// Khronos conformance corpora. The walker creates these on its
		// own, but pre-creating them keeps the dir tree intact even when
		// `dev/` is empty in romfs (defensive — pages that fetch
		// `sdmc:/switch/brewser/dev/...` expect the dir to exist).
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
	 * across profiles, mirrored from `romfs:/dev/` by `seedRomfs`. */
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

	/** Absolute SD-card path to a seeded keyboard panel file. Resolves
	 * the `keyboard` field from `config.json` (`keyboards/<file>.html`)
	 * against the app-level root. Absolute schemes (`sdmc:/…`,
	 * `romfs:/…`) pass through unchanged so a user can point at a
	 * keyboard living anywhere on disk. */
	keyboardPath(rel: string): string {
		if (/^(?:sdmc:|romfs:)\/\//.test(rel)) return rel;
		return `${this.appRoot}${rel}`;
	}

	/** Absolute SD-card path to a seeded style sheet. Resolves the
	 * `brewserStyle` field from `config.json` (`styles/<file>.css`)
	 * against the app-level root. Absolute schemes (`sdmc:/…`,
	 * `romfs:/…`) pass through unchanged so a user can point at a
	 * sheet living anywhere on disk. */
	stylePath(rel: string): string {
		if (/^(?:sdmc:|romfs:)\/\//.test(rel)) return rel;
		return `${this.appRoot}${rel}`;
	}

	/**
	 * Recursively mirror everything under `romfs:/` to `<appRoot>` on the
	 * SD card. Replaced the half-dozen per-dir allowlist seeders (BUILTIN_PAGES,
	 * BUILTIN_DEV_PAGES, BUILTIN_ASSETS, BUILTIN_TEMPLATE_FILES,
	 * BUILTIN_KEYBOARD_FILES, BUILTIN_STYLE_FILES) on 2026-06-12 because
	 * those lists kept drifting from the actual romfs contents — any new
	 * file added to romfs needed a matching allowlist edit or it'd silently
	 * fail to seed (history.html, keyboard panels, etc.). The walker
	 * picks them up automatically.
	 *
	 * Same never-overwrite semantics as before: each per-file write is
	 * gated by `fileExists`, so user edits + per-origin state live in
	 * place across launches, and deleting a file restores the default
	 * next launch. PNG / WASM / TTF binaries survive the round-trip
	 * because we always go through `ArrayBuffer`.
	 *
	 * Skips:
	 *   - `main.js` + `main.js.map` at the romfs root — the runtime bundle,
	 *     read by nxjs from INSIDE the NRO, never from sdmc.
	 *   - The Khronos test corpora under `dev/full-webgl{1,2}-conformance/sdk/`
	 *     — ~2350 files each, read on-demand from romfs by the conformance
	 *     runner at runtime. Seeding them would saturate the SD card with
	 *     read-mostly duplicates for ~hundreds of MB of test vectors.
	 *
	 * Note this also seeds the romfs `shell/` subtree into `<appRoot>shell/`
	 * — which IS the per-profile `storageRoot`, since `DEFAULT_PROFILE_ROOT`
	 * collapsed to match `BREWSER_APP_ROOT` 2026-06-12 (see browser-config.ts).
	 * So one walker covers both the per-profile chrome pages AND the
	 * app-level templates / keyboards / styles / dev fixtures in one pass.
	 */
	async seedRomfs(): Promise<void> {
		await this.seedRomfsDir('');
	}

	/** Recursive worker for `seedRomfs`. `rel` is the path under `romfs:/`
	 * (no leading slash, trailing slash for non-root directories — the empty
	 * string is the romfs root). Each file write goes through
	 * `<appRoot><rel><filename>`, and each child directory recurses one
	 * level deeper. */
	private async seedRomfsDir(rel: string): Promise<void> {
		const src = `romfs:/${rel}`;
		const dst = `${this.appRoot}${rel}`;
		try { Switch.mkdirSync(dst); } catch (_) { /* exists */ }
		let iteratorErr: unknown = null;
		try {
			for await (const entry of Switch.readDir(src)) {
				if (entry.isDirectory) {
					const childRel = `${rel}${entry.name}/`;
					if (SEED_SKIP_DIRS.has(childRel)) continue;
					await this.seedRomfsDir(childRel);
				} else if (entry.isFile) {
					if (rel === '' && SEED_SKIP_ROOT_FILES.has(entry.name)) continue;
					const childRel = `${rel}${entry.name}`;
					const target = `${this.appRoot}${childRel}`;
					if (fileExists(target)) continue;
					try {
						const response = await fetch(`romfs:/${childRel}`);
						if (!response.ok) continue;
						const bytes = new Uint8Array(await response.arrayBuffer());
						Switch.writeFileSync(target, bytes);
					} catch (error) {
						console.debug(`[brewser] seed ${childRel} failed: ${error}`);
					}
				}
				// `isSymlink` (and any other DirEntry kind) is ignored —
				// the bundled romfs has no symlinks.
			}
		} catch (error) {
			iteratorErr = error;
		}
		if (iteratorErr) {
			console.debug(`[brewser] seed readDir ${src} failed: ${iteratorErr}`);
		}
	}
}

function fileExists(path: string): boolean {
	try {
		// `Switch.readFileSync` returns `ArrayBuffer | null` — it does NOT
		// throw on a missing file, it returns `null`. Check the return value
		// so a missing target isn't mistaken for "already seeded" (which
		// would silently skip every fetch for an empty profile dir).
		const data = Switch.readFileSync(path);
		return data !== null;
	} catch (_) {
		return false;
	}
}
