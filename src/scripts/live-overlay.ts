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

import { isBoldWeight, isItalicStyle, isPercent, quoteFontFamily, resolveCanvasFont, resolveLength } from './inline-css.js';
import { getComputedLiveStyle, getKeyframes, type BackgroundLayer, type BoxShadow, type ComputedLiveStyle, type PseudoStyle } from './live-css.js';
import { ensureCssAnimation, getBackgroundImage, getCssAnimState, getLiveTreeVersion, type LiveElement } from './live-dom.js';
import { buildFormSubmitUrl, findEnclosingForm, paintFormWidget } from './live-form.js';
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
import { clearLiveDirty, drainLiveDirty, isKeyboardOpen, requestFullRepaint } from './live-paint-control.js';

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
		setLayoutMeasureCtx(cacheCtx);
		const rect: DirtyRect = { x: box.x, y: box.y, w: box.w, h: box.h };
		cacheCtx.beginPath();
		cacheCtx.rect(rect.x, rect.y, rect.w, rect.h);
		cacheCtx.clip();
		cacheCtx.clearRect(rect.x, rect.y, rect.w, rect.h);
		// Repaint the FULL back-to-front stack inside the region — body bg
		// + every op (ancestor backgrounds, then this element) whose box
		// intersects it, in tree order — not just this element. Otherwise a
		// transparent element (e.g. a logo PNG) clears to a hole and its
		// see-through pixels show the flat page bg instead of the real
		// backdrop behind it (body bg + any colored ancestor like the
		// search bar's gradient). Mirrors patchLiveDirtyRegions' bg-stack
		// repaint + the full build's layering, so there's no seam.
		const root = lastPaintedRoot;
		if (root) {
			const bodyCs = getComputedLiveStyle(root);
			const bodyBox = getLayoutBox(root);
			if (bodyCs.background) {
				cacheCtx.fillStyle = bodyCs.background;
				cacheCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
			}
			if (bodyBox) paintBoxedElement(cacheCtx, root, bodyCs, bodyBox);
			const ops: PaintOp[] = [];
			collectPaintOps(root, ops, /* skipBgOfRoot */ true);
			for (const op of ops) {
				// Clip ops ALWAYS execute regardless of dirty-rect intersection
				// — skipping a clip-push would unbalance the save/restore stack
				// and leak clipping into unrelated subtrees painted later in
				// the op list.
				if (op.kind === 'clip-push' && op.box) {
					try {
						cacheCtx.save();
						cacheCtx.beginPath();
						cacheCtx.rect(op.box.contentX, op.box.contentY, op.box.contentW, op.box.contentH);
						cacheCtx.clip();
					} catch (_) { /* ignore */ }
					continue;
				}
				if (op.kind === 'clip-pop') {
					try { cacheCtx.restore(); } catch (_) { /* ignore */ }
					continue;
				}
				const b: DirtyRect | undefined = op.kind === 'atom' ? op.atom : op.box;
				if (!b || !rectsIntersect(b, rect)) continue;
				try {
					if (op.kind === 'bg' && op.cs && op.box) {
						paintBoxedElement(cacheCtx, op.el, op.cs, op.box);
					} else if (op.kind === 'atom' && op.atom) {
						paintOneInlineAtom(cacheCtx, op.atom);
					}
				} catch (_) { /* skip a bad op, as the build loop does */ }
			}
		} else {
			// No painted-root handle yet — element-only fallback.
			paintSubtreeLaid(cacheCtx, el);
		}
	} finally { cacheCtx.restore(); }
}

/** Batched variant of {@link patchLiveCacheRegion}: patch ALL of `els`
 * in one pass. Collects paint ops once (`collectPaintOps` walks the
 * live tree, which is O(tree); doing it per-element scales O(N·tree)
 * and dominates the flush time on complex parents like Featured app
 * cards), then iterates the op list a single time, checking each op
 * against the union of all rects.
 *
 * Phase 4 (2026-06-02): the per-element `patchLiveCacheRegion` loop
 * in `flushPendingImageCompletions` measured 197 ms/patch on the home
 * page (vs. 3.6 ms/patch on a simple test page) because each call
 * re-walked the tree + re-painted the body gradient + re-painted
 * every intersecting ancestor's backdrop. Batching collapses that to
 * one tree walk per flush; per-flush cost drops from ~580 ms (6 cards
 * × 97 ms) to a single ~100 ms ops pass. Same JS-side correctness,
 * much smaller user-visible freeze. */
export function patchLiveCacheRegions(els: LiveElement[]): void {
	if (els.length === 0 || !liveCacheOffscreen) return;
	const cacheCtx = liveCacheOffscreen.getContext('2d');
	if (!cacheCtx) return;
	// Build rects from cached layout boxes. Elements with no box
	// (detached, display:none, etc.) drop out silently.
	const rects: DirtyRect[] = [];
	for (const el of els) {
		const box = getLayoutBox(el);
		if (!box || box.w <= 0 || box.h <= 0) continue;
		rects.push({ x: box.x, y: box.y, w: box.w, h: box.h });
	}
	if (rects.length === 0) return;
	const root = lastPaintedRoot;
	if (!root) {
		// No painted-root handle yet — fall back to per-element so the
		// element-only paintSubtreeLaid path still runs.
		for (const el of els) patchLiveCacheRegion(el);
		return;
	}
	cacheCtx.save();
	try {
		setLayoutMeasureCtx(cacheCtx);
		// Clip to the UNION of all rects so writes outside the patched
		// regions can't leak.
		cacheCtx.beginPath();
		for (const r of rects) cacheCtx.rect(r.x, r.y, r.w, r.h);
		cacheCtx.clip();
		for (const r of rects) cacheCtx.clearRect(r.x, r.y, r.w, r.h);
		// Body bg stack — once per rect (cheap fillRects), then the body
		// box paint once. Identical-pixels guarantee with the build loop.
		const bodyCs = getComputedLiveStyle(root);
		if (bodyCs.background) {
			cacheCtx.fillStyle = bodyCs.background;
			for (const r of rects) cacheCtx.fillRect(r.x, r.y, r.w, r.h);
		}
		const bodyBox = getLayoutBox(root);
		if (bodyBox) paintBoxedElement(cacheCtx, root, bodyCs, bodyBox);
		// Single pass over every paint op — for each op, see if it
		// intersects ANY of the patch rects; if so, paint it once. Each
		// op is painted at most once even if it intersects multiple
		// rects (the clip restricts where its pixels can land).
		const ops: PaintOp[] = [];
		collectPaintOps(root, ops, /* skipBgOfRoot */ true);
		for (const op of ops) {
			if (op.kind === 'clip-push' && op.box) {
				try {
					cacheCtx.save();
					cacheCtx.beginPath();
					cacheCtx.rect(op.box.contentX, op.box.contentY, op.box.contentW, op.box.contentH);
					cacheCtx.clip();
				} catch (_) { /* ignore */ }
				continue;
			}
			if (op.kind === 'clip-pop') {
				try { cacheCtx.restore(); } catch (_) { /* ignore */ }
				continue;
			}
			const b: DirtyRect | undefined = op.kind === 'atom' ? op.atom : op.box;
			if (!b) continue;
			let hit = false;
			for (const r of rects) { if (rectsIntersect(b, r)) { hit = true; break; } }
			if (!hit) continue;
			try {
				if (op.kind === 'bg' && op.cs && op.box) {
					paintBoxedElement(cacheCtx, op.el, op.cs, op.box);
				} else if (op.kind === 'atom' && op.atom) {
					paintOneInlineAtom(cacheCtx, op.atom);
				}
			} catch (_) { /* skip a bad op, same as the build loop */ }
		}
	} finally { cacheCtx.restore(); }
}

/** Phase 4.2 lightweight image patch (2026-06-02): paint just each
 * element's own box on top of the existing cache. Skips the
 * `clearRect` + ancestor-backdrop repaint that {@link patchLiveCacheRegion}
 * / {@link patchLiveCacheRegions} do — those exist because clearing the
 * region requires re-painting the bg stack to avoid a transparent
 * element clearing to a hole.
 *
 * For image loads where the IMG's box doesn't change (explicit
 * dimensions), the cache pixels around the IMG (ancestor gradients,
 * shadows, borders) ARE ALREADY CORRECT from the initial build. We
 * only need to draw the IMG itself on top. Any transparency in the IMG
 * shows through to the underlying card bg pixels that the build wrote.
 *
 * Measured: per-element cost drops from ~193 ms (on Featured app
 * cards with gradient + box-shadow + border) to ~1-2 ms because
 * Cairo's gradient + gaussian-blur work is skipped. 6 home-page card
 * logos: ~1.2 s freeze → ~10 ms. */
