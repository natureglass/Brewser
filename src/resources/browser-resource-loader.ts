import {
	notFoundResponse,
	RUNTIME_CONFIG_DEFAULTS,
	type ResourceLoader,
	type ResourceRequest,
} from '@switch-web/runtime';
import type { BookmarksStore } from '../navigation/bookmarks-store.js';
import type { HistoryStore } from '../navigation/history-store.js';
import { type AppEntry, buildLibraryPager, HOME_SECTIONS, type LibraryPager, type LibraryTabRender, loadBackgroundRegistry, loadConfig, loadKeyboardRegistry, loadSearchEngines, loadStyleRegistry, loadToolbarRegistry, MISSING_APP_LOGO_URL, pagerPageEntries, pagerTabRender, pagerTotalPages, resolveSearchEngine } from '../profile/browser-toolbar.js';
import type { LibraryTabId } from '@switch-web/runtime';

/**
 * Serves the browser's built-in pages.
 *
 * All `brewser://` pages live on disk under the profile directory and
 * the loader reads them on demand — see `BrowserProfile.seedRomfs()`
 * for how they get there.
 *
 * Two URL shapes are recognised:
 *   - Directory / page URLs: `brewser://X/Y/` → tries
 *     `pages/X/Y.html` first, then `pages/X/Y/index.html`. Content-type
 *     is always `text/html`. Custom tags (`<browser-bookmarks>`,
 *     `<browser-history>`, `<browser-toolbars>`,
 *     `<browser-featured>` / `<browser-community>` /
 *     `<browser-experimental>`, `<browser-search>`) are expanded
 *     server-side before the response is returned.
 *   - Static asset URLs: `brewser://X/Y/assets/main.js` →
 *     `pages/X/Y/assets/main.js` with a MIME type derived from the
 *     extension. Used by demo pages that ship their own JS / CSS /
 *     image assets alongside an `index.html`.
 *
 * Path segments are locked to `[a-z][a-z0-9._-]*` (case-insensitive)
 * with the dot only allowed in the static-asset filename position, so
 * a malformed URL can't escape the profile dir.
 *
 * After reading an HTML file the loader scans for custom tags and
 * substitutes a rendered list / form:
 *   `<browser-bookmarks limit="N">` → most-recently-added bookmarks
 *   `<browser-history   limit="N">` → most-recent visits
 *   `<browser-toolbars>`            → entries from `toolbars.json`
 *   `<browser-featured>`            → cards from `catalogue.json`'s `featured`
 *   `<browser-community>`           → cards from `catalogue.json`'s `community`
 *   `<browser-experimental>`        → cards from `catalogue.json`'s `experimental`
 *   `<browser-search>`              → search bar for the active engine
 * Substitution is a plain text replace, so authors can place the tags
 * anywhere in the document, wrap them in containers, or restyle the
 * resulting markup via the page's own CSS.
 */

const decoder = new TextDecoder();
// Directory + path segments allow letters, digits, hyphen, and
// underscore — including AS THE FIRST CHARACTER for all three:
//   - letters: ordinary names (`apps`, `assets`)
//   - underscore: Cocos Creator output (`_virtual_cc-<hash>.js`) and
//     many bundlers' "internal" file conventions
//   - digits: Cocos Creator's UUID-based asset layout
//     (`assets/<bundle>/import/<2hex>/<uuid>.json`, where both the
//     `<2hex>` directory and the `<uuid>.json` filename can start with
//     0-9; pvzge hit a 404 on `import/05/05bb483a0.json`
//     until digits were added to the leading-char class here)
// FILE_SEGMENT additionally allows `@` interior characters because
// Cocos Creator's native asset files encode atlas/variant identifiers
// inline (`<uuid>@<atlas_chunk>@<frame_hash>.png` for sprite atlases —
// pvzge's resources bundle has files like
// `6f01cf7f-81bf-...@b47c0@e9a6d.png`). DIR_SEGMENT/PATH_PATTERN do not
// need `@` since directories never use it in Cocos's layout.
// DIR_SEGMENT also allows INTERIOR `.` so reverse-DNS directory names
// (`apps/featured/com.natureglass.spectraplay/...`) resolve. The `..`
// directory-escape defense stays intact because it relies on the
// first-character class `[a-z0-9_]` — `..` (and `.`, `.git`, `...`)
// all start with `.` which is not a valid first char.
const DIR_SEGMENT = /^[a-z0-9_][a-z0-9._-]*$/i;
const FILE_SEGMENT = /^[a-z0-9_][a-z0-9.@_-]*$/i;
const PATH_PATTERN = /^[a-z0-9_][a-z0-9._-]*(?:\/[a-z0-9_][a-z0-9._-]*)*$/i;

/** Recognised static-asset MIME types keyed by extension (lowercase). */
const MIME_BY_EXT: Record<string, { mime: string; binary: boolean }> = {
	js: { mime: 'text/javascript; charset=utf-8', binary: false },
	mjs: { mime: 'text/javascript; charset=utf-8', binary: false },
	css: { mime: 'text/css; charset=utf-8', binary: false },
	json: { mime: 'application/json; charset=utf-8', binary: false },
	txt: { mime: 'text/plain; charset=utf-8', binary: false },
	html: { mime: 'text/html; charset=utf-8', binary: false },
	htm: { mime: 'text/html; charset=utf-8', binary: false },
	png: { mime: 'image/png', binary: true },
	jpg: { mime: 'image/jpeg', binary: true },
	jpeg: { mime: 'image/jpeg', binary: true },
	gif: { mime: 'image/gif', binary: true },
	webp: { mime: 'image/webp', binary: true },
	svg: { mime: 'image/svg+xml; charset=utf-8', binary: false },
	obj: { mime: 'text/plain; charset=utf-8', binary: false },
	mtl: { mime: 'text/plain; charset=utf-8', binary: false },
	bin: { mime: 'application/octet-stream', binary: true },
	gltf: { mime: 'model/gltf+json; charset=utf-8', binary: false },
	glb: { mime: 'model/gltf-binary', binary: true },
	// Stanford PLY (`Lucy100k.ply` etc.) — Three's PLYLoader fetches via
	// FileLoader with `arraybuffer` response type; both ASCII and binary
	// variants land here (loader sniffs the header). No registered MIME
	// for PLY; `application/octet-stream` matches the binary=true path.
	ply: { mime: 'application/octet-stream', binary: true },
	// Collada (`elf.dae` etc.) — Three's ColladaLoader fetches via
	// FileLoader as text, then parses the XML with DOMParser. Registered
	// MIME per Khronos is `model/vnd.collada+xml`, but `application/xml`
	// is universally accepted and matches the text-parsing path.
	dae: { mime: 'application/xml; charset=utf-8', binary: false },
	hdr: { mime: 'image/vnd.radiance', binary: true },
	nrrd: { mime: 'application/octet-stream', binary: true },
	// WebAssembly binary. Content-type MUST be `application/wasm`
	// (spec requirement) so `WebAssembly.instantiateStreaming(fetch(...))`
	// doesn't reject with "incorrect response MIME type". Slice 8 of
	// `dev/wasm-probe.html` is exactly this code path; without this
	// entry, the streaming-instantiate path that Unity/Godot/Emscripten
	// exports default to silently breaks even when raw WASM works.
	wasm: { mime: 'application/wasm', binary: true },
	// Unity WebGL data archive (`data.data`, "UnityWebData1.0" packed
	// scenes/resources/StreamingAssets). Unity's `createUnityInstance`
	// fetches it via `readAsync` alongside `code.wasm`/`framework.js`.
	// Without a MIME entry, `classifyUrl` returns null for the unknown
	// `.data` extension and the request 404s — and Unity's loader does
	// NOT check the HTTP status, so it feeds the "Not found: brewser://…"
	// 404 body into the runtime as if it were the archive, which either
	// hangs the load (WebGL1/older loaders) or throws "Unknown data
	// format" (WebGL2/newer). Binary octet-stream (Unity reads it as an
	// arrayBuffer; it doesn't require a specific content-type the way
	// `WebAssembly.instantiateStreaming` requires `application/wasm`).
	data: { mime: 'application/octet-stream', binary: true },
	mp3: { mime: 'audio/mpeg', binary: true },
	ogg: { mime: 'audio/ogg', binary: true },
	wav: { mime: 'audio/wav', binary: true },
	m4a: { mime: 'audio/mp4', binary: true },
	flac: { mime: 'audio/flac', binary: true },
	mp4: { mime: 'video/mp4', binary: true },
	webm: { mime: 'video/webm', binary: true },
	ttf: { mime: 'font/ttf', binary: true },
	otf: { mime: 'font/otf', binary: true },
	woff: { mime: 'font/woff', binary: true },
	woff2: { mime: 'font/woff2', binary: true },
	// Cocos Creator binary asset payloads. `.cconb` is the
	// "cocos creator object binary" serialized scene/prefab/component
	// format; pvzge's scene streamer fetches one each time the player
	// transitions into a level (PLAY button → freeze on 404 without this).
	// Pvzge also ships ASTC / PKM (ETC1/ETC2) / PVR compressed texture
	// payloads alongside its PNGs; adding them preemptively avoids the next
	// resource-loading freeze if Cocos opts into a compressed path.
	cconb: { mime: 'application/octet-stream', binary: true },
	astc: { mime: 'image/x-astc', binary: true },
	pkm: { mime: 'image/x-pkm', binary: true },
	pvr: { mime: 'application/octet-stream', binary: true },
	// Zip archives — Three.js's webgl_texture2darray demo streams a
	// zipped volumetric-data payload via FileLoader + fflate.unzipSync;
	// same code path applies to any demo that packs multi-slice / multi-
	// asset data into a single .zip. Binary + application/zip MIME.
	zip: { mime: 'application/zip', binary: true },
	// OpenEXR HDR (`piz_compressed.exr` etc.) — Three's EXRLoader fetches
	// this via FileLoader; add here so the loader doesn't reject it as
	// an "unknown brewser:// page". Binary application/octet-stream MIME
	// (no standardised registered MIME for EXR).
	exr: { mime: 'application/octet-stream', binary: true },
};

/** Inline right-pointing arrow painted between the installed + catalog
 * versions in the upgrade chip. Drawn as a single polygon (shaft +
 * arrowhead silhouette) inside a 14×10 viewBox; `live-overlay.ts`
 * paintLiveSvg scales the viewBox into the SVG element's layout box
 * each frame. Hardcoded fill matches the chip's `#0b1220` text color
 * so the arrow tracks visually with the surrounding "v1.0.0" /
 * "v1.0.1" labels. Kept module-level so the same markup is reused by
 * every upgrade card without re-stringifying. */
