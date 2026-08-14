import {
	BREWSER_APP_ROOT,
	DEFAULT_PROFILE_ROOT,
	storagePathForOrigin,
	type StorageProfileLike,
} from '@switch-web/runtime';

/**
 * Per-user profile container. Owns the on-disk storage root for cookies,
 * local-storage, cache, history, bookmarks, and (since the move) the
 * built-in HTML pages the shell serves at `brewser://` URLs.
 *
 * `ensure()` creates the profile directory tree if missing.
 * `seedRomfs()` recursively mirrors the romfs tree into the SD-card dir.
 * User data (`configs/`, `apps/`, `logs/`, `shell/auth/`) is seeded
 * missing-only, so edits persist; the app-owned UI (`shell/` + `themes/`)
 * is RE-SEEDED whenever the bundle changed (a build-time content
 * fingerprint drives it), so a rebuilt shell reaches an existing profile
 * without a manual mirror.
 */

/** Filenames at the romfs root that the seeder must NEVER mirror to
 * the SD card. `main.js` + `main.js.map` are the runtime bundle — they
 * live INSIDE the NRO and are read by nxjs at boot, not by the resource
 * loader, so copying them to sdmc would just produce a stale duplicate.
 * `GeistMono.ttf` + `runtime.js.map` are fat-base artifacts merged into
 * `romfs:/` by @nx.js/nro (see nxjs-extended/packages/nro/src/main.ts).
 * They're read at runtime from the separate `nxjs:` mount
 * (`romfsMountSelf("nxjs")` in main.cc) — the terminal font from
 * `nxjs:/GeistMono.ttf`, the source map from `nxjs:/runtime.js.map`. The
 * `romfs:/`-rooted copies are never referenced, so mirroring them to
 * sdmc is dead weight. */
const SEED_SKIP_ROOT_FILES: ReadonlySet<string> = new Set([
	'main.js',
	'main.js.map',
	'GeistMono.ttf',
	'runtime.js.map',
	// The build's app-owned fingerprint (scripts/gen-seed-fingerprint.sh) is
	// read from romfs:/ directly by the versioned seeder and tracked via a
	// separately-written profile marker — never mirrored to the profile as-is.
	'seed-fingerprint',
	// The generic forwarder stub is read from romfs:/forwarder-stub.nro directly
	// by the on-device forwarder generator (FORWARDER_CONTRACT.md / I8). Mirroring
	// it to the SD card would leave a stale, missing-only copy after self-updates;
	// keeping it NRO-only makes it auto version-locked to the runtime.
	'forwarder-stub.nro',
]);

/** Romfs subtrees the seeder must NOT recurse into. Each entry is a
 * directory path relative to `romfs:/` with a trailing slash.
 *
 * `emojis/` is the 1870-PNG Twemoji asset bundle. Live-layout/live-overlay
 * read these directly via `romfs:/emojis/<codepoint>.png` through
 * `LocalSchemeFetchLoader` — there's no reason to copy ~10 MB of PNGs
 * onto the SD card on first launch. Skipping keeps cold-start fast and
 * keeps the user's profile dir tidy. */
const SEED_SKIP_DIRS: ReadonlySet<string> = new Set([
	'emojis/',
]);

export class BrowserProfile implements StorageProfileLike {
	readonly name: string;
	/** Per-profile storage: seeded pages (home.html etc.) sit flat
	 * at the root, plus `assets/` and per-origin dirs. */
	readonly storageRoot: string;
	/** App-level storage shared across profiles. Layout:
	 *   - `configs/` → all persisted JSON state (config, catalogue,
	 *     bookmarks, search_engines, warnings, history.jsonl).
	 *   - `themes/` → `toolbars/`, `keyboards/`, `styles/` plus their
	 *     three registry JSONs.
	 *   - `logs/` → runtime log files.
	 *   - `apps/` → installed apps under `<group>/<id>/...`. */
	readonly appRoot: string;

	constructor(name = 'shell', profileRoot = DEFAULT_PROFILE_ROOT, appRoot = BREWSER_APP_ROOT) {
		this.name = name;
		this.storageRoot = `${profileRoot}${name}/`;
		this.appRoot = appRoot;
	}

	/** Returns the absolute file path for the (app-level) history journal.
	 * Lives under `configs/` alongside the other persisted JSON state. */
	historyPath(): string {
		return `${this.appRoot}configs/history.jsonl`;
	}

	/** Returns the absolute file path for the (app-level) bookmarks file.
	 * Lives under `configs/` alongside the other JSON config files. */
	bookmarksPath(): string {
		return `${this.appRoot}configs/bookmarks.json`;
	}

	/** Per-origin path inside this profile (used by future cookie/local-storage stores). */
	pathForOrigin(origin: string): string {
		return storagePathForOrigin(origin, this.storageRoot);
	}