export function patchLiveImagePixelsOnly(els: LiveElement[]): void {
	if (els.length === 0 || !liveCacheOffscreen) return;
	const cacheCtx = liveCacheOffscreen.getContext('2d');
	if (!cacheCtx) return;
	cacheCtx.save();
	try {
		setLayoutMeasureCtx(cacheCtx);
		for (const el of els) {
			const box = getLayoutBox(el);
			if (!box || box.w <= 0 || box.h <= 0) continue;
			const cs = getComputedLiveStyle(el);
			try { paintBoxedElement(cacheCtx, el, cs, box); }
			catch (_) { /* skip bad op, same as build loop */ }
		}
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

interface DirtyRect { x: number; y: number; w: number; h: number; }
function rectsIntersect(a: DirtyRect, b: DirtyRect): boolean {
	return a.x < b.x + b.w && a.x + a.w > b.x
		&& a.y < b.y + b.h && a.y + a.h > b.y;
}

// TEMPORARY diagnostic (2026-05-28): trace why a tap patches vs full-
// rebuilds. Writes to sdmc:/swb_partial.log. Remove once partial repaint
// is verified on-device. Capped so a stuck loop can't fill the SD card.
const PARTIAL_DEBUG = false;
let _partialDbgCount = 0;
function _partialDbg(msg: string): void {
	if (!PARTIAL_DEBUG || _partialDbgCount >= 400) return;
	_partialDbgCount++;
	try {
		const sw = (globalThis as { Switch?: { appendFileSync?: (p: string, d: string) => void } }).Switch;
		sw?.appendFileSync?.('sdmc:/swb_partial.log', msg + '\n');
	} catch (_) { /* ignore */ }
}
function _tagOf(el: LiveElement): string {
	const cls = el.getAttribute?.('class');
	const id = el.getAttribute?.('id');
	return `${(el.tagName || '?').toLowerCase()}${id ? '#' + id : ''}${cls ? '.' + cls.trim().split(/\s+/).join('.') : ''}`;
}

/** Phase 2.6 (2026-05-28): targeted partial cache repaint for tap-driven
 * mutations. Drains the per-element dirty set (populated by
 * `markLiveDirty` from every paint-affecting mutation), re-lays-out, and
 * for each change finds the nearest ancestor whose box stayed put across
 * the re-layout ("stable container") — the region that bounds any reflow
 * the change caused. It then repaints just those regions instead of the
 * whole page. Returns true when it patched (caller can rely on the next
 * blit showing the change); false when it punted to the normal full
 * rebuild (the version is left ahead of `lastBodyVersion`, so the next
 * `paintLiveOverlay` rebuilds).
 *
 * Correctness for the live cache's LAYERED, semi-transparent backgrounds
 * (e.g. the audio player's body gradient → card → row, translucent
 * buttons): we don't just clear+repaint each element — we re-paint, in
 * tree order and CLIPPED to the changed regions, the body background plus
 * every paint op whose box intersects a changed region. That rebuilds the
 * full back-to-front stack inside those regions exactly as the full build
 * would, so there are no transparent holes or seams. Faithful because it
 * reuses the same `paintBoxedElement` / `paintOneInlineAtom` /
 * `collectPaintOps` the build uses; the only difference is the clip + the
 * intersection filter.
 *
 * Safe-by-construction: any uncertainty (no cache, build in flight, a
 * dirty element with no box, or a reflow that reached the root with no
 * stable container) returns false → the unchanged full-rebuild path runs. */
export function patchLiveDirtyRegions(): boolean {
	const dirty = drainLiveDirty();
	if (dirty.length === 0) return false;
	// Bump the content version of any scrollable whose subtree was mutated,
	// BEFORE we patch the static cache below — the scroll overlay loop reads
	// these versions to decide which per-container offscreens to re-render.
	// Drains here cover both the paint-loop patch and the live-form tap path.
	noteScrollDirty(dirty);
	_partialDbg('--- tap: drained ' + dirty.length + ' dirty: [' + dirty.map(_tagOf).join(', ') + ']');
	// Mutations happened, so a repaint is needed no matter what — whether we
	// patch below or punt to the full rebuild. Schedule it once here so every
	// punt path (and the caller) gets a repaint without repeating the call.
	requestFullRepaint();
	if (!liveCacheOffscreen || cacheBuilding) {
		_partialDbg('  PUNT: ' + (!liveCacheOffscreen ? 'no-cache' : 'cache-building') + ' → full rebuild');
		return false;
	}
	const root = lastPaintedRoot;
	if (!root) { _partialDbg('  PUNT: no-root → full rebuild'); return false; }
	const vpW = lastBodyViewportW;
	const vpH = lastBodyViewportH;
	if (vpW <= 0 || vpH <= 0) { _partialDbg('  PUNT: bad-viewport ' + vpW + 'x' + vpH); return false; }
	const cacheCtx = liveCacheOffscreen.getContext('2d');
	if (!cacheCtx) { _partialDbg('  PUNT: no-ctx'); return false; }

	// LOCALIZED re-layout (perf-critical). For each dirty element, re-lay-out
	// only ITS OWN subtree, in place, pinned to its cached border-box — NOT
	// the whole page. A full `layoutFixedRoot(root)` here re-lays-out the
	// entire page; on the heavy audio-player page that costs SECONDS and was
	// the multi-second freeze on every tap. Re-laying out just the changed
	// elements is ~instant, and because the box is pinned to the cached dims
	// it can't reflow siblings. We deliberately do NOT resetLayoutCache, so
	// every OTHER element keeps its already-correct box for the
	// collectPaintOps walk below. Pure style changes (the RED/GREEN class
	// toggle) work too: the cascade was invalidated on mutation and
	// re-resolves at paint; the relayout just refreshes changed text atoms /
	// freshly-inserted children (e.g. the "Play"/"Stop" label).
	setLayoutMeasureCtx(cacheCtx);
	const rects: DirtyRect[] = [];
	const pushRect = (b: LayoutBox | undefined): boolean => {
		if (!b || b.w <= 0 || b.h <= 0) return false;
		rects.push({ x: b.x, y: b.y, w: b.w, h: b.h });
		return true;
	};
	for (const el of dirty) {
		const cs = getComputedLiveStyle(el);
		const pos = cs.position ?? el.style.position;
		const oldB = getLayoutBox(el);
		if (pos === 'absolute') {
			// An absolutely-positioned element's box can MOVE and RESIZE when
			// its content changes (e.g. the toast: empty → "Bars visualizer"
			// re-runs shrink-to-fit, which widens it and re-centers it). The
			// pinned `layoutFixedRoot(cached box)` path below would reuse the
			// stale (empty-content) width and clip the text. Re-run the
			// absolute layout against its containing block instead, and mark
			// BOTH the old and new boxes dirty so the region covers the move.
			const cb = findAbsoluteContainingBlock(el, root);
			const cbBox = cb ? getLayoutBox(cb) : undefined;
			if (cbBox) {
				try {
					// Padding box (== border box; borders are layout-ignored),
					// not the content box — see the full-rebuild pass above.
					layoutAbsoluteRoot(el, cbBox.x, cbBox.y, cbBox.w, cbBox.h);
				} catch (_) { /* keep cached layout on throw */ }
			}
			const newB = getLayoutBox(el);
			const a = pushRect(oldB);
			const bAdded = newB !== oldB ? pushRect(newB) : false;
			if (!a && !bAdded) { _partialDbg('  skip no-box abs ' + _tagOf(el)); }
			else _partialDbg('  ' + _tagOf(el) + ' abs-relaid');
			continue;
		}
		if (!oldB || oldB.w <= 0 || oldB.h <= 0) {
			// Non-visual (e.g. <audio> whose src changed) or collapsed — paints
			// nothing, so nothing to patch.
			_partialDbg('  skip no-box ' + _tagOf(el));
			continue;
		}
		const rect = { x: oldB.x, y: oldB.y, w: oldB.w, h: oldB.h };
		// Default: pin availableW/H to oldB so an auto-width element
		// (no explicit width, e.g. a flex child like a `.row .v` span)
		// keeps its cached size — layoutFixedRoot's no-explicit-width
		// fallback uses availableWidth as the element's own width, so
		// passing the parent's contentW would inflate it to the full row.
		// HOWEVER, when cs.width is a CssPercent, oldB.w as the
		// containing-block basis multiplies the element by N% each call
		// (98% → 96.04% → 94.12% …), which is the battery-fill decay.
		// Switch only THAT axis to the parent's content size so the
		// percent re-resolves against the actual containing block.
		const parentBox = el.parent ? getLayoutBox(el.parent) : undefined;
		const availW = (isPercent(cs.width) && parentBox)
			? parentBox.contentW
			: oldB.w;
		const availH = (isPercent(cs.height) && parentBox)
			? parentBox.contentH
			: oldB.h;
		try {
			layoutFixedRoot(el, oldB.x, oldB.y, availW, availH);
		} catch (_) { /* keep the cached layout if a localized relayout throws */ }
		rects.push(rect);
		// If the re-layout grew (or moved) the box — for example an
		// auto-dimensioned `<img>` whose `naturalWidth/Height` just became
		// known — push the new box too so the painted region covers both
		// the area being vacated and the area newly occupied. Without
		// this the larger new region's extra pixels stay stale and the
		// element appears clipped to its old size. Mirrors the abs-
		// positioned branch above. `newB !== oldB` is a cheap ref-equal
		// check on the cached layout entry; getLayoutBox returns the
		// same reference until a relayout replaces it.
		const newB = getLayoutBox(el);
		if (newB && newB !== oldB) pushRect(newB);
		_partialDbg('  ' + _tagOf(el) + ' relaid ['
			+ Math.round(rect.x) + ',' + Math.round(rect.y) + ' '
			+ Math.round(rect.w) + 'x' + Math.round(rect.h) + ']');
	}
	if (rects.length === 0) {
		// Only non-visual mutations — layout/paint unchanged; sync so we don't
		// trigger a pointless full rebuild.
		_partialDbg('  PATCH ok: 0 visible regions');
		syncLiveCacheVersion();
		requestFullRepaint();
		return true;
	}

	const ops: PaintOp[] = [];
	collectPaintOps(root, ops, /* skipBgOfRoot */ true);
	let _painted = 0;
	const bodyCs = getComputedLiveStyle(root);
	const bodyBox = getLayoutBox(root);

	cacheCtx.save();
	try {
		// Clip to the union of changed regions; everything below paints only
		// inside them, leaving the rest of the cache (still valid, since no
		// box moved) untouched.
		cacheCtx.beginPath();
		for (const r of rects) cacheCtx.rect(r.x, r.y, r.w, r.h);
		cacheCtx.clip();
		// Rebuild the background stack inside the regions, mirroring the
		// build: clear, fill body bg color, paint the body box (gradients /
		// box-shadow / borders via paintBoxedElement at absolute coords →
		// identical pixels to the build, no seam), then every intersecting
		// op in tree order.
		for (const r of rects) cacheCtx.clearRect(r.x, r.y, r.w, r.h);
		if (bodyCs.background) {
			cacheCtx.fillStyle = bodyCs.background;
			for (const r of rects) cacheCtx.fillRect(r.x, r.y, r.w, r.h);
		}
		if (bodyBox) paintBoxedElement(cacheCtx, root, bodyCs, bodyBox);
		for (const op of ops) {
			// Clip ops ALWAYS execute regardless of dirty-rect intersection
			// so save/restore stays balanced — same reason as the build loop.
			if (op.kind === 'clip-push' && op.box) {
				try {
					cacheCtx.save();
					cacheCtx.beginPath();
					cacheCtx.rect(op.box.contentX, op.box.contentY, op.box.contentW, op.box.contentH);
					cacheCtx.clip();
				} catch (_) { /* ignore */ }
				continue;
			}
			if (op.kind === 'clip-pop') {
				try { cacheCtx.restore(); } catch (_) { /* ignore */ }
				continue;
			}
			const b: DirtyRect | undefined = op.kind === 'atom' ? op.atom : op.box;
			if (!b) continue;
			let hit = false;
			for (const r of rects) { if (rectsIntersect(b, r)) { hit = true; break; } }
			if (!hit) continue;
			try {
				if (op.kind === 'bg' && op.cs && op.box) {
					paintBoxedElement(cacheCtx, op.el, op.cs, op.box);
					_painted++;
				} else if (op.kind === 'atom' && op.atom) {
					paintOneInlineAtom(cacheCtx, op.atom);
					_painted++;
				}
			} catch (_) { /* skip a bad op, same as the build loop */ }
		}
	} finally {
		cacheCtx.restore();
	}

	_partialDbg('  PATCH ok: ' + rects.length + ' region(s), ' + _painted + '/' + ops.length + ' ops painted');
	syncLiveCacheVersion();
	requestFullRepaint();
	return true;
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
//
// Overridable from `config.json`'s `renderChunkMs` (the shell calls
// `setLiveBuildChunkMs` at startup): higher = pages snap in with fewer
// visible build steps but choppier scroll/animation during that initial
// paint; lower = smoother but more drawn-out fill-in. 12 is the default.
let buildChunkMs = 12;
/** Set the idle/continuation build budget (ms per chunk). Wired to
 * `config.json`'s `renderChunkMs`. Guarded so a non-positive / non-finite
 * value can't stall or busy-loop the build (it would just keep the
 * default). The caller (loadConfig) already clamps the upper bound. */
export function setLiveBuildChunkMs(ms: number): void {
	if (Number.isFinite(ms) && ms > 0) buildChunkMs = ms;
}
/** Smaller chunk budget for scroll-driven paintLiveOverlay calls. The
 * build still advances during scroll so content fills in below the
 * user's finger, but each scroll tick pays less paint cost — keeps
 * scroll near 60 FPS. Overridable from `config.json`'s `scrollChunkMs`
 * (the shell calls `setLiveScrollChunkMs` at startup). 4 is the default. */
let scrollChunkMs = 4;
/** Set the scroll-driven build budget (ms per chunk). Wired to
 * `config.json`'s `scrollChunkMs`. Same guard/clamp story as
 * `setLiveBuildChunkMs`. */
export function setLiveScrollChunkMs(ms: number): void {
	if (Number.isFinite(ms) && ms > 0) scrollChunkMs = ms;
}
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
 * IMG atom) inside an inline-formatting context. Clip-push/pop ops
 * bracket children of an `overflow: hidden` container (e.g. `<iframe>`),
 * pairing a `ctx.save() + ctx.rect(box) + ctx.clip()` with a later
 * `ctx.restore()`. Partial-repaint paths must ALWAYS execute clip ops
 * (skipping a clip-push would unbalance the save/restore stack and
 * leak clipping into unrelated subtrees). */
interface PaintOp {
	kind: 'bg' | 'atom' | 'clip-push' | 'clip-pop';
	el: LiveElement;
	cs?: ComputedLiveStyle;
	box?: LayoutBox;
	atom?: InlineAtom;
}
let buildOps: PaintOp[] = [];
let buildOpIndex = 0;
/** Scrollable containers (`overflow:auto/scroll`) found during the last
 * cache build. Excluded from the static cache; their children are drawn
 * into a per-container offscreen (below) and the visible slice blitted on
 * top of the cache each frame. Repopulated on every full build. */
let scrollOverlayEls: LiveElement[] = [];

/** Per-scrollable-container content cache: the element's CHILDREN rendered
 * once into an offscreen of (contentW × intrinsicContentH), re-rendered
 * only when the container's OWN content version or size changes — NOT per
 * frame, and NOT on every global tree-version bump. Scrolling just re-blits
 * a different source slice, so a swipe is a cheap drawImage and steady-state
 * animation pays nothing for the list. WeakMap so a removed container's
 * cache is collected. */
interface ScrollContentCache { canvas: OffscreenCanvas; contentVersion: number; w: number; h: number; }
const scrollContentCaches = new WeakMap<LiveElement, ScrollContentCache>();

/** Per-scrollable "content version", bumped ONLY when a descendant (or the
 * container itself) is mutated — see `noteScrollDirty`. This decouples a
 * scrollable's re-render from the GLOBAL `getLiveTreeVersion()`: the media
 * player's seek bar / time text update ~1×/sec (in the controls card, NOT
 * the library), bumping the global version every second. Keying the scroll
 * cache on that global version forced the heavy `.library-list` subtree to
 * re-render every second even though the library never changed, costing
 * playback FPS. A never-mutated scrollable stays at version 0; a fresh
 * cache starts at -1 so it always renders once. */
const scrollContentVersions = new WeakMap<LiveElement, number>();

function currentScrollContentVersion(el: LiveElement): number {
	return scrollContentVersions.get(el) ?? 0;
}

/** Given the elements drained from the dirty set this paint/tap, bump the
 * content version of every scrollable container (from the last build's
 * `scrollOverlayEls`) whose subtree actually contains one of them. Called
 * from the two places mutations are consumed for a repaint —
 * `patchLiveDirtyRegions` (paint-loop patch + live-form tap) and the
 * full-rebuild drain — so a library mutation (buildLibrary's append/clear,
 * the active-row class toggle, a row's textContent update) re-renders the
 * list, while a seek/time bump outside the list does not. `contains` is
 * true when `dirtyEl === sEl` too, so a mutation that marks the container
 * itself (innerHTML clear / appendChild mark the parent) is caught. */
function noteScrollDirty(dirtyEls: LiveElement[]): void {
	if (dirtyEls.length === 0 || scrollOverlayEls.length === 0) return;
	for (const sEl of scrollOverlayEls) {
		for (const d of dirtyEls) {
			if (sEl.contains(d)) {
				scrollContentVersions.set(sEl, currentScrollContentVersion(sEl) + 1);
				break;
			}
		}
	}
}
/** The body root of the most recent flow paint. `patchLiveDirtyRegions`
 * (driven by tap handlers, which run outside the paint loop) needs a
 * handle to it to re-run layout. */
let lastPaintedRoot: LiveElement | null = null;

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
 * page after a mutation (e.g. Settings template select → reload)
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
	lastPaintedRoot = null;
	clearLiveDirty();
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
	/** Bypass the `isKeyboardOpen()` early-return so the page can be
	 * painted UNDERNEATH the on-canvas keyboard. The shell uses this in
	 * its scroll-behind-keyboard path; it sets up a clip rect that ends
	 * at the keyboard panel's top edge so the keyboard pixels aren't
	 * touched. Off in every other path so rAF/video heartbeats can't
	 * stomp the keyboard while it's modal. */
	paintBehindKeyboard?: boolean;
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
	// widgets / status canvases on top of the keyboard panel. The
	// shell's scroll-behind-keyboard path opts in via
	// `paintBehindKeyboard` and supplies its own clip rect so we paint
	// the page area above the panel without disturbing the panel pixels.
	if (isKeyboardOpen() && !options.paintBehindKeyboard) return;
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
		// Remember the body root + measure ctx so an out-of-paint tap handler
		// can drive a targeted partial repaint (patchLiveDirtyRegions).
		lastPaintedRoot = root;
		const version = getLiveTreeVersion();
		const viewportChanged = viewport.width !== lastBodyViewportW
			|| viewport.height !== lastBodyViewportH;
		// Phase 2.5.2: if a build is in progress AND the tree / viewport
		// has changed under us, abort and restart fresh. Otherwise let
		// the chunked builder finish current run.
		if (cacheBuilding && (version !== buildVersion || viewportChanged)) {
			cacheBuilding = false;
		}
		let dirty = !cacheBuilding
			&& (version !== lastBodyVersion || viewportChanged);
		// Stage 5 (2026-05-28): drive the targeted partial patch from the
		// PAINT path, not just from tap handlers. A mutation that lands AFTER
		// a tap's `patchLiveDirtyRegions()` already synced the cache version —
		// the touch handler clearing `:active` on touchend (any live-DOM CSS
		// with an `:active`/`:hover`/`:focus` rule re-invalidates the hit
		// element), a media-event listener, a timer/async callback — re-bumps
		// `liveTreeVersion` with nobody having patched it. That used to force a
		// full chunked rebuild here (the audio player's "0fps on Play"). For a
		// pure-mutation repaint (NOT a viewport change, which genuinely needs a
		// full re-layout) over an already-warm cache, try patching the dirty
		// regions in place first; only fall through to the full rebuild when
		// the patch punts (returns false). Same function, same
		// safe-by-construction guarantees as the tap path — only the call site
		// is new.
		if (dirty && !viewportChanged && liveCacheOffscreen && lastPaintedRoot === root) {
			const patched = patchLiveDirtyRegions();
			// The patch swaps the layout-measure ctx to the cache ctx and does
			// not restore it; put the screen ctx back before we continue.
			setLayoutMeasureCtx(ctx);
			if (patched) dirty = false;
		}
		if (dirty) {
			// Capture the drained set so a full rebuild reached WITHOUT going
			// through patchLiveDirtyRegions (a viewport-change rebuild) still
			// refreshes any scrollable whose subtree changed. (Punt-driven
			// rebuilds already drained + noted inside patchLiveDirtyRegions, so
			// this is empty then.)
			const drainedForRebuild = drainLiveDirty();
			noteScrollDirty(drainedForRebuild);
			_partialDbg('=== FULL REBUILD: version=' + version + ' lastBody=' + lastBodyVersion
				+ (viewportChanged ? ' VIEWPORT-CHANGED ' + viewport.width + 'x' + viewport.height : '')
				+ ' pendingDirty=[' + drainedForRebuild.map(_tagOf).join(', ') + ']');
			// Start a fresh chunked build. A full rebuild repaints every
			// element, so any pending per-element dirty marks are now moot —
			// drop them so a subsequent tap's patchLiveDirtyRegions doesn't
			// try to patch elements this rebuild already covered (the
			// drainLiveDirty above already emptied the set for the log).
			clearLiveDirty();
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
				// The containing block for an absolutely-positioned element is
				// the ancestor's PADDING box, not its content box. Borders are
				// layout-ignored here, so the padding box == the element's
				// border box (x/y/w/h). Using contentX/contentW offset the
				// child by the ancestor's padding — e.g. the library track's
				// `.num` badge (track has `padding-left: 54px`) landed inside
				// the text instead of in the 54px gutter.
				layoutAbsoluteRoot(abs, cbBox.x, cbBox.y, cbBox.w, cbBox.h);
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
			// ...but grow to the children's painted extent when content
			// OVERFLOWS the body box. A body with an explicit `height`
			// (e.g. the audio player's `height:100vh` grid) reports
			// `bodyBox.h` = that fixed height even when its children run
			// past it, so using `h` alone clipped the bottom of the
			// library/controls and capped the scroll bound short. Children
			// paint from `contentY` down to `contentY + intrinsicContentH`,
			// so that sum is the real painted bottom. `Math.max` keeps the
			// padding-correct `bodyBox.h` for pages whose content fits
			// (identical to before) and only ever extends — never clips.
			lastLiveContentBottom = Math.max(
				bodyBox.h,
				bodyBox.contentY + bodyBox.intrinsicContentH,
			);

			// (Re)allocate the cache OffscreenCanvas. Cleared once at
			// build start; chunked ops paint into it over multiple
			// frame yields.
			const cacheH = Math.max(
				viewport.height,
				Math.min(lastLiveContentBottom, LIVE_CACHE_MAX_H),
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
			scrollOverlayEls = [];
			collectPaintOps(root, buildOps, /* skipBgOfRoot */ true, scrollOverlayEls);
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
		const budget = scrollChanged ? scrollChunkMs : buildChunkMs;
		if (cacheBuilding && liveCacheOffscreen) {
			const cacheCtx = liveCacheOffscreen.getContext('2d');
			if (cacheCtx) {
				setLayoutMeasureCtx(cacheCtx);
				const start = performance.now();
				while (buildOpIndex < buildOps.length) {
					const op = buildOps[buildOpIndex];
					// A single element's paint must NEVER abort the whole-page
					// build: an uncaught throw here left `buildOpIndex` parked
					// on the failing op, so every subsequent frame re-threw on
					// the same op and never advanced — blanking everything
					// after it (e.g. an SVG-icon button throwing dropped the
					// rest of the controls AND the entire library that paints
					// later in tree order). Catch, log which element failed
					// (console.debug — never the render-mode-flipping
					// error/log/warn/info), and skip it.
					try {
						if (op.kind === 'bg' && op.cs && op.box) {
							paintBoxedElement(cacheCtx, op.el, op.cs, op.box);
						} else if (op.kind === 'atom' && op.atom) {
							paintOneInlineAtom(cacheCtx, op.atom);
						} else if (op.kind === 'clip-push' && op.box) {
							cacheCtx.save();
							cacheCtx.beginPath();
							cacheCtx.rect(op.box.contentX, op.box.contentY, op.box.contentW, op.box.contentH);
							cacheCtx.clip();
						} else if (op.kind === 'clip-pop') {
							cacheCtx.restore();
						}
					} catch (err) {
						const el = op.kind === 'atom' ? op.atom?.el : op.el;
						const desc = el
							? `<${(el.tagName || '?').toLowerCase()}${el.getAttribute?.('class') ? ' class="' + el.getAttribute('class') + '"' : ''}${el.getAttribute?.('id') ? ' id="' + el.getAttribute('id') + '"' : ''}>`
							: op.kind;
						console.debug('[live-overlay] paint op threw, skipping', desc, err);
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

		// Paint scrollable containers ON TOP of the cache blit. Each was
		// excluded from the static cache; instead its children live in a
		// dedicated offscreen (rendered once per version/size change) and we
		// blit the visible slice here. Per-frame cost is one drawImage + the
		// scrollbar, so steady-state animation and swiping both stay cheap.
		// Same body-local → screen mapping as the cache blit: translate by
		// (viewport origin − page scrollY), then draw at the element's box.
		for (const sEl of scrollOverlayEls) {
			const sBox = getLayoutBox(sEl);
			if (!sBox) continue;
			const cw = Math.max(1, Math.round(sBox.contentW));
			const ih = Math.max(1, Math.round(sBox.intrinsicContentH));
			const ch = Math.round(sBox.contentH);
			// Key on the container's OWN content version (bumped by
			// noteScrollDirty only when its subtree mutates), NOT the global
			// tree version — otherwise an unrelated bump (the player's per-
			// second seek/time update) re-renders this whole subtree every
			// second and tanks playback FPS.
			const contentVersion = currentScrollContentVersion(sEl);
			let sc = scrollContentCaches.get(sEl);
			if (!sc || sc.w !== cw || sc.h !== ih) {
				sc = { canvas: new OffscreenCanvas(cw, ih), contentVersion: -1, w: cw, h: ih };
				scrollContentCaches.set(sEl, sc);
			}
			if (sc.contentVersion !== contentVersion) {
				// Re-render the children into the offscreen, translated so the
				// content-box origin maps to (0,0). measureText must run against
				// THIS ctx while painting (restored right after).
				const sctx = sc.canvas.getContext('2d');
				if (sctx) {
					sctx.clearRect(0, 0, cw, ih);
					sctx.save();
					try {
						setLayoutMeasureCtx(sctx);
						sctx.translate(-sBox.contentX, -sBox.contentY);
						for (const c of sEl.children) paintSubtreeLaid(sctx, c);
					} finally {
						sctx.restore();
						setLayoutMeasureCtx(ctx);
					}
				}
				sc.contentVersion = contentVersion;
			}
			const maxScroll = Math.max(0, ih - ch);
			const st = Math.min(Math.max(0, sEl.scrollTop | 0), maxScroll);
			const visibleH = Math.min(ch, ih - st);
			ctx.save();
			try {
				ctx.beginPath();
				ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
				ctx.clip();
				ctx.translate(viewport.x, viewport.y - scrollY);
				if (visibleH > 0) {
					ctx.drawImage(
						sc.canvas as unknown as CanvasImageSource,
						0, st, cw, visibleH,
						sBox.contentX, sBox.contentY, cw, visibleH,
					);
				}
				paintLiveScrollbarV(ctx, sBox, st);
			} finally { ctx.restore(); }
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
						// Gated on `controls`: with no bar painted there's
						// no alpha to build up, AND the wipe would otherwise
						// draw a stray black strip on the placeholder for an
						// opt-out page (e.g. the TikTok app's chromeless
						// video).
						const hasControls = el.hasAttribute('controls');
						if (!havePainted && hasControls) {
							const barH = Math.min(VIDEO_CONTROLS_BAR_H, box.h);
							ctx.fillStyle = '#000000';
							ctx.fillRect(
								screenX, screenY + box.h - barH,
								box.w, barH,
							);
						}
						if (hasControls) {
							paintVideoControls(ctx, el, screenX, screenY, box.w, box.h);
						}
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
| { kind: 'dbltap-action'; action: string; el: LiveElement }
| { kind: 'summary'; summary: LiveElement }
| { kind: 'video-control'; control: VideoControlHit; video: LiveElement }
| { kind: 'video-frame-tap'; video: LiveElement }
| null {
	for (let n: LiveElement | null = target; n; n = n.parent) {
		// `data-action` on ANY element (button, or e.g. a search `<input>`)
		// routes to a button-action intent. Checked before the tag
		// branches so an interactive control opts into a shell action
		// even when it's also a form widget.
		const dataAction = n.getAttribute('data-action');
		if (dataAction) return { kind: 'button-action', action: dataAction };
		// `data-dbltap-action` opts an element into a shell action that
		// fires only on a DOUBLE tap (single taps fall through). Used by
		// the audio player's visualizer canvas to enter fullscreen-canvas
		// without a visible button. controller-shortcuts applies the
		// single-vs-double discrimination via {@link handleDoubleTapAction}.
		const dblAction = n.getAttribute('data-dbltap-action');
		if (dblAction) return { kind: 'dbltap-action', action: dblAction, el: n };
		if (n.tagName === 'A') {
			const href = n.getAttribute('href');
			if (href) return { kind: 'navigate', href };
		}
		// `<input type=submit/image>` and `<button type=submit>` (or a
		// `<button>` with no type — submit is the HTML5 default) inside a
		// `<form action=...>` build a navigate intent the same shape an
		// `<a href>` would, so the shell's existing URL-resolution +
		// navigation path handles them with no extra plumbing. Gated on
		// the form having an action — actionless forms are typically
		// in-page state (UI groupings) and shouldn't navigate.
		if (n.tagName === 'INPUT' || n.tagName === 'BUTTON') {
			const defaultType = n.tagName === 'BUTTON' ? 'submit' : 'text';
			const type = (n.getAttribute('type') ?? defaultType).toLowerCase();
			if (type === 'submit' || type === 'image') {
				const form = findEnclosingForm(n);
				if (form && form.getAttribute('action')) {
					const href = buildFormSubmitUrl(form, n);
					if (href) return { kind: 'navigate', href };
				}
			}
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
	// `opacity: 0` → invisible (matches collectPaintOps); skip the subtree.
	const opacity = cs.opacity ?? el.style.opacity ?? 1;
	if (opacity <= 0) return;
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
		// Clip the element's own inline text to its content box when
		// overflow is hidden/clip/scroll. Without this, a text-only
		// element that hides overflow doesn't actually clip its text:
		// e.g. the `.sr-only` accessibility-label idiom (`width:1px;
		// height:1px; overflow:hidden`) leaked its "Seek" / "Volume"
		// labels into the layout, and `overflow:hidden; text-overflow:
		// ellipsis` rows didn't truncate. (Element-child overflow is
		// clipped separately below.)
		const ox = cs.overflowX ?? 'visible';
		const oy = cs.overflowY ?? 'visible';
		if (ox !== 'visible' || oy !== 'visible') {
			ctx.save();
			try {
				ctx.beginPath();
				ctx.rect(box.contentX, box.contentY, box.contentW, box.contentH);
				ctx.clip();
				paintInlineAtoms(ctx, inline);
			} finally { ctx.restore(); }
		} else {
			paintInlineAtoms(ctx, inline);
		}
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
		// Overlay a scrollbar (outside the clip + scroll translate) so the
		// user can see there's more content below and roughly where they
		// are. Only drawn when the box actually overflows — which doubles
		// as proof the element was laid out as scrollable. The engine does
		// not otherwise render the page's `scrollbar-*` CSS.
		if (scrolls) paintLiveScrollbarV(ctx, box, el.scrollTop);
		return;
	}
	for (const c of el.children) paintSubtreeLaid(ctx, c);
}

/** Draw a vertical scrollbar on the right inner edge of a scrollable
 * element's content box. Thumb size + position track the visible
 * fraction and `scrollTop`. Always shown while the element overflows
 * (no auto-hide) so there's a clear "more below" affordance. */
function paintLiveScrollbarV(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	box: LayoutBox,
	scrollTop: number,
): void {
	const maxScroll = Math.max(0, box.intrinsicContentH - box.contentH);
	if (maxScroll <= 0 || box.contentH <= 0) return;
	const trackW = 6;
	const inset = 3;
	const trackX = box.contentX + box.contentW - trackW - inset;
	const trackY = box.contentY + inset;
	const trackH = box.contentH - inset * 2;
	if (trackH <= 8) return;
	const r = trackW / 2;
	const visibleFrac = Math.min(1, box.contentH / box.intrinsicContentH);
	const thumbH = Math.max(24, Math.round(trackH * visibleFrac));
	const st = Math.min(Math.max(0, scrollTop), maxScroll);
	const thumbY = trackY + Math.round((trackH - thumbH) * (st / maxScroll));
	ctx.save();
	try {
		pathLiveRoundedRect(ctx, trackX, trackY, trackW, trackH, r);
		ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
		ctx.fill();
		pathLiveRoundedRect(ctx, trackX, thumbY, trackW, thumbH, r);
		ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
		ctx.fill();
	} finally {
		ctx.restore();
	}
}

/** Paint one element using its layout box. Backgrounds + canvas
 * drawImage land at the box rect; text uses the content rect for
 * alignment / clipping. Children paint via their own boxes (driven
 * by `paintSubtreeLaid`). */
/** Open a transform/alpha scope for the element's current CSS-animation
 * frame (or static `transform:` rotate/scale). Returns a `restore()` to
 * invoke after the element's paint, or undefined when no scope is needed. */
function beginCssAnimationXform(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): (() => void) | undefined {
	// Kick the animation ticker on first observation. Idempotent.
	if (cs.animation && cs.animation.name && cs.animation.durationMs > 0) {
		ensureCssAnimation(el, cs.animation, getKeyframes);
	}
	const anim = getCssAnimState(el);
	// Static rotate/scale come from cs.transform; animated values from the
	// per-tick interpolation. Animation wins when both are set.
	const rotateRad = anim?.rotateRad ?? cs.transform?.rotateRad;
	const scaleX = anim?.scaleX ?? cs.transform?.scaleX;
	const scaleY = anim?.scaleY ?? cs.transform?.scaleY;
	const animOpacity = anim?.opacity;
	const hasXform = (rotateRad !== undefined && rotateRad !== 0)
		|| (scaleX !== undefined && scaleX !== 1)
		|| (scaleY !== undefined && scaleY !== 1);
	const hasAlpha = animOpacity !== undefined && animOpacity !== 1;
	if (!hasXform && !hasAlpha) return undefined;
	ctx.save();
	if (hasXform && box.w > 0 && box.h > 0) {
		const cx = box.x + box.w / 2;
		const cy = box.y + box.h / 2;
		ctx.translate(cx, cy);
		if (rotateRad) ctx.rotate(rotateRad);
		if (scaleX !== undefined || scaleY !== undefined) {
			ctx.scale(scaleX ?? 1, scaleY ?? scaleX ?? 1);
		}
		ctx.translate(-cx, -cy);
	}
	if (hasAlpha) ctx.globalAlpha *= animOpacity!;
	return () => ctx.restore();
}

function paintBoxedElement(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const restoreAnim = beginCssAnimationXform(ctx, el, cs, box);
	try {
		paintBoxedElementInner(ctx, el, cs, box);
	} finally {
		if (restoreAnim) restoreAnim();
	}
}

function paintBoxedElementInner(
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
	// M2.4 form widget dispatch. When a form control carries a rich CSS
	// background (a parsed gradient) or a box-shadow, paint the generic
	// box decoration first — gradient/solid fill, rounded corners,
	// shadows, border — then let the form painter draw ONLY its
	// foreground (label / value / glyphs) on top. The form painters
	// otherwise fill the box with `ctx.fillStyle = cs.background`, which
	// silently no-ops for a gradient string and leaves e.g. a gradient
	// submit button invisible.
	const isFormTag = tag === 'INPUT' || tag === 'BUTTON'
		|| tag === 'SELECT' || tag === 'TEXTAREA';
	if (isFormTag) {
		const richBg = !!cs.backgroundLayers || !!cs.boxShadow;
		if (richBg && box.w > 0 && box.h > 0) {
			paintOuterBoxShadows(ctx, cs, box, radius);
			paintBackground(ctx, cs, box, radius);
			paintInsetBoxShadows(ctx, cs, box, radius);
			paintBorders(ctx, cs, box, radius);
		}
		if (paintFormWidget(ctx, el, cs, box, richBg)) return;
	}
	if (box.w > 0 && box.h > 0) {
		paintOuterBoxShadows(ctx, cs, box, radius);
		paintBackground(ctx, cs, box, radius);
		paintInsetBoxShadows(ctx, cs, box, radius);
	}
	paintBorders(ctx, cs, box, radius);
	// `::before` / `::after` BOX backgrounds (decorative overlays like the
	// visualizer grid) — painted above the host background, below the
	// host's own content + children. Text-only pseudos are no-ops here and
	// remain handled by the pseudo-text painter. Both drawn at this spot;
	// ::after's true above-children z-order isn't modeled (matches the
	// existing pseudo-text limitation), which is fine for box overlays.
	if (cs.beforeStyle || cs.afterStyle) {
		if (box.w > 0 && box.h > 0) {
			if (cs.beforeStyle) paintPseudoBox(ctx, cs.beforeStyle, box, radius);
			if (cs.afterStyle) paintPseudoBox(ctx, cs.afterStyle, box, radius);
		}
	}
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
	if (tag === 'IFRAME') {
		paintIframe(ctx, el, box);
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
		// Glyphs the Switch font lacks (e.g. the ‹ › angle-quote chevrons
		// used as prev/next arrows) render as a notdef dot via fillText.
		// Draw them as vector shapes instead, centered in the atom box.
		const drawn = (atom.text === '‹' || atom.text === '›')
			? paintIconGlyph(ctx, atom.text, atom.x + Math.max(0, (atom.w - fontSize * 0.42) / 2), drawY, fontSize)
			: 0;
		if (drawn === 0) {
			ctx.fillText(atom.text, atom.x, drawY);
			if (bold) ctx.fillText(atom.text, atom.x + 1, drawY);
		}
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
	scrollOut?: LiveElement[],
): void {
	const cs = getComputedLiveStyle(el);
	if (cs.display === 'none') return;
	// `opacity: 0` is invisible per spec — emit no ops for it or its
	// subtree. This is how the audio player's `.toast` stays hidden until
	// `showToast()` adds `.show` (opacity:1); without it the empty toast
	// pill painted permanently. (Partial 0<opacity<1 isn't group-composited
	// in the flat-op build; only the fully-transparent case is handled.)
	const opacity = cs.opacity ?? el.style.opacity ?? 1;
	if (opacity <= 0) return;
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
	// Scrollable container (overflow: auto/scroll): its OWN background stays
	// in the static cache (it doesn't scroll), but its children are excluded
	// — they're rendered into a per-container offscreen and blitted (scrolled
	// + clipped) each frame by the overlay painter. The flat-op cache builder
	// can't express clip/scroll, and re-painting the subtree live every frame
	// is too slow, so the dedicated scroll cache is the cheap middle ground.
	if (!skipBgOfRoot && isScrollOverlayEl(cs)) {
		if (scrollOut) scrollOut.push(el);
		return;
	}
	const inline = getInlineLayout(el);
	if (inline) {
		for (const atom of inline.atoms) {
			if (atom.isBr) continue;
			out.push({ kind: 'atom', el: atom.el, atom });
		}
		return; // inline layout replaces child walk
	}
	// `overflow: hidden` (not auto/scroll — those go via scrollOut above):
	// bracket the children's ops with a clip-push / clip-pop pair so the
	// static cache builder applies the same clipping the live painter
	// (paintSubtreeRest) does. Headline case: `<iframe>` (UA default
	// overflow: hidden) where the grafted child content can exceed the
	// declared box height. Without these ops the children paint past the
	// iframe box into adjacent flow content.
	const oy = cs.overflowY ?? 'visible';
	const ox = cs.overflowX ?? 'visible';
	const needsClip = (oy === 'hidden' || oy === 'clip')
		|| (ox === 'hidden' || ox === 'clip');
	if (needsClip) {
		out.push({ kind: 'clip-push', el, box });
		for (const c of el.children) {
			collectPaintOps(c, out, false, scrollOut);
		}
		out.push({ kind: 'clip-pop', el });
		return;
	}
	for (const c of el.children) {
		collectPaintOps(c, out, false, scrollOut);
	}
}

/** An element that scrolls its overflow vertically/horizontally
 * (`overflow: auto | scroll`). Such elements are painted as per-frame
 * overlays rather than baked into the static body cache, so the cache's
 * flat op list never has to express clipping / scroll translation. */
function isScrollOverlayEl(cs: ComputedLiveStyle): boolean {
	const oy = cs.overflowY ?? 'visible';
	const ox = cs.overflowX ?? 'visible';
	return oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll';
}

/** Scroll the nearest scrollable ancestor of `el` so `el` is fully visible
 * (vertical only). Backs `LiveElement.scrollIntoView()`. Uses raw layout
 * boxes (which are scroll-independent — `scrollTop` is applied at paint),
 * so the math is just "where does this element sit within the unscrolled
 * content." Setting `scrollTop` triggers a cheap re-blit (no re-layout). */
export function scrollElementIntoView(el: LiveElement): void {
	let host: LiveElement | null = el.parent;
	let hostBox: LayoutBox | undefined;
	while (host) {
		const lb = getLayoutBox(host);
		if (lb && isScrollOverlayEl(getComputedLiveStyle(host))
			&& lb.intrinsicContentH > lb.contentH) {
			hostBox = lb;
			break;
		}
		host = host.parent;
	}
	if (!host || !hostBox) return;
	const elBox = getLayoutBox(el);
	if (!elBox) return;
	const margin = 8;
	const topInContent = elBox.y - hostBox.contentY;
	const maxScroll = Math.max(0, hostBox.intrinsicContentH - hostBox.contentH);
	let st = host.scrollTop;
	if (topInContent - margin < st) {
		st = topInContent - margin;
	} else if (topInContent + elBox.h + margin > st + hostBox.contentH) {
		st = topInContent + elBox.h + margin - hostBox.contentH;
	}
	st = Math.max(0, Math.min(maxScroll, Math.round(st)));
	if (st !== host.scrollTop) host.scrollTop = st;
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
		ctx.font = fontSize + 'px ' + quoteFontFamily(cs.fontFamily || 'sans-serif');
		ctx.fillStyle = color;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'right';
		ctx.fillText(text, cx + 4, cy);
	} finally { ctx.restore(); }
}

/** `<img>` paints the loaded Image at the layout box. While the image is
 * still loading it renders NOTHING — the layout box just reserves the
 * space; only a failed/broken load shows the `alt`-text placeholder.
 * The aspect ratio is honored by drawImage's stretch — the page is
 * expected to set width via CSS to control the displayed size. */
/** Paint chrome for an `<iframe>` element. The iframe's grafted content
 * (fetched + parsed from its `src` — see html-to-live.ts
 * `loadIframeContents`) renders via the normal subtree-paint pass since
 * each child is a real LiveElement. This function only draws the
 * iframe's frame border and (when the subtree is still empty) a
 * loading/error placeholder so the box isn't a confusing blank rect.
 *
 * Tier 1B caveats:
 *   - iframe-internal `<script>` is never executed (shared JS context;
 *     skipping is the safer default — see html-to-live.ts grafting).
 *   - `sandbox` / `allow` / CSP attributes are ignored (parsed but
 *     not enforced).
 *   - Cross-origin restrictions (same-origin policy) are NOT enforced.
 *     Any iframe sees its content as if same-origin. */
function paintIframe(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	box: LayoutBox,
): void {
	if (box.w <= 0 || box.h <= 0) return;
	ctx.save();
	try {
		// 1px frame border. Standard browser default; gives the user a
		// visual cue where the embed begins/ends even when content fails.
		ctx.strokeStyle = '#444';
		ctx.lineWidth = 1;
		ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
		// Placeholder text shows while waiting for the fetch + parse,
		// or permanently if the load failed. Suppressed once children
		// exist (the grafted subtree paints over this on the next pass).
		const hasContent = el.children.length > 0;
		if (!hasContent) {
			const src = el.getAttribute('src') ?? '(no src)';
			const failed = (el as unknown as { _iframeLoadFailed?: boolean })._iframeLoadFailed === true;
			ctx.fillStyle = '#f7f7f7';
			ctx.fillRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
			ctx.fillStyle = failed ? '#9a3324' : '#666';
			ctx.font = '14px system-ui';
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'center';
			const cx = box.x + box.w / 2;
			const cy = box.y + box.h / 2;
			ctx.fillText(failed ? 'Embed failed to load' : 'Loading embed…', cx, cy - 10);
			ctx.font = '11px system-ui';
			ctx.fillStyle = '#888';
			const short = src.length > 80 ? src.slice(0, 77) + '…' : src;
			ctx.fillText(short, cx, cy + 10);
		}
	} finally { ctx.restore(); }
}

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
	// While the image is still loading, render NOTHING — the layout box
	// already reserves the space, so we just leave it (the element's own
	// background, if any, was painted by paintBoxedElement). Only a
	// genuinely failed/broken image falls through to the alt placeholder.
	if (!el.hasImageError()) return;
	// Broken image: gray box + alt text centered.
	ctx.fillStyle = cs.background || '#1d2c43';
	ctx.fillRect(box.x, box.y, box.w, box.h);
	ctx.strokeStyle = '#5a6a7e';
	ctx.lineWidth = 1;
	ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
	const alt = el.getAttribute('alt') || '[img]';
	ctx.save();
	try {
		ctx.fillStyle = cs.color || '#9bb1d6';
		ctx.font = (cs.fontSize ?? 12) + 'px ' + quoteFontFamily(cs.fontFamily || 'sans-serif');
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
		// on top of the frame each tick. Gated on `controls` so chromeless
		// videos (TikTok app) stay clean.
		if (el.hasAttribute('controls')) {
			paintVideoControls(ctx, el, box.x, box.y, box.w, box.h);
		}
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
		case '‹': {
			// Left chevron stroke (single left-angle quote). The Switch
			// font has no glyph for these, so they'd paint as a notdef
			// dot — draw the "<" shape instead.
			const w = fontSize * 0.42, h = fontSize * 0.62;
			const prev = ctx.lineWidth;
			ctx.lineWidth = Math.max(1.5, fontSize * 0.11);
			ctx.strokeStyle = ctx.fillStyle as string;
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';
			ctx.beginPath();
			ctx.moveTo(x + w, y - h / 2);
			ctx.lineTo(x, y);
			ctx.lineTo(x + w, y + h / 2);
			ctx.stroke();
			ctx.lineWidth = prev;
			return w;
		}
		case '›': {
			// Right chevron stroke (single right-angle quote). Mirror of ‹.
			const w = fontSize * 0.42, h = fontSize * 0.62;
			const prev = ctx.lineWidth;
			ctx.lineWidth = Math.max(1.5, fontSize * 0.11);
			ctx.strokeStyle = ctx.fillStyle as string;
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';
			ctx.beginPath();
			ctx.moveTo(x, y - h / 2);
			ctx.lineTo(x + w, y);
			ctx.lineTo(x, y + h / 2);
			ctx.stroke();
			ctx.lineWidth = prev;
			return w;
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
			const size = cs.backgroundSize;
			for (const layer of layers) {
				// Image layers: `background-size` sets the IMAGE's draw
				// dimensions, not the tile grid. paintTiledLayer would
				// repeat a 36×36 logo across the whole header — wrong for
				// `background-repeat:no-repeat` (DDG's logo case).
				// Synthesise a sized image layer when cs supplies a size
				// but the layer doesn't already carry one from the
				// shorthand, then defer to paintBackgroundLayer's own
				// size/repeat handling.
				if (layer.type === 'image') {
					const effLayer = (size && layer.sizeMode === undefined
						&& layer.sizeW === undefined && layer.sizeH === undefined)
						? { ...layer, sizeMode: 'auto' as const, sizeW: size.w, sizeH: size.h }
						: layer;
					paintBackgroundLayer(ctx, effLayer, box.x, box.y, box.w, box.h);
					continue;
				}
				if (size) paintTiledLayer(ctx, layer, box.x, box.y, box.w, box.h, size.w, size.h);
				else paintBackgroundLayer(ctx, layer, box.x, box.y, box.w, box.h);
			}
		} finally { ctx.restore(); }
		return;
	}
	const bg = cs.background;
	// `'none'` / `'transparent'` are valid CSS but invalid Canvas2D
	// fillStyle values — assigning them is a silent no-op that LEAVES
	// THE PREVIOUS fillStyle in place. A subsequent fillRect then
	// paints the box with whatever stale colour the prior element used
	// (e.g. tier3's `<form style="background:none">` ended up filled
	// with the toolbar navy). Treat both keywords as "no bg, no fill".
	if (bg && bg !== 'none' && bg !== 'transparent') {
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
	if (layer.type === 'image') {
		const img = getBackgroundImage(layer.url);
		if (!img) return; // not loaded (or failed) — leave layer transparent
		// HTMLImageElement has naturalWidth/Height; OffscreenCanvas (used
		// for SVG rasterizations) has only width/height. Type guard via
		// `in` so the BgImageSource union resolves cleanly.
		const natW = 'naturalWidth' in img ? img.naturalWidth : img.width;
		const natH = 'naturalHeight' in img ? img.naturalHeight : img.height;
		if (natW <= 0 || natH <= 0) return;
		// Resolve draw size: explicit px → use directly; cover → fill +
		// crop; contain → fit + letterbox; otherwise natural size (capped
		// to the box on each axis).
		let dw: number, dh: number;
		if (layer.sizeMode === 'cover') {
			const s = Math.max(w / natW, h / natH);
			dw = natW * s; dh = natH * s;
		} else if (layer.sizeMode === 'contain') {
			const s = Math.min(w / natW, h / natH);
			dw = natW * s; dh = natH * s;
		} else if (layer.sizeMode === 'auto' || layer.sizeW || layer.sizeH) {
			// `auto N`px (aspect-preserving against the fixed axis) — common
			// CSS pattern for icons/logos that want a fixed height + auto
			// width-from-aspect.
			if (layer.sizeW && layer.sizeH) { dw = layer.sizeW; dh = layer.sizeH; }
			else if (layer.sizeW) { dw = layer.sizeW; dh = natH * (layer.sizeW / natW); }
			else if (layer.sizeH) { dh = layer.sizeH; dw = natW * (layer.sizeH / natH); }
			else { dw = natW; dh = natH; }
		} else {
			dw = natW; dh = natH;
		}
		// repeat:repeat tiles across the box. Anything else (no-repeat /
		// repeat-x / repeat-y) draws one tile (we don't axis-tile yet).
		if (layer.repeat === 'repeat') {
			for (let py = y; py < y + h; py += dh) {
				for (let px = x; px < x + w; px += dw) {
					ctx.drawImage(img, px, py, dw, dh);
				}
			}
			return;
		}
		// Position: default `center` matches real-browser default for
		// background-image when no `background-position` is set.
		let dx = x + (w - dw) / 2;
		let dy = y + (h - dh) / 2;
		if (layer.position === 'left') dx = x;
		else if (layer.position === 'right') dx = x + w - dw;
		if (layer.position === 'top') dy = y;
		else if (layer.position === 'bottom') dy = y + h - dh;
		ctx.drawImage(img, dx, dy, dw, dh);
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
		applyStops(grad, layer.stops, len);
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
		applyStops(grad, layer.stops, rMax);
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
		applyStops(grad, layer.stops, ryMax);
		ctx.fillStyle = grad;
		ctx.fillRect(x - rxMax, y - ryMax, w + rxMax * 2, h + ryMax * 2);
	} finally { ctx.restore(); }
}

/** Paint one background layer TILED across the box in `tw`×`th` cells
 * (CSS `background-size`). Each tile re-runs `paintBackgroundLayer` sized
 * to the tile, so a gradient's stops (incl. px stops resolved against the
 * tile extent) repeat per cell — that's how `linear-gradient(c 1px,
 * transparent 1px)` + `background-size: 42px 42px` becomes a 42px grid.
 * The caller is expected to have clipped to the box, so partial edge
 * tiles are trimmed. Falls back to a single fill for degenerate sizes or
 * a pathological tile count. */
function paintTiledLayer(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	layer: BackgroundLayer,
	x: number, y: number, w: number, h: number,
	tw: number, th: number,
): void {
	if (tw <= 0 || th <= 0) { paintBackgroundLayer(ctx, layer, x, y, w, h); return; }
	const cols = Math.ceil(w / tw);
	const rows = Math.ceil(h / th);
	if (cols * rows > 8000) { paintBackgroundLayer(ctx, layer, x, y, w, h); return; }
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			paintBackgroundLayer(ctx, layer, x + c * tw, y + r * th, tw, th);
		}
	}
}

/** Paint a `::before` / `::after` pseudo-element that draws a decorative
 * background BOX (not text) — e.g. the visualizer grid overlay. The box
 * is derived from the host's border box plus the pseudo's inset /
 * offsets / explicit width-height (absolute-positioning model; `inset: 0`
 * fills the host). Honors background-size tiling, opacity, and an
 * optional mask-image alpha fade. No-op for text-only pseudos (no
 * background) — those are still drawn by the pseudo-text painter. */
function paintPseudoBox(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	pseudo: PseudoStyle | undefined,
	hostBox: LayoutBox,
	hostRadius: number,
): void {
	if (!pseudo) return;
	if (!pseudo.backgroundLayers && !pseudo.background) return;
	// Only absolutely-positioned pseudos get a painted background box (the
	// decorative-overlay case, sized via the abs model below). A static /
	// in-flow text pseudo with a background would need content sizing we
	// don't model, so leave those to the pseudo-text painter unchanged.
	if (pseudo.position !== 'absolute') return;
	const cbX = hostBox.x, cbY = hostBox.y, cbW = hostBox.w, cbH = hostBox.h;
	// Edge values: px wins over percent on the same edge. Percent
	// resolves against host width (left/right) or height (top/bottom).
	// Without percent support, `top: 50%` on a chevron pseudo silently
	// dropped to `top: 0` — landing on the host's top edge instead of
	// its centre (DDG dropdown chevrons on the input row).
	const L = pseudo.left ?? (pseudo.leftPct !== undefined ? (pseudo.leftPct / 100) * cbW : undefined);
	const R = pseudo.right ?? (pseudo.rightPct !== undefined ? (pseudo.rightPct / 100) * cbW : undefined);
	const T = pseudo.top ?? (pseudo.topPct !== undefined ? (pseudo.topPct / 100) * cbH : undefined);
	const B = pseudo.bottom ?? (pseudo.bottomPct !== undefined ? (pseudo.bottomPct / 100) * cbH : undefined);
	const explicitW = resolveLength(pseudo.width, cbW);
	const explicitH = resolveLength(pseudo.height, cbH);
	let pw = cbW, ph = cbH, px = cbX, py = cbY;
	if (explicitW !== undefined) pw = explicitW;
	else if (L !== undefined && R !== undefined) pw = Math.max(0, cbW - L - R);
	if (explicitH !== undefined) ph = explicitH;
	else if (T !== undefined && B !== undefined) ph = Math.max(0, cbH - T - B);
	if (L !== undefined) px = cbX + L;
	else if (R !== undefined) px = cbX + cbW - pw - R;
	if (T !== undefined) py = cbY + T;
	else if (B !== undefined) py = cbY + cbH - ph - B;
	if (pw <= 0 || ph <= 0) return;
	ctx.save();
	try {
		const alpha = pseudo.opacity ?? 1;
		if (alpha < 1) ctx.globalAlpha *= alpha;
		// The pseudo is a child of the host box — clip to the host's
		// rounded rect so it respects border-radius + overflow:hidden.
		if (hostRadius > 0) {
			pathLiveRoundedRect(ctx, cbX, cbY, cbW, cbH, hostRadius);
			ctx.clip();
		}
		if (pseudo.maskImage) paintPseudoMaskedBg(ctx, pseudo, px, py, pw, ph);
		else paintPseudoBgLayers(ctx, pseudo, px, py, pw, ph);
	} finally { ctx.restore(); }
}

/** Paint a pseudo's background layers (with optional `background-size`
 * tiling) into the given rect, clipped to it. */
function paintPseudoBgLayers(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	pseudo: PseudoStyle,
	x: number, y: number, w: number, h: number,
): void {
	ctx.save();
	try {
		ctx.beginPath();
		ctx.rect(x, y, w, h);
		ctx.clip();
		const layers = pseudo.backgroundLayers;
		if (layers && layers.length > 0) {
			const size = pseudo.backgroundSize;
			for (const layer of layers) {
				if (size) paintTiledLayer(ctx, layer, x, y, w, h, size.w, size.h);
				else paintBackgroundLayer(ctx, layer, x, y, w, h);
			}
		} else if (pseudo.background) {
			ctx.fillStyle = pseudo.background;
			ctx.fillRect(x, y, w, h);
		}
	} finally { ctx.restore(); }
}

/** Paint a pseudo's background into an offscreen, then knock out its
 * alpha with the `mask-image` gradient (destination-in) before
 * compositing onto the cache — yields a radial/linear fade over the
 * background. Falls back to an unmasked paint if OffscreenCanvas or the
 * destination-in composite op isn't available (detected by read-back). */
function paintPseudoMaskedBg(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	pseudo: PseudoStyle,
	x: number, y: number, w: number, h: number,
): void {
	const iw = Math.max(1, Math.ceil(w));
	const ih = Math.max(1, Math.ceil(h));
	try {
		const off = new OffscreenCanvas(iw, ih);
		const octx = off.getContext('2d');
		if (!octx) { paintPseudoBgLayers(ctx, pseudo, x, y, w, h); return; }
		paintPseudoBgLayers(octx, pseudo, 0, 0, w, h);
		octx.globalCompositeOperation = 'destination-in';
		if (octx.globalCompositeOperation === 'destination-in' && pseudo.maskImage) {
			paintBackgroundLayer(octx, pseudo.maskImage, 0, 0, w, h);
		}
		octx.globalCompositeOperation = 'source-over';
		ctx.drawImage(off as unknown as CanvasImageSource, x, y);
	} catch (_) {
		// OffscreenCanvas / composite path unavailable — fall back to the
		// unmasked grid (still a reasonable result) rather than throwing
		// out of the element's paint op.
		try { paintPseudoBgLayers(ctx, pseudo, x, y, w, h); } catch (_e) { /* swallow */ }
	}
}

function applyStops(
	grad: CanvasGradient,
	stops: { color: string; pos?: number; posPx?: number }[],
	extentPx: number = 0,
): void {
	for (const stop of stops) {
		// Pixel-positioned stops (`color 1px`) resolve against the gradient
		// line length so they track `background-size` tiling — a 1px stop in
		// a 42px tile lands at 1/42, drawing a crisp 1px line per tile.
		let p = stop.pos;
		if (p === undefined && stop.posPx !== undefined && extentPx > 0) {
			p = stop.posPx / extentPx;
		}
		p = p ?? 0;
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
		// Edge resolution: px wins, then percent (against bw/bh — the
		// host box). Matches paintPseudoBox's pattern so pseudo TEXT
		// positioned with e.g. `right: 50%` lands correctly too.
		const pR = pseudo?.right ?? (pseudo?.rightPct !== undefined ? (pseudo.rightPct / 100) * bw : undefined);
		const pL = pseudo?.left ?? (pseudo?.leftPct !== undefined ? (pseudo.leftPct / 100) * bw : undefined);
		const pB = pseudo?.bottom ?? (pseudo?.bottomPct !== undefined ? (pseudo.bottomPct / 100) * bh : undefined);
		const pT = pseudo?.top ?? (pseudo?.topPct !== undefined ? (pseudo.topPct / 100) * bh : undefined);
		if (pR !== undefined) {
			ax = bx + bw - pR;
			align = 'right';
		} else if (pL !== undefined) {
			ax = bx + pL;
			align = 'left';
		} else {
			ax = bx + (defaultAlign === 'right' ? bw - 2 : 2);
			align = defaultAlign;
		}
		let ay: number;
		let baseline: CanvasTextBaseline;
		if (pB !== undefined) {
			ay = by + bh - pB;
			baseline = 'alphabetic';
		} else if (pT !== undefined) {
			ay = by + pT;
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
