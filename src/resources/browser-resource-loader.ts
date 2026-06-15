import {
	notFoundResponse,
	type ResourceLoader,
	type ResourceRequest,
} from '@switch-web/runtime';
import type { BookmarksStore } from '../navigation/bookmarks-store.js';
import type { HistoryStore } from '../navigation/history-store.js';
import { type AppEntry, CATALOG_GROUPS, type CatalogGroup, loadCatalogGroup, loadConfig, loadKeyboardRegistry, loadSearchEngines, loadStyleRegistry, loadToolbarRegistry, resolveSearchEngine } from '../profile/browser-toolbar.js';

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
	hdr: { mime: 'image/vnd.radiance', binary: true },
	nrrd: { mime: 'application/octet-stream', binary: true },
	// WebAssembly binary. Content-type MUST be `application/wasm`
	// (spec requirement) so `WebAssembly.instantiateStreaming(fetch(...))`
	// doesn't reject with "incorrect response MIME type". Slice 8 of
	// `dev/wasm-probe.html` is exactly this code path; without this
	// entry, the streaming-instantiate path that Unity/Godot/Emscripten
	// exports default to silently breaks even when raw WASM works.
	wasm: { mime: 'application/wasm', binary: true },
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

	constructor(options: BrowserResourceLoaderOptions) {
		this.storageRoot = options.storageRoot;
		this.appRoot = options.appRoot;
		this.bookmarksStore = options.bookmarksStore;
		this.historyStore = options.historyStore;
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
				const styleRel = loadConfig(this.appRoot).brewserStyle;
				if (styleRel) {
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
					} catch (_) {
						// Configured path missing — fall through to the baked
						// `<storageRoot>assets/main.css` so the page still has
						// SOME stylesheet.
					}
				}
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
			/<browser-search(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-search\s*>)?/gi,
			() => this.renderSearch(),
		);
		out = out.replace(
			/<browser-featured(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-featured\s*>)?/gi,
			() => this.renderGroup('featured'),
		);
		out = out.replace(
			/<browser-community(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-community\s*>)?/gi,
			() => this.renderGroup('community'),
		);
		out = out.replace(
			/<browser-experimental(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-experimental\s*>)?/gi,
			() => this.renderGroup('experimental'),
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
		// `<browser-config-artifacts>` — expands to the active
		// `config.json` `artifacts` URL (GitHub Contents API listing of
		// per-app artifact manifests). HTML-escaped, same shape as
		// `<browser-config-catalogue>`. Empty when no URL is configured;
		// the download-modal then skips the optional sanity check and
		// goes straight to the artifact-URL fetch (the artifact 404 is
		// the canonical "unknown app" signal anyway).
		out = out.replace(
			/<browser-config-artifacts(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-artifacts\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).artifacts),
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
		// `<browser-config-<provider>-client-id>` family — expands to
		// the matching `config.json` `<provider>OAuthClientId` value,
		// HTML-escaped. Stamped onto each provider's login page <body>
		// as `data-<provider>-client-id` so the per-provider auth.js
		// can read it without re-parsing config.json from the page.
		// Empty string / "REPLACE_ME" when the user hasn't configured
		// the provider; each auth script branches on those and shows
		// the misconfiguration stage instead of starting the flow.
		out = out.replace(
			/<browser-config-github-client-id(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-github-client-id\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).githubOAuthClientId),
		);
		out = out.replace(
			/<browser-config-microsoft-client-id(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-microsoft-client-id\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).microsoftOAuthClientId),
		);
		out = out.replace(
			/<browser-config-google-client-id(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-google-client-id\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).googleOAuthClientId),
		);
		out = out.replace(
			/<browser-config-twitch-client-id(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-config-twitch-client-id\s*>)?/gi,
			() => htmlEscape(loadConfig(this.appRoot).twitchOAuthClientId),
		);
		// `<browser-home-apps>` — renders the catalog group named by
		// `config.json` `homeSection` (featured / community /
		// experimental). The home page has no tab strip, so this is
		// how the user picks which catalog section the home grid
		// surfaces. Falls through to `renderGroup`, which already
		// handles the empty-list case.
		out = out.replace(
			/<browser-home-apps(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-home-apps\s*>)?/gi,
			() => this.renderGroup(loadConfig(this.appRoot).homeSection),
		);
		// `<browser-home-title>` — display name of the currently-
		// selected home section ("Featured Apps", "Community Apps",
		// "Experimental Apps"). Sits in the home page's section header
		// so the title tracks the radio selection.
		out = out.replace(
			/<browser-home-title(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-home-title\s*>)?/gi,
			() => htmlEscape(homeSectionTitle(loadConfig(this.appRoot).homeSection)),
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
		return out;
	}

	/** Render one catalog group's cards (`.app-card` links — logo on
	 * top, then title + description) styled by main.css's `.app-grid`
	 * + `.app-card` rules. Each entry comes from `catalogue.json`'s
	 * `featured` / `community` / `experimental` array; `loadCatalogGroup`
	 * builds the `brewser://apps/<group>/<id>/...` paths used for both
	 * the logo `<img src>` and the card's `href`. Empty / missing group
	 * → an empty-state `<p>`. */
	private renderGroup(group: CatalogGroup): string {
		const entries = loadCatalogGroup(this.appRoot, group);
		if (entries.length === 0) {
			return `<p class="empty">No ${group} apps yet. Add entries to <code>catalogue.json</code>'s <code>${group}</code> array.</p>`;
		}
		return renderAppCards(entries);
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
	private renderSettings(): string {
		const config = loadConfig(this.appRoot);
		const engines = loadSearchEngines(this.appRoot);
		const toolbars = loadToolbarRegistry(this.appRoot);
		const keyboards = loadKeyboardRegistry(this.appRoot);
		const styles = loadStyleRegistry(this.appRoot);

		const checked = (b: boolean) => b ? ' checked' : '';

		const toolbarRows = toolbars.length === 0
			? '<p class="empty">No toolbars registered. Edit <code>toolbars.json</code> to add one.</p>'
			: toolbars.map((e) => {
				const path = htmlEscape(e.path);
				const title = htmlEscape(e.title);
				return (
					'<label class="settings-radio">'
					+ `<input type="radio" name="setting-toolbar" value="${path}" data-setting="toolbar"${checked(e.path === config.toolbar)}>`
					+ `<span class="settings-radio-label">${title}</span>`
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
					+ `<span class="settings-radio-label">${title}</span>`
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
					+ `<span class="settings-radio-label">${title}</span>`
					+ '</label>'
				);
			}).join('');

		const themeRow = (
			'<div class="settings-row">'
			+ '<span class="settings-label">Theme</span>'
			+ '<div class="settings-radios">'
			+ `<label class="settings-radio inline"><input type="radio" name="setting-theme" value="light" data-setting="theme"${checked(config.theme === 'light')}> <span>Light</span></label>`
			+ `<label class="settings-radio inline"><input type="radio" name="setting-theme" value="dark" data-setting="theme"${checked(config.theme === 'dark')}> <span>Dark</span></label>`
			+ '</div>'
			+ '</div>'
		);

		const toolbarPositionRow = (
			'<div class="settings-row">'
			+ '<span class="settings-label">Toolbar position</span>'
			+ '<div class="settings-radios">'
			+ `<label class="settings-radio inline"><input type="radio" name="setting-toolbarPosition" value="top" data-setting="toolbarPosition"${checked(config.toolbarPosition === 'top')}> <span>Top</span></label>`
			+ `<label class="settings-radio inline"><input type="radio" name="setting-toolbarPosition" value="bottom" data-setting="toolbarPosition"${checked(config.toolbarPosition === 'bottom')}> <span>Bottom</span></label>`
			+ '</div>'
			+ '</div>'
		);

		// Home page section picker — drives the `<browser-home-apps>` +
		// `<browser-home-title>` expansions on home.html via the
		// `homeSection` config field. The home page has no in-page tab
		// strip (apps.html does), so this radio is the only way to
		// flip the visible section. Labels mirror `homeSectionTitle`
		// so the Settings copy reads the same as the rendered h2.
		const homeSectionRows = CATALOG_GROUPS.map((group) => {
			const label = homeSectionTitle(group);
			return (
				'<label class="settings-radio">'
				+ `<input type="radio" name="setting-homeSection" value="${group}" data-setting="homeSection"${checked(config.homeSection === group)}>`
				+ `<span class="settings-radio-label">${htmlEscape(label)}</span>`
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
					+ `<span class="settings-radio-label">${title}</span>`
					+ '</label>'
				);
			}).join('');

		const numberRow = (key: string, label: string, value: number, min: number, max: number, hint: string): string => (
			'<div class="settings-row">'
			+ `<label class="settings-label" for="setting-${key}">${htmlEscape(label)}<span class="settings-hint">${htmlEscape(hint)}</span></label>`
			+ `<input id="setting-${key}" name="setting-${key}" data-setting="${key}" type="number" inputmode="numeric" min="${min}" max="${max}" value="${value}">`
			+ '</div>'
		);

		const toggleRow = (key: string, label: string, value: boolean, hint: string): string => (
			'<div class="settings-row settings-row-toggle">'
			+ `<label class="settings-toggle">`
			+ `<input type="checkbox" name="setting-${key}" data-setting="${key}"${checked(value)}>`
			+ `<span class="settings-label">${htmlEscape(label)}<span class="settings-hint">${htmlEscape(hint)}</span></span>`
			+ '</label>'
			+ '</div>'
		);

		return (
			'<div class="settings-form">'
			+ '<div class="settings-row-pair">'
			+ '<fieldset class="settings-group">'
			+ '<legend>Toolbar</legend>'
			+ '<div class="settings-templates">' + toolbarRows + '</div>'
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Keyboard</legend>'
			+ '<div class="settings-templates">' + keyboardRows + '</div>'
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Style</legend>'
			+ '<div class="settings-templates">' + styleRows + '</div>'
			+ '</fieldset>'
			+ '</div>'
			+ '<div class="settings-row-pair">'
			+ '<fieldset class="settings-group">'
			+ '<legend>Home Page</legend>'
			+ '<div class="settings-templates">' + homeSectionRows + '</div>'
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Appearance</legend>'
			+ themeRow
			+ toolbarPositionRow
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Search engine</legend>'
			+ '<div class="settings-templates">' + searchRows + '</div>'
			+ '</fieldset>'
			+ '</div>'
			+ '<div class="settings-row-pair">'
			+ '<fieldset class="settings-group">'
			+ '<legend>Performance</legend>'
			+ numberRow('wwwRenderChunkMs', 'External page render budget', config.wwwRenderChunkMs, 1, 1000, 'ms per frame while building http(s) pages (1–1000)')
			+ numberRow('scrollChunkMs', 'Scroll-time render budget', config.scrollChunkMs, 1, 1000, 'ms per frame while scrolling a still-building page (1–1000)')
			+ numberRow('maxHistory', 'Max history entries', config.maxHistory, 1, 10000, 'oldest entries are dropped past this cap (1–10000)')
			+ numberRow('mouseIdleMs', 'Cursor idle hide', config.mouseIdleMs, 0, 3_600_000, 'ms of stick-idle before the cursor hides (0–3 600 000)')
			+ '</fieldset>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Behaviour</legend>'
			+ toggleRow('videoNVTEGRA', 'NVTEGRA hardware video decode', config.videoNVTEGRA, 'try the hw decoder first, fall back to software per element')
			+ toggleRow('autoRotate', 'Auto-rotate canvas', config.autoRotate, 'reserved — no consumer wired up today, value round-trips through Save')
			+ toggleRow('clickSounds', 'Click sounds', config.clickSounds, 'short click.wav on link / button / chrome activation')
			+ '</fieldset>'
			+ '</div>'
			+ '<fieldset class="settings-group">'
			+ '<legend>Diagnostics</legend>'
			+ toggleRow('navDebug', 'Navigation debug log', config.navDebug, 'writes shell-nav-diag.log on every navigation / shell input / touch')
			+ toggleRow('swbImgDebug', 'Image-load debug log', config.swbImgDebug, 'writes swb_img_diag.log per image load (capped at 500 entries)')
			+ '</fieldset>'
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
function renderAppCards(entries: ReadonlyArray<AppEntry>): string {
	return entries.map((e) => {
		const isMissing = e.missing === true;
		const logo = htmlEscape(e.logo);
		const alt = htmlEscape(`${e.title} logo`);
		const title = htmlEscape(e.title);
		const desc = e.description ? `<span>${htmlEscape(e.description)}</span>` : '';
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
			group: e.group,
			name: e.title,
			description: e.description,
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
		}))}"`;
		const missingAttr = isMissing ? ' data-missing="true"' : '';
		const missingClass = isMissing ? ' app-card--missing' : '';
		// Cards with a pending upgrade get a subtly-lighter background so
		// the upgrade-yellow chip on top has more room to breathe and the
		// row reads as "different from the rest" at a glance. Keyed on
		// `installedVersion` being set — same gate as the yellow chip.
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
		const versionChip = isMissing
			? `<div class="app-meta__version app-meta__version--new">NEW</div>`
			: e.installedVersion && e.version
				? `<div class="app-meta__version app-meta__version--upgrade"><span>v${htmlEscape(e.installedVersion)}</span>${UPGRADE_ARROW_SVG}<span>v${htmlEscape(e.version)}</span></div>`
				: e.version
					? `<div class="app-meta__version">v${htmlEscape(e.version)}</div>`
					: '';
		const licenseChip = e.license
			? `<div class="app-meta__license">${htmlEscape(e.license)}</div>`
			: '';
		// Meta strip sits at the TOP of the card now: version chip flush
		// left, license chip flush right, logo + title + description
		// stacked below. Rendered first in document order so column-flex
		// places it as the topmost row without needing any pinning.
		const meta = (versionChip || licenseChip)
			? `<div class="app-card__meta">${versionChip}${licenseChip}</div>`
			: '';
		return `<a class="app-card${missingClass}${upgradeClass}"${missingAttr}${detailAttrs}>${meta}<img class="app-logo" src="${logo}" alt="${alt}"><strong>${title}</strong>${desc}</a>`;
	}).join('');
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
function homeSectionTitle(group: CatalogGroup): string {
	switch (group) {
		case 'featured': return 'Featured Apps';
		case 'community': return 'Community Apps';
		case 'experimental': return 'Experimental Apps';
	}
}