const UPGRADE_ARROW_SVG =
	'<svg class="upgrade-arrow" viewBox="0 0 14 10" width="14" height="10">'
	+ '<polygon points="0,4 8,4 8,1 14,5 8,9 8,6 0,6" fill="#0b1220"/>'
	+ '</svg>';

export interface BrowserResourceLoaderOptions {
	/** Per-profile root for `pages/` lookups. */
	storageRoot: string;
	/** App-level root for `loadCatalogGroup` / `loadConfig` / `loadSearchEngines` / `loadToolbarRegistry`. */
	appRoot: string;
	bookmarksStore: BookmarksStore;
	historyStore: HistoryStore;
}

export class BrowserResourceLoader implements ResourceLoader {
	private readonly storageRoot: string;
	private readonly appRoot: string;
	private readonly bookmarksStore: BookmarksStore;
	private readonly historyStore: HistoryStore;
	/** Parsed + sorted library from the most recent apps.html / home render,
	 * retained so the `__brewserAppsPager` hook can render pages 2…N on demand
	 * without re-parsing the catalogue (see `expandCustomTags`). Refreshed on
	 * every render that touches a library tag; null before the first one. */
	private pagerData: LibraryPager | null = null;
	private pagerPerPage = 12;

	constructor(options: BrowserResourceLoaderOptions) {
		this.storageRoot = options.storageRoot;
		this.appRoot = options.appRoot;
		this.bookmarksStore = options.bookmarksStore;
		this.historyStore = options.historyStore;
		this.installAppsPagerHook();
	}

	/** Install the client-side pagination bridge on `globalThis`. apps.html's
	 * `apps-pagination.js` reads it (same shared JS context as the shell, the
	 * way `__brewserPlatformClient` etc. are shared) to render pages 2…N of a
	 * library tab on demand — the shell already holds the parsed, sorted
	 * catalogue (`pagerData`), so a page render is a slice + map of just
	 * ~maxPerPage cards, never a re-parse. Returns '' / 1 until a library page
	 * has been served (which populates `pagerData`). */
	private installAppsPagerHook(): void {
		const self = this;
		Reflect.set(globalThis, '__brewserAppsPager', {
			perPage(): number {
				return self.pagerPerPage;
			},
			totalPages(tab: string): number {
				return self.pagerData
					? pagerTotalPages(self.pagerData, tab as LibraryTabId | 'myapps' | 'favorites' | 'downloads', self.pagerPerPage)
					: 1;
			},
			render(tab: string, page: number): string {
				if (!self.pagerData) return '';
				return renderAppCards(
					pagerPageEntries(self.pagerData, tab as LibraryTabId | 'myapps' | 'favorites' | 'downloads', page, self.pagerPerPage),
				);
			},
		});
	}

	canLoad(request: ResourceRequest): boolean {
		return request.url.startsWith('brewser://');
	}

	/** Decide whether a `brewser://`-derived `<rel>` reads from the
	 * app-level `apps/` tree (shared across profiles) or the per-profile
	 * flat content root. The `apps.html` launcher does NOT start with
	 * `apps/`, so it correctly stays at `<storageRoot>apps.html`;
	 * `apps/<rest>` (where `<rest>` is non-empty) goes to the app root.
	 * `dev/` routing was removed 2026-06-13 alongside the romfs purge. */
	private resolveContentPath(rel: string): string {
		if (rel.startsWith('apps/')) return `${this.appRoot}${rel}`;
		return `${this.storageRoot}${rel}`;
	}

