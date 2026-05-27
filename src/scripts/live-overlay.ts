// Per-frame painter for the live-DOM overlay. Called from the shell's
// `repaintContent()` and `repaintFullscreenCanvas()`. Owns the
// chunked-build OffscreenCanvas cache for the body subtree and also
// paints `position:fixed` live elements on top of it.
//
// Layout model (Phase 1 / M2.0 scope — still pre-layout):
//   - A LiveElement paints iff (a) it's attached to the live root,
//     (b) some ancestor in the chain (or self) has
//     `position:fixed`, (c) its `display !== 'none'`.
//   - "Fixed" origin is viewport-relative: `position:fixed top:0
//     left:0` lands at the top-left of the page content area, NOT
//     the absolute screen surface. The caller passes a `viewport`
//     rect that the overlay offsets into — typically
//     `{x:0, y:topInset, width:canvasW, height:canvasH-topInset-bottomInset}`
//     in normal mode and `{x:0, y:0, width, height}` in
//     fullscreen-canvas mode. This matches real-browser behaviour
//     where the chrome strip sits outside the viewport.
//   - Right/bottom are ignored for v1 (Stats only uses top/left).
//   - Non-fixed descendants paint at the same origin as their
//     nearest-fixed ancestor — no normal-flow stacking. Stats
//     intentionally hides all-but-one canvas panel via
//     `display:none`, so the visible one shows; the hidden ones
//     don't paint regardless.
//   - z-index ordering: top-level fixed elements are stable-sorted
//     by `style.zIndex` (default 0). Within a subtree, document
//     order wins.
//   - Opacity: `globalAlpha` is multiplied through the chain.
//
// Element-type paint:
//   - `<canvas>`: drawImage from the OffscreenCanvas backing, at the
//     element's display size (style.width/height fall back to
//     pixel-buffer width/height).
//   - `<div>` / `<span>` / etc.: paint `style.background` rect if
//     set, then paint `textContent` / `innerHTML` text on top using
//     the resolved font + colour + alignment (M2.1). Bold is
//     synthesized via 1-px-offset double-draw and italic via a 0.2-rad
//     shear transform because nx.js's font parser rejects the
//     `bold`/`italic` prefix and falls back to a different (larger)
//     font — see [[nxjs-font-no-bold-italic]]. Text is clipped to the
//     element's bbox if the element has explicit width/height; no
//     wrapping (M2.3 layout pass).

import { isBoldWeight, isItalicStyle, resolveCanvasFont, resolveLength } from './inline-css.js';
import { getComputedLiveStyle, type BackgroundLayer, type BoxShadow, type ComputedLiveStyle, type PseudoStyle } from './live-css.js';
import { getLiveTreeVersion, type LiveElement } from './live-dom.js';
import { paintFormWidget } from './live-form.js';
import {
	VIDEO_CONTROLS_BAR_H,
	hitTestVideoControls, paintVideoControls, paintVideoFrameAt,
	type VideoControlHit,
} from './live-video.js';

import {
	collectAbsolutes, findAbsoluteContainingBlock,
	getInlineLayout, getLayoutBox,
	layoutAbsoluteRoot, layoutFixedRoot,
	resetLayoutCache, setLayoutMeasureCtx,
	type InlineAtom, type InlineLayout, type LayoutBox,
} from './live-layout.js';
import { paintSvgSubtree, type SvgNodeAdapter } from './svg-painter.js';
import { isKeyboardOpen, requestFullRepaint } from './live-paint-control.js';

/** Viewport rectangle for the live overlay. `x` / `y` are the
 * top-left offset into the screen surface; `width` / `height` are
 * the size of the page-content area (used for clipping if we add
 * it; not enforced in v1). */
export interface LiveViewport {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Last computed bottom of the live body's normal-flow content, in
 * the body's local layout space (NOT screen-space — does NOT include
 * scrollY). Read by browser-shell.maxScroll() so D-pad / stick / touch
 * drag scrolling can reach the end of live content even when the
 * static layout is short. Cached at paint time; default 0 when the
 * live body has no non-fixed children. */
let lastLiveContentBottom = 0;
export function getLiveContentBottom(): number {
	return lastLiveContentBottom;
}

/** Phase 1.6.1 (2026-05-25): partial cache repaint. Clears just `el`'s
 * border-box region in the live cache and re-paints its subtree at the
 * existing body-local layout box. Used by form-tap handlers (radio,
 * range, checkbox, color, label-for) to update the visual without
 * paying the ~80-150 ms full-rebuild cost.
 *
 * Assumes no LAYOUT change has happened — only the element's paint
 * output changed (e.g. `.checked` toggled, range value changed). The
 * caller should NOT use this for mutations that move siblings around
 * (e.g. `<details>` open/close, tree insertions). For those, let the
 * full-rebuild path run by NOT calling `syncLiveCacheVersion` afterward.
 *
 * Patches the box in body-local coords; the cache OffscreenCanvas is
 * already in body-local space so the blit on the next paint shows the
 * fresh widget at the right screen position. */
export function patchLiveCacheRegion(el: LiveElement): void {
	if (!liveCacheOffscreen) return;
	const box = getLayoutBox(el);
	if (!box || box.w <= 0 || box.h <= 0) return;
	const cacheCtx = liveCacheOffscreen.getContext('2d');
	if (!cacheCtx) return;
	// Save the active measure-ctx so paintLiveOverlay's next full
	// rebuild reverts to whatever was active before this patch. In
	// practice paintLiveOverlay always overwrites it at the start of
	// each frame so this is belt-and-suspenders.
	cacheCtx.save();
	try {
		cacheCtx.clearRect(box.x, box.y, box.w, box.h);
		setLayoutMeasureCtx(cacheCtx);
		paintSubtreeLaid(cacheCtx, el);
	} finally { cacheCtx.restore(); }
}

/** Phase 1.6.1: mark the live cache as up-to-date with the current
 * `liveTreeVersion`. The next `paintLiveOverlay` will see a version
 * match and skip the full rebuild, blitting the cache as-is. Call this
 * AFTER `patchLiveCacheRegion` for every element you mutated, so the
 * patched cache content survives the next paint instead of being
 * overwritten by a full rebuild. */
export function syncLiveCacheVersion(): void {
	lastBodyVersion = getLiveTreeVersion();
}

// Phase 1.5 + 1.6 cache (2026-05-25): body-flow layout is computed at
// body-LOCAL origin (0, 0) AND the painter output is baked into a
// dedicated OffscreenCanvas. Per scroll tick the cache is blitted at
// the current scroll position via ONE `drawImage` — no layout, no paint
// walk, no measureText. Mutation (script tree/style/attr writes bump
// liveTreeVersion) triggers a single rebuild on the next paint.
//
// Why we need both Phase 1.5 (layout cache) and 1.6 (paint cache):
//   - Phase 1.5 alone saved cascade + relayout on scroll, but still
//     walked ~150 elements per scroll tick doing fillText/measureText
//     (~80-120 ms on Citron). 8 FPS on dom-elements.
//   - Phase 1.6 collapses that walk to a `drawImage` (~1-3 ms). 60+ FPS.
//
// Cap the cache at 8192 px tall — that's well past `GL_MAX_TEXTURE_SIZE`
// (relevant for the static path's GPU compositor, not us) but a safe
// upper bound for the OffscreenCanvas allocation. Pages taller than
// that get the top 8192 px cached + a content-bottom warning (TODO).
const LIVE_CACHE_MAX_H = 8192;
let liveCacheOffscreen: OffscreenCanvas | null = null;
let liveCacheW = 0;
let liveCacheH = 0;
let lastBodyVersion = -1;
let lastBodyViewportW = -1;
let lastBodyViewportH = -1;
// Phase 2.5.2 chunked-paint (2026-05-25): the cache build is split into
// time-budgeted slices (~12 ms each) so the JS event loop can process
// scroll input + dispatch animation frames between chunks. Initially
// chunked per-child of root; that broke down on pages with heavy inline
// elements (one mixed-inline `<p>` with 30+ atoms paints in ~90 ms, way
// past the 12 ms budget). Phase 2.5.3 flattens the paint walk into a
// list of per-element bg ops + per-atom ops so the budget check fires
// between any two atoms — giving uniform ~16 ms chunks regardless of
// element size.
const BUILD_CHUNK_MS = 12;
/** Smaller chunk budget for scroll-driven paintLiveOverlay calls. The
 * build still advances during scroll so content fills in below the
 * user's finger, but each scroll tick pays less paint cost — keeps
 * scroll near 60 FPS. */
const SCROLL_CHUNK_MS = 4;
let cacheBuilding = false;
let buildVersion = -1;
let buildContinuationScheduled = false;
/** Last `scrollY` we painted with. Used to pick the chunk budget —
 * scroll-driven calls use the smaller SCROLL_CHUNK_MS so the per-tick
 * paint cost stays low; setTimeout-driven continuations get the larger
 * BUILD_CHUNK_MS for faster catch-up when the user is idle. */
let lastPaintedScrollY = Number.NaN;

/** One unit of paint work emitted by the pre-walk. Bg ops paint an
 * element's background + borders + non-inline text via the existing
 * `paintBoxedElement`. Atom ops paint a single inline text atom (or
 * IMG atom) inside an inline-formatting context. */
interface PaintOp {
	kind: 'bg' | 'atom';
	el: LiveElement;
	cs?: ComputedLiveStyle;
	box?: LayoutBox;
	atom?: InlineAtom;
}
let buildOps: PaintOp[] = [];
let buildOpIndex = 0;

/** True iff a cache build is in progress (chunked). Image / form-tap
 * handlers consult this so they don't try to patch a region that the
 * build is about to over-paint. */
export function isLiveCacheBuilding(): boolean { return cacheBuilding; }

/** True only when the live-DOM cache OffscreenCanvas exists AND its
 * chunked build is fully complete (every paint op consumed). The shell's
 * video-only fast path uses this to decide whether it can skip the
 * per-tick fillRect+cache-blit on a stable page: if the cache hasn't
 * been built yet (or is still chunking), we still need to run
 * `paintLiveOverlay` so the build advances. */
export function isLiveCacheReady(): boolean {
	return liveCacheOffscreen !== null && !cacheBuilding;
}

/** Phase 3b (2026-05-26): force-invalidate all live-overlay module
 * state so the next `paintLiveOverlay` call performs a full layout +
 * cascade + cache rebuild. Required after `resetLiveRoot()` because
 * the per-frame cache is keyed by LiveElement identity (WeakMap),
 * AND `paintLiveOverlay`'s dirty check uses `liveTreeVersion` which
 * `resetLiveRoot()` resets to 0 — meaning a freshly-populated new
 * tree could COINCIDENTALLY have the same version as the last paint
 * of the previous page, fooling the dirty check into thinking the
 * cache is valid when it's actually structurally stale.
 *
 * Symptom of NOT calling this: the second navigation to the same
 * page after a mutation (e.g. Library template select → reload)
 * appears visually correct (cache pixels happen to match), but
 * `hitTestLive` returns null because the layout WeakMap has no
 * entries for the freshly-populated LiveElements. */
