// Live-DOM for switch-web-browser. Originally Phase 1 (Stats slice);
// expanded in Phase 2.0 to a generic element surface that future
// milestones build text rendering / CSS / flex layout / form widgets
// on top of. lil-gui is the eventual phase-2.6 target.
//
// Phase 1 scope (Stats addon — FPS-counter overlay): position:fixed
// element with a visible 80×48 canvas; per-frame canvas-2d ops; tap
// cycles panels via the touch hit-tester.
//
// Phase 2.0 additions (this file): `classList` DOMTokenList shim;
// `parentElement` getter; `insertBefore` / `replaceChild`;
// `toggleAttribute`; `textContent` / `innerHTML` getter+setter (text
// stored on the element — painting in 2.1); `getBoundingClientRect`
// (viewport-relative, uses the same fixed-positioning math as the
// painter); `nextSibling` / `previousSibling` / `firstChild` /
// `lastChild`; `ownerDocument` stub; window-level event-target bridge
// so future drag handlers (`window.addEventListener('mousemove', ...)`)
// can be plumbed from the canvas touch listener.
//
// Layout / rendering is STILL Phase 1 — only position:fixed paints,
// children stack at the parent's origin, no text in non-canvas
// elements. Those land in 2.1+ atop the M2.0 surface.

import { type HtmlElement, parseHtml } from '../html/html-parser.js';
import { applyDecl, parseCssText, parseLength, serializeStyle, type CssLength, type InlineStyle } from './inline-css.js';
import { paintSvgSubtree, type SvgNodeAdapter } from './svg-painter.js';

/** Coerce a value written to `style.{width,height,...}` into a
 * `CssLength | undefined`. Accepts numbers (raw px), CssLength objects,
 * percent/px strings, and undefined. Anything unparseable lands as
 * undefined so layout code sees a missing value rather than NaN math. */
function coerceLength(v: CssLength | string | undefined): CssLength | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v === 'number') return v;
	if (typeof v === 'string') {
		const s = v.trim();
		if (s === '' || s === 'auto') return undefined;
		return parseLength(s);
	}
	// Already a CssLength object.
	return v;
}
import {
	getComputedLiveStyle, invalidateLiveStyle, registerStyleSheet, resetLiveCss, unregisterStyleSheet,
} from './live-css.js';
// Runtime-only import (used inside the innerHTML setter). html-to-live
// imports LiveElement back from this module — the cycle is safe because
// neither side touches the other's exports at module-eval time.
import { loadIframeContents, parseFragmentInto } from './html-to-live.js';
import {
	getInputChecked, getInputValue, setInputChecked, setInputValue,
} from './live-form.js';
import {
	videoCurrentTime, videoDuration, videoErrorMessage, videoIsEnded,
	videoIsPaused, videoPause, videoPlay, videoResetSource, videoSeek,
	videoGetVolume, videoSetVolume, videoIsMuted, videoSetMuted,
	videoGetAudioLevels, videoGetFrequencyData, videoGetWaveform,
} from './live-video.js';
import { getInlineLayout, getLayoutBox } from './live-layout.js';
import {
	isLiveCacheBuilding, patchLiveCacheRegion, scrollElementIntoView,
	syncLiveCacheVersion,
} from './live-overlay.js';
import { markLiveDirty, requestFullRepaint } from './live-paint-control.js';

const LIVE_ELEMENT_BRAND = Symbol('LiveElement');

// =========================================================================
// `<img>` src resolution
// =========================================================================
// nx.js's `Image` fetch resolves a relative URL against the runtime base
// (`romfs:/`), NOT the page — so a page-authored relative path read the
// BUNDLED romfs copy instead of the editable profile copy (and required a
// full .nro rebuild + redeploy to update). `browser://` URLs can't be
// fetched by Image at all (its fetch's protocol registry has no browser
// loader). The shell sets the active profile root here so `<img>` srcs that
// use the profile-pages convention (`../pages/<rest>`, `browser://<rest>`)
// resolve to the absolute `<profile>/pages/<rest>` SD-card path, loading the
// same file the rest of the browser serves — editable via a profile sync.
let liveProfileRoot = '';
let livePageBase = '';
export function setLiveProfileRoot(root: string): void { liveProfileRoot = root; }

// =========================================================================
// Animated-GIF ticker registry
// =========================================================================

/** nx.js's `Image` class gains three multi-frame accessors when a GIF
 * is decoded (see image.ts in nxjs-source). Web `HTMLImageElement`
 * doesn't model these, so we narrow via this typed view at the call
 * site instead of polluting the global Image declaration. */
interface GifAnimatedImage {
	frameCount: number;
	frameDelay(index: number): number;
	setFrame(index: number): void;
}

/** Hard floor on per-frame delay. GIF spec allows 0 ("as fast as
 * possible"), which would peg the timer at native frame rate and burn
 * CPU painting the same image; real browsers clamp similarly. */
const GIF_MIN_FRAME_DELAY_MS = 20;
function clampGifDelay(ms: number): number {
	if (!Number.isFinite(ms) || ms < GIF_MIN_FRAME_DELAY_MS) return GIF_MIN_FRAME_DELAY_MS;
	return ms;
}

/** Every active GIF frame-ticker. The shell calls `clearGifAnimations`
 * on page-change so previously-scheduled `setFrame` + repaint calls
 * don't fire on detached elements (and clobber the new page's cache). */
const activeGifAnimations = new Set<{ cancel: () => void }>();

export function clearGifAnimations(): void {
	for (const t of activeGifAnimations) t.cancel();
	activeGifAnimations.clear();
}

// =========================================================================
// CSS background-image cache. Keys are RAW (unresolved) URL strings as
// they appear in the cascade. Each entry lazily kicks off a network /
// disk load on first lookup; subsequent lookups return the cached
// image source (HTMLImageElement for raster formats; OffscreenCanvas
// for SVG which we rasterize ourselves since nx.js's image decoder
// has no SVG support). On load success we bump `liveTreeVersion` so
// the next paint draws the image instead of leaving the layer blank.
// Cleared on page nav.
// =========================================================================

/** Image source for a CSS background — either a raster `HTMLImageElement`
 * (nx.js's Image, decoded by the C-side decoder) or an OffscreenCanvas
 * we rasterize ourselves for SVG. Both are valid `CanvasImageSource`
 * args to `drawImage`. */
export type BgImageSource = HTMLImageElement | OffscreenCanvas;

interface BgImageEntry {
	img: BgImageSource | null;
	failed: boolean;
}
const bgImageCache = new Map<string, BgImageEntry>();

/** Lookup-or-load a background-image URL. Returns the loaded image, or
 * `null` while still loading / on permanent failure. Triggers a fresh
 * load + tree-version bump on first call per URL. */
export function getBackgroundImage(url: string): BgImageSource | null {
	if (!url) return null;
	const existing = bgImageCache.get(url);
	if (existing) return existing.failed ? null : existing.img;
	const entry: BgImageEntry = { img: null, failed: false };
	bgImageCache.set(url, entry);
	const resolved = resolveLiveResourceUrl(url);
	_imgDiag('[' + new Date().toISOString() + '] BG-START url=' + url + ' resolved=' + resolved);
	// SVG is now handled by the native decoder (nanosvg in image.c) so
	// .svg URLs flow through the same `new Image()` path as raster
	// formats. `rasterizeSvgBackground` stays defined below as a
	// defensive fallback path but is no longer wired in.
	try {
		const img: HTMLImageElement = new (globalThis as unknown as {
			Image: new () => HTMLImageElement;
		}).Image();
		img.onload = () => {
			_imgDiag('[' + new Date().toISOString() + '] BG-LOAD ok url=' + url
				+ ' w=' + img.naturalWidth + ' h=' + img.naturalHeight);
			entry.img = img;
			bumpLiveTreeVersion();
			// `bumpLiveTreeVersion` alone only invalidates the cache —
			// it doesn't wake the paint loop. On idle pages (DDG result
			// list after layout settles) the loop was sleeping, so the
			// duck logo only appeared after the user scrolled twice
			// (first scroll = stale cache blit, second = full rebuild).
			// Active repaint matches what `<img>` element loadImage does.
			requestFullRepaint();
		};
		img.onerror = () => {
			_imgDiag('[' + new Date().toISOString() + '] BG-LOAD fail url=' + url);
			entry.failed = true;
		};
		img.src = resolved;
	} catch (err) {
		entry.failed = true;
		_imgDiag('[' + new Date().toISOString() + '] BG-LOAD threw url=' + url + ' err=' + String(err));
	}
	return null;
}

/** Fetch + rasterize an SVG URL into an OffscreenCanvas, store on
 * `entry.img` when done. Uses html-parser's permissive HTML5 mode —
 * good enough for the simple-shapes SVGs sites actually serve
 * (favicons, logos, icon glyphs). Sizing comes from `viewBox` first,
 * then `width`/`height` attrs, then a 24×24 fallback. Failures (404,
 * unparseable, no shapes) are silent — entry.failed flips so we don't
 * re-attempt. */
async function rasterizeSvgBackground(url: string, resolved: string, entry: BgImageEntry): Promise<void> {
	try {
		const res = await fetch(resolved);
		if (!res.ok) {
			_imgDiag('[' + new Date().toISOString() + '] BG-LOAD fail (svg http ' + res.status + ') url=' + url);
			entry.failed = true;
			return;
		}
		const svgText = await res.text();
		const tree = parseHtml(svgText);
		// The parser wraps top-level elements under a synthetic root.
		// Real SVG documents have <svg> at the top; if the parser
		// HTML-wrapped them (under <html><body>), defensively unwrap.
		const svgEl = findSvgRoot(tree);
		if (!svgEl) {
			_imgDiag('[' + new Date().toISOString() + '] BG-LOAD fail (svg no root) url=' + url);
			entry.failed = true;
			return;
		}
		const { width, height, vbX, vbY, vbW, vbH } = readSvgViewport(svgEl);
		if (width <= 0 || height <= 0) {
			entry.failed = true;
			return;
		}
		// Rasterize at up to 2x the natural size so we have headroom when
		// the background is scaled up (most CSS-sized SVGs end up larger
		// than their viewBox). Capped to keep memory reasonable for big
		// logos.
		const scale = Math.min(2, Math.max(1, 64 / Math.max(width, height)));
		const cw = Math.max(1, Math.round(width * scale));
		const ch = Math.max(1, Math.round(height * scale));
		const oc = new OffscreenCanvas(cw, ch);
		const octx = oc.getContext('2d');
		if (!octx) { entry.failed = true; return; }
		// Map viewBox → canvas so SVG user-space coordinates land in
		// [0, cw] × [0, ch] regardless of viewBox origin or aspect.
		octx.scale(cw / vbW, ch / vbH);
		octx.translate(-vbX, -vbY);
		paintSvgSubtree(octx as OffscreenCanvasRenderingContext2D, svgEl, BG_SVG_ADAPTER);
		_imgDiag('[' + new Date().toISOString() + '] BG-LOAD ok (svg) url=' + url
			+ ' w=' + cw + ' h=' + ch);
		entry.img = oc as unknown as BgImageSource;
		bumpLiveTreeVersion();
	} catch (err) {
		_imgDiag('[' + new Date().toISOString() + '] BG-LOAD threw (svg) url=' + url + ' err=' + String(err));
		entry.failed = true;
	}
}