	async load(request: ResourceRequest): Promise<Response> {
		const canonical = canonicalUrl(request.url);
		const classification = classifyUrl(canonical);

		// DIAGNOSTIC PROBE (TEMP) — log every PNG request so we can see
		// where Image.src calls land. Filter to .png to keep log volume
		// sane across asset-heavy apps like pvzge.
		const isPng = /\.png(?:\?|#|$)/i.test(request.url);
		if (isPng) {
			const cls = classification ? classification.kind : 'null';
			const rel = classification?.kind === 'static' ? classification.relPath : '<n/a>';
			console.debug(`[brewser:img-probe] url=${request.url} cls=${cls} rel=${rel}`);
		}

		if (classification?.kind === 'static') {
			// Style picker: serve the file named by `config.brewserStyle`
			// (e.g. `<appRoot>styles/dark.css`) in place of the baked
			// `<storageRoot>assets/main.css` so every built-in page's
			// `<link rel="stylesheet" href="brewser://assets/main.css">`
			// loads the chosen sheet. Missing / unreadable falls back to
			// the seeded asset path below — a broken style pointer can't
			// blank the chrome.
			if (classification.relPath === 'assets/main.css') {
				// 2026-06-16: stylesheet architecture is themes-only. Each
				// theme under `<appRoot>themes/styles/` is a complete,
				// self-contained stylesheet — there is no base
				// `shell/assets/main.css` to fall back to or concat with.
				// Adding a new selector means editing the relevant theme
				// file(s). Read `config.brewserStyle` and serve that
				// theme's bytes verbatim; if the field is missing or the
				// file is unreadable, default to `themes/styles/dark.css`
				// so the page always has SOME stylesheet (a broken style
				// pointer can't blank the chrome).
				const styleRel = loadConfig(this.appRoot).brewserStyle
					|| 'themes/styles/dark.css';
				const stylePath = /^(?:sdmc:|romfs:)\/\//.test(styleRel)
					? styleRel
					: `${this.appRoot}${styleRel}`;
				try {
					const styleData = Switch.readFileSync(stylePath);
					if (styleData) {
						return new Response(decoder.decode(styleData), {
							status: 200,
							headers: { 'content-type': classification.mime },
						});
					}
				} catch (_) { /* fall through to the default-theme attempt */ }
				if (styleRel !== 'themes/styles/dark.css') {
					try {
						const defaultPath = `${this.appRoot}themes/styles/dark.css`;
						const defaultData = Switch.readFileSync(defaultPath);
						if (defaultData) {
							return new Response(decoder.decode(defaultData), {
								status: 200,
								headers: { 'content-type': classification.mime },
							});
						}
					} catch (_) { /* fall through to 404 */ }
				}
				// Neither configured theme nor default readable — fall
				// through to the 404 below (chrome won't have styles, but
				// page will still render).
			}
			try {
				const resolvedPath = this.resolveContentPath(classification.relPath);
				if (isPng) {
					console.debug(`[brewser:img-probe] readFile path=${resolvedPath}`);
				}
				const data = Switch.readFileSync(resolvedPath);
				if (data) {
					if (isPng) {
						console.debug(`[brewser:img-probe] readFile OK size=${data.byteLength}`);
					}
					const body = classification.binary
						? data
						: decoder.decode(data);
					return new Response(body, {
						status: 200,
						headers: { 'content-type': classification.mime },
					});
				}
				if (isPng) {
					console.debug(`[brewser:img-probe] readFile returned falsy data`);
				}
			} catch (e) {
				// Missing file falls through to the 404 below.
				if (isPng) {
					console.debug(`[brewser:img-probe] readFile threw: ${String((e as Error)?.message || e)}`);
				}
			}
		} else if (classification?.kind === 'html') {
			// Try each candidate in order: `pages/X/Y.html` first, then
			// `pages/X/Y/index.html`. This lets a demo with its own
			// folder of assets live at `pages/X/Y/index.html` alongside
			// `pages/X/Y/assets/...` without colliding with the
			// existing single-file-per-page convention used everywhere
			// else.
			for (const filename of classification.candidates) {
				try {
					const data = Switch.readFileSync(this.resolveContentPath(filename));
					if (data) {
						const html = this.expandCustomTags(decoder.decode(data));
						return new Response(html, {
							status: 200,
							headers: {
								'content-type': 'text/html; charset=utf-8',
								'x-browser-page': canonical,
							},
						});
					}
				} catch (_) {
					// Try the next candidate.
				}
			}
		}

		console.debug(`[brewser] unknown brewser:// page: ${request.url}`);
		return notFoundResponse(request.url);
	}

	/** Replace every `<browser-bookmarks>` / `<browser-history>` /
	 * `<browser-toolbars>` tag with a rendered `<ul>` (or an
	 * empty-state `<p>`). Pages without any of the tags fall through
	 * unchanged. */
	private expandCustomTags(html: string): string {
		// 2026-06-14: strip HTML comments BEFORE the custom-tag regexes run.
		// The author-side comments in `home.html` / `apps.html` reference the
		// literal `<browser-modal>` token (documenting why the tag exists);
		// without this strip, the modal expansion regex matches the
		// occurrence INSIDE the comment, swallowing the real modal's
		// `id` / `class` attrs into the captured body. The downstream
		// HTML parser (`html-to-live`) drops comments at parse time anyway,
		// so removing them here changes no rendered output — only the
		// custom-tag regexes' view of the source.
		let out = html.replace(/<!--[\s\S]*?-->/g, '');
		out = out.replace(
			/<browser-bookmarks(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-bookmarks\s*>)?/gi,
			(_match, attrs: string | undefined) => this.renderBookmarks(parseLimit(attrs), parseFormat(attrs)),
		);
		out = out.replace(
			/<browser-history(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-history\s*>)?/gi,
			(_match, attrs: string | undefined) => this.renderHistory(parseLimit(attrs) ?? 50),
		);
		out = out.replace(
			/<browser-toolbars(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-toolbars\s*>)?/gi,
			() => this.renderToolbars(),
		);
		out = out.replace(
			/<browser-keyboards(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-keyboards\s*>)?/gi,
			() => this.renderKeyboards(),
		);
		out = out.replace(
			/<browser-settings(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-settings\s*>)?/gi,
			() => this.renderSettings(),
		);
		out = out.replace(
			/<browser-settings-bookmarks-link(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-settings-bookmarks-link\s*>)?/gi,
			() => this.renderSettingsBookmarksLink(),
		);
		out = out.replace(
			/<browser-settings-login-link(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-settings-login-link\s*>)?/gi,
			() => this.renderSettingsLoginLink(),
		);
		out = out.replace(
			/<browser-search(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-search\s*>)?/gi,
			() => this.renderSearch(),
		);
		// The four browse tabs (Phase 4, mirroring the WP plugin):
		// Featured is a curation FILTER; Most Recent / Popular / Top
		// Rated are sorts. One `buildLibraryPager` call (memoized below)
		// feeds every tag on the page (single disk pass per render); a tab
		// whose driving data is absent renders unavailable with its reason —
		// sparse data hides a sort, it never fakes one.
		// Client-side pagination: parse + sort the library ONCE (held in
		// `pagerMemo`, then stashed for the `__brewserAppsPager` hook at the end
		// of this method) and server-render only PAGE 1 of each tab.
		// apps-pagination.js asks the hook for pages 2…N and swaps them into the
		// grid, so the live DOM only ever holds ~maxPerPage cards even for a
		// 10k-app catalogue. A tab whose driving data is absent still renders
		// unavailable with its reason — sparse data hides a sort, never fakes one.
		const perPage = loadConfig(this.appRoot).maxPerPage;
		let pagerMemo: LibraryPager | null = null;
		const pager = (): LibraryPager => (pagerMemo ??= buildLibraryPager(this.appRoot));
		const libraryTab = (id: LibraryTabId): string =>
			this.renderLibraryTab(pagerTabRender(pager(), id, perPage));
		out = out.replace(
			/<browser-tab-featured(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-tab-featured\s*>)?/gi,
			() => libraryTab('featured'),
		);
		out = out.replace(
			/<browser-tab-recent(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-tab-recent\s*>)?/gi,
			() => libraryTab('recent'),
		);
		out = out.replace(
			/<browser-tab-popular(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-tab-popular\s*>)?/gi,
			() => libraryTab('popular'),
		);
		out = out.replace(
			/<browser-tab-toprated(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-tab-toprated\s*>)?/gi,
			() => libraryTab('toprated'),
		);
		// "Downloads" - the local-install facet: every app physically present on
		// this SD card (`installed !== null`), the SAME disk truth that dims
		// not-installed cards. Unlike My Apps / Favorites it needs no signed-in
		// document, so it is ALWAYS rendered (its view is never null); an empty
		// install set falls through to renderLibraryTab's plain empty state.
		out = out.replace(
			/<browser-tab-downloads(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-tab-downloads\s*>)?/gi,
			() => this.renderLibraryTab(pagerTabRender(pager(), 'downloads', perPage)),
		);
		// "My Apps" (per-user) — a SEPARATE cached document
		// (`configs/my-catalogue.json`, the WordPress-generated set of the
		// signed-in user's own apps), carried on `pager().myApps`. Both the tab's
		// label and its panel render only when that document exists and parses;
		// otherwise both collapse to '' so the facet is absent for signed-out
		// users and before the first fetch.
		out = out.replace(
			/<browser-tab-myapps(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-tab-myapps\s*>)?/gi,
			() => (pager().myApps ? this.renderLibraryTab(pagerTabRender(pager(), 'myapps', perPage)) : ''),
		);
		// The tab's clickable label — present only when the panel is (i.e. the
		// user has a cached my-catalogue). Keeps the CSS-radio tab unreachable
		// (no `<label for>`) when there is nothing to show.
		out = out.replace(
			/<browser-myapps-label(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-myapps-label\s*>)?/gi,
			() => (pager().myApps ? '<label for="apps-tab-myapps" class="tab-label">My Apps</label>' : ''),
		);
		// `<browser-tab-favorites>` — the standalone favorites.html grid, rendered
		// from `configs/favorites.json` (the WordPress-generated set of the
		// signed-in user's favorited apps) via the SAME
		// parseCatalogue → joinLibrary → renderAppCards path as My Apps, so the
		// cards, `data-app-detail` contract, lazy banners and pagination are all
		// shared. Calling `pager()` also stashes `pagerData`, so the client
		// `__brewserAppsPager` hook can render favorites pages 2…N. A missing /
		// unparseable document yields a neutral empty state (the page is normally
		// only reachable once a sync has written the file, but a direct
		// brewser://favorites/ nav must still render something sane).
		out = out.replace(
			/<browser-tab-favorites(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-tab-favorites\s*>)?/gi,
			() => (pager().favorites
				? this.renderLibraryTab(pagerTabRender(pager(), 'favorites', perPage))
				: '<p class="empty">No favorites synced yet. Sign in and press Check for Updates on the Apps page.</p>'),
		);
		// `<browser-config-catalogue>` — expands to the active
		// `config.json` `catalogue` URL, HTML-escaped so it's safe inside
		// either an attribute or text content. Empty string when no URL
		// is configured; consumers (apps.html's Check-for-Updates button)
		// branch on the empty case to show an error instead of fetching.
		out = out.replace(
			/<browser-config-catalogue(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-catalogue\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).catalogue),
		);
		// `<browser-config-stats>` — expands to the strict-pinned
		// `stats.json` URL (C2 operational counters). Fetched by the
		// Check-for-Updates flow alongside the catalogue; per-app
		// artifact URLs are NOT config anymore — they come from the
		// normalized catalogue via the platform bridge.
		out = out.replace(
			/<browser-config-stats(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-stats\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).stats),
		);
		// `<browser-config-downloads>` / `<browser-config-ratings>` —
		// expand to the active `config.json` `downloads` / `ratings`
		// URLs. Stamped onto the apps.html Check-for-Updates button as
		// `data-downloads-url` / `data-ratings-url` so updates-modal.js
		// can fetch them alongside the catalogue and replace the
		// local copies under `<appRoot>configs/`. Empty when no URL is
		// configured; the modal skips the refresh in that case and
		// leaves the on-disk file untouched.
		out = out.replace(
			/<browser-config-downloads(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-downloads\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).downloads),
		);
		out = out.replace(
			/<browser-config-ratings(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-ratings\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).ratings),
		);
		// `<browser-config-versions>` — expands to the bundled-runtime
		// `versions` URL. Stamped onto the apps.html Check-for-Updates
		// button as `data-versions-url` so updates-modal.js can download
		// `versions.json` alongside the catalogue, persist it under
		// `<appRoot>configs/versions.json`, and compare it field-by-field
		// against the seeded `<appRoot>configs/current.json` baseline.
		// Read directly from `RUNTIME_CONFIG_DEFAULTS` rather than via
		// `loadConfig` — versions is the one strict-pinned URL that
		// isn't surfaced through `BrowserConfig` since nothing on the
		// engine side consumes it (the page-script is the only reader),
		// so threading it through the config interface would be dead
		// indirection.
		out = out.replace(
			/<browser-config-versions(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-versions\s*>)?/gi,
			() => htmlEscape(RUNTIME_CONFIG_DEFAULTS.versions),
		);
		// `<browser-config-my-catalogue>` — expands to the strict-pinned
		// WordPress "My Apps" endpoint. Stamped onto the apps.html "Fetch my
		// Apps" button as `data-my-catalogue-url` so my-apps.js can fetch the
		// signed-in user's own apps (with their Bearer session token) and write
		// the result to `<appRoot>configs/my-catalogue.json`. Read straight from
		// `RUNTIME_CONFIG_DEFAULTS` — like `versions`, it's a page-script-only
		// consumer, so threading it through `BrowserConfig` would be dead
		// indirection.
		out = out.replace(
			/<browser-config-my-catalogue(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-my-catalogue\s*>)?/gi,
			() => htmlEscape(RUNTIME_CONFIG_DEFAULTS.myCatalogue),
		);
		// `<browser-config-favorites>` / `<browser-config-achievements>` — expand
		// to the strict-pinned WordPress per-user Favorites / Achievements
		// endpoints. Stamped onto the apps.html Check-for-Updates button as
		// `data-favorites-url` / `data-achievements-url` so updates-modal.js can
		// fetch them (with the user's Bearer token) alongside the catalogue and
		// write `configs/favorites.json` + `configs/my-achievements.json`. Read
		// straight from `RUNTIME_CONFIG_DEFAULTS` — page-script-only consumers,
		// like `versions` / `myCatalogue`.
		out = out.replace(
			/<browser-config-favorites(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-favorites\s*>)?/gi,
			() => htmlEscape(RUNTIME_CONFIG_DEFAULTS.favorites),
		);
		out = out.replace(
			/<browser-config-achievements(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-achievements\s*>)?/gi,
			() => htmlEscape(RUNTIME_CONFIG_DEFAULTS.achievements),
		);
		// `<browser-account-links>` — the extra Favorites / Achievements nav
		// links on the Google account page (googleLogin.html), each emitted ONLY
		// when its per-user document exists on disk. Independent per-file gating:
		// Favorites needs `configs/favorites.json`, Achievements needs
		// `configs/my-achievements.json`. A signed-out user — or one who hasn't
		// run Check-for-Updates yet — has neither file and so sees just Home.
		out = out.replace(
			/<browser-account-links(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-account-links\s*>)?/gi,
			() => this.renderAccountLinks(),
		);
		// `<browser-config-telemetry>` — expands to the strict-pinned
		// `config.telemetry` URL (runtime-bundled per
		// `@switch-web/runtime` `RUNTIME_CONFIG_DEFAULTS`). Stamped onto
		// `<body data-telemetry-url>` of apps.html / home.html so
		// missing-app-modal.js can read it from the DOM instead of
		// fetching `configs/config.json` (which no longer carries the
		// field anyway — the runtime value is authoritative).
		out = out.replace(
			/<browser-config-telemetry(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-telemetry\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).telemetry),
		);
		// `<browser-config-warnings>` — expands to the active
		// `config.warnings` array joined as a comma-separated string
		// (e.g. `"low,medium,high"` or `"medium,high"` or empty when the
		// user disabled every severity). Stamped onto
		// `<body data-warnings>` of apps.html / home.html so
		// warnings-modal.js reads the user's severity gate synchronously
		// at script load — same DOM-attribute pattern the telemetry URL
		// and OAuth client IDs use. Synchronous read removes the
		// fetch-vs-tap race the prior `globalThis.fetch('configs/config.json')`
		// path was exposed to.
		out = out.replace(
			/<browser-config-warnings(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-warnings\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).warnings.join(',')),
		);
		// `<browser-config-maxperpage>` — expands to the active
		// `config.maxPerPage` (already clamped by `loadConfig`). Stamped onto
		// `<body data-max-per-page>` of apps.html / home.html so
		// `apps-pagination.js` + `banner-loader.js` read the page size
		// synchronously at load — same DOM-attribute pattern the telemetry URL
		// and warnings gate use. Client-side pagination + lazy banner loading
		// key off this value.
		out = out.replace(
			/<browser-config-maxperpage(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-maxperpage\s*>)?/gi,
			() => htmlEscape(String(loadConfig(this.appRoot).maxPerPage)),
		);
		// `<browser-config-<provider>-client-id>` family — expands to
		// the matching `config.json` `<provider>OAuthClientId` value,
		// HTML-escaped. Stamped onto each provider's login page <body>
		// as `data-<provider>-client-id` so the per-provider auth.js
		// can read it without re-parsing config.json from the page.
		// Empty string / "REPLACE_ME" when the user hasn't configured
		// the provider; each auth script branches on those and shows
		// the misconfiguration stage instead of starting the flow.
		out = out.replace(
			/<browser-config-microsoft-client-id(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-microsoft-client-id\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).microsoftOAuthClientId),
		);
		out = out.replace(
			/<browser-config-google-client-id(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-google-client-id\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).googleOAuthClientId),
		);
		out = out.replace(
			/<browser-config-google-client-secret(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-google-client-secret\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).googleOAuthClientSecret),
		);
		// `<browser-home-apps>` — the home grid renders the library tab
		// named by `config.json homeSection` (featured / recent /
		// popular / toprated). Shares the page-render memo above.
		out = out.replace(
			/<browser-home-apps(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-home-apps\s*>)?/gi,
			// Home is a single-page teaser: render only page 1 of the configured
			// section (banners promoted by banner-loader.js in "auto" mode) — the
			// full paginated grid lives on apps.html. Shares the same `pager()`
			// parse as the library tags above (one disk pass per render).
			() => this.renderLibraryTab(pagerTabRender(pager(), loadConfig(this.appRoot).homeSection, perPage)),
		);
		// `<browser-home-title>` — display name of the currently-
		// selected home section ("Featured Apps", "Community Apps",
		// "Experimental Apps"). Sits in the home page's section header
		// so the title tracks the radio selection.
		out = out.replace(
			/<browser-home-title(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-home-title\s*>)?/gi,
			() => htmlEscape(homeSectionTitle(loadConfig(this.appRoot).homeSection)),
		);
		// `<browser-config-homesection>` — the RAW home section id
		// (featured / recent / popular / toprated). Stamped onto the archived
		// home_archived.html's grid panel as `data-tab` so `apps-pagination.js`
		// treats it as a paginated panel and asks the `__brewserAppsPager` hook
		// for the right tab's pages. (home_archived.html has no tab radios, so
		// the pager script falls back to "always active" for a panel whose
		// `apps-tab-<id>` radio is absent — see its `isActive`.) The live Home
		// (brewser://home/, the former apps.html) DOES have tab radios and uses
		// `<browser-home-checked>` below instead.
		out = out.replace(
			/<browser-config-homesection(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-homesection\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).homeSection),
		);
		// `<browser-home-checked section="X"/>` — emits ` checked` on the tab
		// radio whose `section` matches `config.homeSection`, else ''. The Home
		// landing (brewser://home/, the former apps.html) places one of these on
		// each of its four sort radios so the page opens on the configured
		// section's tab with no client flash — the existing `#apps-tab-X:checked`
		// CSS reveals the matching panel from first paint. homeSection is
		// validated to one of the four sorts (see `loadConfig`), so exactly one
		// radio is stamped; "My Apps" is never a homeSection, so its radio is
		// never default-checked.
		// One-shot Home-tab override: a page script (download-modal.js after a
		// completed install) sets `globalThis.__brewserPendingHomeTab` right before
		// `__swbReload()` to make the reloaded Home open on a specific tab (e.g.
		// "downloads") instead of `config.homeSection`. Read-and-CLEAR on the first
		// tag so it applies to exactly ONE render (this reload); the next Home render
		// falls back to the configured section. Consumed only when the page actually
		// carries <browser-home-checked> tags (i.e. Home), so a sub-resource fetch
		// can't swallow it. Only known tab ids are honored.
		let homeCheckedSection: string | null = null;
		out = out.replace(
			/<browser-home-checked(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-home-checked\s*>)?/gi,
			(_match, attrs: string | undefined) => {
				if (homeCheckedSection === null) {
					const g = globalThis as { __brewserPendingHomeTab?: unknown };
					const pending = typeof g.__brewserPendingHomeTab === 'string' ? g.__brewserPendingHomeTab : '';
					if (g.__brewserPendingHomeTab !== undefined) delete g.__brewserPendingHomeTab;
					homeCheckedSection = (pending === 'featured' || pending === 'recent'
						|| pending === 'popular' || pending === 'toprated' || pending === 'downloads')
						? pending : loadConfig(this.appRoot).homeSection;
				}
				const m = attrs ? /\bsection\s*=\s*"([^"]*)"/i.exec(attrs) : null;
				const section = m ? m[1] : '';
				return homeCheckedSection === section ? ' checked' : '';
			},
		);
		// `<browser-modal id="…" class="…" ...>CONTENT</browser-modal>` —
		// the engine-blessed modal wrapper. Expanded to a `<div>` with
		// the `data-engine-modal="true"` stamp the live-DOM engine
		// recognises as a modal-layer root. The expansion:
		//   - preserves whatever attributes the author wrote (id, class,
		//     aria-*, data-*, role) so the page's CSS still matches
		//     (`.app-modal-overlay`, `.updates-modal-overlay`, etc.)
		//   - merges any author-supplied `style` with the engine's
		//     `position: fixed` hint (`collectPaintOps` reads the
		//     INLINE `style.position` to decide cache eligibility, so
		//     the inline hint must survive)
		//   - stamps `data-engine-modal="true"` (engine sees the
		//     attribute on attach via `propagateAttached` and registers
		//     the element as a modal root)
		// Self-closing form (`<browser-modal />`) is also accepted — yields
		// an empty modal root the page can fill later via innerHTML.
		// See the modal-layer block in live-paint-control.ts for the
		// full rationale.
		out = out.replace(
			/<browser-modal(\s+[^>]*)?\s*\/>|<browser-modal(\s+[^>]*)?\s*>([\s\S]*?)<\/browser-modal\s*>/gi,
			(_match, selfAttrs: string | undefined, openAttrs: string | undefined, body: string | undefined) => {
				const attrs = (selfAttrs ?? openAttrs ?? '').trim();
				const inner = body ?? '';
				return renderBrowserModal(attrs, inner);
			},
		);
		// Retain the parsed library for the `__brewserAppsPager` hook. Only set
		// when a library / home tag actually rendered (which called `pager()` and
		// populated `pagerMemo`); other pages leave the prior stash untouched —
		// harmless, since only apps.html's script calls the hook.
		if (pagerMemo) {
			this.pagerData = pagerMemo;
			this.pagerPerPage = perPage;
		}
		return out;
	}

	/** Render one library tab's cards (`.app-card` links — logo on top,
	 * then title + description) styled by main.css's `.app-grid` +
	 * `.app-card` rules. Unavailable tabs render their reason in the
	 * existing empty-state style — visible degradation, never a fake
	 * ordering. An *available but empty* tab (Featured with nothing
	 * curated) gets the plain empty state. */
	private renderLibraryTab(tab: LibraryTabRender): string {
		if (!tab.available) {
			return `<p class="empty">${htmlEscape(tab.reason)}</p>`;
		}
		if (tab.entries.length === 0) {
			return '<p class="empty">Nothing here yet — run Check for Updates to fetch the catalogue, or install apps under <code>apps/</code>.</p>';
		}
		// `tab.entries` is already the first page (the pager pre-slices via
		// `pagerTabRender`); `apps-pagination.js` renders pages 2…N on demand.
		return renderAppCards(tab.entries);
	}

	/** Extra nav links for the account pages (`<browser-account-links>`, used by
	 * googleLogin.html / microsoftLogin.html). Favorites is ALWAYS emitted:
	 * enabled while a session is active, otherwise a disabled, non-navigating
	 * pill — gated on the live session, NOT on whether favorites.json exists.
	 * Achievements stays file-gated (emitted once a signed-in Check-for-Updates
	 * has written my-achievements.json); the page itself renders every badge
	 * locked when signed out, so a lingering file is harmless. `statSync` is a
	 * cheap existence probe (no file read); a throw / null = absent. */
	private renderAccountLinks(): string {
		// Require a NON-EMPTY file. The auth flow "deletes" a per-user cache by
		// writing 0 bytes (there is no unlink), so a bare existence check would
		// keep showing the link to an empty Favorites / Achievements page right
		// after a login clears the cache. `statSync().size` is a cheap probe (no
		// file read); size 0 or a missing file both read as absent.
		const has = (rel: string): boolean => {
			try {
				const st = Switch.statSync(`${this.appRoot}${rel}`);
				return !!st && st.size > 0;
			} catch (_) { return false; }
		};
		let links = '';
		// Favorites: gate the enabled/disabled state on the ACTIVE SESSION, not on
		// favorites.json. Signed out → a dimmed, inert pill (no href so the
		// engine's findTapIntent finds nothing to navigate; `pointer-events:none`
		// is the belt-and-suspenders). Signed in → the real link. This keeps the
		// button present-but-disabled even if a stale favorites.json lingers.
		if (this.isSignedIn()) {
			links += '<a class="munch-link" href="brewser://favorites/">Favorites</a>';
		} else {
			links += '<a class="munch-link munch-link--disabled" aria-disabled="true"'
				+ ' style="opacity:0.45;pointer-events:none;cursor:default;">Favorites</a>';
		}
		if (has('configs/my-achievements.json')) {
			links += '<a class="munch-link" href="brewser://achievements/">Achievements</a>';
		}
		return links;
	}

	/** Signed-in probe for the account nav. Mirrors auth-shared.js
	 * `readActiveSession`: `auth/active.json` names a provider AND that
	 * provider's `<provider>-auth.json` holds a record with a non-empty `id`.
	 * Both reads target shell-owned paths (readable under the shell's grant-all
	 * policy). Any throw / empty / malformed / unknown-provider = signed out. */
	private isSignedIn(): boolean {
		const readObj = (rel: string): Record<string, unknown> | null => {
			try {
				const data = Switch.readFileSync(`${this.appRoot}${rel}`);
				if (!data) return null;
				const text = decoder.decode(data);
				if (!text.trim()) return null;
				const parsed = JSON.parse(text);
				return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
			} catch (_) { return null; }
		};
		const active = readObj('shell/auth/active.json');
		const provider = active && typeof active.provider === 'string' ? active.provider : '';
		if (provider !== 'google' && provider !== 'microsoft') return false;
		const rec = readObj(`shell/auth/${provider}-auth.json`);
		return !!(rec && typeof rec.id === 'string' && (rec.id as string).length > 0);
	}

	/** Render the welcome-page search bar for the active engine (per
	 * `config.json` → `search_engines.json`): the engine logo + a search
	 * input + a Search button. Both the input and the button carry
	 * `data-action="search"` so a tap opens the keyboard and routes the
	 * query to the engine (the shell's `search` button-action). */
	private renderSearch(): string {
		const engine = resolveSearchEngine(this.appRoot);
		// `logo` is a ready-to-use relative path (e.g.
		// `assets/google_logo.png`) — used verbatim as the img src,
		// resolved against the page that embeds the search widget
		// (typically `home.html` at `<storageRoot>`).
		const logo = htmlEscape(engine.logo);
		const alt = htmlEscape(`${engine.title} logo`);
		return (
			'<form class="search-form" role="search">'
			+ `<img class="search-logo" src="${logo}" alt="${alt}">`
			+ '<input class="search-input" type="search" name="q" placeholder="Search the internet"'
			+ ' aria-label="Search the internet" data-action="search" autocomplete="off">'
			+ '<button class="search-button" type="submit" data-action="search">Search</button>'
			+ '</form>'
		);
	}

	private renderBookmarks(limit: number | null, format: 'list' | 'cards' = 'list'): string {
		let list = this.bookmarksStore.list();
		if (limit !== null) list = list.slice(0, limit);
		if (list.length === 0) {
			return '<p class="empty">No bookmarks saved yet. Tap ★ in the toolbar to add one.</p>';
		}
		return format === 'cards' ? renderBookmarkCards(list) : renderList(list);
	}

	private renderHistory(limit: number): string {
		const list = this.historyStore.recent(limit);
		if (list.length === 0) {
			return '<p class="empty">No visits recorded yet. Press ZR to enter a URL.</p>';
		}
		return renderList(list);
	}

	/** Render the toolbars registry as radio-style rows. Each row is
	 * a `<button>` with a circle indicator on the left + the
	 * title/path label on the right. The currently-selected toolbar
	 * (per `config.json`) carries `.active` (filled inner dot) and has
	 * no `data-action`, so taps don't fire. Every other row carries
	 * `<button data-action="select-toolbar:<path>">` whose tap the
	 * shell intercepts to rewrite `config.json` and reload. */
	private renderToolbars(): string {
		const entries = loadToolbarRegistry(this.appRoot);
		if (entries.length === 0) {
			return '<p class="empty">No toolbars registered. Edit <code>toolbars.json</code> to add one.</p>';
		}
		const config = loadConfig(this.appRoot);
		const indicator = '<span class="radio-indicator"><span class="radio-dot"></span></span>';
		return entries.map((e) => {
			const title = htmlEscape(e.title);
			const path = htmlEscape(e.path);
			const label = `<span class="template-label">${title} · <span class="path">${path}</span></span>`;
			if (e.path === config.toolbar) {
				return `<button class="template-row active" type="button">${indicator}${label}</button>`;
			}
			return `<button class="template-row" type="button" data-action="select-toolbar:${path}">${indicator}${label}</button>`;
		}).join('');
	}

	/** Render the keyboards registry as radio-style rows. Mirrors
	 * `renderToolbars` — the currently-selected keyboard (per
	 * `config.json`'s `keyboard` field) carries `.active` and has no
	 * `data-action` so taps are inert; every other row carries
	 * `<button data-action="select-keyboard:<path>">` whose tap the
	 * shell intercepts via `selectKeyboard` to rewrite `config.json`
	 * and rebuild the kb live root on the spot. */
	private renderKeyboards(): string {
		const entries = loadKeyboardRegistry(this.appRoot);
		if (entries.length === 0) {
			return '<p class="empty">No keyboards registered. Edit <code>keyboards.json</code> to add one.</p>';
		}
		const config = loadConfig(this.appRoot);
		const indicator = '<span class="radio-indicator"><span class="radio-dot"></span></span>';
		return entries.map((e) => {
			const title = htmlEscape(e.title);
			const path = htmlEscape(e.path);
			const label = `<span class="template-label">${title} · <span class="path">${path}</span></span>`;
			if (e.path === config.keyboard) {
				return `<button class="template-row active" type="button">${indicator}${label}</button>`;
			}
			return `<button class="template-row" type="button" data-action="select-keyboard:${path}">${indicator}${label}</button>`;
		}).join('');
	}

	/** Full settings form. Every editable `config.json` key is rendered as a
	 * native form widget tagged with `data-setting="<key>"`. The Save
	 * button (`data-action="save-settings"`, sticky bottom-right) is the
	 * single apply point — until it fires, every edit lives only in the
	 * live-DOM widget state, so the user can poke around without
	 * committing.
	 *
	 * Mirrors `loadConfig`'s clamps/types — the shell-side reader applies
	 * the same bounds on the way out, so an out-of-range type-in is
	 * silently clamped rather than rejecting the save. */
	/** The Settings page's "Bookmarks" quick-link. Emitted only when the
	 * toolbar is enabled — bookmarks are a toolbar affordance, so with the
	 * toolbar turned off (Show Toolbar unchecked + saved) the link is hidden,
	 * mirroring the Toolbar + Search Engine settings row. Reads the SAVED
	 * config (saveSettings reloads the page). Returns '' to hide. */
	private renderSettingsBookmarksLink(): string {
		if (!loadConfig(this.appRoot).showToolbar) return '';
		return '<a class="munch-link" href="brewser://bookmarks/">Bookmarks</a>';
	}

	/** The Settings page's "Login" quick-link, with the signed-in user's avatar
	 * (or the default bitmap) shown to its LEFT. Same source as the toolbar
	 * avatar: the active session's cached thumb/full bitmap under `shell/auth/`,
	 * surfaced as a `brewser://auth/…` page URL; falls back to the default asset
	 * when signed out or the cached file is missing. */
	private renderSettingsLoginLink(): string {
		const avatar = this.resolveActiveAvatarUrl();
		return '<a class="munch-link munch-link--login" href="brewser://googleLogin/">'
			+ `<img class="settings-login-avatar" src="${htmlEscape(avatar)}" alt="" width="22" height="22">`
			+ '<span>Login</span>'
			+ '</a>';
	}

	/** Resolve the active session's avatar as a `brewser://` page URL, else the
	 * default avatar asset. Reads the same SDMC auth records the shell's toolbar
	 * avatar resolver uses (`auth/active.json` → `<provider>-auth.json` → cached
	 * bitmap path), converting the absolute `shell/…` path to a `brewser://…`
	 * URL the page image loader resolves back to the same file. */
	private resolveActiveAvatarUrl(): string {
		const DEFAULT_AVATAR = 'brewser://assets/avatar_default.png';
		const SHELL_ROOT = 'sdmc:/switch/brewser/shell/';
		const AUTH_DIR = `${SHELL_ROOT}auth/`;
		const readJson = (path: string): Record<string, unknown> | null => {
			try {
				const raw = Switch.readFileSync(path);
				if (!raw || raw.byteLength === 0) return null;
				const v = JSON.parse(decoder.decode(raw));
				return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
			} catch { return null; }
		};
		const hasBytes = (path: string): boolean => {
			try { const r = Switch.readFileSync(path); return !!(r && r.byteLength > 0); }
			catch { return false; }
		};
		const active = readJson(`${AUTH_DIR}active.json`);
		const provider = typeof active?.provider === 'string' ? active.provider : '';
		if (provider !== 'google' && provider !== 'microsoft') return DEFAULT_AVATAR;
		const rec = readJson(`${AUTH_DIR}${provider}-auth.json`);
		if (!rec || typeof rec.id !== 'string' || rec.id.length === 0) return DEFAULT_AVATAR;
		// Thumb (64×64) preferred over the full bitmap — the slot is tiny.
		for (const cand of [rec.avatar_local_thumb_path, rec.avatar_local_path]) {
			if (typeof cand === 'string' && cand.startsWith(SHELL_ROOT) && hasBytes(cand)) {
				return `brewser://${cand.slice(SHELL_ROOT.length)}`;
			}
		}
		return DEFAULT_AVATAR;
	}

	private renderSettings(): string {
		const config = loadConfig(this.appRoot);
		const engines = loadSearchEngines(this.appRoot);
		const toolbars = loadToolbarRegistry(this.appRoot);
		const keyboards = loadKeyboardRegistry(this.appRoot);
		const styles = loadStyleRegistry(this.appRoot);
		const backgrounds = loadBackgroundRegistry(this.appRoot);

		const checked = (b: boolean) => b ? ' checked' : '';

		// 2026-06-17 perf trim: drop the inner `<span class="settings-radio-label">`
		// (text directly inside the `<label>` is fine — the `flex: 1` it
		// carried was decorative; the row uses `display: flex; gap: 12px`
		// already). Saves one node per row × ~23 stacked-list rows. Same
		// trim applies to the inline-radios block below. See the
		// `kb-on-Settings perf drop` memory entry.
		const toolbarRows = toolbars.length === 0
			? '<p class="empty">No toolbars registered. Edit <code>toolbars.json</code> to add one.</p>'
			: toolbars.map((e) => {
				const path = htmlEscape(e.path);
				const title = htmlEscape(e.title);
				return (
					'<label class="settings-radio">'
					+ `<input type="radio" name="setting-toolbar" value="${path}" data-setting="toolbar"${checked(e.path === config.toolbar)}>`
					+ title
					+ '</label>'
				);
			}).join('');

		const keyboardRows = keyboards.length === 0
			? '<p class="empty">No keyboards registered. Edit <code>keyboards.json</code> to add one.</p>'
			: keyboards.map((e) => {
				const path = htmlEscape(e.path);
				const title = htmlEscape(e.title);
				return (
					'<label class="settings-radio">'
					+ `<input type="radio" name="setting-keyboard" value="${path}" data-setting="keyboard"${checked(e.path === config.keyboard)}>`
					+ title
					+ '</label>'
				);
			}).join('');

		const styleRows = styles.length === 0
			? '<p class="empty">No styles registered. Edit <code>styles.json</code> to add one.</p>'
			: styles.map((e) => {
				const path = htmlEscape(e.path);
				const title = htmlEscape(e.title);
				return (
					'<label class="settings-radio">'
					+ `<input type="radio" name="setting-brewserStyle" value="${path}" data-setting="brewserStyle"${checked(e.path === config.brewserStyle)}>`
					+ title
					+ '</label>'
				);
			}).join('');

		// Wallpaper picker — keyed by the entry `title` (backgrounds have
		// no CSS path), staged into `config.themeBackground`. The shell
		// resolves the selected title back to its `backgrounds.json` entry
		// and applies the static image / animated shader live on Save.
		const backgroundRows = backgrounds.length === 0
			? '<p class="empty">No backgrounds registered. Edit <code>backgrounds.json</code> to add one.</p>'
			: backgrounds.map((e) => {
				const title = htmlEscape(e.title);
				return (
					'<label class="settings-radio">'
					+ `<input type="radio" name="setting-themeBackground" value="${title}" data-setting="themeBackground"${checked(e.title === config.themeBackground)}>`
					+ title
					+ '</label>'
				);
			}).join('');

		const themeRow = (
			'<div class="settings-row">'
			+ '<span class="settings-label">Theme</span>'
			+ '<div class="settings-radios">'
			+ `<label class="settings-radio inline"><input type="radio" name="setting-theme" value="light" data-setting="theme"${checked(config.theme === 'light')}> Light</label>`
			+ `<label class="settings-radio inline"><input type="radio" name="setting-theme" value="dark" data-setting="theme"${checked(config.theme === 'dark')}> Dark</label>`
			+ '</div>'
			+ '</div>'
		);

		const toolbarPositionRow = (
			'<div class="settings-row">'
			+ '<span class="settings-label">Toolbar position</span>'
			+ '<div class="settings-radios">'
			+ `<label class="settings-radio inline"><input type="radio" name="setting-toolbarPosition" value="top" data-setting="toolbarPosition"${checked(config.toolbarPosition === 'top')}> Top</label>`
			+ `<label class="settings-radio inline"><input type="radio" name="setting-toolbarPosition" value="bottom" data-setting="toolbarPosition"${checked(config.toolbarPosition === 'bottom')}> Bottom</label>`
			+ '</div>'
			+ '</div>'
		);

		// Date-format placeholder for `<input type="date">` empty fields.
		// Round-trips as the `local` config key; pushed into the runtime
		// via `setDateInputDefaultPlaceholder` at boot + on save.
		const dateFormatRow = (
			'<div class="settings-row">'
			+ '<span class="settings-label">Local Date Format</span>'
			+ '<div class="settings-radios">'
			+ `<label class="settings-radio inline"><input type="radio" name="setting-local" value="dd/mm/yyyy" data-setting="local"${checked(config.local === 'dd/mm/yyyy')}> dd/mm/yyyy</label>`
			+ `<label class="settings-radio inline"><input type="radio" name="setting-local" value="mm/dd/yyyy" data-setting="local"${checked(config.local === 'mm/dd/yyyy')}> mm/dd/yyyy</label>`
			+ `<label class="settings-radio inline"><input type="radio" name="setting-local" value="yyyy/mm/dd" data-setting="local"${checked(config.local === 'yyyy/mm/dd')}> yyyy/mm/dd</label>`
			+ '</div>'
			+ '</div>'
		);

		// Permission-warning severity gate. Each checkbox carries a
		// boolean `data-setting`; `BrowserShell.saveSettings` reads the
		// three booleans and composes `config.warnings` as a string array
		// in canonical low/medium/high order, then strips the three keys
		// so they don't bake into config.json. Reusing the
		// `.settings-radio inline` class for the labels — visually checkbox
		// or radio share the same chrome here, and the live-form widget
		// dispatch keys off the `type=checkbox` attribute anyway. */
		const warningsRow = (
			'<div class="settings-row">'
			+ '<span class="settings-label">App warnings<span class="settings-hint">severities shown in the Permissions Warning modal when launching an app</span></span>'
			+ '<div class="settings-radios">'
			+ `<label class="settings-radio inline"><input type="checkbox" name="setting-warningLow" data-setting="warningLow"${checked(config.warnings.includes('low'))}> Low</label>`
			+ `<label class="settings-radio inline"><input type="checkbox" name="setting-warningMedium" data-setting="warningMedium"${checked(config.warnings.includes('medium'))}> Medium</label>`
			+ `<label class="settings-radio inline"><input type="checkbox" name="setting-warningHigh" data-setting="warningHigh"${checked(config.warnings.includes('high'))}> High</label>`
			+ '</div>'
			+ '</div>'
		);

		// Component versions from `<appRoot>configs/current.json`, read
		// fresh on every settings render so the row reflects the
		// installed build without a runtime restart. Missing / malformed
		// file → the row is omitted silently (fail-open, same as
		// loadConfig's on-parse fallback). Rendered as a single text
		// flow (`<strong>key</strong>: value | ...`) so all entries
		// share one line rather than stacking as list items.
		let versionsRow = '';
		try {
			const raw = Switch.readFileSync(`${this.appRoot}configs/current.json`);
			if (raw) {
				const parsed = JSON.parse(decoder.decode(raw));
				if (parsed && typeof parsed === 'object') {
					const items: string[] = [];
					for (const key of Object.keys(parsed)) {
						const value = (parsed as Record<string, unknown>)[key];
						if (typeof value !== 'string') continue;
						items.push(
							`<strong>${htmlEscape(key)}</strong>: ${htmlEscape(value)}`
						);
					}
					if (items.length > 0) {
						versionsRow = (
							'<div class="settings-row">'
							+ `<p>${items.join(' | ')}</p>`
							+ '</div>'
						);
					}
				}
			}
		} catch (_) { /* current.json unreadable — skip row */ }

		// Home page section picker — drives the `<browser-home-apps>` +
		// `<browser-home-title>` expansions on home.html via the
		// `homeSection` config field. The home page has no in-page tab
		// strip (apps.html does), so this radio is the only way to
		// flip the visible section. Labels mirror `homeSectionTitle`
		// so the Settings copy reads the same as the rendered h2.
		const homeSectionRows = HOME_SECTIONS.map((section) => {
			const label = homeSectionTitle(section);
			return (
				'<label class="settings-radio">'
				+ `<input type="radio" name="setting-homeSection" value="${section}" data-setting="homeSection"${checked(config.homeSection === section)}>`
				+ htmlEscape(label)
				+ '</label>'
			);
		}).join('');

		// Search-engine picker — rendered as a radio list (one row per
		// engine) instead of a `<select>`. The live-form SELECT tap
		// handler cycles options on tap (see comment "M2.5 popup overlay"
		// in live-form.ts paintSelect), which is unintuitive for a
		// "pick one" preference. Radios share the same widget shape as
		// the Toolbar list so the visual language stays consistent. */
		const searchRows = engines.length === 0
			? `<p class="empty">No search engines registered. Edit <code>search_engines.json</code> to add one.</p>`
			: engines.map((e) => {
				const title = htmlEscape(e.title);
				return (
					'<label class="settings-radio">'
					+ `<input type="radio" name="setting-searchEngine" value="${title}" data-setting="searchEngine"${checked(e.title === config.searchEngine)}>`
					+ title
					+ '</label>'
				);
			}).join('');

		const numberRow = (key: string, label: string, value: number, min: number, max: number, hint: string): string => (
			'<div class="settings-row">'
			+ `<label class="settings-label" for="setting-${key}">${htmlEscape(label)}<span class="settings-hint">${htmlEscape(hint)}</span></label>`
			+ `<input id="setting-${key}" name="setting-${key}" data-setting="${key}" type="number" inputmode="numeric" min="${min}" max="${max}" value="${value}">`
			+ '</div>'
		);

		// 2026-06-17 perf trim: drop the outer `.settings-row.settings-row-toggle`
		// wrapper div — the `.settings-toggle` label already has its own
		// `margin-top: 6px` so the row spacing survives. Saves one node
		// per toggle × 5. (The .settings-label inner span stays — both
		// title and hint live inside it as a vertical stack, and dropping
		// the wrapper would lose the column flex container for the hint.)
		const toggleRow = (key: string, label: string, value: boolean, hint: string): string => (
			'<label class="settings-toggle">'
			+ `<input type="checkbox" name="setting-${key}" data-setting="${key}"${checked(value)}>`
			+ `<span class="settings-label">${htmlEscape(label)}${hint ? `<span class="settings-hint">${htmlEscape(hint)}</span>` : ''}</span>`
			+ '</label>'
		);

		// 2026-06-17 perf trim: drop the `.settings-templates` wrapper
		// divs around the radio lists. They were just `display: flex;
		// flex-direction: column` — but the rows already stack
		// vertically inside the parent fieldset's default block layout
		// (the .settings-radio rows are display:flex inline-flex items
		// laid out by their own `margin-top: 6px`). Saves 5 wrapper
		// nodes.
		// 3rd row (Toolbar + Search Engine) is emitted ONLY when the toolbar is
		// enabled. With `showToolbar` off there is no toolbar strip and no search
		// bar, so both pickers are irrelevant — the row is omitted entirely. This
		// reads the SAVED config (saveSettings reloads the page), so the row
		// disappears only after Show Toolbar is unchecked AND saved, and returns
		// when it is re-enabled + saved. Same signal hides the Settings
		// "Bookmarks" quick-link (see renderSettingsBookmarksLink).
		const toolbarSearchRow = config.showToolbar
			? (
				'<div class="settings-row-pair">'
				+ '<fieldset class="settings-group">'
				+ '<legend>Toolbar</legend>'
				+ toolbarRows
				+ '</fieldset>'
				+ '<fieldset class="settings-group">'
				+ '<legend>Search engine</legend>'
				+ searchRows
				+ '</fieldset>'
				+ '</div>'
			)
			: '';

		return (
			'<div class="settings-form">'
			// 1st row: Background + Style
			+ '<div class="settings-row-pair">'
			+ '<fieldset class="settings-group">'
			+ '<legend>Background</legend>'
			+ backgroundRows
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Style</legend>'
			+ styleRows
			+ '</fieldset>'
			+ '</div>'
			// 2nd row: Keyboard + Home Page
			+ '<div class="settings-row-pair">'
			+ '<fieldset class="settings-group">'
			+ '<legend>Keyboard</legend>'
			+ keyboardRows
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Home Page</legend>'
			+ homeSectionRows
			+ '</fieldset>'
			+ '</div>'
			// 3rd row: Toolbar + Search Engine (hidden when the toolbar is off)
			+ toolbarSearchRow
			// 4th row: Appearance + System
			+ '<div class="settings-row-pair">'
			+ '<fieldset class="settings-group">'
			+ '<legend>Appearance</legend>'
			+ themeRow
			+ toolbarPositionRow
			+ dateFormatRow
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>System</legend>'
			+ warningsRow
			+ toggleRow('showToolbar', 'Show Toolbar', config.showToolbar, 'hide or show the toolbar strip')
			+ versionsRow
			+ '</fieldset>'
			+ '</div>'
			// 5th row: Performance + Behaviour
			+ '<div class="settings-row-pair">'
			+ '<fieldset class="settings-group">'
			+ '<legend>Performance</legend>'
			+ numberRow('wwwRenderChunkMs', 'External page render budget', config.wwwRenderChunkMs, 1, 1000, 'ms per frame while building http(s) pages (1–1000)')
			+ numberRow('scrollChunkMs', 'Scroll-time render budget', config.scrollChunkMs, 1, 1000, 'ms per frame while scrolling a still-building page (1–1000)')
			+ numberRow('maxHistory', 'Max history entries', config.maxHistory, 1, 10000, 'oldest entries are dropped past this cap (1–10000)')
			+ numberRow('maxPerPage', 'Apps per page', config.maxPerPage, 1, 60, 'app cards shown per page; fewer means fewer app banners fetched at once (1–60)')
			+ numberRow('mouseIdleMs', 'Cursor idle hide', config.mouseIdleMs, 0, 3_600_000, 'ms of stick-idle before the cursor hides (0–3 600 000)')
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Behaviour</legend>'
			+ toggleRow('videoNVTEGRA', 'NVTEGRA hardware video decode', config.videoNVTEGRA, 'try the hw decoder first, fall back to software per element')
			+ toggleRow('autoRotate', 'Auto-rotate canvas', config.autoRotate, 'reserved — no consumer wired up today, value round-trips through Save')
			+ toggleRow('clickSounds', 'Click sounds', config.clickSounds, 'short click.wav on link / button / chrome activation')
			+ toggleRow('momentumScrolling', 'Momentum scrolling', config.momentumScrolling, 'scroll content coasts to a stop with friction after right-stick release / finger lift')
			+ toggleRow('showFps', 'Show FPS', config.showFps, 'small semi-transparent FPS counter at the top-left; stays on across the shell and every app')
			+ toggleRow('browsingWarning', 'Internet browsing warning', config.browsingWarning, 'warn before opening any http(s) website — internet browsing is experimental and may crash the app')
			+ '</fieldset>'
			+ '</div>'
			+ '</div>'
			+ '<div class="settings-savebar">'
			+ '<span class="settings-status" data-settings-status>No unsaved changes.</span>'
			+ '<button type="button" class="settings-save" data-action="save-settings" data-settings-save disabled>Save</button>'
			+ '</div>'
		);
	}
}