export function resetLiveOverlayCache(): void {
	lastBodyVersion = -1;
	lastBodyViewportW = -1;
	lastBodyViewportH = -1;
	liveCacheOffscreen = null;
	liveCacheW = 0;
	liveCacheH = 0;
	cacheBuilding = false;
	buildOps = [];
	buildOpIndex = 0;
	buildVersion = -1;
	buildContinuationScheduled = false;
	lastPaintedScrollY = Number.NaN;
	cachedFixed = [];
	cachedFixedVersion = -1;
	lastLiveContentBottom = 0;
}
// Phase 1.6.2: fixed-element walk cache keyed by liveTreeVersion. Lets
// the scroll-hot path skip the tree walk + sort entirely when nothing
// changed. Particularly valuable for pages with zero fixed elements
// (dom-elements showcase) where the walk produces an empty array but
// still costs 1-3 ms.
let cachedFixed: { el: LiveElement; cs: ComputedLiveStyle; order: number }[] = [];
let cachedFixedVersion = -1;

/** Walk the live root and paint visible fixed elements onto `ctx`,
 * with `position:fixed` interpreted relative to `viewport`. M2.3
 * runs a layout pass per fixed subtree first so children get real
 * boxes; the paint pass then reads the layout cache and draws each
 * element at its computed bbox.
 *
 * Phase 1 (2026-05-25): also paints the body root's non-fixed children
 * as a normal-flow scrollable region. `scrollY` is the page scroll
 * offset (from browser-shell) applied to the body's origin so content
 * scrolls with the rest of the page. The viewport rect is the clip
 * area — content outside it (chrome strip, off-screen) is masked. */
export interface PaintLiveOverlayOptions {
	/** Skip the body-flow render (cache build + blit). The fixed-element
	 * pass still runs so lil-gui style overlays stay visible. Used by
	 * fullscreen-canvas mode where the WebGL canvas should fill the
	 * screen instead of the page content. */
	skipFlow?: boolean;
}

export function paintLiveOverlay(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	root: LiveElement,
	viewport: LiveViewport = { x: 0, y: 0, width: 0, height: 0 },
	scrollY: number = 0,
	options: PaintLiveOverlayOptions = {},
): void {
	// Stand down while the on-canvas keyboard owns the screen — the
	// keyboard is modal and lives in a higher visual layer than the
	// live overlay. Without this gate the rAF heartbeat would draw
	// widgets / status canvases on top of the keyboard panel.
	if (isKeyboardOpen()) return;
	// Hand the measurement context to the layout pass so it can use
	// measureText for intrinsic widths.
	setLayoutMeasureCtx(ctx);

	// Phase 1 / 1.5 — body root in normal flow, painted via a
	// translate(viewport.x, viewport.y - scrollY) so the cached body-
	// local layout boxes can be re-used across paints. Skip when the
	// body has no non-fixed children.
	const hasFlowKids = root.children.some((c) => {
		// `c.style.position` is the inline-style fast path (no cascade
		// walk needed) — fine for the gate since 99% of fixed elements
		// set position inline. Cascade-resolved position would be more
		// correct but costs a getComputedLiveStyle per child every
		// frame, which defeats Phase 1.5's whole point. If a stylesheet
		// rule sets position:fixed on a class, the user can also set
		// the inline style to match, or wait for Phase 2.
		const pos = c.style.position;
		return pos !== 'fixed' && c.style.display !== 'none';
	});
	// `skipFlow` (fullscreen-canvas mode) leaves the body-flow cache
	// state untouched — neither the build branch NOR the reset branch
	// runs — so exiting fullscreen returns to a still-warm cache. Fixed
	// elements (lil-gui etc.) still paint via the pass below.
	if (options.skipFlow) {
		// no-op
	} else if (hasFlowKids) {
		const version = getLiveTreeVersion();
		const viewportChanged = viewport.width !== lastBodyViewportW
			|| viewport.height !== lastBodyViewportH;
		// Phase 2.5.2: if a build is in progress AND the tree / viewport
		// has changed under us, abort and restart fresh. Otherwise let
		// the chunked builder finish current run.
		if (cacheBuilding && (version !== buildVersion || viewportChanged)) {
			cacheBuilding = false;
		}
		const dirty = !cacheBuilding
			&& (version !== lastBodyVersion || viewportChanged);
		if (dirty) {
			// Start a fresh chunked build.
			//
			// Phase 1.5.1 (2026-05-25): no global cascade cache clear —
			// per-element invalidations from the LiveStyle Proxy +
			// setAttribute + classList.notify handle that incrementally.
			resetLayoutCache();
			const bodyBox = layoutFixedRoot(root, 0, 0, viewport.width, viewport.height);
			// Post-pass: lay out `position: absolute` descendants against
			// their nearest positioned ancestor's box (or body when none).
			// Run AFTER normal flow so containing-block boxes are cached;
			// the absolutes' own boxes land in the same cache and paint
			// via paintSubtreeLaid's natural child walk.
			for (const abs of collectAbsolutes(root)) {
				const cb = findAbsoluteContainingBlock(abs, root);
				const cbBox = getLayoutBox(cb);
				if (!cbBox) continue;
				layoutAbsoluteRoot(abs, cbBox.contentX, cbBox.contentY, cbBox.contentW, cbBox.contentH);
			}
			// Use the body's FULL layout height (which includes its own
			// padding) rather than just `intrinsicContentH`. Children
			// paint at `contentY = paddingTop` upwards, so the actual
			// painted region of the cache spans `[0, bodyBox.h)`. Using
			// `intrinsicContentH` here (which excludes paddingTop +
			// paddingBottom) made the last `paddingTop` pixels of every
			// page fall off the cache + past the reported scroll bound —
			// you couldn't scroll far enough to see them, and even if you
			// could, the cache canvas was too short to hold them.
			lastLiveContentBottom = bodyBox.h;

			// (Re)allocate the cache OffscreenCanvas. Cleared once at
			// build start; chunked ops paint into it over multiple
			// frame yields.
			const cacheH = Math.max(
				viewport.height,
				Math.min(bodyBox.h, LIVE_CACHE_MAX_H),
			);
			if (!liveCacheOffscreen
				|| liveCacheW !== viewport.width
				|| liveCacheH !== cacheH
			) {
				liveCacheOffscreen = new OffscreenCanvas(viewport.width, cacheH);
				liveCacheW = viewport.width;
				liveCacheH = cacheH;
			}
			const cacheCtx = liveCacheOffscreen.getContext('2d');
			if (cacheCtx) {
				cacheCtx.clearRect(0, 0, liveCacheW, liveCacheH);
				// Paint the body's own box (background fill) up-front so
				// partial-paint frames show the page bg below the painted
				// content instead of a transparent void.
				const bodyCs = getComputedLiveStyle(root);
				const bodyBoxAtFlow = getLayoutBox(root);
				// Phase 3b (2026-05-26): when body has a bg color AND
				// the cache canvas is taller than body's layout box
				// (short page over a viewport-sized cache, or any case
				// where body's box doesn't tile the full cache),
				// fillRect the ENTIRE cache with body bg so the cache
				// is fully opaque regardless of body's box dims. Avoids
				// the "drawImage with transparent edges produces
				// stacking artifacts on scroll" issue seen on Citron's
				// web-experiments page after the per-frame screen fill
				// was removed. Cheap: one fillRect per cache build, not
				// per frame.
				if (bodyCs.background) {
					cacheCtx.fillStyle = bodyCs.background;
					cacheCtx.fillRect(0, 0, liveCacheW, liveCacheH);
				}
				if (bodyBoxAtFlow) {
					setLayoutMeasureCtx(cacheCtx);
					paintBoxedElement(cacheCtx, root, bodyCs, bodyBoxAtFlow);
					setLayoutMeasureCtx(ctx);
				}
			}
			// Pre-walk the body subtree producing a flat list of paint
			// ops (one per element bg + one per inline atom). The chunked
			// loop below yields by time-budget across this flat list, so
			// a heavy `<p>` with 30+ atoms breaks across multiple chunks
			// instead of painting in one ~90 ms blob.
			buildOps = [];
			collectPaintOps(root, buildOps, /* skipBgOfRoot */ true);
			buildOpIndex = 0;
			cacheBuilding = true;
			buildVersion = version;
			lastBodyViewportW = viewport.width;
			lastBodyViewportH = viewport.height;
		}

		// Paint a time-budgeted chunk of ops into the cache. Each op is
		// either an element's bg/borders/non-inline-text (paintBoxedElement)
		// or one inline atom. After ~budget ms we yield via setTimeout →
		// requestFullRepaint so the event loop can process scroll input +
		// animation frames.
		//
		// Phase 2.5.5 (2026-05-25): use a smaller chunk budget when this
		// paint was triggered by scroll input. Both scroll AND idle ticks
		// advance the build so content fills in below the user's finger
		// during continuous scrolling. Skipping the chunk entirely on
		// scroll (the earlier attempt) left the cache empty until the
		// user paused — visible to the user as "page doesn't render until
		// I stop scrolling."
		const scrollChanged = !Number.isNaN(lastPaintedScrollY) && scrollY !== lastPaintedScrollY;
		const budget = scrollChanged ? SCROLL_CHUNK_MS : BUILD_CHUNK_MS;
		if (cacheBuilding && liveCacheOffscreen) {
			const cacheCtx = liveCacheOffscreen.getContext('2d');
			if (cacheCtx) {
				setLayoutMeasureCtx(cacheCtx);
				const start = performance.now();
				while (buildOpIndex < buildOps.length) {
					const op = buildOps[buildOpIndex];
					if (op.kind === 'bg' && op.cs && op.box) {
						paintBoxedElement(cacheCtx, op.el, op.cs, op.box);
					} else if (op.kind === 'atom' && op.atom) {
						paintOneInlineAtom(cacheCtx, op.atom);
					}
					buildOpIndex++;
					if (performance.now() - start > budget) break;
				}
				setLayoutMeasureCtx(ctx);
				if (buildOpIndex >= buildOps.length) {
					cacheBuilding = false;
					buildOps = [];
					lastBodyVersion = buildVersion;
				}
			}
		}
		lastPaintedScrollY = scrollY;

		// Blit cache to screen at the current scroll offset (partial or
		// complete — partial paints show the body bg below the painted
		// chunks so the page doesn't look broken during build).
		if (liveCacheOffscreen) {
			const srcY = Math.max(0, Math.min(scrollY, liveCacheH));
			const visibleH = Math.min(viewport.height, liveCacheH - srcY);
			if (visibleH > 0) {
				ctx.save();
				try {
					ctx.beginPath();
					ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
					ctx.clip();
					ctx.drawImage(
						liveCacheOffscreen as unknown as CanvasImageSource,
						0, srcY, viewport.width, visibleH,
						viewport.x, viewport.y, viewport.width, visibleH,
					);
				} finally { ctx.restore(); }
			}
		}

		// Schedule next chunk via setTimeout(0) → requestFullRepaint.
		// The shell's onTick consumes the flag and calls repaintContent,
		// which re-enters this function with cacheBuilding still true
		// → continues from buildChildIndex.
		if (cacheBuilding && !buildContinuationScheduled) {
			buildContinuationScheduled = true;
			setTimeout(() => {
				buildContinuationScheduled = false;
				requestFullRepaint();
			}, 0);
		}
	} else {
		lastLiveContentBottom = 0;
		lastBodyVersion = -1;
		lastBodyViewportW = -1;
		lastBodyViewportH = -1;
		// Drop the OffscreenCanvas reference so it gets GC'd on pages
		// that switch from live-DOM to overlay-only after navigation.
		liveCacheOffscreen = null;
		liveCacheW = 0;
		liveCacheH = 0;
		cacheBuilding = false;
		buildOps = [];
		buildOpIndex = 0;
		buildVersion = -1;
	}

	// Collect top-level fixed elements (any descendant of root whose
	// computed position === 'fixed'). M2.6 reads computed style so
	// class-based `.lil-gui.autoPlace { position: fixed }` rules work.
	// Fixed elements paint AFTER the body flow (z-stacking on top) and
	// at viewport-origin coords (no scrollY applied).
	//
	// Phase 1.6.2 (2026-05-25): cache the walk result keyed by
	// liveTreeVersion. For pages with NO fixed elements (the dom-elements
	// showcase et al.) this collapses the per-scroll-tick walk from
	// "150 × getComputedLiveStyle" to "1 cache-hit comparison." Saves
	// 1-3 ms per scroll frame — the difference between 50 and 60 FPS
	// on Citron.
	const fixedVersion = getLiveTreeVersion();
	if (cachedFixedVersion !== fixedVersion) {
		cachedFixed = [];
		let order = 0;
		const collect = (el: LiveElement) => {
			const cs = getComputedLiveStyle(el);
			if (cs.display === 'none') return;
			const pos = cs.position ?? el.style.position;
			if (pos === 'fixed') {
				cachedFixed.push({ el, cs, order: order++ });
			}
			for (const c of el.children) collect(c);
		};
		collect(root);
		cachedFixed.sort((a, b) => {
			const za = a.cs.zIndex ?? a.el.style.zIndex ?? 0;
			const zb = b.cs.zIndex ?? b.el.style.zIndex ?? 0;
			if (za !== zb) return za - zb;
			return a.order - b.order; // stable in document order
		});
		cachedFixedVersion = fixedVersion;
	}
	const fixed = cachedFixed;

	for (const { el, cs } of fixed) {
		const alpha = cs.opacity ?? el.style.opacity ?? 1;
		// Resolve box width / height from cascade-or-inline, defaulting
		// to "let layout figure it out" when neither side declares.
		// Position:fixed's containing block is the viewport so percent
		// widths/heights resolve against viewport.{width,height}.
		const explicitW = resolveLength(cs.width, viewport.width)
			?? resolveLength(el.style.width, viewport.width);
		const explicitH = resolveLength(cs.height, viewport.height)
			?? resolveLength(el.style.height, viewport.height);
		// Resolve origin: prefer `left`/`top`; if `right`/`bottom` set
		// and width/height known, anchor from viewport's right/bottom
		// edge (lil-gui's `.autoPlace { right: 15px; top: 0 }` lands
		// here).
		const csLeft = cs.left ?? el.style.left;
		const csRight = cs.right ?? el.style.right;
		const csTop = cs.top ?? el.style.top;
		const csBottom = cs.bottom ?? el.style.bottom;
		let x = viewport.x;
		if (csLeft !== undefined) {
			x = viewport.x + csLeft;
		} else if (csRight !== undefined && explicitW !== undefined) {
			x = viewport.x + viewport.width - explicitW - csRight;
		}
		let y = viewport.y;
		if (csTop !== undefined) {
			y = viewport.y + csTop;
		} else if (csBottom !== undefined && explicitH !== undefined) {
			y = viewport.y + viewport.height - explicitH - csBottom;
		}
		const availW = explicitW
			?? Math.max(0, viewport.width - (csLeft ?? 0));
		const availH = explicitH
			?? Math.max(0, viewport.height - (csTop ?? 0));
		layoutFixedRoot(el, x, y, availW, availH);
		ctx.save();
		try {
			ctx.globalAlpha = alpha;
			paintSubtreeLaid(ctx, el);
		} finally {
			ctx.restore();
		}
	}
}