/** Locate the `<svg>` element inside an html-parser tree. */
function findSvgRoot(node: HtmlElement): HtmlElement | null {
	if (node.tag === 'svg') return node;
	for (const child of node.children) {
		if (child.type !== 'element') continue;
		const found = findSvgRoot(child);
		if (found) return found;
	}
	return null;
}

/** Resolve an `<svg>` element's intrinsic dimensions + viewBox. Width /
 * height attrs override viewBox-derived sizing per SVG spec; if both
 * are missing we fall back to the viewBox extent, then a 24×24 default
 * so a malformed SVG still rasterizes to *something*. */
function readSvgViewport(svgEl: HtmlElement): { width: number; height: number; vbX: number; vbY: number; vbW: number; vbH: number } {
	const attrs = svgEl.attrs ?? {};
	const wAttr = parseFloat(attrs['width'] ?? '');
	const hAttr = parseFloat(attrs['height'] ?? '');
	// html-parser lowercases attr names — viewBox → viewbox.
	const vbRaw = attrs['viewbox'];
	let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
	if (vbRaw) {
		const parts = vbRaw.trim().split(/[\s,]+/).map(parseFloat);
		if (parts.length === 4 && parts.every((p) => Number.isFinite(p))) {
			vbX = parts[0]; vbY = parts[1]; vbW = parts[2]; vbH = parts[3];
		}
	}
	const width = Number.isFinite(wAttr) && wAttr > 0 ? wAttr : (vbW > 0 ? vbW : 24);
	const height = Number.isFinite(hAttr) && hAttr > 0 ? hAttr : (vbH > 0 ? vbH : 24);
	if (vbW <= 0) vbW = width;
	if (vbH <= 0) vbH = height;
	return { width, height, vbX, vbY, vbW, vbH };
}

/** SVG-painter adapter over html-parser's HtmlElement shape — same
 * fields as live-overlay's LIVE_SVG_ADAPTER but reading the parsed
 * primitives directly so we don't construct LiveElements just to
 * rasterize an icon. */
const BG_SVG_ADAPTER: SvgNodeAdapter<HtmlElement> = {
	tag(n) { return n.tag; },
	attr(n, name) {
		return n.attrs ? n.attrs[name.toLowerCase()] : undefined;
	},
	children(n) {
		const kids = n.children ?? [];
		return kids.filter((c): c is HtmlElement => c.type === 'element');
	},
};

/** Wipe the background-image cache on page navigation so loads from
 * the previous page don't leak into the new one. */
export function clearBackgroundImageCache(): void {
	bgImageCache.clear();
}

// =========================================================================
// Image-load diagnostic — appends every `<img>` load attempt + result to
// `sdmc:/switch/webprofiles/default/logs/swb_img_diag.log` so we can
// diagnose missing-image bugs on real hardware (where stdout/stderr aren't
// easy to see). Capped so a broken page can't fill the SD card. Set
// `IMG_DIAG` to `false` to silence.
// =========================================================================

const IMG_DIAG = true;
const IMG_DIAG_PATH = 'sdmc:/switch/webprofiles/default/logs/swb_img_diag.log';
const IMG_DIAG_CAP = 500;
let _imgDiagCount = 0;
function _imgDiag(msg: string): void {
	if (!IMG_DIAG || _imgDiagCount >= IMG_DIAG_CAP) return;
	_imgDiagCount++;
	try {
		const sw = (globalThis as { Switch?: { appendFileSync?: (p: string, d: string) => void } }).Switch;
		sw?.appendFileSync?.(IMG_DIAG_PATH, msg + '\n');
	} catch (_) { /* ignore */ }
}

/** SD-card directory of the page currently loaded (e.g.
 * `sdmc:/switch/webprofiles/default/pages/apps/mediaplayer/`). Set by
 * the shell per navigation; used to resolve PAGE-relative `<img>` srcs
 * (`./assets/x.png`) so `index.html` acts as the base, like a real browser. */
export function setLivePageBase(dir: string): void { livePageBase = dir; }

/** Resolve a relative path against an absolute `scheme:/a/b/` base,
 * honoring `.` / `..` segments. */
function resolveAgainstBase(baseDir: string, rel: string): string {
	const m = /^([a-z][a-z0-9+.-]*:\/)(.*)$/i.exec(baseDir);
	if (!m) return baseDir + rel;
	const parts = m[2].split('/').filter(Boolean);
	for (const seg of rel.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') { parts.pop(); continue; }
		parts.push(seg);
	}
	return m[1] + parts.join('/');
}

/** Resolve a live-DOM resource URL (`<img>` src, `<audio>`/`<video>` src)
 * to a fetchable absolute URL using the page-relative architecture. Shared
 * so every resource reference resolves the same way. */