function canonicalUrl(url: string): string {
	const withoutFragment = url.split('#', 1)[0];
	const withoutQuery = withoutFragment.split('?', 1)[0];
	// Static-asset URLs are canonical as-is (no trailing slash);
	// directory / page URLs get a trailing slash for consistency.
	if (looksLikeStaticAsset(withoutQuery)) return withoutQuery;
	return withoutQuery.endsWith('/') ? withoutQuery : `${withoutQuery}/`;
}

/** True iff the URL's last segment looks like a filename with a
 * recognized extension (e.g. `.../assets/three.iife.js`). Used to
 * decide whether to add a trailing slash in `canonicalUrl` and which
 * branch to take in `classifyUrl`. */
function looksLikeStaticAsset(url: string): boolean {
	if (url.endsWith('/')) return false;
	const lastSegment = url.split('/').pop() ?? '';
	const dotIdx = lastSegment.lastIndexOf('.');
	if (dotIdx <= 0) return false;
	const ext = lastSegment.slice(dotIdx + 1).toLowerCase();
	return Object.hasOwn(MIME_BY_EXT, ext);
}

type UrlClassification =
	| { kind: 'static'; relPath: string; mime: string; binary: boolean }
	| { kind: 'html'; candidates: readonly string[] };

/** Classify a canonical `brewser://...` URL into either a static-asset
 * lookup or an HTML page lookup, validating each path segment against
 * `DIR_SEGMENT` / `FILE_SEGMENT` to keep callers from escaping the
 * profile dir via `../` or other weirdness. Returns `null` if the URL
 * shape doesn't match either route. */