/** Per-frame walk of the live tree to overlay animated `<canvas>`
 * content on top of the cached body paint.
 *
 * For each visible CANVAS LiveElement in body-flow:
 *   - WebGL-backed → `copyBridgeToScreen(...)` (fast direct path).
 *   - 2D-backed → `drawImage(offscreen, ...)`.
 *
 * `copyBridgeToScreen` is dependency-injected to avoid coupling
 * live-overlay.ts to canvas-runner.ts (the canvas-runner imports
 * live-overlay for the cache patch APIs, so the reverse would create
 * a cycle). The shell hands in its closure-bound helper.
 *
 * Clips to the viewport rect; honors `scrollY`. Skips fixed-position
 * canvases (they're painted at viewport-origin via the fixed-element
 * pass, which already handles canvas via `paintBoxedElement`'s normal
 * drawImage branch — WebGL fixed canvases would need separate work). */
export function overlayLiveAnimatedCanvases(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	root: LiveElement,
	viewport: LiveViewport,
	scrollY: number,
	copyBridgeToScreen: (
		srcX: number, srcY: number, srcW: number, srcH: number,
		dstX: number, dstY: number,
	) => boolean,
): void {
	ctx.save();
	try {
		ctx.beginPath();
		ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
		ctx.clip();
		const visit = (el: LiveElement, inFixed: boolean) => {
			const cs = getComputedLiveStyle(el);
			if (cs.display === 'none') return;
			const pos = cs.position ?? el.style.position;
			const nowFixed = inFixed || pos === 'fixed';
			if (el.tagName === 'CANVAS' && !nowFixed) {
				const box = getLayoutBox(el);
				if (box && box.w > 0 && box.h > 0) {
					const screenX = box.x + viewport.x;
					const screenY = box.y + viewport.y - scrollY;
					// Visibility cull against viewport.
					const vTop = viewport.y;
					const vBot = viewport.y + viewport.height;
					if (screenY + box.h >= vTop && screenY <= vBot) {
						if (el.isWebGLBacked()) {
							copyBridgeToScreen(
								0, 0, box.w, box.h,
								screenX, screenY,
							);
						} else {
							const off = el.getOffscreen();
							if (off) {
								try {
									ctx.drawImage(
										off as unknown as CanvasImageSource,
										screenX, screenY, box.w, box.h,
									);
								} catch (_) { /* swallow */ }
							}
						}
					}
				}
			}
			// Slice 2a: VIDEO frames overlay on top of the cached
			// placeholder. The cache holds the slice-1 placeholder paint;
			// each tickVideo blit updates live-video's per-element
			// OffscreenCanvas and getVideoFrame returns it here. Pattern
			// mirrors the CANVAS branch above so we don't bump live-tree
			// version and trigger a full cache rebuild every frame.
			if (el.tagName === 'VIDEO' && !nowFixed) {
				const box = getLayoutBox(el);
				if (box && box.w > 0 && box.h > 0) {
					const screenX = box.x + viewport.x;
					const screenY = box.y + viewport.y - scrollY;
					const vTop = viewport.y;
					const vBot = viewport.y + viewport.height;
					if (screenY + box.h >= vTop && screenY <= vBot) {
						// Sized variant (2026-05-27): pass the full layout
						// box so paintVideoFrameAt can scale (object-fit:
						// contain with letterbox/pillarbox).
						const havePainted = paintVideoFrameAt(ctx, el, screenX, screenY, box.w, box.h);
						// Controls bar on top of the frame so it stays
						// visible regardless of decoder state. Time
						// display updates here so it's always live.
						// When no frame painted (audio-only, or decoder
						// not yet open), wipe the bar region with the
						// placeholder background before the translucent
						// bar paint — otherwise repeated passes (cache
						// blit, walker, walker, walker...) would compound
						// the alpha and darken the bar over time.
						if (!havePainted) {
							const barH = Math.min(VIDEO_CONTROLS_BAR_H, box.h);
							ctx.fillStyle = '#000000';
							ctx.fillRect(
								screenX, screenY + box.h - barH,
								box.w, barH,
							);
						}
						paintVideoControls(ctx, el, screenX, screenY, box.w, box.h);
					}
				}
			}
			for (const c of el.children) visit(c, nowFixed);
		};
		visit(root, false);
	} finally { ctx.restore(); }
}

/** Walk the live tree extracting `<a href>` / `<button data-action>` /
 * `<summary>` tap targets so the touch dispatcher can fire navigation,
 * button-action, and summary-toggle inputs without re-implementing
 * tree-walking in controller-shortcuts. Returns the closest matching
 * ancestor of `target`, or null. */
export function findTapIntent(
	target: LiveElement,
	tapX: number = 0, tapY: number = 0,
	viewportX: number = 0, viewportY: number = 0, scrollY: number = 0,
): { kind: 'navigate'; href: string }
| { kind: 'button-action'; action: string }
| { kind: 'summary'; summary: LiveElement }
| { kind: 'video-control'; control: VideoControlHit; video: LiveElement }
| { kind: 'video-frame-tap'; video: LiveElement }
| null {
	for (let n: LiveElement | null = target; n; n = n.parent) {
		if (n.tagName === 'A') {
			const href = n.getAttribute('href');
			if (href) return { kind: 'navigate', href };
		}
		if (n.tagName === 'BUTTON') {
			const action = n.getAttribute('data-action');
			if (action) return { kind: 'button-action', action };
		}
		if (n.tagName === 'SUMMARY') {
			return { kind: 'summary', summary: n };
		}
		if (n.tagName === 'VIDEO') {
			// Controls-bar hits route through `video-control`. Taps on
			// the frame itself (outside the bar) route through
			// `video-frame-tap` so controller-shortcuts can apply the
			// single-vs-double-tap discrimination (single = play/pause
			// toggle, double = fullscreen toggle). Stop the ancestor
			// walk either way so a tap on a video inside an <a> doesn't
			// fall through to navigation.
			const box = getLayoutBox(n);
			if (box) {
				const screenX = box.x + viewportX;
				const screenY = box.y + viewportY - scrollY;
				const ctrl = hitTestVideoControls(
					screenX, screenY, box.w, box.h, tapX, tapY, n,
				);
				if (ctrl) return { kind: 'video-control', control: ctrl, video: n };
			}
			return { kind: 'video-frame-tap', video: n };
		}
	}
	return null;
}