export function resolveLiveResourceUrl(src: string): string {
	const s = src.trim();
	if (!s) return s;
	// Already a fetchable absolute scheme → use as-is.
	if (/^(?:sdmc|romfs|file|data|blob|https?):/i.test(s)) return s;
	// `browser://<rest>` is an absolute browser URL → map to the profile
	// pages path (Image can't fetch the `browser:` scheme).
	if (/^browser:\/\//i.test(s)) {
		if (!liveProfileRoot) return s;
		const rel = s.replace(/^browser:\/\//i, '').replace(/^pages\//, '');
		return `${liveProfileRoot}pages/${rel}`;
	}
	// Everything else is PAGE-relative — resolved against the page's own
	// directory (`index.html` as the base), like a real browser. This is
	// uniform across all pages; `./assets/x.png`, `assets/x.png` and
	// `../sibling/x.png` all resolve relative to the current page.
	if (livePageBase) {
		// External http(s) pages: defer to the standard `URL` parser,
		// which handles root-relative (`/x`), directory-relative
		// (`./x`, `../x`), protocol-relative (`//host/x`), and
		// absolute (`scheme://...`) hrefs against the page URL in one
		// step. Required for tier3-style pages whose assets are root-
		// relative — see `BrowserShell.computeLivePageBase`. Falls
		// back to the original src on a malformed input so a bad
		// attribute doesn't throw out of the load path.
		if (/^https?:\/\//i.test(livePageBase)) {
			try { return new URL(s, livePageBase).toString(); }
			catch (_) { return s; }
		}
		return resolveAgainstBase(livePageBase, s);
	}
	return s;
}

// =========================================================================
// Live tree version counter (Phase 1.5, 2026-05-25)
// =========================================================================
//
// Bumped every time the live-DOM tree mutates in a way that could change
// the rendered output: appendChild/removeChild/insertBefore/replaceChild,
// setAttribute/removeAttribute/toggleAttribute, textContent / innerHTML /
// value / checked writes, classList mutations, AND inline-style writes
// (via the LiveStyle Proxy on LiveElement construction).
//
// `paintLiveOverlay` reads this and skips re-cascade + re-layout when the
// version matches the last paint — collapses scroll-only paints from
// "walk the entire cascade for ~150 elements" to "re-blit body subtree
// via cached layout boxes." That's the FPS difference between Phase 1
// (re-layout every frame) and Phase 1.5 (re-layout only on mutation).
//
// Side effect for callers: page scripts that mutate state DON'T need to
// call any "invalidate" API; mutation hooks bump the counter automatically.
let liveTreeVersion = 0;
export function bumpLiveTreeVersion(): void { liveTreeVersion++; }
export function getLiveTreeVersion(): number { return liveTreeVersion; }
function resetLiveTreeVersion(): void { liveTreeVersion = 0; }

/**
 * Minimal `DOMTokenList` shim returned by `el.classList`. Stores tokens
 * in insertion order with set semantics (duplicates ignored). Backed by
 * a plain `Set<string>` for O(1) contains.
 *
 * lil-gui calls .add / .toggle / .contains heavily ("controller", "name",
 * "widget", "number", "hasSlider", "active" etc.). The painter's CSS
 * cascade (M2.2) will read this list via `.contains` and `forEach`.
 */
export class LiveTokenList {
	private readonly tokens = new Set<string>();
	/** Owning element — set by LiveElement's constructor. Mutations
	 * notify the element's invalidation hook so the M2.2 CSS cascade
	 * recomputes on the next paint. Optional so tests can construct a
	 * standalone token list. */
	owner: LiveElement | null = null;
	private notify(): void {
		// Bump tree version FIRST so paintLiveOverlay can detect the
		// mutation. invalidateLiveStyle would also bump (see live-css.ts),
		// but the chained call ensures both the style cache and the
		// live-overlay cache see a consistent dirty signal.
		bumpLiveTreeVersion();
		if (this.owner) invalidateLiveStyle(this.owner);
	}
	get length(): number { return this.tokens.size; }
	add(...names: string[]): void {
		for (const n of names) {
			const trimmed = n.trim();
			if (trimmed) this.tokens.add(trimmed);
		}
		this.notify();
	}
	remove(...names: string[]): void {
		for (const n of names) this.tokens.delete(n.trim());
		this.notify();
	}
	contains(name: string): boolean {
		return this.tokens.has(name);
	}
	toggle(name: string, force?: boolean): boolean {
		const trimmed = name.trim();
		if (!trimmed) return false;
		const present = this.tokens.has(trimmed);
		const target = force === undefined ? !present : !!force;
		if (target) this.tokens.add(trimmed);
		else this.tokens.delete(trimmed);
		this.notify();
		return target;
	}
	replace(oldName: string, newName: string): boolean {
		if (!this.tokens.has(oldName)) return false;
		this.tokens.delete(oldName);
		if (newName.trim()) this.tokens.add(newName.trim());
		this.notify();
		return true;
	}
	forEach(fn: (value: string) => void): void {
		this.tokens.forEach(fn);
	}
	values(): IterableIterator<string> {
		return this.tokens.values();
	}
	get value(): string {
		return Array.from(this.tokens).join(' ');
	}
	set value(v: string) {
		this.tokens.clear();
		if (v) {
			for (const tok of v.split(/\s+/)) {
				if (tok) this.tokens.add(tok);
			}
		}
		this.notify();
	}
	toString(): string { return this.value; }
}

/** Detect a LiveElement without `instanceof` (works across class-
 * identity issues if the module ever gets re-evaluated). */
export function isLiveElement(v: unknown): v is LiveElement {
	return !!v && typeof v === 'object' && (v as { [LIVE_ELEMENT_BRAND]?: true })[LIVE_ELEMENT_BRAND] === true;
}

export class LiveElement {
	readonly [LIVE_ELEMENT_BRAND] = true as const;
	readonly tagName: string;
	readonly style: LiveStyle;
	readonly attrs: Record<string, string> = {};
	readonly classList: LiveTokenList;
	parent: LiveElement | null = null;
	readonly children: LiveElement[] = [];
	private listeners: Map<string, Set<Function>> | null = null;
	/** For `<canvas>`: lazy-allocated OffscreenCanvas backing the 2D
	 * context. `null` for non-canvas tags. Also re-pointed by Phase 3b
	 * `attachOffscreen` to share a canvas-runner-owned offscreen. */
	private offscreen: OffscreenCanvas | null = null;
	private canvasCtx2d: OffscreenCanvasRenderingContext2D | null = null;
	/** Phase 3b: true iff the attached offscreen is fed by the shared
	 * screen GL bridge (live painter skips drawImage, shell's per-frame
	 * overlay does copyBridgeToScreen instead). Always false for
	 * canvases obtained by `getContext('2d')` from this LiveElement. */
	private _webglBacked = false;
	/** For `<img>`: the loaded Image instance (or null while loading
	 * or on failure). Set asynchronously from `loadImage()` on first
	 * `src` attribute assignment. Painter reads via `getLoadedImage()`. */
	private loadedImage: HTMLImageElement | null = null;
	/** True once an `<img>` src fails to load. The painter shows the
	 * `alt` placeholder ONLY in this state; a still-loading image renders
	 * nothing (just reserves its box). Reset on each new `loadImage`. */
	private imageLoadFailed = false;
	/** Animated-GIF frame ticker. Null for static images and for
	 * elements whose load hasn't completed (or whose decoded image has
	 * `frameCount <= 1`). Cancelled by `loadImage` on re-load, and by
	 * `clearGifAnimations()` from the shell on page navigation. */
	private gifAnimation: { cancel: () => void } | null = null;
	/** Per-element width/height, used both as canvas-pixel dims (when
	 * tag is `canvas`) and as fallback paint-size for fixed div
	 * backgrounds. Defaults match HTMLCanvasElement (300×150). */
	private _width = 300;
	private _height = 150;
	/** Tracks whether this element (or an ancestor) is currently
	 * attached to the live root. Maintained by appendChild/removeChild
	 * so the registry-driven painter can shortcut traversal. */
	attached = false;
	/** Plain text content (set via `.textContent =` / `.innerHTML =`).
	 * Stored in M2.0; rendered by the painter in M2.1. innerHTML strips
	 * tags rather than parsing (lil-gui only assigns text strings, not
	 * markup, so this is fine). */
	private _text = '';

	constructor(tag: string) {
		// `#text` text nodes keep their tagName lowercase (DOM spec uses
		// `#text` literally for Text.nodeName / .tagName). Element tags
		// uppercase per the spec. Tests use `tagName === '#text'` to
		// branch into inline-text paint, so the case sensitivity matters.
		this.tagName = tag === '#text' ? '#text' : tag.toUpperCase();
		// Phase 1.5 + 1.5.1 (2026-05-25): wrap inline style in a Proxy
		// so per-property writes (`el.style.width = '83.5%'`, lil-gui's
		// slider pattern) invalidate THIS element's subtree only.
		// `invalidateLiveStyle(self)` walks self+descendants in the
		// computed-style cache and bumps liveTreeVersion. Other elements'
		// cached cascades are preserved — saves ~80-150 ms per tap on
		// 150-element pages (the rebuild was previously re-cascading
		// every element).
		const rawStyle = new LiveStyle();
		const self = this;
		this.style = new Proxy(rawStyle, {
			set(target, prop, value) {
				(target as unknown as Record<string | symbol, unknown>)[prop as string] = value;
				invalidateLiveStyle(self);
				return true;
			},
		}) as LiveStyle;
		this.classList = new LiveTokenList();
		this.classList.owner = this;
		// Canvas defaults to 300×150 per HTMLCanvasElement spec.
		if (this.tagName === 'CANVAS') {
			this._width = 300;
			this._height = 150;
		}
	}

	get nodeName(): string { return this.tagName; }
	/** DOM spec: ELEMENT_NODE = 1, TEXT_NODE = 3. */
	get nodeType(): number { return this.tagName === '#text' ? 3 : 1; }
	/** Text nodes only. `el.data` mirrors `el.textContent` for `#text`
	 * elements — that's the inline-flow content payload. For non-text
	 * elements this is a no-op getter returning ''. Real DOM puts this
	 * on CharacterData; here we expose it on LiveElement for simplicity. */
	get data(): string { return this.tagName === '#text' ? this._text : ''; }
	set data(v: string) {
		if (this.tagName !== '#text') return;
		this._text = v == null ? '' : String(v);
		invalidateLiveStyle(this);
	}
	/** DOM-spec `parentElement` getter. Real DOM distinguishes it from
	 * `parentNode` (returns `null` for non-element parents); here our
	 * tree only has elements, so both alias `parent`. */
	get parentElement(): LiveElement | null { return this.parent; }
	get parentNode(): LiveElement | null { return this.parent; }
	get ownerDocument(): unknown { return getOwnerDocument(); }
	get firstChild(): LiveElement | null { return this.children[0] ?? null; }
	get lastChild(): LiveElement | null {
		return this.children.length ? this.children[this.children.length - 1] : null;
	}
	get nextSibling(): LiveElement | null {
		if (!this.parent) return null;
		const siblings = this.parent.children;
		const i = siblings.indexOf(this);
		return i >= 0 && i + 1 < siblings.length ? siblings[i + 1] : null;
	}
	get previousSibling(): LiveElement | null {
		if (!this.parent) return null;
		const siblings = this.parent.children;
		const i = siblings.indexOf(this);
		return i > 0 ? siblings[i - 1] : null;
	}
	get childNodes(): LiveElement[] { return this.children; }

	/** Spec `className` accessor — round-trips via classList so both
	 * forms (`el.className = 'a b'` and `el.classList.add('a')`) stay in
	 * sync. lil-gui's stylesheet selectors lean on this. */
	get className(): string { return this.classList.value; }
	set className(v: string) { this.classList.value = v; }

	/** `textContent` — concatenates all child text plus this node's own
	 * text. lil-gui never uses this for reading; setter is what matters.
	 *
	 * For `<style>` elements, the new text is parsed as a stylesheet
	 * and registered with the M2.2 cascade. Subsequent reassignments
	 * (lil-gui's pattern: build the rules string, then `style.innerHTML
	 * = rules`) replace the previous registration. */
	get textContent(): string { return this._text; }
	set textContent(v: string) {
		this._text = v == null ? '' : String(v);
		// Setting textContent removes all children per DOM spec. lil-gui
		// uses this pattern on `$display.innerHTML = '...'` to replace
		// the current select option text — there are no real children to
		// drop, but matching the spec keeps the surface predictable.
		while (this.children.length) {
			const c = this.children[this.children.length - 1];
			this.removeChild(c);
		}
		if (this.tagName === 'STYLE') {
			registerStyleSheet(this, this._text);
		}
		invalidateLiveStyle(this);
	}

	/** `innerHTML`. A plain string (no `<`) takes the fast path and
	 * behaves like `textContent` — preserves lil-gui's short-label
	 * assignments ("Controls", "✓", "Linear") and keeps the
	 * `textContent` getter accurate. A string containing markup is parsed
	 * into child LiveElements via the shared HtmlElement→Live converter,
	 * so page scripts that build structured DOM (e.g. an audio player's
	 * playlist rows) render with real nested elements + cascade matching,
	 * not the raw tag text. */
	get innerHTML(): string { return this._text; }
	set innerHTML(v: string) {
		const s = v == null ? '' : String(v);
		if (s.indexOf('<') < 0) { this.textContent = s; return; }
		// Clear existing content (children + _text), then graft the parsed
		// fragment. `textContent = ''` also fires the STYLE-sheet
		// unregister + invalidateLiveStyle paths.
		this.textContent = '';
		parseFragmentInto(this, s);
		invalidateLiveStyle(this);
		bumpLiveTreeVersion();
	}

	/** M2.4 form-element accessors. `.value` works for INPUT / SELECT /
	 * TEXTAREA; `.checked` for INPUT[type=checkbox]. Storage is a
	 * per-element WeakMap in live-form.ts so the LiveElement class
	 * stays form-agnostic and tests can mutate widget state without
	 * dragging the painter in. */
	get value(): string { return getInputValue(this); }
	set value(v: string) {
		setInputValue(this, v == null ? '' : String(v));
		invalidateLiveStyle(this);
	}
	get checked(): boolean { return getInputChecked(this); }
	set checked(v: boolean) {
		setInputChecked(this, !!v);
		// Mirror to attribute so the M2.2 :checked selector picks it up.
		if (v) {
			if (!this.hasAttribute('checked')) this.setAttribute('checked', '');
		} else if (this.hasAttribute('checked')) {
			this.removeAttribute('checked');
		}
	}
	// HTMLInputElement reflected attributes. Per the HTML spec `input.min`
	// / `.max` / `.step` are string properties that reflect the matching
	// attribute. Pages rely on them — e.g. an audio player computing a
	// seek position as `Number(seek.value) / Number(seek.max)`. Without
	// these getters `seek.max` was `undefined` → `Number(undefined)` =
	// `NaN` → the computed seek target was `NaN`, which `set currentTime`
	// coerces to 0, so every seek jumped to the start.
	get min(): string { return this.getAttribute('min') ?? ''; }
	set min(v: string) { this.setAttribute('min', v == null ? '' : String(v)); }
	get max(): string { return this.getAttribute('max') ?? ''; }
	set max(v: string) { this.setAttribute('max', v == null ? '' : String(v)); }
	get step(): string { return this.getAttribute('step') ?? ''; }
	set step(v: string) { this.setAttribute('step', v == null ? '' : String(v)); }

	/** Slice 2a HTMLMediaElement-shaped accessors for <video>. State and
	 * decoder live in live-video.ts's WeakMap. Reading these on non-VIDEO
	 * elements is well-defined (returns paused=true / duration=0 / etc.)
	 * since live-video accepts any LiveElement, so we don't gate by tag.
	 */
	get currentTime(): number { return videoCurrentTime(this); }
	set currentTime(v: number) { videoSeek(this, +v || 0); }
	get duration(): number { return videoDuration(this); }
	get paused(): boolean { return videoIsPaused(this); }
	get ended(): boolean { return videoIsEnded(this); }
	get error(): string | null { return videoErrorMessage(this); }
	// HTMLMediaElement.volume / .muted — wired to the decoder's audrv gain
	// (videoSetVolume → audrvVoiceSetVolume) + mute. The desired value is
	// remembered in live-video state so it survives decoder re-opens.
	get volume(): number { return videoGetVolume(this); }
	set volume(v: number) { videoSetVolume(this, +v); }
	get muted(): boolean { return videoIsMuted(this); }
	set muted(v: boolean) { videoSetMuted(this, !!v); }
	play(): void { videoPlay(this); }
	pause(): void { videoPause(this); }
	/** `HTMLMediaElement.src` reflects the `src` attribute (per spec), so
	 * `audio.src = '...'` reaches `resolveSourceForDecoder` (which reads
	 * the attribute). A plain JS-property set would NOT, leaving the
	 * decoder with no source. */
	get src(): string { return this.getAttribute('src') ?? ''; }
	set src(v: string) { this.setAttribute('src', v == null ? '' : String(v)); }
	/** `HTMLMediaElement.load()` — reset the media pipeline so the next
	 * `play()` opens a decoder for the CURRENT `src`. Used when switching
	 * sources (e.g. an audio player's next/prev track). */
	load(): void { videoResetSource(this); }
	/** Non-standard: audio-reactive per-band levels (low→high, ~0..1) at the
	 * play head, for music visualizers. Empty array when not playing / no
	 * audio. Stands in for the absent Web Audio AnalyserNode. */
	getAudioLevels(): number[] { return videoGetAudioLevels(this); }
	/** Non-standard: fill `out` with the play-head frequency spectrum
	 * (low→high, ~0..1). Returns true when written. ~getByteFrequencyData. */
	getFrequencyData(out: Float32Array): boolean { return videoGetFrequencyData(this, out); }
	/** Non-standard: fill `out` with the play-head time-domain waveform
	 * (-1..1). Returns true when written. ~getByteTimeDomainData. */
	getWaveform(out: Float32Array): boolean { return videoGetWaveform(this, out); }

	/** M2.5 scroll accessors. `scrollTop` reads/writes the current
	 * vertical scroll offset (clamped to [0, scrollHeight-clientHeight]
	 * by the layout / touch handler). `scrollHeight` / `clientHeight`
	 * are derived from the M2.3 layout box. */
	private _scrollTop = 0;
	get scrollTop(): number { return this._scrollTop; }
	set scrollTop(v: number) {
		const nv = Math.max(0, v | 0);
		if (nv === this._scrollTop) return;
		this._scrollTop = nv;
		// Scrollable containers are painted as per-frame overlays (NOT baked
		// into the body cache), so a scroll only needs a repaint — NOT a cache
		// rebuild / re-layout (which would be the multi-second freeze on heavy
		// pages). Don't bump the tree version; just request a repaint.
		requestFullRepaint();
	}
	get scrollHeight(): number {
		const lb = getLayoutBox(this);
		return lb ? Math.max(lb.intrinsicContentH, lb.contentH) : 0;
	}
	get scrollWidth(): number {
		const lb = getLayoutBox(this);
		return lb ? Math.max(lb.intrinsicContentW, lb.contentW) : 0;
	}
	get clientHeight(): number {
		const lb = getLayoutBox(this);
		return lb ? lb.contentH : 0;
	}
	get clientWidth(): number {
		const lb = getLayoutBox(this);
		return lb ? lb.contentW : 0;
	}

	/** Scroll the nearest scrollable ancestor so this element is visible.
	 * Page scripts use it to keep a selected list row on screen. Vertical
	 * only; the optional arg is accepted for DOM-API shape and ignored. */
	scrollIntoView(_arg?: unknown): void {
		scrollElementIntoView(this);
	}

	get width(): number { return this._width; }
	set width(v: number) {
		this._width = v | 0;
		if (this.offscreen && this.tagName === 'CANVAS') {
			// Resizing an OffscreenCanvas in nx.js: assign width/height
			// directly. The 2D context (if already obtained) becomes
			// stale; the next getContext('2d') re-attaches.
			this.offscreen.width = this._width;
		}
	}
	get height(): number { return this._height; }
	set height(v: number) {
		this._height = v | 0;
		if (this.offscreen && this.tagName === 'CANVAS') {
			this.offscreen.height = this._height;
		}
	}

	/** Spec-shaped attribute setter — currently only stores. Style
	 * attribute (`setAttribute('style', '...')`) re-parses cssText.
	 * `class` mirrors into `classList` for future CSS-cascade lookups. */
	setAttribute(name: string, value: string): void {
		const lower = name.toLowerCase();
		this.attrs[lower] = value;
		if (lower === 'style') this.style.cssText = value;
		else if (lower === 'class') this.classList.value = value;
		// Batch B: `<img src="...">` triggers an async load. onload bumps
		// the live tree version so the cache rebuilds with the loaded
		// image. `romfs:/` / `sdmc:/` work; `browser://` may not per
		// [[nxjs-image-bypasses-global-fetch]].
		else if (lower === 'src' && this.tagName === 'IMG') {
			this.loadImage(value);
		}
		// `<iframe src="...">` triggers a separate fetch+parse+graft.
		// Tier 1B: content is fetched, parsed, and appended as iframe
		// children. Scripts are skipped; styles get scoped to the
		// iframe's subtree only (see html-to-live.ts loadIframeContents).
		else if (lower === 'src' && this.tagName === 'IFRAME') {
			loadIframeContents(this, value);
		}
		// Phase 3b (2026-05-26): `<canvas width="640" height="360">`
		// — sync the parsed-attr value into `_width` / `_height` so
		// the leaf layout's `getDisplaySize()` returns the canvas's
		// declared intrinsic dims instead of the HTMLCanvasElement
		// 300×150 default. Without this, parsed-but-script-less
		// canvases (or canvases whose script doesn't draw before the
		// first paint) would size at 300×150 regardless of HTML attrs.
		else if ((lower === 'width' || lower === 'height') && this.tagName === 'CANVAS') {
			const n = parseInt(value, 10);
			if (Number.isFinite(n) && n > 0) {
				if (lower === 'width') {
					this._width = n;
					if (this.offscreen) this.offscreen.width = n;
				} else {
					this._height = n;
					if (this.offscreen) this.offscreen.height = n;
				}
			}
		}
		// M2.2: any attr change can affect CSS cascade ([type=text] etc.).
		invalidateLiveStyle(this);
	}

	/** Async-load an image from `src` and cache it on this element so
	 * the painter / layout pass can read `naturalWidth` + `drawImage`
	 * once the load completes. Loading is fire-and-forget; the live
	 * tree version bumps in `onload` to trigger a fresh paint. */
	private loadImage(src: string): void {
		this.loadedImage = null;
		this.imageLoadFailed = false;
		// Cancel any GIF ticker from a previous load (src changed,
		// element reused). The next `onload` will start a fresh one if
		// the new image is animated.
		this.stopGifAnimation();
		const resolved = resolveLiveResourceUrl(src);
		_imgDiag('[' + new Date().toISOString() + '] START src=' + src + ' resolved=' + resolved);
		try {
			const img: HTMLImageElement = new (globalThis as unknown as {
				Image: new () => HTMLImageElement;
			}).Image();
			img.onload = () => {
				const anim = img as unknown as { frameCount?: number };
				const fc = typeof anim.frameCount === 'number' ? anim.frameCount : 0;
				_imgDiag('[' + new Date().toISOString() + '] LOAD ok src=' + src
					+ ' w=' + img.naturalWidth + ' h=' + img.naturalHeight
					+ ' frames=' + fc);
				this.loadedImage = img;
				// Animated GIF? Start the frame ticker. `frameCount` is a
				// runtime-only nx.js extension on Image (see image.ts);
				// `HTMLImageElement` doesn't know about it, hence the
				// cast. Static images and single-frame GIFs no-op here.
				this.startGifAnimationIfNeeded(img);
				// Phase 2.5.2 (B): when the image has explicit dimensions
				// (style.width AND style.height set as pixels), the load
				// doesn't change layout — only the painted pixels in this
				// image's box. Patch the cache directly + sync version so
				// the next paint blits the updated cache without a full
				// rebuild. Saves ~1-2 s of rebuild cost per image load on
				// dom-elements-class pages.
				//
				// When the cache is still building (initial paint not
				// complete), don't patch — the chunked builder will
				// paint the now-loaded image when it reaches this element.
				// Does this image have a DEFINITE box (width AND height set
				// via inline style, CSS, or HTML attrs)? If so, the decode
				// only fills pixels in a fixed box — layout can't change — so
				// we patch just this element's region into the cache instead
				// of forcing a full re-layout/rebuild. Crucially this also
				// holds mid-build: the chunked builder may have already
				// painted a placeholder for this op (top-of-page logos run
				// early) and won't revisit it, and a bare requestFullRepaint
				// wouldn't replace it — but a region patch does. Avoiding the
				// version bump here is what stops a page with logos (e.g. the
				// welcome page) from rendering twice: an image decoding mid-
				// build used to abort + restart the whole build.
				const cs = getComputedLiveStyle(this);
				const hasW = this.style.width !== undefined || cs.width !== undefined
					|| this.getAttribute('width') !== null;
				const hasH = this.style.height !== undefined || cs.height !== undefined
					|| this.getAttribute('height') !== null;
				if (hasW && hasH) {
					patchLiveCacheRegion(this);
					// Don't advance the cache version while a build is in
					// flight (it owns the version handshake); the in-progress
					// build keeps running and our patch lands in the same
					// offscreen. Only the steady-state path syncs.
					if (!isLiveCacheBuilding()) syncLiveCacheVersion();
					requestFullRepaint();
				} else {
					// Auto-dimension image — layout depends on the decoded
					// size, so the box needs to grow from the pre-load
					// fallback (parent width × default intrinsic height) to
					// the natural width/height. Bump the live tree version
					// AND mark this element dirty so the next paint either
					// reaches the full-rebuild fallback (when the dirty set
					// drains empty for other reasons) or routes through
					// `patchLiveDirtyRegions`, which re-lays-out this
					// element with the now-known naturalWidth/Height and
					// repaints both the old (small) and new (grown) regions.
					// Without the mark, the patch path can sync the cache
					// version without doing the layout update — leaving the
					// IMG painted at the fallback box (the symptom on slower
					// SDMC fetches: the animated-GIF ticker starts patching
					// frames into a pre-load 1280×24 strip).
					markLiveDirty(this);
					bumpLiveTreeVersion();
					requestFullRepaint();
				}
			};
			img.onerror = (ev: unknown) => {
				// Best-effort error message extraction (ErrorEvent.error
				// from nx.js's Image; falls back to a generic tag when the
				// event shape differs).
				let why = 'unknown';
				const e = ev as { error?: unknown; message?: string } | null | undefined;
				if (e) {
					if (typeof e.message === 'string') why = e.message;
					else if (e.error instanceof Error) why = e.error.message;
					else if (typeof e.error === 'string') why = e.error;
					else if (e.error) why = String(e.error);
				}
				_imgDiag('[' + new Date().toISOString() + '] LOAD FAIL src=' + src
					+ ' resolved=' + resolved + ' why=' + why);
				// Genuinely broken image: flag it so the painter switches
				// from "render nothing (still loading)" to the alt-text
				// placeholder, and repaint that region so it shows. Box is
				// already reserved by layout, so a region patch suffices.
				this.imageLoadFailed = true;
				patchLiveCacheRegion(this);
				if (!isLiveCacheBuilding()) syncLiveCacheVersion();
				requestFullRepaint();
			};
			img.src = resolved;
		} catch (e) {
			_imgDiag('[' + new Date().toISOString() + '] LOAD THROW src=' + src
				+ ' err=' + (e instanceof Error ? e.message : String(e)));
			/* swallow — bad URL or runtime gap */
		}
	}

	/** Backing Image for `<img>` elements. Null when the element isn't
	 * IMG, the src hasn't been set, or the load is still pending /
	 * failed. */
	getLoadedImage(): HTMLImageElement | null { return this.loadedImage; }
	/** True only when the image's load failed (not while it's loading). */
	hasImageError(): boolean { return this.imageLoadFailed; }

	/** If `img` is an animated GIF (`frameCount > 1`), schedule a
	 * chained-setTimeout loop that advances frames at each frame's
	 * declared delay and patches just this element's region into the
	 * live cache so the next paint blits the new frame without rebuilding
	 * the whole tree. No-op for static images. */
	private startGifAnimationIfNeeded(img: HTMLImageElement): void {
		const anim = img as unknown as GifAnimatedImage;
		const total = typeof anim.frameCount === 'number' ? anim.frameCount : 0;
		if (total <= 1) return;
		let idx = 0;
		let cancelled = false;
		let currentTid: ReturnType<typeof setTimeout> | null = null;
		const advance = (): void => {
			if (cancelled) return;
			idx = (idx + 1) % total;
			try { anim.setFrame(idx); } catch (_) { return; }
			// Per-element region patch — paint the new frame into the
			// element's slot in the offscreen cache.
			//
			// We deliberately do NOT call `syncLiveCacheVersion()` here.
			// On the FIRST `onload` for an auto-dimensioned (no width/
			// height attr) animated GIF, `loadImage`'s `else` branch
			// bumps the live tree version so the engine re-lays-out the
			// element with the now-known `naturalWidth/Height`. If we
			// synced the cache version on the very first tick we'd mask
			// that pending rebuild and freeze the layout box at the
			// pre-load fallback (parent's content width × default
			// intrinsic height) — drawImage would then stretch every
			// frame onto a ~1280×24 strip. Skipping the sync keeps the
			// rebuild scheduled; subsequent ticks fire after layout has
			// settled, so the patch lands in the correct region with no
			// further work needed.
			patchLiveCacheRegion(this);
			requestFullRepaint();
			const delay = clampGifDelay(anim.frameDelay(idx));
			currentTid = setTimeout(advance, delay);
		};
		const ticker = {
			cancel: () => {
				cancelled = true;
				if (currentTid !== null) clearTimeout(currentTid);
			},
		};
		this.gifAnimation = ticker;
		activeGifAnimations.add(ticker);
		currentTid = setTimeout(advance, clampGifDelay(anim.frameDelay(0)));
	}

	/** Stop this element's GIF ticker (if any) and drop it from the
	 * global active set. */
	private stopGifAnimation(): void {
		if (this.gifAnimation) {
			this.gifAnimation.cancel();
			activeGifAnimations.delete(this.gifAnimation);
			this.gifAnimation = null;
		}
	}
	getAttribute(name: string): string | null {
		const lower = name.toLowerCase();
		if (lower === 'class') return this.classList.value || null;
		return this.attrs[lower] ?? null;
	}
	hasAttribute(name: string): boolean {
		const lower = name.toLowerCase();
		if (lower === 'class') return this.classList.length > 0;
		return lower in this.attrs;
	}
	removeAttribute(name: string): void {
		const lower = name.toLowerCase();
		delete this.attrs[lower];
		if (lower === 'class') this.classList.value = '';
		invalidateLiveStyle(this);
	}
	/** lil-gui calls `el.toggleAttribute('disabled', state)` to enable
	 * / disable inputs. We treat presence as truthy and store the empty
	 * string when set (HTML5 spec for boolean attributes). */
	toggleAttribute(name: string, force?: boolean): boolean {
		const lower = name.toLowerCase();
		const has = this.hasAttribute(lower);
		const target = force === undefined ? !has : !!force;
		if (target) {
			this.setAttribute(lower, '');
			return true;
		}
		this.removeAttribute(lower);
		return false;
	}

	appendChild(child: LiveElement): LiveElement {
		if (!isLiveElement(child)) return child;
		if (child.parent) child.parent.removeChild(child);
		child.parent = this;
		this.children.push(child);
		propagateAttached(child, this.attached);
		markLiveDirty(this);
		bumpLiveTreeVersion();
		return child;
	}
	removeChild(child: LiveElement): LiveElement {
		const idx = this.children.indexOf(child);
		if (idx >= 0) {
			this.children.splice(idx, 1);
			child.parent = null;
			propagateAttached(child, false);
			if (child.tagName === 'STYLE') unregisterStyleSheet(child);
			markLiveDirty(this);
			bumpLiveTreeVersion();
		}
		return child;
	}
	/** DOM spec: `insertBefore(node, reference)`. `reference == null`
	 * appends. lil-gui's slider widget calls
	 * `$widget.insertBefore($slider, $input)` to slide the slider in
	 * before the number input. */
	insertBefore(child: LiveElement, reference: LiveElement | null): LiveElement {
		if (!isLiveElement(child)) return child;
		if (reference == null) return this.appendChild(child);
		const idx = this.children.indexOf(reference);
		if (idx < 0) return this.appendChild(child);
		if (child.parent) child.parent.removeChild(child);
		child.parent = this;
		this.children.splice(idx, 0, child);
		propagateAttached(child, this.attached);
		markLiveDirty(this);
		bumpLiveTreeVersion();
		return child;
	}
	replaceChild(newChild: LiveElement, oldChild: LiveElement): LiveElement {
		if (!isLiveElement(newChild) || !isLiveElement(oldChild)) return oldChild;
		const idx = this.children.indexOf(oldChild);
		if (idx < 0) return oldChild;
		if (newChild.parent) newChild.parent.removeChild(newChild);
		oldChild.parent = null;
		propagateAttached(oldChild, false);
		newChild.parent = this;
		this.children.splice(idx, 1, newChild);
		propagateAttached(newChild, this.attached);
		markLiveDirty(this);
		bumpLiveTreeVersion();
		return oldChild;
	}
	/** Detach from parent. lil-gui's `destroy()` removes its panel via
	 * `this.domElement.parentElement.removeChild(this.domElement)`. */
	remove(): void {
		if (this.parent) this.parent.removeChild(this);
	}
	contains(other: LiveElement): boolean {
		for (let n: LiveElement | null = other; n; n = n.parent) {
			if (n === this) return true;
		}
		return false;
	}

	addEventListener(type: string, listener: Function, _opts?: unknown): void {
		if (typeof listener !== 'function') return;
		if (!this.listeners) this.listeners = new Map();
		const lower = type.toLowerCase();
		let set = this.listeners.get(lower);
		if (!set) { set = new Set(); this.listeners.set(lower, set); }
		set.add(listener);
	}
	removeEventListener(type: string, listener: Function): void {
		const set = this.listeners?.get(type.toLowerCase());
		if (set) set.delete(listener);
	}
	/** Fire registered listeners + bubble up the parent chain.
	 *
	 * M2.6: bubbling is required for lil-gui — it registers click on
	 * `.slider` (a div), but the hit-test may return the deeper `.fill`
	 * child. Without bubble, the click never reaches `.slider`'s
	 * handler. Real DOM mouse/touch events bubble; this matches.
	 *
	 * `event.stopPropagation()` (if supplied by the caller) is wrapped
	 * so it ALSO flips an internal `_bubbleCancelled` flag the bubble
	 * loop checks. `event.bubbles === false` skips bubbling entirely
	 * (some synthetic events shouldn't bubble — drag-target-only ones). */
	dispatchEvent(event: { type: string; [key: string]: unknown }): boolean {
		const lower = event.type.toLowerCase();
		const bubbles = event.bubbles !== false;
		const ev = event as { type: string; bubbles?: boolean; _bubbleCancelled?: boolean; stopPropagation?: () => void; [key: string]: unknown };
		if (bubbles && typeof ev.stopPropagation !== 'function') {
			ev.stopPropagation = function () { ev._bubbleCancelled = true; };
		} else if (bubbles) {
			const orig = ev.stopPropagation;
			ev.stopPropagation = function () {
				ev._bubbleCancelled = true;
				if (typeof orig === 'function') {
					try { orig.call(ev); } catch (_) { /* swallow */ }
				}
			};
		}
		let target: LiveElement | null = this;
		while (target) {
			const set = target.listeners?.get(lower);
			if (set) {
				for (const fn of set) {
					try { fn(event); } catch (_) { /* swallow */ }
					if (ev._bubbleCancelled) break;
				}
			}
			if (!bubbles || ev._bubbleCancelled) break;
			target = target.parent;
		}
		return true;
	}

	getContext(kind: string): unknown {
		if (this.tagName !== 'CANVAS') return null;
		if (kind !== '2d') return null; // WebGL on dynamic canvases not supported
		if (!this.offscreen) {
			this.offscreen = new OffscreenCanvas(this._width, this._height);
		}
		if (!this.canvasCtx2d) {
			this.canvasCtx2d = this.offscreen.getContext('2d');
		}
		return this.canvasCtx2d;
	}

	/**
	 * Spec-shaped `getBoundingClientRect`. Returned `x/y/left/top/right/
	 * bottom/width/height` are in screen coordinates (the viewport the
	 * painter uses — chrome inset already applied for normal mode, 0
	 * for fullscreen-canvas mode).
	 *
	 * M2.0 layout model — for any element, walks up the chain looking
	 * for the nearest `position:fixed` ancestor. The bbox origin is
	 * `viewport + (ancestor.style.left/top)`; the size is the element's
	 * own style width/height, with a canvas display-size fallback (the
	 * Stats-pattern container has no size, but its visible canvas does).
	 *
	 * lil-gui uses this on `$slider.getBoundingClientRect()` to map
	 * `clientX` into the slider's [min,max] range. M2.3 (flex layout)
	 * will replace the "stack at parent's origin" assumption with real
	 * computed bounds; until then sliders inside fixed panels still get
	 * the panel's origin (good enough for the M2.0 validation page,
	 * which doesn't exercise drag).
	 */
	getBoundingClientRect(): {
		x: number; y: number; width: number; height: number;
		top: number; left: number; right: number; bottom: number;
	} {
		// M2.3: prefer the laid-out box from the most recent paint.
		// The layout cache is per-frame; if we've painted at least once
		// it has the right answer including flex-distributed widths and
		// padding-aware content boxes.
		const lb = getLayoutBox(this);
		if (lb) {
			return {
				x: lb.x, y: lb.y, width: lb.w, height: lb.h,
				top: lb.y, left: lb.x,
				right: lb.x + lb.w, bottom: lb.y + lb.h,
			};
		}
		// Fallback (no layout yet — first call before first paint, or
		// element not under a fixed root): M2.0 viewport + fixed-ancestor
		// math.
		const vp = getLiveViewportInternal();
		let originX = vp.x;
		let originY = vp.y;
		for (let n: LiveElement | null = this; n; n = n.parent) {
			if (n.style.position === 'fixed') {
				originX = vp.x + (n.style.left ?? 0);
				originY = vp.y + (n.style.top ?? 0);
				break;
			}
		}
		// Percent values have no containing block here (this is a
		// fallback when layout cache misses) — drop to undefined and
		// let the canvas-walk supply the size.
		const sw = typeof this.style.width === 'number' ? this.style.width : undefined;
		const sh = typeof this.style.height === 'number' ? this.style.height : undefined;
		let w = sw ?? (this.tagName === 'CANVAS' ? this._width : 0);
		let h = sh ?? (this.tagName === 'CANVAS' ? this._height : 0);
		if (w === 0 || h === 0) {
			let cw = w;
			let ch = h;
			const walk = (node: LiveElement) => {
				if (node.style.display === 'none') return;
				if (node.tagName === 'CANVAS') {
					const ds = node.getDisplaySize();
					if (ds.w > cw) cw = ds.w;
					if (ds.h > ch) ch = ds.h;
				}
				for (const c of node.children) walk(c);
			};
			walk(this);
			w = cw; h = ch;
		}
		return {
			x: originX, y: originY, width: w, height: h,
			top: originY, left: originX,
			right: originX + w, bottom: originY + h,
		};
	}

	/** Read-only access to the OffscreenCanvas backing a `<canvas>`
	 * LiveElement. Used by the overlay painter to drawImage the live
	 * pixels onto the screen surface. */
	getOffscreen(): OffscreenCanvas | null {
		return this.offscreen;
	}

	/** Phase 3b (2026-05-26): attach an externally-owned OffscreenCanvas
	 * to this `<canvas>` LiveElement. Used by the shell after
	 * `runPageScripts` to wire each canvas-runner-managed offscreen into
	 * the live tree so the live painter draws what the script rendered.
	 *
	 * `isWebGL` flags the offscreen as backed by the shared screen GL
	 * bridge (per `canvas-runner.ts`'s `webGLBackedCanvases`). The
	 * painter consults this to skip drawImage and let the shell's
	 * `overlayLiveAnimatedCanvases` pass do the bridge → screen copy. */
	attachOffscreen(off: OffscreenCanvas, isWebGL: boolean): void {
		if (this.tagName !== 'CANVAS') return;
		this.offscreen = off;
		// Reset the 2D context cache — if a previous offscreen was
		// attached, its context is stale.
		this.canvasCtx2d = null;
		this._webglBacked = isWebGL;
		// Mirror the offscreen's intrinsic dims onto the LiveElement so
		// layout sees the actual canvas dimensions (rather than the
		// HTMLCanvasElement 300×150 default). The runner sized the
		// offscreen from the parsed canvas element's width/height attrs,
		// which the converter also copied to the LiveElement via
		// setAttribute, but the inline-attribute setter doesn't route
		// width/height through the OffscreenCanvas — only `el.width =`
		// does. Sync explicitly here.
		this._width = off.width;
		this._height = off.height;
	}

	/** Phase 3b: true iff `attachOffscreen` was called with
	 * `isWebGL = true`. The live painter skips drawImage for these so
	 * the shell's per-frame `overlayLiveAnimatedCanvases` can do the
	 * bridge → screen direct copy with fresh pixels. */
	isWebGLBacked(): boolean {
		return this._webglBacked;
	}

	/** Stats reads `canvas.style.cssText = 'width:80px;height:48px'`
	 * and uses that as the *display* size (logical CSS pixels) while
	 * `canvas.width`/`height` are the *pixel-buffer* size. We honour
	 * the difference here so the overlay can blit at the display
	 * size, which is what produces the correct on-screen footprint. */
	getDisplaySize(): { w: number; h: number } {
		// Percent-valued style.width has no containing block from here —
		// fall back to the pixel-buffer size. Stats only uses px, so this
		// is a safe default for the one in-tree consumer.
		const sw = this.style.width;
		const sh = this.style.height;
		return {
			w: typeof sw === 'number' ? sw : this._width,
			h: typeof sh === 'number' ? sh : this._height,
		};
	}
}

/** Walk a subtree updating the `attached` flag. The live painter
 * relies on this so it can iterate only the registered roots' trees
 * and skip orphan subtrees. */
function propagateAttached(el: LiveElement, isAttached: boolean): void {
	if (el.attached === isAttached) return;
	el.attached = isAttached;
	for (const c of el.children) propagateAttached(c, isAttached);
}

/**
 * LiveStyle — proxy-ish object behind `el.style`. Two access shapes:
 *   - `style.cssText = '...';` re-parses the whole text.
 *   - `style.position = 'fixed'; style.top = 0;` mutates one field at
 *     a time. Numeric values can come as numbers OR `'10px'`-style
 *     strings; we coerce.
 *
 * The DOM spec says `style.top` returns the *string* form (e.g. `'0px'`).
 * Stats only writes, never reads (the test would care). For safety we
 * coerce on read back to a string with `px` suffix where it makes sense.
 */
class LiveStyle implements InlineStyle {
	position?: InlineStyle['position'];
	top?: number;
	left?: number;
	right?: number;
	bottom?: number;
	// Length-bearing props (width/height/min-*/max-*) need string-aware
	// setters: real-browser DOM accepts `el.style.width = "83.5%"` as a
	// plain string. lil-gui's slider drives `this.$fill.style.width =
	// (i*100)+'%'` directly that way. Without parsing on set, the string
	// "83.5%" lands in the field as a raw string and resolveLength sees
	// neither a number nor a CssPercent → returns NaN.
	private _width?: CssLength;
	private _height?: CssLength;
	private _minWidth?: CssLength;
	private _maxWidth?: CssLength;
	private _minHeight?: CssLength;
	private _maxHeight?: CssLength;
	get width(): CssLength | undefined { return this._width; }
	set width(v: CssLength | string | undefined) { this._width = coerceLength(v); }
	get height(): CssLength | undefined { return this._height; }
	set height(v: CssLength | string | undefined) { this._height = coerceLength(v); }
	get minWidth(): CssLength | undefined { return this._minWidth; }
	set minWidth(v: CssLength | string | undefined) { this._minWidth = coerceLength(v); }
	get maxWidth(): CssLength | undefined { return this._maxWidth; }
	set maxWidth(v: CssLength | string | undefined) { this._maxWidth = coerceLength(v); }
	get minHeight(): CssLength | undefined { return this._minHeight; }
	set minHeight(v: CssLength | string | undefined) { this._minHeight = coerceLength(v); }
	get maxHeight(): CssLength | undefined { return this._maxHeight; }
	set maxHeight(v: CssLength | string | undefined) { this._maxHeight = coerceLength(v); }
	display?: InlineStyle['display'];
	opacity?: number;
	zIndex?: number;
	cursor?: string;
	background?: string;
	color?: string;
	// M2.1 text props.
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: InlineStyle['fontWeight'];
	fontStyle?: InlineStyle['fontStyle'];
	textAlign?: InlineStyle['textAlign'];
	lineHeight?: number;
	textDecoration?: InlineStyle['textDecoration'];
	verticalAlign?: InlineStyle['verticalAlign'];
	listStyleType?: InlineStyle['listStyleType'];
	// M2.3 layout props.
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	gap?: number;
	flexDirection?: InlineStyle['flexDirection'];
	flexGrow?: number;
	flexShrink?: number;
	flexBasis?: number;
	alignItems?: InlineStyle['alignItems'];
	justifyContent?: InlineStyle['justifyContent'];
	boxSizing?: InlineStyle['boxSizing'];
	borderTopWidth?: number;
	borderRightWidth?: number;
	borderBottomWidth?: number;
	borderLeftWidth?: number;
	borderTopColor?: string;
	borderRightColor?: string;
	borderBottomColor?: string;
	borderLeftColor?: string;
	// M2.5 overflow.
	overflowX?: InlineStyle['overflowX'];
	overflowY?: InlineStyle['overflowY'];

	get cssText(): string { return serializeStyle(this); }
	set cssText(v: string) {
		// Wipe + reparse.
		this.position = undefined;
		this.top = undefined; this.left = undefined;
		this.right = undefined; this.bottom = undefined;
		this.width = undefined; this.height = undefined;
		this.display = undefined; this.opacity = undefined;
		this.zIndex = undefined; this.cursor = undefined;
		this.background = undefined; this.color = undefined;
		this.fontFamily = undefined; this.fontSize = undefined;
		this.fontWeight = undefined; this.fontStyle = undefined;
		this.textAlign = undefined; this.lineHeight = undefined;
		this.textDecoration = undefined; this.verticalAlign = undefined;
		this.listStyleType = undefined;
		this.paddingTop = undefined; this.paddingRight = undefined;
		this.paddingBottom = undefined; this.paddingLeft = undefined;
		this.marginTop = undefined; this.marginRight = undefined;
		this.marginBottom = undefined; this.marginLeft = undefined;
		this.gap = undefined;
		this.flexDirection = undefined;
		this.flexGrow = undefined; this.flexShrink = undefined;
		this.flexBasis = undefined;
		this.alignItems = undefined;
		this.justifyContent = undefined;
		this.boxSizing = undefined;
		this.minWidth = undefined; this.maxWidth = undefined;
		this.minHeight = undefined; this.maxHeight = undefined;
		this.overflowX = undefined; this.overflowY = undefined;
		const parsed = parseCssText(v);
		Object.assign(this, parsed);
	}

	/** Object-style write for unknown / camelCased property access.
	 * Stats uses dot access (`style.display = 'none'`) which TypeScript
	 * sees as the typed fields; this is a fallback for tools that go
	 * through `Object.assign`. */
	setProperty(name: string, value: string): void {
		applyDecl(this, name, value);
	}
}

/**
 * LiveRoot — the single `document.body` equivalent. Children attached
 * here (and recursively) become candidates for the per-frame overlay
 * pass. `attached` is propagated on append/remove so descendants know
 * whether they're live.
 *
 * Singleton-per-script-context: every script runs against the same
 * root within a given page session. Reset on navigation
 * ({@link resetLiveRoot}).
 */
class LiveRoot extends LiveElement {
	constructor() { super('body'); this.attached = true; }
}

let liveRoot: LiveRoot = new LiveRoot();
// `liveWindow` + `liveDocumentRef` declarations are below the
// `LiveWindow` class (TS forward-reference rules forbid using a
// class before its declaration in a `let` initializer).

export function getLiveRoot(): LiveRoot { return liveRoot; }

/** Reset the live root on page navigation so live elements created
 * by the previous page don't survive into the next. Also resets the
 * window-level event registry (M2.0) so listeners from the previous
 * page don't keep firing under the next one. */
export function resetLiveRoot(): void {
	liveRoot = new LiveRoot();
	liveWindow = new LiveWindow();
	liveDocumentRef = null;
	// M2.2: clear stylesheet registry + cascade caches.
	resetLiveCss();
	// Phase 1.5: reset the tree version so the new page's cache state
	// starts fresh (without this, the first paint after navigation could
	// hit a stale cache from the previous page).
	resetLiveTreeVersion();
	// CSS background-image cache — entries reference HTMLImageElements
	// owned by the previous page session; flush so the new page's url()
	// references trigger fresh loads against the new base URL.
	clearBackgroundImageCache();
}

/**
 * Page-level `window` shim that owns the listener registry forwarded
 * to by the shell's touch handler (mouse / touch events lil-gui needs
 * for slider drags). Used internally; pages see the proxy below.
 *
 * Bound to one page session — `resetLiveRoot()` replaces this on
 * navigation so a leaving page's drag handlers don't keep firing.
 */
export class LiveWindow {
	private listeners: Map<string, Set<Function>> = new Map();
	addEventListener(type: string, listener: Function, _opts?: unknown): void {
		if (typeof listener !== 'function') return;
		const lower = type.toLowerCase();
		let set = this.listeners.get(lower);
		if (!set) { set = new Set(); this.listeners.set(lower, set); }
		set.add(listener);
	}
	removeEventListener(type: string, listener: Function, _opts?: unknown): void {
		this.listeners.get(type.toLowerCase())?.delete(listener);
	}
	dispatchEvent(event: { type: string; [key: string]: unknown }): boolean {
		const set = this.listeners.get(event.type.toLowerCase());
		if (!set) return true;
		for (const fn of set) {
			try { fn(event); } catch (_) { /* swallow — keep loop alive */ }
		}
		return true;
	}
	hasListeners(type: string): boolean {
		return (this.listeners.get(type.toLowerCase())?.size ?? 0) > 0;
	}
}

// `let` storage for the per-page LiveWindow + owner-doc ref.
// Defined here (after the class) to satisfy TS forward-reference
// rules. `resetLiveRoot()` (above) reassigns both per page.
let liveWindow: LiveWindow = new LiveWindow();
let liveDocumentRef: unknown = null;

export function getLiveWindow(): LiveWindow { return liveWindow; }

/**
 * Returns a Proxy that surface-shadows `window` per page. Intercepts
 * `addEventListener` / `removeEventListener` / `dispatchEvent` so
 * synthetic mouse/touch events from the canvas touch handler land in
 * this page's `LiveWindow` registry. Everything else (devicePixelRatio,
 * requestAnimationFrame, innerWidth, etc.) falls through to globalThis
 * so existing Three.js demos that probe those don't regress.
 *
 * The returned proxy is what the documentShim injects into the
 * AsyncFunction body as the `window` parameter — page scripts that
 * read `window.X` get the proxy; the proxy decides whether to handle
 * X locally or delegate up.
 */
export function getLiveWindowProxy(): unknown {
	const win = liveWindow;
	const global = globalThis as unknown as Record<string, unknown>;
	const handler: ProxyHandler<object> = {
		get(_target, prop) {
			if (prop === 'addEventListener') return win.addEventListener.bind(win);
			if (prop === 'removeEventListener') return win.removeEventListener.bind(win);
			if (prop === 'dispatchEvent') return win.dispatchEvent.bind(win);
			// Fall through to globalThis for everything else.
			const v = global[prop as string];
			return typeof v === 'function' ? v.bind(globalThis) : v;
		},
		has(_target, prop) {
			if (prop === 'addEventListener' || prop === 'removeEventListener' || prop === 'dispatchEvent') return true;
			return prop in global;
		},
		set(_target, prop, value) {
			global[prop as string] = value;
			return true;
		},
	};
	return new Proxy({}, handler);
}

/** The shell's documentShim stashes itself here once per page so
 * LiveElement.ownerDocument can return something. Not used by lil-gui
 * directly, but several third-party libs probe `el.ownerDocument` to
 * locate `document.body` indirectly. */
export function setOwnerDocument(doc: unknown): void {
	liveDocumentRef = doc;
}
function getOwnerDocument(): unknown { return liveDocumentRef; }

/** Module-internal viewport mirror, kept in sync with the painter +
 * hit-tester via setLiveViewport (called by the shell from each
 * render path). Read by `LiveElement.getBoundingClientRect()`. */
let internalLiveViewport: LiveViewport = { x: 0, y: 0, width: 0, height: 0 };
export function setInternalLiveViewport(v: LiveViewport): void {
	internalLiveViewport = v;
}
function getLiveViewportInternal(): LiveViewport { return internalLiveViewport; }

/** Module-internal page scroll offset, mirroring the painter's
 * `effectiveScrollY`. Set by the shell after each paintLiveOverlay so
 * hit-test can translate body-local boxes (Phase 1.5, 2026-05-25) into
 * screen coords. Default 0 keeps fullscreen-canvas / pre-paint paths
 * unaffected. */
let internalLiveScrollY = 0;
export function setInternalLiveScrollY(v: number): void {
	internalLiveScrollY = v;
}

/** Compute the on-screen bounding-box size of a position:fixed live
 * element. If the element itself has explicit `style.width`/`height`,
 * use that; otherwise fall back to the union of visible canvas
 * children's display sizes (the Stats pattern: container has no size,
 * but its visible canvas panel does). */
function computeFixedSize(el: LiveElement): { w: number; h: number } {
	// Percent values can't be resolved without a containing block — this
	// is a Phase-1 fallback used before layout runs, so drop them. The
	// Phase-2 layout (layout-fixed-root) resolves percents properly.
	const sw = typeof el.style.width === 'number' ? el.style.width : undefined;
	const sh = typeof el.style.height === 'number' ? el.style.height : undefined;
	if (sw !== undefined && sh !== undefined) return { w: sw, h: sh };
	let w = sw ?? 0;
	let h = sh ?? 0;
	function walk(node: LiveElement) {
		if (node.style.display === 'none') return;
		if (node.tagName === 'CANVAS') {
			const ds = node.getDisplaySize();
			if (ds.w > w) w = ds.w;
			if (ds.h > h) h = ds.h;
		}
		for (const c of node.children) walk(c);
	}
	walk(el);
	return { w, h };
}

/** Viewport rect used by both the overlay painter and the touch
 * hit-tester. See `live-overlay.ts` for the painter side. */
export interface LiveViewport {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Walk the live tree and return the topmost `position:fixed` element
 * whose bounding box (offset by `viewport.x/y`) contains the screen
 * coordinate `(x, y)`. Used by the touch dispatcher to route synthetic
 * click events to live-DOM overlays (e.g. Stats's tap-to-cycle).
 *
 * Returns the matched element so the caller can `dispatchEvent({type:'click', ...})`
 * on it. Caller is responsible for synthesising the event object;
 * `dispatchEvent` already exists on LiveElement.
 *
 * Sort order: highest z-index first; within the same z, latest
 * document-order first (which is "on top" by the painter's stable
 * sort). `display:none` elements are skipped.
 */
export function hitTestLive(
	root: LiveElement,
	x: number,
	y: number,
	viewport: LiveViewport,
): LiveElement | null {
	// M2.3: walk EVERY element in the tree (not just position:fixed)
	// since flex layout now means descendants of a fixed root have
	// their own laid-out bboxes. We use the layout cache; if an element
	// has no laid-out box (off-screen ancestor / display:none /
	// pre-paint), fall back to the M2.0 viewport+fixed-ancestor math
	// for the fixed-rooted case.
	const candidates: {
		el: LiveElement; x: number; y: number; w: number; h: number;
		z: number; order: number;
	}[] = [];
	let order = 0;
	// M2.5 hit-test fix: collect walks the tree carrying the cumulative
	// scrollTop from every scrollable ancestor. Each candidate's stored
	// y is its layout y MINUS the accumulated scroll, matching where
	// the painter actually draws it after `ctx.translate(0, -scrollTop)`.
	// Also skip OPTION / OPTGROUP children of SELECT — they get layout
	// boxes but aren't tappable independently; their parent SELECT
	// captures the tap via handleFormTap.
	interface ClipRect { x: number; y: number; w: number; h: number }
	function collect(el: LiveElement, inFixed: boolean, scrollOff: number, inheritedZ: number, clipRect: ClipRect | null, relOffsetX: number, relOffsetY: number) {
		const cs = getComputedLiveStyle(el);
		if (cs.display === 'none' || el.style.display === 'none') return;
		const tag = el.tagName;
		if (tag === 'OPTION' || tag === 'OPTGROUP') return;
		const elPosition = cs.position ?? el.style.position;
		const nowFixed = inFixed || elPosition === 'fixed';
		const ownZ = cs.zIndex ?? el.style.zIndex ?? 0;
		const effZ = Math.max(ownZ, inheritedZ);
		// position: relative — shift the element's painted bbox + its
		// descendants by (top|-bottom, left|-right) in the same way the
		// painter does via ctx.translate. Cumulative through nested
		// relative ancestors.
		let descRelX = relOffsetX;
		let descRelY = relOffsetY;
		if (elPosition === 'relative') {
			descRelX += (cs.left ?? el.style.left ?? 0) - (cs.right ?? el.style.right ?? 0);
			descRelY += (cs.top ?? el.style.top ?? 0) - (cs.bottom ?? el.style.bottom ?? 0);
		}
		// Phase 1 (2026-05-25): also push non-fixed candidates when they
		// have a layout box from the body-flow pass. Skip the BODY root
		// itself so taps that miss all body children fall through to the
		// static link/button dispatch — otherwise body's full-viewport
		// bbox would steal every tap from the static layer.
		//
		// Phase 1.5 (2026-05-25): body-flow boxes are now stored in body-
		// LOCAL coords (origin 0,0) because the painter applies a
		// ctx.translate(viewport.x, viewport.y - scrollY) before walking.
		// Translate them back to screen-space here so hit-test compares
		// the right rect. Fixed-rooted boxes are already in screen-space
		// — no translation needed.
		const isBodyRoot = el === root;
		if (!isBodyRoot) {
			const lb = getLayoutBox(el);
			let cx: number | undefined, cy: number | undefined, cw: number | undefined, ch: number | undefined;
			if (lb && lb.w > 0 && lb.h > 0) {
				if (nowFixed) {
					cx = lb.x + descRelX; cy = lb.y - scrollOff + descRelY;
				} else {
					cx = lb.x + viewport.x + descRelX;
					cy = lb.y + viewport.y - internalLiveScrollY - scrollOff + descRelY;
				}
				cw = lb.w; ch = lb.h;
			} else if (elPosition === 'fixed') {
				cx = viewport.x + (cs.left ?? el.style.left ?? 0);
				cy = viewport.y + (cs.top ?? el.style.top ?? 0);
				const sz = computeFixedSize(el);
				cw = sz.w; ch = sz.h;
			}
			if (cx !== undefined && cy !== undefined && cw !== undefined && ch !== undefined) {
				let bx = cx, by = cy, bw = cw, bh = ch;
				if (clipRect) {
					const x2 = Math.min(bx + bw, clipRect.x + clipRect.w);
					const y2 = Math.min(by + bh, clipRect.y + clipRect.h);
					bx = Math.max(bx, clipRect.x);
					by = Math.max(by, clipRect.y);
					bw = Math.max(0, x2 - bx);
					bh = Math.max(0, y2 - by);
				}
				// Phase 2.5 fix (2026-05-25): body-flow candidates must
				// also be clipped to the viewport rect. Otherwise an atom
				// that's scrolled UP into the toolbar zone (screen y < 30)
				// is still hittable in that area, eating toolbar taps.
				// Fixed-rooted candidates already paint at viewport-origin
				// coords so they don't need this clamp.
				if (!nowFixed) {
					const vx2 = Math.min(bx + bw, viewport.x + viewport.width);
					const vy2 = Math.min(by + bh, viewport.y + viewport.height);
					bx = Math.max(bx, viewport.x);
					by = Math.max(by, viewport.y);
					bw = Math.max(0, vx2 - bx);
					bh = Math.max(0, vy2 - by);
				}
				if (bw > 0 && bh > 0) {
					candidates.push({
						el, x: bx, y: by, w: bw, h: bh,
						z: effZ,
						order: order++,
					});
				}
			}
		}
		// M2.6 fix: tighten clip rect for descendants when this element
		// has overflow != visible. Scrollable + hidden containers clip
		// their children visually; hit-test follows so scrolled-out or
		// out-of-overflow items aren't hittable in the cleared area.
		// Phase 1: gate on having a layout box (not on nowFixed) — body-
		// flow elements with overflow:auto need the same clip propagation.
		// Phase 1.5: the clipRect must be in SCREEN space (same as
		// candidate boxes) — translate body-local contentX/Y to screen.
		let descendantClip = clipRect;
		const oy = cs.overflowY ?? 'visible';
		const ox = cs.overflowX ?? 'visible';
		if (oy !== 'visible' || ox !== 'visible') {
			const lb = getLayoutBox(el);
			if (lb) {
				const own = nowFixed
					? { x: lb.contentX, y: lb.contentY, w: lb.contentW, h: lb.contentH }
					: {
						x: lb.contentX + viewport.x,
						y: lb.contentY + viewport.y - internalLiveScrollY,
						w: lb.contentW, h: lb.contentH,
					};
				if (clipRect) {
					const x2 = Math.min(own.x + own.w, clipRect.x + clipRect.w);
					const y2 = Math.min(own.y + own.h, clipRect.y + clipRect.h);
					descendantClip = {
						x: Math.max(own.x, clipRect.x),
						y: Math.max(own.y, clipRect.y),
						w: Math.max(0, x2 - Math.max(own.x, clipRect.x)),
						h: Math.max(0, y2 - Math.max(own.y, clipRect.y)),
					};
				} else {
					descendantClip = own;
				}
			}
		}
		// Phase 2.5 (2026-05-25): if this element has an inline-formatting
		// context, its atoms are stored in the inlineCache rather than
		// child layout boxes. Push each atom as a hit candidate so taps
		// on a specific word / link / inline element resolve correctly.
		const inline = getInlineLayout(el);
		if (inline) {
			for (const atom of inline.atoms) {
				if (atom.isBr) continue;
				if (atom.w <= 0 || atom.h <= 0) continue;
				// Atom boxes are in body-local (or fixed-rooted) space —
				// same coordinate system as the enclosing element's box.
				let bx: number, by: number;
				if (nowFixed) {
					bx = atom.x + descRelX;
					by = atom.y - scrollOff + descRelY;
				} else {
					bx = atom.x + viewport.x + descRelX;
					by = atom.y + viewport.y - internalLiveScrollY - scrollOff + descRelY;
				}
				let bw = atom.w, bh = atom.h;
				if (clipRect) {
					const x2 = Math.min(bx + bw, clipRect.x + clipRect.w);
					const y2 = Math.min(by + bh, clipRect.y + clipRect.h);
					bx = Math.max(bx, clipRect.x);
					by = Math.max(by, clipRect.y);
					bw = Math.max(0, x2 - bx);
					bh = Math.max(0, y2 - by);
				}
				// Same viewport clamp as element-level candidates above —
				// atoms scrolled above into the toolbar zone shouldn't
				// eat toolbar taps.
				if (!nowFixed) {
					const vx2 = Math.min(bx + bw, viewport.x + viewport.width);
					const vy2 = Math.min(by + bh, viewport.y + viewport.height);
					bx = Math.max(bx, viewport.x);
					by = Math.max(by, viewport.y);
					bw = Math.max(0, vx2 - bx);
					bh = Math.max(0, vy2 - by);
				}
				if (bw > 0 && bh > 0) {
					candidates.push({
						el: atom.el, x: bx, y: by, w: bw, h: bh,
						z: effZ, order: order++,
					});
				}
			}
			// Atoms replace the child walk — the inline children's content
			// is already in the atom list.
			return;
		}
		const childScrollOff = scrollOff + (el.scrollTop || 0);
		for (const c of el.children) collect(c, nowFixed, childScrollOff, effZ, descendantClip, descRelX, descRelY);
	}
	collect(root, false, 0, 0, null, 0, 0);
	candidates.sort((a, b) => {
		if (a.z !== b.z) return b.z - a.z; // higher z first
		return b.order - a.order;          // latest in doc order first
	});
	for (const c of candidates) {
		if (c.w <= 0 || c.h <= 0) continue;
		if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) {
			return c.el;
		}
	}
	return null;
}