function classifyUrl(canonical: string): UrlClassification | null {
	const stripped = canonical.replace(/^brewser:\/\//, '').replace(/\/+$/, '');
	if (!stripped) return null;

	const segments = stripped.split('/');
	const last = segments[segments.length - 1] ?? '';
	const dotIdx = last.lastIndexOf('.');
	const isStatic = !canonical.endsWith('/') && dotIdx > 0;

	if (isStatic) {
		for (let i = 0; i < segments.length; i++) {
			const ok = i === segments.length - 1
				? FILE_SEGMENT.test(segments[i])
				: DIR_SEGMENT.test(segments[i]);
			if (!ok) return null;
		}
		const ext = last.slice(dotIdx + 1).toLowerCase();
		const entry = MIME_BY_EXT[ext];
		if (!entry) return null;
		return { kind: 'static', relPath: stripped, mime: entry.mime, binary: entry.binary };
	}

	if (!PATH_PATTERN.test(stripped)) return null;
	return {
		kind: 'html',
		candidates: [`${stripped}.html`, `${stripped}/index.html`],
	};
}

function parseLimit(attrs: string | undefined): number | null {
	if (!attrs) return null;
	const m = /\blimit\s*=\s*"(\d+)"/i.exec(attrs) ?? /\blimit\s*=\s*'(\d+)'/i.exec(attrs);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** `format="cards"` renders the legacy home-page `.quick-card` design
 * (the styling was last present on the old welcome.html quick-links
 * grid before the 2026-06-02 Featured Apps refactor removed it);
 * anything else (default) renders the settings `<ul>` list. */
function parseFormat(attrs: string | undefined): 'list' | 'cards' {
	if (!attrs) return 'list';
	const m = /\bformat\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\bformat\s*=\s*'([^']*)'/i.exec(attrs);
	return m && m[1].toLowerCase() === 'cards' ? 'cards' : 'list';
}