/** Paint a subtree using the per-frame layout cache. Each element
 * draws at its laid-out border-box; children recurse. M2.5: when an
 * element has `overflow-y: auto|scroll|hidden` and its intrinsic
 * content exceeds the content box, clip children to the content rect
 * and translate by -scrollTop so only the visible window shows. */
function paintSubtreeLaid(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
): void {
	const cs = getComputedLiveStyle(el);
	if (cs.display === 'none') return;
	const box = getLayoutBox(el);
	if (!box) {
		// Table sectioning elements (THEAD / TBODY / TFOOT / TR) don't get
		// their own LayoutBox — layoutTable stores boxes per-cell directly.
		// Without this fall-through the painter would stop at the section
		// boundary and skip every cell beneath it.
		const tag = el.tagName;
		if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT' || tag === 'TR') {
			for (const c of el.children) paintSubtreeLaid(ctx, c);
		}
		return;
	}
	// position: relative — element stays at its normal-flow box but its
	// painted output (and descendant subtree) shifts by `top`/`left`.
	// `right`/`bottom` are reverse offsets when their counterpart is
	// unset. We wrap the whole subtree (box + children) in a
	// ctx.translate so the relative element AND every absolutely-
	// positioned descendant whose containing-block is this relative
	// element move together visually.
	const pos = cs.position ?? el.style.position;
	const isRelative = pos === 'relative';
	if (isRelative) {
		const dx = (cs.left ?? el.style.left ?? 0) - (cs.right ?? el.style.right ?? 0);
		const dy = (cs.top ?? el.style.top ?? 0) - (cs.bottom ?? el.style.bottom ?? 0);
		if (dx !== 0 || dy !== 0) {
			ctx.save();
			try {
				ctx.translate(dx, dy);
				paintBoxedElement(ctx, el, cs, box);
				paintSubtreeRest(ctx, el, cs, box);
			} finally {
				ctx.restore();
			}
			return;
		}
	}
	paintBoxedElement(ctx, el, cs, box);
	paintSubtreeRest(ctx, el, cs, box);
}

/** Post-`paintBoxedElement` walk: inline-flow atoms OR clip-aware child
 * recursion. Factored out so the `position: relative` branch in
 * `paintSubtreeLaid` can share the same logic under its translate. */
function paintSubtreeRest(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	// Phase 2.5 inline-formatting context (2026-05-25): if `el` is a
	// block parent that contains inline content (own text + inline kids),
	// layoutInline stored an InlineLayout with per-atom boxes. Paint
	// those atoms instead of recursing into children — the children's
	// content has already been packed into line-box atoms.
	const inline = getInlineLayout(el);
	if (inline) {
		paintInlineAtoms(ctx, inline);
		return;
	}
	if (el.children.length === 0) return;

	const oy = cs.overflowY ?? 'visible';
	const ox = cs.overflowX ?? 'visible';
	const clips = (oy !== 'visible') || (ox !== 'visible');
	const scrolls = (oy === 'auto' || oy === 'scroll')
		&& box.intrinsicContentH > box.contentH;
	if (clips || scrolls) {
		ctx.save();
		try {
			ctx.beginPath();
			ctx.rect(box.contentX, box.contentY, box.contentW, box.contentH);
			ctx.clip();
			if (scrolls) {
				const maxScroll = Math.max(0, box.intrinsicContentH - box.contentH);
				const st = Math.min(el.scrollTop, maxScroll);
				ctx.translate(0, -st);
			}
			for (const c of el.children) paintSubtreeLaid(ctx, c);
		} finally { ctx.restore(); }
		return;
	}
	for (const c of el.children) paintSubtreeLaid(ctx, c);
}

/** Paint one element using its layout box. Backgrounds + canvas
 * drawImage land at the box rect; text uses the content rect for
 * alignment / clipping. Children paint via their own boxes (driven
 * by `paintSubtreeLaid`). */
function paintBoxedElement(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const tag = el.tagName;
	const radius = resolveLiveBorderRadius(cs, box.w, box.h);
	if (tag === 'CANVAS') {
		// Phase 3b (2026-05-26): drawImage the OffscreenCanvas regardless
		// of whether it's WebGL-backed. The canvas-runner's
		// `readbackWebGLEntries` populates each WebGL canvas's offscreen
		// with the bridge FBO pixels between page scripts, so the
		// offscreen always has SOMETHING to draw (the final frame from
		// the script's draw chain). For animated pages, the shell's
		// `overlayLiveAnimatedCanvases` runs per-frame AFTER paintLiveOverlay
		// and overwrites this drawImage with fresh `copyBridgeToScreen`
		// content — so the only cost of always-drawImage is one extra
		// cache-build-time blit per WebGL canvas, never per-frame.
		//
		// Previously skipped for WebGL canvases assuming the overlay
		// would always handle them, but that's only true on pages with
		// rAF activity. Static WebGL pages (canvas-webgl etc.) ran
		// scripts once, then nothing — canvas slots stayed blank because
		// the overlay never fired. Drawing the readback pixels fixes
		// both static and animated cases.
		const off = el.getOffscreen();
		if (off) {
			const w = box.w > 0 ? box.w : el.getDisplaySize().w;
			const h = box.h > 0 ? box.h : el.getDisplaySize().h;
			try {
				if (radius > 0) {
					ctx.save();
					try {
						pathLiveRoundedRect(ctx, box.x, box.y, w, h, radius);
						ctx.clip();
						ctx.drawImage(off as unknown as CanvasImageSource, box.x, box.y, w, h);
					} finally { ctx.restore(); }
				} else {
					ctx.drawImage(off as unknown as CanvasImageSource, box.x, box.y, w, h);
				}
			} catch (_) { /* swallow — drawImage on uninitialised canvas */ }
		}
		return;
	}
	// M2.4 form widget dispatch.
	if (paintFormWidget(ctx, el, cs, box)) return;
	if (box.w > 0 && box.h > 0) {
		paintOuterBoxShadows(ctx, cs, box, radius);
		paintBackground(ctx, cs, box, radius);
		paintInsetBoxShadows(ctx, cs, box, radius);
	}
	paintBorders(ctx, cs, box, radius);
	// DOM-showcase paint cases (HR / METER / PROGRESS / SUMMARY chevron).
	// BR / DETAILS produce no own pixels — BR is whitespace, DETAILS is
	// a layout container whose children paint individually.
	if (tag === 'HR') {
		paintHr(ctx, cs, box);
		return;
	}
	if (tag === 'METER') {
		paintMeter(ctx, el, cs, box);
		return;
	}
	if (tag === 'PROGRESS') {
		paintProgress(ctx, el, cs, box);
		return;
	}
	if (tag === 'IMG') {
		paintImg(ctx, el, cs, box, radius);
		return;
	}
	if (tag === 'SVG') {
		paintLiveSvg(ctx, el, box);
		return;
	}
	if (tag === 'VIDEO') {
		paintVideoPlaceholder(ctx, el, cs, box, radius);
		return;
	}
	if (tag === 'BR') return;
	if (tag === 'LI') paintListMarker(ctx, el, cs, box);
	// Phase 2.5: if this element has inline content packed into line
	// boxes, paintSubtreeLaid will walk them separately via
	// paintInlineAtoms. The single-line paintLiveText path stays for
	// form widgets / no-inline-layout containers.
	if (getInlineLayout(el)) return;
	paintLiveText(ctx, el, cs, box.contentX, box.contentY, box.contentW, box.contentH, box);
}

/** Phase 2.5 inline paint (2026-05-25): walk an InlineLayout's atoms and
 * paint each at its already-resolved body-local box. Cascade-derived
 * styling (color / fontWeight / fontStyle / textDecoration / vertical-
 * align / background) is read per-atom from `atom.el`'s computed style. */
function paintInlineAtoms(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	layout: InlineLayout,
): void {
	for (const atom of layout.atoms) {
		paintOneInlineAtom(ctx, atom);
	}
}

/** Phase 2.5.3 (2026-05-25): extracted single-atom paint so the
 * chunked-build flat-ops list can yield between atoms. Shared with
 * `paintInlineAtoms` for the non-chunked case (partial repaint patch). */
function paintOneInlineAtom(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	atom: InlineAtom,
): void {
	if (atom.isBr) return; // pure layout marker
	const cs = getComputedLiveStyle(atom.el);
	if (atom.el.tagName === 'IMG') {
		paintImg(ctx, atom.el, cs, {
			x: atom.x, y: atom.y, w: atom.w, h: atom.h,
			contentX: atom.x, contentY: atom.y,
			contentW: atom.w, contentH: atom.h,
			intrinsicContentH: atom.h, intrinsicContentW: atom.w,
		});
		return;
	}
	if (atom.el.tagName === 'CANVAS') {
		// drawImage the offscreen at the atom's box. For WebGL-backed
		// canvases the per-frame `overlayLiveAnimatedCanvases` pass runs
		// AFTER the cache blit and overwrites this with fresh bridge
		// pixels via `copyBridgeToScreen` — so this is the static
		// fallback (initial paint before first rAF, or non-animated
		// WebGL pages whose offscreen was populated by
		// `readbackWebGLEntries`).
		const off = atom.el.getOffscreen();
		if (off) {
			try {
				ctx.drawImage(off as unknown as CanvasImageSource,
					atom.x, atom.y, atom.w, atom.h);
			} catch (_) { /* swallow — drawImage on uninitialised canvas */ }
		}
		return;
	}
	if (!atom.text) return;
	const styleShim = {
		fontFamily: cs.fontFamily,
		fontSize: atom.fontSize,
		fontWeight: cs.fontWeight,
		fontStyle: cs.fontStyle,
	};
	const color = cs.color || '#e0e8f4';
	const bold = isBoldWeight(styleShim);
	const italic = isItalicStyle(styleShim);
	const fontSize = atom.fontSize;
	let shiftY = 0;
	if (cs.verticalAlign === 'super') shiftY = -fontSize * 0.35;
	else if (cs.verticalAlign === 'sub') shiftY = fontSize * 0.3;
	const drawY = atom.y + atom.h / 2 + shiftY;
	ctx.save();
	try {
		if (cs.background && cs.background !== 'transparent') {
			ctx.fillStyle = cs.background;
			ctx.fillRect(atom.x, atom.y, atom.w, atom.h);
		}
		ctx.font = atom.font;
		ctx.fillStyle = color;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		if (italic) ctx.transform(1, 0, -0.2, 1, drawY * 0.2, 0);
		ctx.fillText(atom.text, atom.x, drawY);
		if (bold) ctx.fillText(atom.text, atom.x + 1, drawY);
		const td = cs.textDecoration;
		if (td && td !== 'none' && !atom.text.match(/^\s*$/)) {
			let lineY: number;
			if (td === 'underline') lineY = drawY + fontSize * 0.45;
			else if (td === 'overline') lineY = drawY - fontSize * 0.5;
			else lineY = drawY;
			ctx.fillStyle = color;
			ctx.fillRect(atom.x, Math.round(lineY), atom.w, 1);
		}
	} finally { ctx.restore(); }
}