	/** Pick the storage namespace for a page URL. Implements
	 * {@link StorageProfileLike} so the runtime's `installLocalStorage`
	 * / `installIndexedDB` can route brewser:// dev pages into a
	 * sandboxed `dev/` subdir without runtime code knowing about the
	 * `brewser://dev/` URL convention. */
	pickStorageNamespace(currentUrl: string): string {
		return currentUrl.startsWith('brewser://dev/') ? 'dev' : 'default';
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
		// All app-level JSON config files (config / catalogue / bookmarks /
		// search_engines / warnings) consolidated under `configs/` 2026-06-14.
		try { Switch.mkdirSync(`${this.appRoot}configs/`); } catch (_) { /* exists */ }
		// All theme assets (toolbars/ + keyboards/ + styles/ + their
		// registry JSONs) consolidated under `themes/` 2026-06-14.
		try { Switch.mkdirSync(`${this.appRoot}themes/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}themes/toolbars/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}themes/keyboards/`); } catch (_) { /* exists */ }
		try { Switch.mkdirSync(`${this.appRoot}themes/styles/`); } catch (_) { /* exists */ }
		// `apps/` itself is intentionally NOT pre-created here. Apps live
		// in arbitrary subtrees (e.g. `apps/<channel>/<reverse-dns>/...`)
		// that are deployed via robocopy; the structure changes over time
		// and the shell must not assume any particular shape.
	}

	/** Absolute SD-card path to a seeded HTML page. The browser's
	 * resource loader resolves `brewser://X/Y/` to `<storageRoot>X/Y.html`.
	 * Centralised so the on-disk layout lives in one place. */
	pagePath(filename: string): string {
		return `${this.storageRoot}${filename}`;
	}

/** Absolute SD-card path to a seeded asset. Used by the chrome
	 * code to construct `Image.src` URLs for toolbar icons. */
	assetPath(filename: string): string {
		return `${this.storageRoot}assets/${filename}`;
	}