/** Render bookmarks as legacy `.quick-card` anchors (title in
 * `<strong>`, description in `<span>`). The styling has been removed
 * from the home page (formerly welcome.html); this function survives
 * for any future page that opts back in via
 * `<browser-bookmarks format="cards">` and ships its own `.quick-card`
 * CSS. */
function renderBookmarkCards(
	entries: ReadonlyArray<{ url: string; title?: string; description?: string }>,
): string {
	return entries.map((e) => {
		const title = htmlEscape(e.title && e.title !== e.url ? e.title : e.url);
		const desc = e.description ? `<span>${htmlEscape(e.description)}</span>` : '';
		return `<a class="quick-card" href="${htmlEscape(e.url)}"><strong>${title}</strong>${desc}</a>`;
	}).join('');
}

/** Render app entries as `.app-card` links: a logo `<img>` on top,
 * then the title in `<strong>` and the description in `<span>` — the
 * `.app-card` styling + `::after` arrow live in apps.html's stylesheet,
 * so this only emits structural markup (mirrors `renderBookmarkCards`).
 * The `logo` path is used verbatim as the img src (resolved like the
 * welcome page's relative asset paths); `url` is rewritten to an
 * absolute `brewser://` link the launcher's modal hands to its Play
 * button when the entry is installed.
 *
 * Every card — installed AND missing — carries `data-app-detail` and
 * NO `href`, so every tap routes through the launcher's modal script
 * instead of navigating directly. The modal branches on
 * `detail.missing`: installed entries show a Play button (an `<a>`
 * whose href the script stamps from `detail.url` at open time);
 * missing entries show Download (stub for now). Missing entries also
 * carry `data-missing="true"` and the `app-card--missing` class so
 * the card visuals still distinguish at a glance. */