/** Phase 2.5.3 pre-walk: produce a flat list of paint ops in document
 * order — one `'bg'` op per visible element (which paints its background,
 * borders, and any non-inline text via `paintBoxedElement`), plus one
 * `'atom'` op per inline atom inside an InlineLayout. The chunked
 * builder consumes these one at a time so the time budget can fire
 * between any two atoms, even inside a heavy paragraph.
 *
 * Skips fixed-position descendants (they paint via the separate
 * fixed-element pass at the bottom of `paintLiveOverlay`).
 * `skipBgOfRoot` lets the caller omit the body's own bg op when it was
 * already painted up-front. */
function collectPaintOps(
	el: LiveElement,
	out: PaintOp[],
	skipBgOfRoot: boolean,
): void {
	const cs = getComputedLiveStyle(el);
	if (cs.display === 'none') return;
	if (el.style.position === 'fixed' && !skipBgOfRoot) return;
	const box = getLayoutBox(el);
	if (!box) {
		// Table sectioning elements (THEAD / TBODY / TFOOT / TR) don't get
		// their own LayoutBox — layoutTable stores boxes per-cell directly.
		// Mirror paintSubtreeLaid's fall-through so the chunked builder
		// reaches every cell instead of stopping at the section boundary.
		const tag = el.tagName;
		if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT' || tag === 'TR') {
			for (const c of el.children) collectPaintOps(c, out, false);
		}
		return;
	}
	if (!skipBgOfRoot) {
		out.push({ kind: 'bg', el, cs, box });
	}
	const inline = getInlineLayout(el);
	if (inline) {
		for (const atom of inline.atoms) {
			if (atom.isBr) continue;
			out.push({ kind: 'atom', el: atom.el, atom });
		}
		return; // inline layout replaces child walk
	}
	for (const c of el.children) {
		collectPaintOps(c, out, false);
	}
}

/** Format a positive integer 1..n as an upper-case roman numeral (1→'I',
 * 4→'IV', 9→'IX', 40→'XL', etc.). Caller lowercases for `lower-roman`.
 * Numbers ≤0 or non-finite fall back to the decimal form. */
