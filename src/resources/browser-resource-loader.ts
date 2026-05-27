import {
	notFoundResponse,
	type ResourceLoader,
	type ResourceRequest,
} from '@switch-web/runtime';
import type { BookmarksStore } from '../navigation/bookmarks-store.js';
import type { HistoryStore } from '../navigation/history-store.js';
import { loadConfig, loadTemplateRegistry } from '../profile/browser-template.js';

/**
 * Serves the browser's built-in pages.
 *
 * All `browser://` pages live on disk under the profile directory and
 * the loader reads them on demand — see `BrowserProfile.seedBuiltinPages()`
 * for how they get there.
 *
 * Two URL shapes are recognised:
 *   - Directory / page URLs: `browser://X/Y/` → tries
 *     `pages/X/Y.html` first, then `pages/X/Y/index.html`. Content-type
 *     is always `text/html`. Custom tags (`<browser-bookmarks>`,
 *     `<browser-history>`, `<browser-templates>`) are expanded
 *     server-side before the response is returned.
 *   - Static asset URLs: `browser://X/Y/assets/main.js` →
 *     `pages/X/Y/assets/main.js` with a MIME type derived from the
 *     extension. Used by demo pages that ship their own JS / CSS /
 *     image assets alongside an `index.html`.
 *
 * Path segments are locked to `[a-z][a-z0-9._-]*` (case-insensitive)
 * with the dot only allowed in the static-asset filename position, so
 * a malformed URL can't escape the profile dir.
 *
 * After reading an HTML file the loader scans for three custom tags
 * and substitutes a rendered list:
 *   `<browser-bookmarks limit="N">` → most-recently-added bookmarks
 *   `<browser-history   limit="N">` → most-recent visits
 *   `<browser-templates>`           → entries from `templates.json`
 * Substitution is a plain text replace, so authors can place the tags
 * anywhere in the document, wrap them in containers, or restyle the
 * resulting `<ul class="library-list">` via the page's own CSS.
 */

const decoder = new TextDecoder();
const DIR_SEGMENT = /^[a-z][a-z0-9-]*$/i;
const FILE_SEGMENT = /^[a-z][a-z0-9._-]*$/i;
const PATH_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/i;

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
};

export interface BrowserResourceLoaderOptions {
	profileRoot: string;
	bookmarksStore: BookmarksStore;
	historyStore: HistoryStore;
}

export class BrowserResourceLoader implements ResourceLoader {
	private readonly profileRoot: string;
	private readonly bookmarksStore: BookmarksStore;
	private readonly historyStore: HistoryStore;

	constructor(options: BrowserResourceLoaderOptions) {
		this.profileRoot = options.profileRoot;
		this.bookmarksStore = options.bookmarksStore;
		this.historyStore = options.historyStore;
	}

	canLoad(request: ResourceRequest): boolean {
		return request.url.startsWith('browser://');
	}

	async load(request: ResourceRequest): Promise<Response> {
		const canonical = canonicalUrl(request.url);
		const classification = classifyUrl(canonical);

		if (classification?.kind === 'static') {
			try {
				const data = Switch.readFileSync(`${this.profileRoot}pages/${classification.relPath}`);
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
					const data = Switch.readFileSync(`${this.profileRoot}pages/${filename}`);
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

		console.debug(`[switch-web-browser] unknown browser:// page: ${request.url}`);
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
			(_match, attrs: string | undefined) => this.renderBookmarks(parseLimit(attrs)),
		);
		out = out.replace(
			/<browser-history(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-history\s*>)?/gi,
			(_match, attrs: string | undefined) => this.renderHistory(parseLimit(attrs) ?? 50),
		);
		out = out.replace(
			/<browser-templates(\s+[^>]*)?\s*\/?>(?:\s*<\/browser-templates\s*>)?/gi,
			() => this.renderTemplates(),
		);
		return out;
	}

	private renderBookmarks(limit: number | null): string {
		let list = this.bookmarksStore.list();
		if (limit !== null) list = list.slice(0, limit);
		if (list.length === 0) {
			return '<p class="empty">No bookmarks saved yet. Tap ★ in the toolbar to add one.</p>';
		}
		return renderList(list);
	}

	private renderHistory(limit: number): string {
		const list = this.historyStore.recent(limit);
		if (list.length === 0) {
			return '<p class="empty">No visits recorded yet. Press ZR to enter a URL.</p>';
		}
		return renderList(list);
	}

	/** Render the templates registry. The currently-selected template
	 * (per `config.json`) is a plain styled button with no
	 * `data-action`, so taps don't fire — visually distinct via the
	 * `.active` CSS class. Every other row is a clickable
	 * `<button data-action="select-template:<path>">` whose tap the
	 * shell intercepts to rewrite `config.json` and reload. */
	private renderTemplates(): string {
		const entries = loadTemplateRegistry(this.profileRoot);
		if (entries.length === 0) {
			return '<p class="empty">No templates registered. Edit <code>templates.json</code> to add one.</p>';
		}
		const config = loadConfig(this.profileRoot);
		return entries.map((e) => {
			const title = htmlEscape(e.title);
			const path = htmlEscape(e.path);
			if (e.path === config.template) {
				return `<button class="template-row active">${title} · <span class="path">${path}</span> · <em>active</em></button>`;
			}
			return `<button class="template-row" data-action="select-template:${path}">${title} · <span class="path">${path}</span></button>`;
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

/** Classify a canonical `browser://...` URL into either a static-asset
 * lookup or an HTML page lookup, validating each path segment against
 * `DIR_SEGMENT` / `FILE_SEGMENT` to keep callers from escaping the
 * profile dir via `../` or other weirdness. Returns `null` if the URL
 * shape doesn't match either route. */
function classifyUrl(canonical: string): UrlClassification | null {
	const stripped = canonical.replace(/^browser:\/\//, '').replace(/\/+$/, '');
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

function renderList(entries: ReadonlyArray<{ url: string; title?: string }>): string {
	const items = entries.map((e) => {
		const label = e.title && e.title !== e.url
			? `${htmlEscape(e.title)} · <span class="url">${htmlEscape(e.url)}</span>`
			: htmlEscape(e.url);
		return `<li><a href="${htmlEscape(e.url)}">${label}</a></li>`;
	}).join('');
	return `<ul class="library-list">${items}</ul>`;
}

function htmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