/** Rating average → short display string ("5", "4.5"); "0" when unrated. */
function formatRatingAvg(avg: number): string {
	if (!Number.isFinite(avg) || avg <= 0) return '0';
	const s = avg.toFixed(1);
	return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Non-negative integer count with thousands separators ("1,234"). */
function formatCardCount(n: number): string {
	const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
	return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function renderAppCards(entries: ReadonlyArray<AppEntry>): string {
	return entries.map((e) => {
		const isMissing = e.missing === true;
		const banner = htmlEscape(e.banner);
		const alt = htmlEscape(`${e.title} banner`);
		const title = htmlEscape(e.title);
		const blurb = e.description ? `<div class="app-card__blurb">${htmlEscape(e.description)}</div>` : '';
		// `data-app-detail` is read by the launcher's modal script.
		// Emitted on EVERY card now (installed + missing) so taps on
		// any card route through the modal instead of navigating
		// directly. The script branches on `missing` to swap the
		// modal's action button (Download for missing, Play for
		// installed) and reads `url` for the Play button's href.
		// JSON is HTML-attribute-escaped via htmlEscape; the script
		// does `JSON.parse(card.getAttribute('data-app-detail'))` to
		// recover the structure.
		const detailAttrs = ` data-app-detail="${htmlEscape(JSON.stringify({
			id: e.id,
			name: e.title,
			// `description` is the short card blurb (the summary). The modal
			// shows the full HTML in `fullDescription` and falls back to this
			// blurb when there is no full description.
			description: e.description,
			// Full HTML description — the modal renders it as HTML in a
			// scrollable block. Kept in the catalogue entry (v1), so no
			// remote manifest fetch is needed to show it.
			fullDescription: e.fullDescription,
			// `logo` carries the brewser:// URL the script stamps
			// into the modal header. Installed entries get the
			// real `brewser://apps/.../<logo>` path; missing
			// entries get `MISSING_APP_LOGO_URL` (= the generic
			// download.png) — both already resolved by
			// `loadCatalogGroup`.
			logo: e.logo,
			// `url` is the per-app launcher URL the Play button
			// navigates to. Always supplied; only consumed by the
			// modal when `missing === false`.
			url: appUrlToBrowserHref(e.url),
			missing: isMissing,
			version: e.version,
			// On-disk manifest version when it differs from `version`
			// above. Empty in every "no upgrade signal" case. The
			// modal script keys the yellow chip ("v1.0.0 -> v1.0.7")
			// on this being non-empty — mirrors the grid card's
			// upgrade chip exactly so the two stay visually consistent.
			installedVersion: e.installedVersion,
			license: e.license,
			category: e.category,
			features: e.features,
			permissions: e.permissions,
			allowedOrigins: e.allowedOrigins,
			developer: e.developer,
			source: e.source,
			// Relative launcher path (typically `index.html`). Used by
			// the download-modal so it can reorder the entry file to
			// last in the install loop — an interrupted download then
			// leaves the card flagged as missing and a re-tap retries
			// cleanly.
			entry: e.entry,
			// Total install size in bytes. Surfaced by the missing-app
			// modal as a megabyte chip in the action row so the user
			// sees the download footprint before tapping Download /
			// Update. Zero when the catalog entry omits the field —
			// the modal hides the chip in that case.
			sizeBytes: e.sizeBytes,
			// Per-user "My Apps" lifecycle ('' for ordinary catalogue cards).
			status: e.status,
		}))}"`;
		const missingAttr = isMissing ? ' data-missing="true"' : '';
		const missingClass = isMissing ? ' app-card--missing' : '';
		// My Apps status pill (published / staged / unpublished), painted over
		// the banner's top-left. Empty for every ordinary catalogue card, so
		// only the "My Apps" tab shows it.
		const statusBadge = e.status
			? `<span class="app-card__status app-card__status--${htmlEscape(e.status)}">${htmlEscape(myAppsStatusLabel(e.status))}</span>`
			: '';
		// Cards for an installed app whose catalogue version differs from the
		// on-disk manifest version (a new version is available to download) are
		// flagged at render with `app-card--upgrade`, which the theme paints as
		// a red border. Keyed on `installedVersion` being set — the same gate
		// `libraryAppToCard` uses for the `installed-update` state. The shell's
		// updates-modal.js adds the same class dynamically after a manual
		// Check-for-Updates (idempotent); download-modal.js removes it on a
		// successful install.
		const upgradeClass = (e.installedVersion && e.version) ? ' app-card--upgrade' : '';
		// Version + license sit in a small footer strip pinned to the
		// card's bottom edge — `v1.0.0` chip flush left, `MIT` chip
		// flush right (see `.app-card__meta` in main.css). Either field
		// may be empty (entry omitted it in `catalogue.json`); we just
		// skip the chip in that case so a card with neither metadatum
		// renders identically to the pre-version layout.
		//
		// `<div>` (not `<span>`) is deliberate: the existing `.app-card
		// span` rule in main.css forces `display: block; text-align:
		// left` so the description text line-wraps left-aligned, and the
		// extra specificity we'd need to override that for chips inside
		// an absolutely-positioned flex row was brittle (and brewser's
		// layout treats inline `<span>` heights inconsistently even
		// after `display: flex`). Switching the strip + chips to `<div>`
		// sidesteps both problems — generic-tag rule doesn't match, and
		// `<div>` is block-level by default so `height:` always applies.
		// Upgrade chip: when `installedVersion` is non-empty, the
		// on-disk manifest's version differs from the catalog's. Paint
		// the chip as `v1.0.0 [→] v1.0.1` with the bright-yellow
		// palette (same #ffd35e as the page titles + tab-active fill)
		// so it reads as a call-to-action. Falls back to the normal
		// chip (catalog version only) when the on-disk version matches
		// OR the app isn't installed.
		//
		// The arrow is an inline `<svg><polygon>` — same approach
		// live-form.ts paintSelect took for the dropdown chevron after
		// the U+25BC `▼` glyph tofu'd. live-overlay.ts's paintLiveSvg
		// scales the viewBox into the layout box; one filled polygon
		// per upgrade card, so paint cost is negligible. Hardcoded
		// fill (`#0b1220`, the chip's text color) avoids any
		// `currentColor` resolution questions in the SVG painter.
		// Three-way chip palette:
		//   - Missing (entry file absent on disk) → red "NEW" pill so the
		//     card reads as "this is something to install" at a glance.
		//     Overrides the version-text path even when the catalog
		//     carries a version, because the user hasn't installed
		//     anything yet — the version number is less interesting than
		//     the call-to-action.
		//   - Installed-but-stale (`installedVersion` differs from the
		//     catalog's `version`) → yellow `vOld → vNew` upgrade chip.
		//   - Installed-and-current OR catalog-only-version → ordinary
		//     blue version pill.
		// Footer: rating on the left (a star icon + average, or "Not rated
		// yet"), download count on the right. Both come from the cached
		// stats.json via the card model; absent stats read as 0 / unrated,
		// which is the honest offline state (and matches the mockup).
		const rating = e.ratingCount > 0
			? `${formatRatingAvg(e.ratingAvg)}<span class="app-card__rcount"> (${formatCardCount(e.ratingCount)})</span>`
			: 'Not rated yet';
		const ratingHtml = `<span class="app-card__rating"><img class="app-card__ricon" src="brewser://assets/star_full.png" alt="">${rating}</span>`;
		const dlWord = e.downloads === 1 ? 'download' : 'downloads';
		const downloadsHtml = `<span class="app-card__downloads"><img class="app-card__dicon" src="brewser://assets/download.png" alt="">${formatCardCount(e.downloads)} ${dlWord}</span>`;
		const footer = `<div class="app-card__footer">${ratingHtml}${downloadsHtml}</div>`;
		// Banner fallback: not-installed apps point `banner` at the remote
		// catalogue URL, which loads the real image on hardware but fails
		// offline (e.g. Citron); a broken load would otherwise paint the
		// `alt`-text placeholder. `data-fallback-src` tells the engine's
		// `<img>` loader to retry once with the bundled download.png (a
		// 480×380 banner-shaped placeholder) instead. Skipped when the
		// banner already IS download.png so we don't declare a no-op retry.
		const bannerFallback = e.banner !== MISSING_APP_LOGO_URL
			? ` data-fallback-src="${htmlEscape(MISSING_APP_LOGO_URL)}"`
			: '';
		// Store-style card: full-width banner on top, then a body with the
		// title, blurb, and the rating|downloads footer. Install state
		// (NEW / upgrade / version / license) is no longer chipped on the
		// card — it lives in the detail modal that every card tap opens.
		//
		// The banner shows the app image IN FULL — scaled to the card width at
		// the image's own aspect ratio, so the height follows the width (see
		// `.app-banner`: width:100% + height auto + object-fit:contain; the card
		// auto-sizes to fit). `width`/`height` are the placeholder's dimensions
		// (480×380), used only to reserve the box at the right shape BEFORE the
		// async image load so the body doesn't jump; the loaded image's own
		// natural aspect takes over once it arrives. The gray `.app-banner`
		// background fills the box while loading.
		//
		// LAZY BANNER (pagination): the banner URL is emitted as `data-src`,
		// NOT `src`, so the engine's `<img>` loader does NOT fetch it at parse
		// time. `banner-loader.js` promotes `data-src` → `src` only for the
		// cards on the CURRENTLY-VISIBLE pagination page of the ACTIVE tab
		// (see `apps-pagination.js`), so a catalogue with many apps only pulls
		// the ~`maxPerPage` banners the user can actually see — not every
		// remote `appbanner.jpg` up front. Off-page / off-tab cards keep their
		// `data-src` untouched and never hit the network until shown. The gray
		// `.app-banner` box stands in until a card's page is promoted.
		//
		// INLINE SIZING (critical): the width/object-fit/max-height are stamped
		// as an INLINE style, not left to the `.app-banner` class rule alone.
		// When a card is swapped into the grid via `innerHTML` (page change),
		// the first card whose local banner loads before the class cascade
		// settles could otherwise lay its `<img>` out at the image's NATURAL
		// size — an off-spec banner then blew the page height into the millions
		// of pixels and OOM'd the paint's OffscreenCanvas. Inline style applies
		// at parse regardless of cascade timing, so `width:100%` +
		// `max-height` bound the box unconditionally. `.app-banner` still
		// supplies the gray placeholder bg + rounded corners.
		return `<a class="app-card${upgradeClass}"${missingAttr}${detailAttrs}>`
			+ statusBadge
			+ `<img class="app-banner" style="display:block;width:100%;height:auto;max-height:420px;object-fit:contain" width="480" height="380" data-src="${banner}"${bannerFallback} alt="${alt}">`
			+ `<div class="app-card__body"><strong>${title}</strong>${blurb}${footer}</div>`
			+ `</a>`;
	}).join('');
}