function toRoman(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return String(n);
	const table: [number, string][] = [
		[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
		[100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
		[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
	];
	let out = '';
	for (const [v, sym] of table) {
		while (n >= v) { out += sym; n -= v; }
	}
	return out;
}

/** Paint the list-style marker (bullet / number / letter / roman) to
 * the left of an `<li>` element. Marker position lands in the parent
 * list's left-padding region — the parent UL/OL ships with
 * `padding-left: 30px` so the marker has room without overlapping content.
 *
 * Marker shape is picked from the cascade-resolved `list-style-type`,
 * with `<ol type="1|A|a|I|i">` honored as a fallback when the cascade
 * doesn't set one. Bullet glyphs that aren't reliably in the Switch font
 * are drawn as canvas paths (filled disc, stroked circle, filled square)
 * per [[nxjs-font-glyph-coverage]]. */
function paintListMarker(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	let styleType = cs.listStyleType;
	const parent = el.parent;
	if (!styleType && parent && parent.tagName === 'OL') {
		const t = parent.getAttribute('type');
		if (t === '1') styleType = 'decimal';
		else if (t === 'A') styleType = 'upper-alpha';
		else if (t === 'a') styleType = 'lower-alpha';
		else if (t === 'I') styleType = 'upper-roman';
		else if (t === 'i') styleType = 'lower-roman';
	}
	if (!styleType || styleType === 'none') return;

	const fontSize = cs.fontSize ?? 14;
	const color = cs.color || '#e0e8f4';
	// Marker baseline lines up with the LI's first text line.
	const cy = box.y + Math.min(box.h, fontSize * 1.2) / 2;
	// Marker x sits 18 px left of the LI's content box. Parent's
	// padding-left (30 px UA default) reserves the room.
	const cx = box.x - 18;

	if (styleType === 'disc' || styleType === 'circle' || styleType === 'square') {
		ctx.save();
		try {
			ctx.fillStyle = color;
			ctx.strokeStyle = color;
			ctx.lineWidth = 1;
			const r = Math.max(2, fontSize * 0.18);
			if (styleType === 'disc') {
				ctx.beginPath();
				ctx.arc(cx, cy, r, 0, Math.PI * 2);
				ctx.fill();
			} else if (styleType === 'circle') {
				ctx.beginPath();
				ctx.arc(cx, cy, r, 0, Math.PI * 2);
				ctx.stroke();
			} else {
				ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
			}
		} finally { ctx.restore(); }
		return;
	}

	// Numeric / alphabetic markers: compute the LI's 1-based index
	// within its parent list (counting LI children only).
	let index = 1;
	if (parent) {
		let i = 1;
		for (const sib of parent.children) {
			if (sib === el) { index = i; break; }
			if (sib.tagName === 'LI') i++;
		}
	}
	let text: string;
	if (styleType === 'decimal') text = String(index) + '.';
	else if (styleType === 'lower-alpha') text = String.fromCharCode(96 + ((index - 1) % 26) + 1) + '.';
	else if (styleType === 'upper-alpha') text = String.fromCharCode(64 + ((index - 1) % 26) + 1) + '.';
	else if (styleType === 'lower-roman') text = toRoman(index).toLowerCase() + '.';
	else if (styleType === 'upper-roman') text = toRoman(index) + '.';
	else return;

	ctx.save();
	try {
		ctx.font = fontSize + 'px ' + (cs.fontFamily || 'sans-serif');
		ctx.fillStyle = color;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'right';
		ctx.fillText(text, cx + 4, cy);
	} finally { ctx.restore(); }
}

/** `<img>` paints the loaded Image at the layout box, or a placeholder
 * (dashed border + `alt` text) while the image is loading / missing.
 * The aspect ratio is honored by drawImage's stretch — the page is
 * expected to set width via CSS to control the displayed size. */
function paintImg(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	radius: number = 0,
): void {
	const img = el.getLoadedImage();
	if (img && box.w > 0 && box.h > 0) {
		try {
			if (radius > 0) {
				ctx.save();
				try {
					pathLiveRoundedRect(ctx, box.x, box.y, box.w, box.h, radius);
					ctx.clip();
					ctx.drawImage(img as unknown as CanvasImageSource, box.x, box.y, box.w, box.h);
				} finally { ctx.restore(); }
			} else {
				ctx.drawImage(img as unknown as CanvasImageSource, box.x, box.y, box.w, box.h);
			}
			return;
		} catch (_) { /* fall through to placeholder */ }
	}
	// Placeholder: gray box + alt text centered.
	ctx.fillStyle = cs.background || '#1d2c43';
	ctx.fillRect(box.x, box.y, box.w, box.h);
	ctx.strokeStyle = '#5a6a7e';
	ctx.lineWidth = 1;
	ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
	const alt = el.getAttribute('alt') || '[img]';
	ctx.save();
	try {
		ctx.fillStyle = cs.color || '#9bb1d6';
		ctx.font = (cs.fontSize ?? 12) + 'px ' + (cs.fontFamily || 'sans-serif');
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.beginPath();
		ctx.rect(box.x, box.y, box.w, box.h);
		ctx.clip();
		ctx.fillText(alt, box.x + box.w / 2, box.y + box.h / 2);
	} finally { ctx.restore(); }
}

/** `<video>` slice 1 placeholder paint. Reserves the element's box
 * (sized via attributes in `layoutLeaf`) and fills it with a black
 * background + a centered play triangle + the resolved source URL.
 * Real decode + frame render is a future slice — until then this
 * gives pages a visible video-shaped slot so layout can be exercised.
 *
 * The "resolved source" follows the HTML <video> spec selection rules
 * loosely: prefer the element's own `src` attribute, else the first
 * `<source>` child with a matching `type` attribute (we treat any
 * MIME-type-shaped value as acceptable since no decoder is wired yet),
 * else the first `<source>` child with any `src`. */
function paintVideoPlaceholder(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	radius: number = 0,
): void {
	// Slice 2a: the cache-side painter always renders the slice-1
	// placeholder (black box + play triangle). Live video frames are
	// blitted over the top in `overlayLiveAnimatedCanvases` once per
	// tickVideo, so we don't have to invalidate the cache + rebuild
	// chunks every video frame.
	// Box fill: prefer cs.background (page CSS may override), else black.
	const bg = cs.background && cs.background !== 'transparent' ? cs.background : '#000000';
	ctx.save();
	try {
		if (radius > 0) {
			pathLiveRoundedRect(ctx, box.x, box.y, box.w, box.h, radius);
			ctx.clip();
		}
		ctx.fillStyle = bg;
		ctx.fillRect(box.x, box.y, box.w, box.h);
		// Play triangle: equilateral, centered, ~30% of min(w, h).
		const minDim = Math.min(box.w, box.h);
		const triH = Math.max(16, Math.round(minDim * 0.3));
		const triW = Math.round(triH * 0.866); // equilateral aspect
		const cx = box.x + box.w / 2;
		const cy = box.y + box.h / 2;
		ctx.fillStyle = '#ffffff';
		ctx.globalAlpha = 0.85;
		ctx.beginPath();
		ctx.moveTo(cx - triW / 2, cy - triH / 2);
		ctx.lineTo(cx + triW / 2, cy);
		ctx.lineTo(cx - triW / 2, cy + triH / 2);
		ctx.closePath();
		ctx.fill();
		ctx.globalAlpha = 1;
		// Source URL below the triangle, if the box is tall enough.
		const src = resolveVideoSourceUrl(el);
		if (src && box.h > triH + 40) {
			ctx.fillStyle = '#cfd6e3';
			ctx.font = '12px sans-serif';
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'center';
			const labelY = cy + triH / 2 + 14;
			// Clip the label to the box so long URLs don't escape.
			ctx.save();
			try {
				ctx.beginPath();
				ctx.rect(box.x + 4, labelY - 8, box.w - 8, 16);
				ctx.clip();
				ctx.fillText(src, cx, labelY);
			} finally { ctx.restore(); }
			// Tag attribute hints (controls / autoplay / loop / muted) in
			// a row above the URL so we can verify they were parsed.
			const hints: string[] = [];
			if (el.hasAttribute('controls')) hints.push('controls');
			if (el.hasAttribute('autoplay')) hints.push('autoplay');
			if (el.hasAttribute('loop')) hints.push('loop');
			if (el.hasAttribute('muted')) hints.push('muted');
			if (hints.length > 0 && box.h > triH + 60) {
				ctx.fillStyle = '#8aa3c4';
				ctx.font = '11px sans-serif';
				ctx.fillText(hints.join(' · '), cx, labelY + 16);
			}
		}
		// Static controls bar (2026-05-27): drawn into the cache so the
		// buttons are visible before any decoder is opened. Live time
		// updates come from the overlay walker, which repaints the bar
		// on top of the frame each tick.
		paintVideoControls(ctx, el, box.x, box.y, box.w, box.h);
	} finally { ctx.restore(); }
}

/** Slice-1 source selection. The HTML spec walks <source> children
 * checking each one's `type` against a list of supported MIME types,
 * but we have no decoder yet — return the first non-empty src we can
 * find, preferring the element's own `src` attribute. */
function resolveVideoSourceUrl(el: LiveElement): string | null {
	const direct = el.getAttribute('src');
	if (direct) return direct;
	for (const child of el.children) {
		if (child.tagName !== 'SOURCE') continue;
		const childSrc = child.getAttribute('src');
		if (childSrc) return childSrc;
	}
	return null;
}

/** `<hr>` paints a 1px horizontal rule centered vertically in its box.
 * The line color comes from `border-top-color` (Chrome default), falling
 * back to the current text color. The marginTop/marginBottom of the box
 * come from the UA defaults so two HRs don't collapse together. */
function paintHr(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const color = cs.borderTopColor || cs.color || '#9bb1d6';
	const y = Math.round(box.y + box.h / 2);
	ctx.fillStyle = color;
	ctx.fillRect(box.x, y, box.w, 1);
}

/** Inline-SVG paint for the live-DOM stack. Walks the SVG element's
 * children via the shared `paintSvgSubtree` helper (same painter used
 * by the static path). Honors the `viewBox` attribute by translating +
 * scaling into user coordinates before delegating. */
const LIVE_SVG_ADAPTER: SvgNodeAdapter<LiveElement> = {
	tag: (n) => n.tagName.toLowerCase(),
	attr: (n, name) => {
		// LiveElement attribute lookup is case-sensitive in our model;
		// SVG authors typically write `viewBox`, so try that AND lower.
		const raw = n.getAttribute(name) ?? n.getAttribute(name.toLowerCase());
		return raw === null ? undefined : raw;
	},
	children: (n) => n.children,
};

function paintLiveSvg(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	box: LayoutBox,
): void {
	const viewBoxRaw = el.getAttribute('viewBox') ?? el.getAttribute('viewbox');
	let viewBox: [number, number, number, number] | undefined;
	if (viewBoxRaw) {
		const parts = viewBoxRaw.trim().split(/[\s,]+/).map(parseFloat);
		if (parts.length === 4 && parts.every((p) => Number.isFinite(p))) {
			viewBox = [parts[0], parts[1], parts[2], parts[3]];
		}
	}
	ctx.save();
	try {
		ctx.translate(box.x, box.y);
		if (viewBox) {
			const sx = box.w / Math.max(1, viewBox[2]);
			const sy = box.h / Math.max(1, viewBox[3]);
			ctx.translate(-viewBox[0] * sx, -viewBox[1] * sy);
			ctx.scale(sx, sy);
		}
		paintSvgSubtree(ctx, el, LIVE_SVG_ADAPTER);
	} finally {
		ctx.restore();
	}
}

/** `<meter>` paints a track + filled bar proportional to
 * (value − min) / (max − min). Defaults follow HTML spec: min=0,
 * max=1, value=0. Color is green (cascade-overridable via background). */
function paintMeter(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const min = parseFloat(el.getAttribute('min') ?? '0') || 0;
	const max = parseFloat(el.getAttribute('max') ?? '1');
	const value = parseFloat(el.getAttribute('value') ?? '0') || 0;
	const range = max > min ? max - min : 1;
	const frac = Math.max(0, Math.min(1, (value - min) / range));
	const trackBg = cs.background || '#1d2c43';
	const fillColor = cs.color || '#7eda9f';
	ctx.fillStyle = trackBg;
	ctx.fillRect(box.x, box.y, box.w, box.h);
	ctx.fillStyle = fillColor;
	ctx.fillRect(box.x, box.y, box.w * frac, box.h);
	ctx.strokeStyle = '#5a6a7e';
	ctx.lineWidth = 1;
	ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
}

/** `<progress>` is like meter but with only `value` + `max` attributes
 * (default max=1). No `value` attr → indeterminate; rendered as a striped
 * stand-in so it's visually distinct from a 0%-complete bar. */
function paintProgress(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const valueAttr = el.getAttribute('value');
	const max = parseFloat(el.getAttribute('max') ?? '1') || 1;
	const trackBg = cs.background || '#1d2c43';
	const fillColor = cs.color || '#7aa2ff';
	ctx.fillStyle = trackBg;
	ctx.fillRect(box.x, box.y, box.w, box.h);
	if (valueAttr === null) {
		// Indeterminate — paint a static striped pattern.
		ctx.fillStyle = fillColor;
		const stripe = 8;
		for (let x = 0; x < box.w; x += stripe * 2) {
			ctx.fillRect(box.x + x, box.y, stripe, box.h);
		}
	} else {
		const value = parseFloat(valueAttr) || 0;
		const frac = Math.max(0, Math.min(1, value / max));
		ctx.fillStyle = fillColor;
		ctx.fillRect(box.x, box.y, box.w * frac, box.h);
	}
	ctx.strokeStyle = '#5a6a7e';
	ctx.lineWidth = 1;
	ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
}

/** Paint known icon-font glyphs as canvas paths. lil-gui's CSS uses
 * `font-family: lil-gui` on its `:before`/`:after` content with four
 * icon characters (`▾` folder-open, `▸` folder-closed, `↕` dropdown
 * marker, `✓` checkmark) — the lil-gui CSS embeds a base64 woff that
 * supplies those glyphs in the browser, but we don't process @font-face.
 * Returns the painted glyph's advance width in px (so the caller can
 * offset subsequent inline content); 0 when `text` isn't a recognised
 * icon (caller falls back to fillText). Sized to the cascade-resolved
 * font size so triangles scale with the panel. Painted at the current
 * fillStyle. */
function paintIconGlyph(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	fontSize: number,
): number {
	if (text.length !== 1) return 0;
	switch (text) {
		case '▾': {
			// Down-pointing filled triangle. Centered vertically at y.
			const w = fontSize * 0.6;
			const h = fontSize * 0.45;
			ctx.beginPath();
			ctx.moveTo(x, y - h / 2);
			ctx.lineTo(x + w, y - h / 2);
			ctx.lineTo(x + w / 2, y + h / 2);
			ctx.closePath();
			ctx.fill();
			return w;
		}
		case '▸': {
			// Right-pointing filled triangle. Centered vertically at y.
			const w = fontSize * 0.45;
			const h = fontSize * 0.6;
			ctx.beginPath();
			ctx.moveTo(x, y - h / 2);
			ctx.lineTo(x, y + h / 2);
			ctx.lineTo(x + w, y);
			ctx.closePath();
			ctx.fill();
			return w;
		}
		case '↕': {
			// Vertical double-arrow. Two triangles touching at the
			// middle stroke. The select-widget painter draws its own
			// dropdown chevron, but this branch covers any direct text
			// path that emits `↕` (e.g. a `:after` content rule).
			const w = fontSize * 0.5;
			const halfH = fontSize * 0.35;
			const tipOffset = fontSize * 0.15;
			ctx.beginPath();
			ctx.moveTo(x + w / 2, y - halfH);
			ctx.lineTo(x, y - halfH + tipOffset);
			ctx.lineTo(x + w, y - halfH + tipOffset);
			ctx.closePath();
			ctx.fill();
			ctx.beginPath();
			ctx.moveTo(x + w / 2, y + halfH);
			ctx.lineTo(x, y + halfH - tipOffset);
			ctx.lineTo(x + w, y + halfH - tipOffset);
			ctx.closePath();
			ctx.fill();
			return w;
		}
		case '✓': {
			// Checkmark stroke. Kept here for completeness; the
			// checkbox painter uses its own variant.
			const prev = ctx.lineWidth;
			ctx.lineWidth = Math.max(1, fontSize * 0.12);
			ctx.strokeStyle = ctx.fillStyle as string;
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';
			const s = fontSize * 0.6;
			ctx.beginPath();
			ctx.moveTo(x, y);
			ctx.lineTo(x + s * 0.35, y + s * 0.35);
			ctx.lineTo(x + s, y - s * 0.45);
			ctx.stroke();
			ctx.lineWidth = prev;
			return s;
		}
	}
	return 0;
}

/** Paint solid-only CSS borders inside the border-box edges. Borders
 * are painted at the EDGE of `box` (no layout effect — see comment in
 * inline-css.ts on the border type slots). Skips zero-width sides and
 * sides without a resolved color. */
function paintBorders(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	radius: number = 0,
): void {
	if (box.w <= 0 || box.h <= 0) return;
	const tw = cs.borderTopWidth ?? 0;
	const rw = cs.borderRightWidth ?? 0;
	const bw = cs.borderBottomWidth ?? 0;
	const lw = cs.borderLeftWidth ?? 0;
	if (tw === 0 && rw === 0 && bw === 0 && lw === 0) return;
	const tc = cs.borderTopColor;
	const rc = cs.borderRightColor;
	const bc = cs.borderBottomColor;
	const lc = cs.borderLeftColor;
	// Rounded-rect mode: pick the first non-zero edge's settings (same
	// trade as the static painter; mismatched edges with rounded corners
	// are uncommon authoring patterns).
	if (radius > 0) {
		const sw = tw || rw || bw || lw;
		const sc = tc || rc || bc || lc;
		if (sw > 0 && sc && sc !== 'transparent') {
			ctx.save();
			try {
				ctx.lineWidth = sw;
				ctx.strokeStyle = sc;
				pathLiveRoundedRect(ctx, box.x, box.y, box.w, box.h, radius);
				ctx.stroke();
			} finally { ctx.restore(); }
		}
		return;
	}
	if (tw > 0 && tc && tc !== 'transparent') {
		ctx.fillStyle = tc;
		ctx.fillRect(box.x, box.y, box.w, tw);
	}
	if (rw > 0 && rc && rc !== 'transparent') {
		ctx.fillStyle = rc;
		ctx.fillRect(box.x + box.w - rw, box.y, rw, box.h);
	}
	if (bw > 0 && bc && bc !== 'transparent') {
		ctx.fillStyle = bc;
		ctx.fillRect(box.x, box.y + box.h - bw, box.w, bw);
	}
	if (lw > 0 && lc && lc !== 'transparent') {
		ctx.fillStyle = lc;
		ctx.fillRect(box.x, box.y, lw, box.h);
	}
}

/** Resolve a `ComputedLiveStyle.borderRadius` against a box size. */
function resolveLiveBorderRadius(cs: ComputedLiveStyle, w: number, h: number): number {
	const v = cs.borderRadius;
	if (!v || w <= 0 || h <= 0) return 0;
	const maxR = Math.min(w, h) / 2;
	if ('px' in v) return Math.max(0, Math.min(v.px, maxR));
	return Math.max(0, Math.min(v.percent * Math.min(w, h), maxR));
}

/** Paint outer (non-inset) `box-shadow` halos. Drawn BEFORE the
 * background fill so the shadow halo escapes around the box edge and
 * the background covers the opaque seed underneath. Uses Canvas's
 * native `shadow*` properties; `spread` is approximated by expanding
 * the path. */
function paintOuterBoxShadows(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	radius: number,
): void {
	const shadows = cs.boxShadow;
	if (!shadows || shadows.length === 0) return;
	for (const sh of shadows) {
		if (sh.inset) continue;
		ctx.save();
		try {
			// Spread: enlarge the casting path by `spread` px on each side
			// (and grow the corner radius proportionally so the halo keeps
			// its rounded shape).
			const sx = box.x - sh.spread;
			const sy = box.y - sh.spread;
			const sw = box.w + sh.spread * 2;
			const sh_ = box.h + sh.spread * 2;
			const sr = Math.max(0, radius + sh.spread);
			ctx.shadowOffsetX = sh.offsetX;
			ctx.shadowOffsetY = sh.offsetY;
			ctx.shadowBlur = sh.blur;
			ctx.shadowColor = sh.color;
			ctx.fillStyle = '#000'; // opaque seed for the shadow cast
			if (sr > 0) pathLiveRoundedRect(ctx, sx, sy, sw, sh_, sr);
			else { ctx.beginPath(); ctx.rect(sx, sy, sw, sh_); }
			ctx.fill();
		} finally { ctx.restore(); }
	}
}

/** Paint inset `box-shadow` highlights on top of the background. The
 * Canvas trick: clip to the box interior, then fill a doughnut
 * (outer rect minus the box) with the shadow enabled — the shadow
 * "leaks" inward through the clip and the doughnut itself is clipped
 * away. */
function paintInsetBoxShadows(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	radius: number,
): void {
	const shadows = cs.boxShadow;
	if (!shadows || shadows.length === 0) return;
	for (const sh of shadows) {
		if (!sh.inset) continue;
		ctx.save();
		try {
			// Clip to interior so the doughnut fill is invisible but the
			// shadow it casts inward isn't.
			if (radius > 0) {
				pathLiveRoundedRect(ctx, box.x, box.y, box.w, box.h, radius);
			} else {
				ctx.beginPath();
				ctx.rect(box.x, box.y, box.w, box.h);
			}
			ctx.clip();
			ctx.shadowOffsetX = sh.offsetX;
			ctx.shadowOffsetY = sh.offsetY;
			ctx.shadowBlur = sh.blur;
			ctx.shadowColor = sh.color;
			ctx.fillStyle = '#000';
			// Doughnut: outer rect surrounds the box + blur extent;
			// inner subpath traces the box reversed so even-odd fill
			// renders the ring only.
			const pad = Math.max(sh.blur * 2 + Math.abs(sh.offsetX) + Math.abs(sh.offsetY) + 8, 16);
			ctx.beginPath();
			ctx.rect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
			pathLiveRoundedRectReverse(ctx, box.x, box.y, box.w, box.h, radius);
			ctx.fill('evenodd');
		} finally { ctx.restore(); }
	}
}

/** Reverse-wound rounded-rect subpath. Used inside `paintInsetBoxShadows`'s
 * even-odd fill so the box-shaped hole punches out of the outer rect. */
function pathLiveRoundedRectReverse(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	x: number, y: number, w: number, h: number, r: number,
): void {
	const cr = Math.min(r, w / 2, h / 2);
	if (cr <= 0) {
		ctx.moveTo(x, y);
		ctx.lineTo(x, y + h);
		ctx.lineTo(x + w, y + h);
		ctx.lineTo(x + w, y);
		ctx.closePath();
		return;
	}
	ctx.moveTo(x + cr, y);
	ctx.quadraticCurveTo(x, y, x, y + cr);
	ctx.lineTo(x, y + h - cr);
	ctx.quadraticCurveTo(x, y + h, x + cr, y + h);
	ctx.lineTo(x + w - cr, y + h);
	ctx.quadraticCurveTo(x + w, y + h, x + w, y + h - cr);
	ctx.lineTo(x + w, y + cr);
	ctx.quadraticCurveTo(x + w, y, x + w - cr, y);
	ctx.closePath();
}

/** Paint the box's background: gradient layers if parsed, else solid
 * `cs.background` fillStyle. All layers fill the rounded rect path so
 * `border-radius` clips gradients automatically. */
function paintBackground(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	radius: number,
): void {
	const layers = cs.backgroundLayers;
	if (layers && layers.length > 0) {
		ctx.save();
		try {
			if (radius > 0) {
				pathLiveRoundedRect(ctx, box.x, box.y, box.w, box.h, radius);
				ctx.clip();
			} else {
				ctx.beginPath();
				ctx.rect(box.x, box.y, box.w, box.h);
				ctx.clip();
			}
			for (const layer of layers) {
				paintBackgroundLayer(ctx, layer, box.x, box.y, box.w, box.h);
			}
		} finally { ctx.restore(); }
		return;
	}
	const bg = cs.background;
	if (bg) {
		ctx.fillStyle = bg;
		if (radius > 0) {
			pathLiveRoundedRect(ctx, box.x, box.y, box.w, box.h, radius);
			ctx.fill();
		} else {
			ctx.fillRect(box.x, box.y, box.w, box.h);
		}
	}
}

function paintBackgroundLayer(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	layer: BackgroundLayer,
	x: number, y: number, w: number, h: number,
): void {
	if (layer.type === 'solid') {
		ctx.fillStyle = layer.color;
		ctx.fillRect(x, y, w, h);
		return;
	}
	if (layer.type === 'linear') {
		// CSS angle: 0deg = "to top", clockwise. Direction vector that
		// points from start → end is (sin θ, -cos θ). The gradient line
		// extent is |W·sin θ| + |H·cos θ| (the diagonal projection),
		// centred on the box midpoint.
		const cx = x + w / 2;
		const cy = y + h / 2;
		const s = Math.sin(layer.angleRad);
		const c = Math.cos(layer.angleRad);
		const len = Math.abs(w * s) + Math.abs(h * c);
		const dx = (s * len) / 2;
		const dy = (-c * len) / 2;
		const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
		applyStops(grad, layer.stops);
		ctx.fillStyle = grad;
		ctx.fillRect(x, y, w, h);
		return;
	}
	// radial
	const cx = x + layer.cxFrac * w;
	const cy = y + layer.cyFrac * h;
	// Default sizing: farthest-corner. Find the corner farthest from
	// the center and use its distance as the radius (or per-axis radii
	// for ellipse). Canvas only supports circular radial gradients via
	// createRadialGradient, so we approximate an ellipse by scaling the
	// fill (cheap + good enough for our use cases).
	const corners = [
		[x, y], [x + w, y], [x, y + h], [x + w, y + h],
	] as const;
	let rMax = 0;
	let rxMax = 0;
	let ryMax = 0;
	for (const [px, py] of corners) {
		rMax = Math.max(rMax, Math.hypot(px - cx, py - cy));
		rxMax = Math.max(rxMax, Math.abs(px - cx));
		ryMax = Math.max(ryMax, Math.abs(py - cy));
	}
	if (layer.shape === 'circle' || rxMax === 0 || ryMax === 0) {
		const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMax);
		applyStops(grad, layer.stops);
		ctx.fillStyle = grad;
		ctx.fillRect(x, y, w, h);
		return;
	}
	// Ellipse: paint into a transform that squashes the X axis so the
	// circular gradient looks elliptical. We clip to the original box
	// in transformed space to avoid leakage.
	ctx.save();
	try {
		ctx.translate(cx, cy);
		ctx.scale(rxMax / ryMax, 1);
		ctx.translate(-cx, -cy);
		const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, ryMax);
		applyStops(grad, layer.stops);
		ctx.fillStyle = grad;
		ctx.fillRect(x - rxMax, y - ryMax, w + rxMax * 2, h + ryMax * 2);
	} finally { ctx.restore(); }
}

function applyStops(grad: CanvasGradient, stops: { color: string; pos?: number }[]): void {
	for (const stop of stops) {
		const p = stop.pos ?? 0;
		const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
		try {
			grad.addColorStop(clamped, normalizeGradientColor(stop.color));
		} catch (_) { /* swallow unparseable colour — skip stop */ }
	}
}

function normalizeGradientColor(color: string): string {
	const t = color.trim().toLowerCase();
	if (t === 'transparent') return 'rgba(0,0,0,0)';
	return color;
}

function pathLiveRoundedRect(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	x: number, y: number, w: number, h: number, r: number,
): void {
	const cr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + cr, y);
	ctx.lineTo(x + w - cr, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + cr);
	ctx.lineTo(x + w, y + h - cr);
	ctx.quadraticCurveTo(x + w, y + h, x + w - cr, y + h);
	ctx.lineTo(x + cr, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - cr);
	ctx.lineTo(x, y + cr);
	ctx.quadraticCurveTo(x, y, x + cr, y);
	ctx.closePath();
}

