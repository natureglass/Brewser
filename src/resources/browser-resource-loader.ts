import {
	notFoundResponse,
	type ResourceLoader,
	type ResourceRequest,
} from '@switch-web/runtime';
import type { BookmarksStore } from '../navigation/bookmarks-store.js';
import type { HistoryStore } from '../navigation/history-store.js';
import { type AppEntry, loadApps, loadConfig, loadFeatured, loadTemplateRegistry, resolveSearchEngine } from '../profile/browser-template.js';

/**
 * Serves the browser's built-in pages.
 *
 * All `brewser://` pages live on disk under the profile directory and
 * the loader reads them on demand — see `BrowserProfile.seedBuiltinPages()`
 * for how they get there.
 *
 * Two URL shapes are recognised:
 *   - Directory / page URLs: `brewser://X/Y/` → tries
 *     `pages/X/Y.html` first, then `pages/X/Y/index.html`. Content-type
 *     is always `text/html`. Custom tags (`<browser-bookmarks>`,
 *     `<browser-history>`, `<browser-templates>`, `<browser-apps>`,
 *     `<browser-featured>`, `<browser-search>`) are expanded
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
 *   `<browser-templates>`           → entries from `templates.json`
 *   `<browser-apps>`                → cards from `apps.json` (full catalog)
 *   `<browser-featured>`            → cards from `featured.json` (curated subset)
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

export interface BrowserResourceLoaderOptions {
	/** Per-profile root for `pages/` lookups. */
	storageRoot: string;
	/** App-level root for `loadApps` / `loadConfig` / `loadSearchEngines` / `loadTemplateRegistry`. */
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
	 * app-level `apps/` tree (shared across profiles), the app-level
	 * `dev/` tree (HTML/CSS/canvas/WebGL test fixtures + Khronos
	 * conformance corpus), or the per-profile flat content root. The
	 * `apps.html` launcher does NOT start with `apps/`, so it correctly
	 * stays at `<storageRoot>apps.html`; `apps/<rest>` and `dev/<rest>`
	 * (where `<rest>` is non-empty) go to the app root. */
	private resolveContentPath(rel: string): string {
		if (rel.startsWith('apps/')) return `${this.appRoot}${rel}`;
		if (rel.startsWith('dev/')) return `${this.appRoot}${rel}`;
		return `${this.storageRoot}${rel}`;
	}

	async load(request: ResourceRequest): Promise<Response> {
		const canonical = canonicalUrl(request.url);
		const classification = classifyUrl(canonical);

		if (classification?.kind === 'static') {
			try {
				const data = Switch.readFileSync(this.resolveContentPath(classification.relPath));
				if (data) {
					const body = classification.binary
						? data
						: decoder.decode(data);
					return new Response(body, {
						status: 200,
						headers: { 'content-type': classification.mime },
					});
				}
			} catch (_) {
				// Missing file falls through to the 404 below.
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
	 * `<browser-templates>` tag with a rendered `<ul>` (or an
	 * empty-state `<p>`). Pages without any of the tags fall through
	 * unchanged. */
	private expandCustomTags(html: string): string {
		let out = html;
		out = out.replace(
			/<browser-bookmarks(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-bookmarks\s*>)?/gi,
			(_match, attrs: string | undefined) => this.renderBookmarks(parseLimit(attrs), parseFormat(attrs)),
		);
		out = out.replace(
			/<browser-history(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-history\s*>)?/gi,
			(_match, attrs: string | undefined) => this.renderHistory(parseLimit(attrs) ?? 50),
		);
		out = out.replace(
			/<browser-templates(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-templates\s*>)?/gi,
			() => this.renderTemplates(),
		);
		out = out.replace(
			/<browser-search(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-search\s*>)?/gi,
			() => this.renderSearch(),
		);
		out = out.replace(
			/<browser-apps(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-apps\s*>)?/gi,
			() => this.renderApps(),
		);
		out = out.replace(
			/<browser-featured(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-featured\s*>)?/gi,
			() => this.renderFeatured(),
		);
		return out;
	}

	/** Render the Apps page cards from `apps.json`. Each entry becomes a
	 * `.app-card` link (logo on top, then title + description) styled by
	 * apps.html's own stylesheet — this only emits the structural
	 * markup, mirroring `renderBookmarks`. Empty / missing catalog →
	 * an empty-state `<p>`. */
	private renderApps(): string {
		const apps = loadApps(this.appRoot);
		if (apps.length === 0) {
			return '<p class="empty">No apps installed yet. Add entries to <code>apps.json</code>.</p>';
		}
		return renderAppCards(apps);
	}

	/** Render the welcome-page "Featured Apps" grid from `featured.json`.
	 * Reuses the same `.app-card` markup as `renderApps`, so the welcome
	 * page just needs `apps.html`-style CSS for the grid + card. Empty /
	 * missing catalog → an empty-state `<p>`. */
	private renderFeatured(): string {
		const featured = loadFeatured(this.appRoot);
		if (featured.length === 0) {
			return '<p class="empty">No featured apps yet. Add entries to <code>featured.json</code>.</p>';
		}
		return renderAppCards(featured);
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

	/** Render the templates registry as radio-style rows. Each row is
	 * a `<button>` with a circle indicator on the left + the
	 * title/path label on the right. The currently-selected template
	 * (per `config.json`) carries `.active` (filled inner dot) and has
	 * no `data-action`, so taps don't fire. Every other row carries
	 * `<button data-action="select-template:<path>">` whose tap the
	 * shell intercepts to rewrite `config.json` and reload. */
	private renderTemplates(): string {
		const entries = loadTemplateRegistry(this.appRoot);
		if (entries.length === 0) {
			return '<p class="empty">No templates registered. Edit <code>templates.json</code> to add one.</p>';
		}
		const config = loadConfig(this.appRoot);
		const indicator = '<span class="radio-indicator"><span class="radio-dot"></span></span>';
		return entries.map((e) => {
			const title = htmlEscape(e.title);
			const path = htmlEscape(e.path);
			const label = `<span class="template-label">${title} · <span class="path">${path}</span></span>`;
			if (e.path === config.template) {
				return `<button class="template-row active" type="button">${indicator}${label}</button>`;
			}
			return `<button class="template-row" type="button" data-action="select-template:${path}">${indicator}${label}</button>`;
		}).join('');
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
 * absolute `brewser://` link the resource loader can serve. */
function renderAppCards(entries: ReadonlyArray<AppEntry>): string {
	return entries.map((e) => {
		const href = htmlEscape(appUrlToBrowserHref(e.url));
		const logo = htmlEscape(e.logo);
		const alt = htmlEscape(`${e.title} logo`);
		const title = htmlEscape(e.title);
		const desc = e.description ? `<span>${htmlEscape(e.description)}</span>` : '';
		return `<a class="app-card" href="${href}"><img class="app-logo" src="${logo}" alt="${alt}"><strong>${title}</strong>${desc}</a>`;
	}).join('');
}

/** Turn an `apps.json` `url` into a navigable href. Entries are
 * authored relative to the profile's `pages/` dir (`../pages/<rest>`),
 * matching how the welcome page references its assets. Navigation goes
 * through `globalThis.fetch`, which has no base-URL resolution and only
 * `brewser://` loaders registered (local fetch is disabled), so a bare
 * relative path would 404 to the error page. Strip the leading
 * `../`/`./` and the `pages/` prefix and re-express the remainder as a
 * `brewser://` URL, which `BrowserResourceLoader` maps back to
 * `<profile>/pages/<rest>`. Already-absolute URLs pass through. */
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

function htmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