/** Display label for a My Apps status badge; passes an unknown value
 * through so a future status still renders text rather than nothing. */
function myAppsStatusLabel(status: string): string {
	switch (status) {
		case 'published': return 'Published';
		case 'unpublished': return 'Unpublished';
		case 'staged': return 'Staged';
		default: return status;
	}
}

/** Turn a card's `url` into a navigable href. `loadCatalogGroup`
 * already emits `brewser://apps/<group>/<id>/<entry>` for every
 * catalog entry, so this is a pass-through for current callers — kept
 * for the legacy `pages/`-relative shape so older user-edited entries
 * still work. Already-absolute URLs (including `brewser://`) pass
 * through; bare relative paths get the leading `../` / `pages/`
 * stripped + re-expressed as `brewser://`. */
function appUrlToBrowserHref(url: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
	const rel = url.replace(/^(?:\.\.?\/)+/, '').replace(/^pages\//, '');
	return `brewser://${rel}`;
}

function renderList(entries: ReadonlyArray<{ url: string; title?: string; description?: string }>): string {
	const items = entries.map((e) => {
		const label = e.title && e.title !== e.url
			? `${htmlEscape(e.title)} · <span class="url">${htmlEscape(e.url)}</span>`
			: htmlEscape(e.url);
		const desc = e.description
			? `<span class="desc">${htmlEscape(e.description)}</span>`
			: '';
		return `<li><a href="${htmlEscape(e.url)}">${label}${desc}</a></li>`;
	}).join('');
	return `<ul class="settings-list">${items}</ul>`;
}

/** Expand `<browser-modal>` into `<div data-engine-modal="true" ...>` —
 * the engine-blessed modal-layer root the live-DOM painter recognises
 * (see the modal-layer block in `src/scripts/live-paint-control.ts`).
 *
 * Author attributes (id, class, role, aria-*, data-*) flow through to
 * the output div unchanged. The author's `style` (if any) is merged
 * with the engine's `position: fixed` hint — `collectPaintOps` reads
 * `style.position` from INLINE style (not the computed cascade) to
 * decide cache eligibility, so the inline hint MUST survive even when
 * the page's CSS already sets `position: fixed` on the matching class.
 *
 * `data-engine-modal="true"` is always stamped: it's how
 * `propagateAttached` knows to register the element with the
 * modal-roots registry and propagate `inModalLayer = true` to
 * descendants (so per-modal mutations route through `modalTreeVersion`
 * instead of dirtying the host page cache). */
function renderBrowserModal(rawAttrs: string, body: string): string {
	const attrs = parseAttrs(rawAttrs);
	let style = (attrs['style'] ?? '').trim();
	// Force `position: fixed` into the inline style. Re-using the
	// author's style verbatim if it already contains the declaration;
	// otherwise prepending so the rule wins source order if the author
	// later adds an overriding `position:` (last-wins is the spec
	// behavior, but we want the engine hint to always be present).
	if (!/(^|;)\s*position\s*:/i.test(style)) {
		style = style ? `position: fixed; ${style}` : 'position: fixed';
	}
	attrs['style'] = style;
	attrs['data-engine-modal'] = 'true';
	// Serialize attrs in stable order so the output diffs cleanly
	// across builds and tests can string-compare. Keep author-supplied
	// attrs first (preserves any test-visible ordering they wrote)
	// then the engine stamps.
	const parts: string[] = [];
	for (const [name, value] of Object.entries(attrs)) {
		parts.push(`${name}="${htmlEscape(value)}"`);
	}
	return `<div ${parts.join(' ')}>${body}</div>`;
}

/** Minimal attribute parser for the `<browser-modal>` expansion. Handles
 * `name="value"`, `name='value'`, and bareword `name` (treated as
 * `name=""`). Sufficient for the brewser:// page authoring surface,
 * which doesn't put angle brackets or weird whitespace inside attribute
 * values. */
function parseAttrs(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		const name = m[1].toLowerCase();
		const value = m[2] ?? m[3] ?? m[4] ?? '';
		out[name] = value;
	}
	return out;
}

function htmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Display title for a catalog group, used by the home page's header
 * (`<browser-home-title>`) and the Settings page's "Home Page" radio
 * labels. Kept as a single source of truth so the two locations stay
 * in sync if the wording ever changes. */
function homeSectionTitle(section: LibraryTabId): string {
	switch (section) {
		case 'featured': return 'Featured';
		case 'recent': return 'Most Recent';
		case 'popular': return 'Popular';
		case 'toprated': return 'Top Rated';
	}
}