/**
 * M2.1 text painter + M2.2 pseudo-element painter. Draws the
 * element's own `textContent` (centred per `text-align`), plus
 * `:before` content flush-left and `:after` content flush-right —
 * all sharing the resolved font/colour/style from the cascade.
 *
 * Bold + italic foot-guns (see [[nxjs-font-no-bold-italic]]):
 *   - Bold via 1-px-offset double-draw.
 *   - Italic via 0.2 rad column shear.
 *
 * Form element rendering (INPUT/SELECT/OPTION/TEXTAREA) is M2.4 —
 * the generic text painter skips them so the form-widget painter
 * can own its own drawing later.
 */
function paintLiveText(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	originX: number,
	originY: number,
	w: number,
	h: number,
	hostBox?: LayoutBox,
): void {
	const ownText = el.textContent;
	const beforeText = cs.before;
	const afterText = cs.after;
	if (!ownText && !beforeText && !afterText) return;

	// Form input rendering is M2.4 — skip for now so a future <input>
	// shim isn't double-painted by the generic text path.
	const tag = el.tagName;
	if (tag === 'INPUT' || tag === 'SELECT' || tag === 'OPTION' || tag === 'TEXTAREA') {
		return;
	}

	// Compose an InlineStyle-shaped view for resolveCanvasFont +
	// isBoldWeight + isItalicStyle helpers. They were written for
	// InlineStyle but the relevant fields overlap exactly.
	const styleShim = {
		fontFamily: cs.fontFamily,
		fontSize: cs.fontSize,
		fontWeight: cs.fontWeight,
		fontStyle: cs.fontStyle,
	};
	const font = resolveCanvasFont(styleShim);
	const color = cs.color || '#e0e8f4';
	const align = cs.textAlign || 'start';
	const bold = isBoldWeight(styleShim);
	const italic = isItalicStyle(styleShim);

	// Vertical baseline: when h is known, centre vertically. Otherwise
	// paint from the top of the box.
	const baseline: CanvasTextBaseline = h > 0 ? 'middle' : 'top';
	const textY = h > 0 ? originY + h / 2 : originY;

	ctx.save();
	try {
		// Clip to host's border box when available so abs-positioned
		// pseudo-elements (which anchor against the border edge, not the
		// content edge) aren't clipped by the padding inset. Otherwise
		// fall back to the content-box clip — long ownText still gets
		// contained instead of spilling across the screen.
		const clipX = hostBox?.x ?? originX;
		const clipY = hostBox?.y ?? originY;
		const clipW = hostBox?.w ?? w;
		const clipH = hostBox?.h ?? h;
		if (clipW > 0 && clipH > 0) {
			ctx.beginPath();
			ctx.rect(clipX, clipY, clipW, clipH);
			ctx.clip();
		}
		ctx.font = font;
		ctx.textBaseline = baseline;
		ctx.fillStyle = color;
		if (italic) {
			ctx.transform(1, 0, -0.2, 1, textY * 0.2, 0);
		}

		// Vertical-align: super / sub raise/lower the text baseline
		// by ~30% of font-size. The text painter is single-line so we
		// only shift the row's y rather than mixing baselines within a
		// line (real inline-flow would do per-glyph baseline).
		const fontSize = cs.fontSize ?? 14;
		let shiftY = 0;
		if (cs.verticalAlign === 'super') shiftY = -fontSize * 0.35;
		else if (cs.verticalAlign === 'sub') shiftY = fontSize * 0.3;
		const drawY = textY + shiftY;

		// <details>/<summary> chevron — drawn as a left-edge triangle
		// pointing right (closed) or down (open). Inline-flow style
		// pushes the summary text by ~14px so the chevron has room.
		let chevronAdvance = 0;
		const isSummary = el.tagName === 'SUMMARY';
		if (isSummary) {
			const parent = el.parent;
			const open = !!(parent && parent.tagName === 'DETAILS' && parent.hasAttribute('open'));
			ctx.save();
			try {
				ctx.fillStyle = color;
				const cx = originX + 4;
				const cy = drawY;
				const s = fontSize * 0.55;
				ctx.beginPath();
				if (open) {
					ctx.moveTo(cx, cy - s * 0.4);
					ctx.lineTo(cx + s, cy - s * 0.4);
					ctx.lineTo(cx + s / 2, cy + s * 0.5);
				} else {
					ctx.moveTo(cx, cy - s * 0.55);
					ctx.lineTo(cx + s * 0.85, cy);
					ctx.lineTo(cx, cy + s * 0.55);
				}
				ctx.closePath();
				ctx.fill();
			} finally { ctx.restore(); }
			chevronAdvance = fontSize + 2;
		}

		// :before — paint at the LEFT edge of the box. lil-gui injects
		// icon-font glyphs here (folder open/closed triangles) that
		// aren't in the Switch font; paint those as canvas paths so
		// the example's verbatim `content: "▾"` declarations render
		// correctly without touching the lil-gui CSS.
		// Tracks how far :before pushed the inline cursor so ownText
		// starts AFTER it instead of overlapping (display:inline-block
		// behaviour for the pseudo-element).
		let beforeAdvance = chevronAdvance;
		if (beforeText) {
			ctx.textAlign = 'left';
			const iconW = paintIconGlyph(ctx, beforeText, originX + 2 + chevronAdvance, drawY, fontSize);
			if (iconW > 0) {
				beforeAdvance = chevronAdvance + 2 + iconW + 4;
			} else {
				ctx.fillText(beforeText, originX + 2 + chevronAdvance, drawY);
				if (bold) ctx.fillText(beforeText, originX + 3 + chevronAdvance, drawY);
				beforeAdvance = chevronAdvance + 2 + ctx.measureText(beforeText).width + 4;
			}
			paintTextDecorationLine(
				ctx, cs, beforeText, originX + 2 + chevronAdvance, drawY, fontSize, color,
			);
		}
		// own text — paint at the per-`text-align` position, shifted by
		// any `:before` advance so the pseudo-element and own text sit
		// side-by-side rather than stacked at the same x.
		if (ownText) {
			let textX = originX + beforeAdvance;
			if (w > 0) {
				if (align === 'center') textX = originX + (w + beforeAdvance) / 2;
				else if (align === 'right' || align === 'end') textX = originX + w;
			}
			ctx.textAlign = align as CanvasTextAlign;
			ctx.fillText(ownText, textX, drawY);
			if (bold) ctx.fillText(ownText, textX + 1, drawY);
			paintTextDecorationLine(
				ctx, cs, ownText, textX, drawY, fontSize, color, align as CanvasTextAlign,
			);
		}
		// :after — abs-positioned when the pseudo's own cascade set
		// position:absolute (+ right/bottom/etc), else flush-right at the
		// box edge. Pseudo overrides for font-size + color let the visual
		// (e.g. an oversize arrow glyph) differ from host text.
		if (afterText) {
			// Absolute positioning is spec'd against the host's padding
			// box; use the LayoutBox border rect when available so an
			// `::after { right: 18px }` lands 18px inside the card edge
			// (not 18px inside the content box, which would double-apply
			// padding).
			paintPseudoText(
				ctx, afterText, cs.afterStyle,
				originX, originY, w, h, drawY, fontSize, color, bold, 'right',
				hostBox,
			);
		}
	} finally {
		ctx.restore();
	}
}