	/** Absolute SD-card path to the (app-level) `themes/toolbars.json` —
	 * the registry of available toolbar designs the shell reads at launch.
	 * The active toolbar lives at one of the paths the registry
	 * references (typically `themes/toolbars/<name>.json`). */
	toolbarsRegistryPath(): string {
		return `${this.appRoot}themes/toolbars.json`;
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

	/** Absolute SD-card path to a seeded toolbar HTML file. Resolves
	 * the `toolbar` field from `config.json`
	 * (`themes/toolbars/<file>.html`) against the app-level root.
	 * Same absolute-scheme passthrough as `keyboardPath`. The shell
	 * parses this file once at boot into a scoped live root that the
	 * engine paints into the chrome strip area every frame. */
	toolbarPath(rel: string): string {
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
	 * Synchronously seed `configs/config.json` from romfs BEFORE the async
	 * {@link seedRomfs} walk runs.
	 *
	 * The shell reads `config.json` in the `BrowserShell` *constructor* — for
	 * the colour scheme, button mapping, splash timing, history cap, momentum,
	 * etc. — and the constructor runs BEFORE `run()` calls `seedRomfs`. On a
	 * fresh (un-seeded) profile that first read would miss the file and fall
	 * back to `DEFAULT_CONFIG`, so the very first launch rendered with the
	 * compiled defaults (LIGHT theme → white UI, engine-default button mapping)
	 * instead of the seeded `dark` config. The file only reached the SD card
	 * once `seedRomfs` ran later in `run()`, so the *second* launch — reading a
	 * now-present file — looked correct. This closes that window.
	 *
	 * Copying just this one small file synchronously (`Switch.readFileSync` /
	 * `writeFileSync` are both sync and support the `romfs:` scheme) fixes the
	 * ordering at the source without delaying the boot splash the way a
	 * synchronous full-tree seed would. Missing-only, exactly like `seedRomfs`:
	 * an existing (user-edited) `config.json` is never overwritten, and the
	 * later `seedRomfs` walk skips the file it now finds present — so there is
	 * no double write. A no-op on every launch after the first.
	 */
	seedConfigSync(): void {
		const target = `${this.appRoot}configs/config.json`;
		// Missing-only: never clobber a user-edited config, and let the later
		// seedRomfs walk skip it too. (`ensure()` has already created the
		// `configs/` dir by the time the shell constructor calls this, but
		// mkdir defensively so the method is safe to call in isolation.)
		if (fileExists(target)) return;
		try { Switch.mkdirSync(`${this.appRoot}configs/`); } catch (_) { /* exists */ }
		let bytes: ArrayBuffer | null;
		try {
			bytes = Switch.readFileSync('romfs:/configs/config.json');
		} catch (error) {
			console.debug(`[brewser] seedConfigSync read failed: ${error}`);
			return;
		}
		if (!bytes) return;
		try {
			Switch.writeFileSync(target, new Uint8Array(bytes));
		} catch (error) {
			console.debug(`[brewser] seedConfigSync write failed: ${error}`);
		}
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
	 *
	 * Note this also seeds the romfs `shell/` subtree into `<appRoot>shell/`
	 * — which IS the per-profile `storageRoot`, since `DEFAULT_PROFILE_ROOT`
	 * collapsed to match `BREWSER_APP_ROOT` 2026-06-12 (see browser-config.ts).
	 * So one walker covers both the per-profile chrome pages AND the
	 * app-level toolbars / keyboards / styles in one pass.
	 */
	async seedRomfs(): Promise<void> {
		const embedded = await this.readRomfsFingerprint();
		const stored = this.readStoredFingerprint();
		// Re-seed app-owned files (shell/ + themes/) when the bundle's
		// fingerprint differs from what we last wrote to this profile. On a
		// fresh profile `stored` is '' so this is true, but there is nothing to
		// overwrite yet — the walk is then identical to a first-run missing-only
		// seed. When the fingerprint is unavailable (`embedded === ''`, e.g. an
		// older bundle without the file) we keep the pure missing-only behavior,
		// so a missing marker never wipes anything.
		const forceApp = embedded !== '' && embedded !== stored;
		if (forceApp) {
			console.debug(`[brewser] seed: bundle changed (${stored || 'none'} → ${embedded}) — re-seeding shell/ + themes/`);
		}
		await this.seedRomfsDir('', forceApp);
		// Record the applied fingerprint so the next boot skips the re-seed
		// until the bundle changes again (an unchanged rebuild is then a no-op).
		if (forceApp) {
			this.writeStoredFingerprint(embedded);
		}
	}

	/** Content fingerprint of the app-owned romfs (shell/ + themes/) baked
	 * into the NRO at build time by `scripts/gen-seed-fingerprint.sh`. '' when
	 * the file is absent (older bundle / generation skipped) — callers then
	 * keep the missing-only behavior. */
	private async readRomfsFingerprint(): Promise<string> {
		try {
			const response = await fetch('romfs:/seed-fingerprint');
			if (!response.ok) return '';
			return (await response.text()).trim();
		} catch (_) {
			return '';
		}
	}

	/** The fingerprint last applied to THIS profile, or '' when it was never
	 * seeded by the versioned seeder (fresh profile / pre-upgrade). */
	private readStoredFingerprint(): string {
		try {
			const data = Switch.readFileSync(`${this.appRoot}seed-fingerprint`);
			if (!data) return '';
			return new TextDecoder().decode(data).trim();
		} catch (_) {
			return '';
		}
	}

	private writeStoredFingerprint(fingerprint: string): void {
		try {
			Switch.writeFileSync(`${this.appRoot}seed-fingerprint`, new TextEncoder().encode(fingerprint));
		} catch (error) {
			console.debug(`[brewser] failed to write seed fingerprint: ${error}`);
		}
	}

	/** Recursive worker for `seedRomfs`. `rel` is the path under `romfs:/`
	 * (no leading slash, trailing slash for non-root directories — the empty
	 * string is the romfs root). `forceApp` overwrites existing app-owned files
	 * (shell/ + themes/, per `isAppOwnedRel`); every other file stays
	 * missing-only. */
	private async seedRomfsDir(rel: string, forceApp: boolean): Promise<void> {
		const src = `romfs:/${rel}`;
		const dst = `${this.appRoot}${rel}`;
		try { Switch.mkdirSync(dst); } catch (_) { /* exists */ }
		let iteratorErr: unknown = null;
		try {
			for await (const entry of Switch.readDir(src)) {
				if (entry.isDirectory) {
					const childRel = `${rel}${entry.name}/`;
					if (SEED_SKIP_DIRS.has(childRel)) continue;
					await this.seedRomfsDir(childRel, forceApp);
				} else if (entry.isFile) {
					if (rel === '' && SEED_SKIP_ROOT_FILES.has(entry.name)) continue;
					const childRel = `${rel}${entry.name}`;
					const target = `${this.appRoot}${childRel}`;
					// App-owned UI is overwritten on a bundle change; user data
					// (configs/, apps/, logs/, shell/auth/) stays missing-only.
					const overwrite = forceApp && isAppOwnedRel(childRel);
					if (!overwrite && fileExists(target)) continue;
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

/** App-owned romfs paths the versioned seeder may overwrite on a bundle
 * change: the shell UI (pages/scripts/assets) and the theme assets. The
 * runtime-created `shell/auth/` login store is explicitly excluded (it is not
 * shipped in romfs, but guard anyway), as are `configs/`, `apps/`, and
 * `logs/` — user data that is only ever seeded when missing. */
function isAppOwnedRel(rel: string): boolean {
	if (rel.startsWith('shell/auth/')) return false;
	return rel.startsWith('shell/') || rel.startsWith('themes/');
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