/** Paint a `::before` / `::after` text. When the pseudo cascade set
 * `position: absolute` (+ right/bottom/top/left), place at those offsets
 * relative to the host box's border edge. Otherwise fall back to the
 * legacy edge-aligned text. `defaultAlign` picks the fallback alignment
 * ('left' for ::before, 'right' for ::after). */
function paintPseudoText(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	text: string,
	pseudo: PseudoStyle | undefined,
	originX: number, originY: number,
	w: number, h: number,
	drawY: number,
	hostFontSize: number,
	hostColor: string,
	hostBold: boolean,
	defaultAlign: 'left' | 'right',
	hostBox?: LayoutBox,
): void {
	const isAbs = pseudo?.position === 'absolute';
	const pseudoFontSize = pseudo?.fontSize ?? hostFontSize;
	const pseudoColor = pseudo?.color ?? hostColor;
	const sizeChanged = pseudoFontSize !== hostFontSize
		|| pseudo?.fontFamily !== undefined
		|| pseudo?.fontWeight !== undefined
		|| pseudo?.fontStyle !== undefined;
	let restoreFont: string | undefined;
	if (sizeChanged) {
		restoreFont = ctx.font;
		ctx.font = resolveCanvasFont({
			fontFamily: pseudo?.fontFamily,
			fontSize: pseudoFontSize,
			fontWeight: pseudo?.fontWeight,
			fontStyle: pseudo?.fontStyle,
		});
	}
	const prevFillStyle = ctx.fillStyle;
	ctx.fillStyle = pseudoColor;
	const prevBaseline = ctx.textBaseline;
	if (isAbs) {
		// Anchor against the host's border-box if available (so right:18px
		// lands 18px inside the card edge, not 18px inside the inner
		// content area). Fall back to content-box coords when no hostBox.
		const bx = hostBox?.x ?? originX;
		const by = hostBox?.y ?? originY;
		const bw = hostBox?.w ?? w;
		const bh = hostBox?.h ?? h;
		let ax: number;
		let align: CanvasTextAlign;
		if (pseudo?.right !== undefined) {
			ax = bx + bw - pseudo.right;
			align = 'right';
		} else if (pseudo?.left !== undefined) {
			ax = bx + pseudo.left;
			align = 'left';
		} else {
			ax = bx + (defaultAlign === 'right' ? bw - 2 : 2);
			align = defaultAlign;
		}
		let ay: number;
		let baseline: CanvasTextBaseline;
		if (pseudo?.bottom !== undefined) {
			ay = by + bh - pseudo.bottom;
			baseline = 'alphabetic';
		} else if (pseudo?.top !== undefined) {
			ay = by + pseudo.top;
			baseline = 'top';
		} else {
			ay = drawY;
			baseline = 'middle';
		}
		ctx.textAlign = align;
		ctx.textBaseline = baseline;
		ctx.fillText(text, ax, ay);
		if (hostBold) ctx.fillText(text, ax + 1, ay);
		ctx.textBaseline = prevBaseline;
	} else if (defaultAlign === 'right') {
		ctx.textAlign = 'right';
		const ax = w > 0 ? originX + w - 2 : originX;
		ctx.fillText(text, ax, drawY);
		if (hostBold) ctx.fillText(text, ax + 1, drawY);
	} else {
		ctx.textAlign = 'left';
		ctx.fillText(text, originX + 2, drawY);
		if (hostBold) ctx.fillText(text, originX + 3, drawY);
	}
	ctx.fillStyle = prevFillStyle;
	if (restoreFont !== undefined) ctx.font = restoreFont;
}

/** Draw text-decoration (underline / line-through / overline) under or
 * through a previously-painted text span. Width is measured against the
 * current ctx.font, x is the alignment-relative anchor (matching the
 * textAlign that was used to paint the text). Color defaults to the text
 * color but the cascade can override via text-decoration-color (not yet
 * parsed; falls back to text color). Painted as a 1-px filled rect — a
 * 1-px stroke would alias differently per align. */
function paintTextDecorationLine(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	cs: ComputedLiveStyle,
	text: string,
	x: number,
	textY: number,
	fontSize: number,
	color: string,
	align: CanvasTextAlign = 'left',
): void {
	const td = cs.textDecoration;
	if (!td || td === 'none') return;
	const m = ctx.measureText(text);
	const w = m.width;
	if (w <= 0) return;
	let lineX = x;
	if (align === 'center') lineX = x - w / 2;
	else if (align === 'right' || align === 'end') lineX = x - w;
	let lineY: number;
	if (td === 'underline') lineY = textY + fontSize * 0.45;
	else if (td === 'overline') lineY = textY - fontSize * 0.5;
	else lineY = textY; // line-through at middle
	ctx.save();
	try {
		ctx.fillStyle = color;
		ctx.fillRect(lineX, Math.round(lineY), w, 1);
	} finally { ctx.restore(); }
}

/** True iff there's at least one paintable element in the tree (fixed
 * OR a normal-flow direct child of body). Lets the shell skip the
 * entire overlay path on idle frames.
 *
 * Phase 1 widened the check: a script that creates `<div>` children
 * under document.body without setting position:fixed now produces
 * paintable normal-flow content, so the overlay path must run. */
export function hasLiveOverlay(root: LiveElement): boolean {
	if (root.children.length === 0) return false;
	function walk(el: LiveElement): boolean {
		if (el.style.display === 'none') return false;
		if (el.style.position === 'fixed') return true;
		for (const c of el.children) if (walk(c)) return true;
		return false;
	}
	if (walk(root)) return true;
	// At this point no fixed elements anywhere — but if body has any
	// direct non-fixed children with content, they count too.
	for (const c of root.children) {
		if (c.style.display === 'none') continue;
		if (c.style.position === 'fixed') continue;
		return true;
	}
	return false;
}
