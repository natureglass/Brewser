// M2.3: layout pass for the live-DOM tree.
//
// Before this milestone, every descendant of a position:fixed element
// painted at the same origin as the fixed ancestor — no flex, no
// block stacking, no padding. M2.3 introduces a real layout pass:
// walk the subtree under each fixed root, compute a LayoutBox per
// element (x/y/w/h plus content-box inset for padding), and store
// the result so the paint pass + getBoundingClientRect read from the
// same source of truth.
//
// Scope:
//   - `display: block` (default) — stack children vertically, full
//     content width.
//   - `display: flex; flex-direction: column` (default for flex) —
//     stack vertically; distribute leftover main-axis space per
//     `flex-grow` / `flex-shrink` / `flex-basis`; cross-axis sizing
//     follows `align-items` (`stretch` default).
//   - `display: flex; flex-direction: row` — same on the horizontal
//     axis.
//   - `padding` (per-edge longhand or shorthand) — inset for content
//     box.
//   - `margin` — extra space outside the box; collapses with siblings
//     in block layout (additive, not the real margin-collapse rules).
//   - `gap` — spacing between flex children (applied between each
//     pair, no leading/trailing).
//   - `width` / `height` — explicit sizing; otherwise inferred from
//     content or container.
//   - `min-width` / `max-width` / `min-height` / `max-height` —
//     clamp the computed sizing.
//   - `box-sizing` — `content-box` (default) vs `border-box` (width
//     INCLUDES padding).
//   - `justify-content` for flex main-axis alignment.
//   - `align-items` for flex cross-axis alignment.
//   - Text content has measured intrinsic width via `ctx.measureText`
//     when the element has no explicit width AND its parent isn't
//     stretching it (used for auto-sized button-style labels).
//
// Out of scope:
//   - Multi-line text wrap (single line, clipped to box).
//   - Real margin-collapse rules (we add margins; close enough for
//     lil-gui's small spacing values).
//   - `position: absolute` siblings.
//   - `flex-wrap`.
//   - `grid`.
//   - `inline` participating in line-box layout.

import { getComputedLiveStyle, type ComputedLiveStyle } from './live-css.js';
import type { LiveElement } from './live-dom.js';
import { quoteFontFamily, resolveLength, type CssLength } from './inline-css.js';

/** Per-element layout result. `(x, y, w, h)` is the border box (i.e.
 * the rect the painter draws the background into). `contentX/Y/W/H`
 * is the inset rect for children + text. `intrinsicContentH` is the
 * natural height children + text wanted (used to compute scrollable
 * overflow); when an element has explicit height + overflow:auto/scroll,
 * `intrinsicContentH > contentH` means scrollable. */
export interface LayoutBox {
	x: number;
	y: number;
	w: number;
	h: number;
	contentX: number;
	contentY: number;
	contentW: number;
	contentH: number;
	intrinsicContentH: number;
	intrinsicContentW: number;
}

/** Per-page measurement context — we need a CanvasRenderingContext2D
 * to call `measureText` for intrinsic width. The shell calls
 * `setLayoutMeasureCtx` once per frame with the current screen 2d
 * context. */
let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
export function setLayoutMeasureCtx(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null): void {
	measureCtx = ctx;
}

/** Layout cache for the current frame. Cleared by the painter at the
 * start of each frame so layout reflects style changes since last
 * paint. */
let cache = new WeakMap<LiveElement, LayoutBox>();
const cacheTouched = new Set<LiveElement>();

/** Phase 2.5 inline-formatting context (2026-05-25): per-block-parent
 * inline-flow result. Multiple atoms can map to the same source element
 * (a text node spanning several words / several lines), so we can't key
 * the layout boxes by element. Instead the parent block stores a
 * structure of atoms, and the painter / hit-test walk it. */
export interface InlineAtom {
	/** Source element — text node, inline element, IMG, or BR. */
	el: LiveElement;
	x: number; y: number; w: number; h: number;
	/** Text content for this atom (single word or `' '` for whitespace,
	 * empty for IMG / BR / non-text inline). */
	text: string;
	/** Canvas `font` string used to measure + render the text. */
	font: string;
	fontSize: number;
	/** True for `<br>`; the painter skips drawing but the layout already
	 * advanced the y cursor by line-height. */
	isBr: boolean;
}
export interface InlineLayout {
	atoms: InlineAtom[];
	/** Total height consumed (cumulative line-height). */
	height: number;
}
let inlineCache = new WeakMap<LiveElement, InlineLayout>();
const inlineCacheTouched = new Set<LiveElement>();

export function resetLayoutCache(): void {
	cacheTouched.forEach((e) => cache.delete(e));
	cacheTouched.clear();
	inlineCacheTouched.forEach((e) => inlineCache.delete(e));
	inlineCacheTouched.clear();
}

export function getLayoutBox(el: LiveElement): LayoutBox | undefined {
	return cache.get(el);
}

/** Phase 2.5: read the inline-flow result for a block-level parent.
 * Painter detects "has inline-layout" → paint atoms; otherwise recurse
 * into children as usual. */
export function getInlineLayout(el: LiveElement): InlineLayout | undefined {
	return inlineCache.get(el);
}

/**
 * Lay out a position:fixed root inside the given outer rect
 * `(originX, originY, outerWidth?)`. Returns the root's LayoutBox
 * and stores it (+ every descendant's box) in the per-frame cache.
 *
 * `outerWidth` is the available width — typically the viewport width
 * minus the element's `left + right` insets, or just `style.width`
 * when set. When undefined we fall back to a generous default so a
 * single-column root without explicit width still gets reasonable
 * defaults.
 */
export function layoutFixedRoot(
	root: LiveElement,
	originX: number,
	originY: number,
	availableWidth: number,
	availableHeight: number,
): LayoutBox {
	const cs = getComputedLiveStyle(root);
	// Resolve the root's box dims from CSS or available space. Root's
	// containing block IS the viewport, so percent widths/heights resolve
	// against the available space passed in.
	const explicitW = resolveLength(cs.width, availableWidth)
		?? resolveLength(root.style.width, availableWidth);
	const explicitH = resolveLength(cs.height, availableHeight)
		?? resolveLength(root.style.height, availableHeight);
	// When no explicit width, prefer the intrinsic width of any canvas
	// children — but ONLY for fixed-overlay roots (the Stats pattern:
	// `position: fixed` container with no size, but a visible 80×48
	// canvas inside that defines the hit box). For the document body
	// itself, always use the full available width: the body's
	// containing block IS the viewport. Without this guard, a page
	// like dev/rounded with a `<canvas width="240">`
	// somewhere in body would shrink the entire body's content area
	// to 240px wide and all paragraphs/tables wrap at that width.
	const isBody = root.tagName === 'BODY';
	let w: number;
	if (explicitW !== undefined) {
		w = clampSize(explicitW, cs.minWidth, cs.maxWidth, availableWidth);
	} else if (isBody) {
		w = clampSize(availableWidth, cs.minWidth, cs.maxWidth, availableWidth);
	} else {
		const intrinsicCanvasW = canvasIntrinsicWidth(root);
		w = clampSize(intrinsicCanvasW > 0 ? intrinsicCanvasW : availableWidth, cs.minWidth, cs.maxWidth, availableWidth);
	}
	const initialH = explicitH ?? availableHeight;
	// Compute children first so we can grow the root to fit them when
	// no explicit height.
	const pad = padding(cs);
	const contentX = originX + pad.left;
	const contentY = originY + pad.top;
	const contentWGuess = Math.max(0, w - pad.left - pad.right);
	let intrinsicH = layoutChildren(root, contentX, contentY, contentWGuess, initialH - pad.top - pad.bottom);
	// Childless form controls (range/text inputs, button, select) reserve a
	// line box for their height in the full flow layout (see intrinsicCross /
	// intrinsicContentHeight). The pinned-root relayout used by the partial-
	// repaint path has no children to measure, so without this fallback a
	// re-laid-out <input> collapses to height 0 and then paints nothing
	// ("skip no-box") — which made the audio player's range seek bar vanish
	// on the first 4 Hz timeline poll after playback started.
	if (intrinsicH <= 0 && explicitH === undefined) {
		const tag = root.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
			intrinsicH = cs.lineHeight ?? (cs.fontSize ?? 14) * 1.2;
		}
	}
	const h = clampSize(explicitH ?? (pad.top + intrinsicH + pad.bottom), cs.minHeight, cs.maxHeight, availableHeight);
	const contentH = Math.max(0, h - pad.top - pad.bottom);
	const box: LayoutBox = {
		x: originX, y: originY, w, h,
		contentX, contentY,
		contentW: contentWGuess,
		contentH,
		intrinsicContentH: intrinsicH,
		intrinsicContentW: contentWGuess,
	};
	storeBox(root, box);
	return box;
}

/** Walk the live tree and collect every element with
 * `position: absolute`. Used by the painter's post-flow pass to lay
 * out + paint absolutes against their nearest positioned ancestor's
 * box. Order-preserving (document order) so z-index ties break
 * deterministically. */
export function collectAbsolutes(root: LiveElement): LiveElement[] {
	const out: LiveElement[] = [];
	const visit = (el: LiveElement) => {
		const cs = getComputedLiveStyle(el);
		if (cs.display === 'none') return;
		// Skip the root itself; we only care about descendants. The body
		// root being absolutely positioned is meaningless in our model.
		if (el !== root) {
			const pos = cs.position ?? el.style.position;
			if (pos === 'absolute') out.push(el);
		}
		for (const c of el.children) visit(c);
	};
	visit(root);
	return out;
}

/** Resolve the containing-block ancestor for a `position: absolute`
 * element: nearest non-static positioned ancestor with a layout box;
 * falls back to `fallbackRoot` (typically body) so absolutes without
 * a positioned ancestor anchor to the viewport-equivalent. */
export function findAbsoluteContainingBlock(
	el: LiveElement,
	fallbackRoot: LiveElement,
): LiveElement {
	let cur = el.parent;
	while (cur) {
		const cs = getComputedLiveStyle(cur);
		const pos = cs.position ?? cur.style.position;
		if (pos && pos !== 'static') {
			if (getLayoutBox(cur)) return cur;
		}
		cur = cur.parent;
	}
	return fallbackRoot;
}

/** Lay out a `position: absolute` element against the supplied
 * containing-block rect (typically `cb.content{X,Y,W,H}`). Resolves
 * top/left/right/bottom + width/height from the cascade with `auto`
 * defaults: width = content - left - right, height = intrinsic. */
export function layoutAbsoluteRoot(
	el: LiveElement,
	cbContentX: number,
	cbContentY: number,
	cbContentW: number,
	cbContentH: number,
): LayoutBox {
	const cs = getComputedLiveStyle(el);
	// Resolve each edge to px: an explicit px offset wins, else a `%`
	// offset resolves against the containing block (width for left/right,
	// height for top/bottom). `left: 50%` → half the container width.
	const edge = (px: number | undefined, pct: number | undefined, basis: number): number | undefined =>
		px !== undefined ? px : pct !== undefined ? (pct / 100) * basis : undefined;
	const csLeft = edge(cs.left ?? el.style.left, cs.leftPct, cbContentW);
	const csRight = edge(cs.right ?? el.style.right, cs.rightPct, cbContentW);
	const csTop = edge(cs.top ?? el.style.top, cs.topPct, cbContentH);
	const csBottom = edge(cs.bottom ?? el.style.bottom, cs.bottomPct, cbContentH);
	const explicitW = resolveLength(cs.width, cbContentW)
		?? resolveLength(el.style.width, cbContentW);
	const explicitH = resolveLength(cs.height, cbContentH)
		?? resolveLength(el.style.height, cbContentH);
	const availW = explicitW !== undefined
		? explicitW
		: csLeft !== undefined && csRight !== undefined
			? Math.max(0, cbContentW - csLeft - csRight)
			: Math.max(0, cbContentW - (csLeft ?? 0));
	// Height: an explicit height wins; an element anchored on BOTH top
	// and bottom stretches between them; otherwise the height is auto =
	// shrink-to-fit, so pass 0 and let `layoutFixedRoot` grow it to its
	// content. Previously this defaulted to `cbContentH - top`, which
	// gave an auto-height absolute (e.g. a top-anchored status-bar
	// overlay with `top:22px` only) the entire remaining card height —
	// and a flex row inside it with the default `align-items: stretch`
	// then stretched its children to that full height (the giant
	// status-pill bug).
	const availH = explicitH !== undefined
		? explicitH
		: csTop !== undefined && csBottom !== undefined
			? Math.max(0, cbContentH - csTop - csBottom)
			: 0;
	// An auto-width absolute (no explicit width, not anchored on BOTH left
	// and right) is SHRINK-TO-FIT per CSS, not full-width: size it to its
	// max-content, capped by the available band and `max-width`. Without
	// this a block-level overlay (e.g. the player's toast) stretched across
	// the whole available width instead of hugging its text.
	let useW = availW;
	const autoWidth = explicitW === undefined
		&& !(csLeft !== undefined && csRight !== undefined);
	if (autoWidth) {
		useW = Math.min(availW, intrinsicContentWidth(el, cs));
		const maxW = resolveLength(cs.maxWidth, cbContentW);
		if (maxW !== undefined) useW = Math.min(useW, maxW);
		if (useW < 0) useW = 0;
	}
	// First (measure) pass at the content origin so we know the resolved
	// box size — needed to anchor right/bottom for an AUTO-size box (no
	// explicit width/height) and to resolve a `transform: translate(%)`
	// against the element's own box. Cheap: absolutes are few.
	let box = layoutFixedRoot(el, cbContentX, cbContentY, useW, availH);
	// Resolve x: `left` wins; else `right` anchors the box's right edge
	// (works for auto-width now that `box.w` is measured); else origin.
	let x = cbContentX;
	if (csLeft !== undefined) x = cbContentX + csLeft;
	else if (csRight !== undefined) x = cbContentX + cbContentW - box.w - csRight;
	let y = cbContentY;
	if (csTop !== undefined) y = cbContentY + csTop;
	else if (csBottom !== undefined) y = cbContentY + cbContentH - box.h - csBottom;
	// Bake `transform: translate(...)` into the position. `%` resolves
	// against the element's own box, so `left:50%` + `translateX(-50%)`
	// centers a shrink-to-fit overlay (e.g. the audio player's toast).
	const tf = cs.transform;
	if (tf) {
		if (tf.tx !== undefined) x += resolveLength(tf.tx, box.w) ?? 0;
		if (tf.ty !== undefined) y += resolveLength(tf.ty, box.h) ?? 0;
	}
	// Re-lay-out at the final position so the subtree's boxes are correct
	// (the measure pass placed them at the origin).
	if (x !== cbContentX || y !== cbContentY) {
		box = layoutFixedRoot(el, x, y, useW, availH);
	}
	return box;
}

/** Detect "state-passing" text inputs that pages stash inside a
 * standalone `<form>` purely so the browser POSTs a hidden value with
 * the next nav. DDG html-mode has `<form><input type="text"
 * name="state_hidden" id="state_hidden"/></form>` — no submit, no
 * placeholder, no value, no other siblings — and real browsers hide
 * it via UA-stylesheet rules that we don't apply. Without filtering
 * here it renders as a blank text field above the real search bar.
 *
 * Conservative heuristic — only fires when EVERY signal matches:
 *   - `<input type="text">` (or no `type` attr, which defaults to text)
 *   - empty `value` AND no `placeholder` (nothing to display anyway)
 *   - parent is a `<form>` with this input as its sole element child
 *
 * The "sole element child" guard prevents false positives on real
 * search forms, which always have at least a submit button or another
 * field alongside the text input. */
function isLonelyStateInput(el: LiveElement): boolean {
	if (el.tagName !== 'INPUT') return false;
	const type = (el.getAttribute('type') ?? 'text').toLowerCase();
	if (type !== 'text') return false;
	if (el.getAttribute('value')) return false;
	if (el.getAttribute('placeholder')) return false;
	const parent = el.parentElement;
	if (!parent || parent.tagName !== 'FORM') return false;
	return parent.children.length === 1;
}

/**
 * Lay out every child of `parent` inside the content rect `(originX,
 * originY, contentW, contentH)`. Dispatches on parent's `display`:
 * `flex` → flex layout, else block stacking. Returns the consumed
 * height (used by the parent to grow if height is unset).
 */
function layoutChildren(
	parent: LiveElement,
	originX: number,
	originY: number,
	contentW: number,
	contentH: number,
): number {
	// <video> children (<source>, fallback text) are metadata, not laid-out
	// content. The painter renders a placeholder via paintBoxedElement
	// using the element's attribute-driven box dims. Skip the walk so the
	// fallback text doesn't paint over the placeholder.
	if (parent.tagName === 'VIDEO') return 0;
	const cs = getComputedLiveStyle(parent);
	// <details> without `open` attribute renders only its <summary> child
	// per HTML spec. Other children are layout-suppressed but remain in
	// the DOM tree so tapping summary can re-show them.
	const isClosedDetails = parent.tagName === 'DETAILS' && !parent.hasAttribute('open');
	const kids = parent.children.filter((c) => {
		const ccs = getComputedLiveStyle(c);
		if (ccs.display === 'none') return false;
		if (isClosedDetails && c.tagName !== 'SUMMARY') return false;
		// Phase 1 (2026-05-25): position:fixed children are taken out of
		// normal flow per CSS spec — they're painted separately by the
		// overlay's fixed-element pass and DON'T consume sibling space.
		// Without this filter, a `<div style="position:fixed">` inside
		// `<body>` would push subsequent body children down by its
		// intrinsic height, breaking the scroll math.
		// position:absolute is similarly out-of-flow; laid out in a
		// separate post-pass against its nearest positioned ancestor.
		const pos = ccs.position ?? c.style.position;
		if (pos === 'fixed' || pos === 'absolute') return false;
		if (isLonelyStateInput(c)) return false;
		return true;
	});
	const hasOwnText = parent.tagName !== '#text' && !!parent.textContent;

	if (kids.length === 0) {
		// No element children but possibly own text — flow it inline so
		// long text wraps at the content-box edge. Without this, p/div/
		// li/etc. with textContent would clip at the right edge.
		if (hasOwnText) {
			return layoutInline(parent, [], cs, originX, originY, contentW, contentH);
		}
		return 0;
	}

	if (cs.display === 'flex' || cs.display === 'inline-flex') {
		return layoutFlex(parent, kids, cs, originX, originY, contentW, contentH);
	}
	if (cs.display === 'grid') {
		// A grid box whose only children are text nodes is really a text
		// box (e.g. `<span class="num">01</span>` with `display:grid;
		// place-items:center`). Route it to the inline path so the text
		// centers via justify-items/align-items, instead of treating the
		// text node as a grid item placed at the cell's top-left. (Flex
		// text buttons are intentionally NOT rerouted — they center their
		// label via justify-content in layoutFlex.)
		if (kids.every((k) => k.tagName === '#text')) {
			return layoutInline(parent, kids, cs, originX, originY, contentW, contentH);
		}
		return layoutGrid(parent, kids, cs, originX, originY, contentW, contentH);
	}
	if (cs.display === 'table') {
		return layoutTable(parent, kids, cs, originX, originY, contentW);
	}
	// Phase 2.5 inline-formatting context (2026-05-25): when every kid is
	// inline (display: inline or text node), break into line boxes that
	// wrap at the right edge of the parent's content box. Mixed inline +
	// block content falls back to block stacking — block kids get their
	// own row; consecutive inline runs would need anonymous-block wrapping
	// (deferred). Most realistic markup is one or the other, so this is
	// the common path that matters.
	// `inline-block` participates in inline flow per CSS spec — siblings
	// sit on the same line, line-wraps when the row fills. DDG result
	// rows hit this: `<div class="result__extras__url">` is inline-block
	// and contains a sibling `<span>` (also inline-block, wraps the
	// favicon) + an `<a>` (inline) for the URL text. Treating inline-block
	// as "not inline" routed the parent to layoutBlock which STACKED the
	// favicon span ON TOP of the URL anchor (each took its own full-width
	// row), making the URL appear under the icon. Including inline-block
	// here lets layoutInline flow the span (whose `walkInline` recurses
	// into its IMG kid as a replaced-inline atom) on the same line as the
	// URL text — matches real browsers.
	let allInline = true;
	for (const c of kids) {
		const ccs = getComputedLiveStyle(c);
		const d = ccs.display;
		if (d !== 'inline' && d !== 'inline-block') { allInline = false; break; }
	}
	if (allInline) {
		return layoutInline(parent, kids, cs, originX, originY, contentW, contentH);
	}
	return layoutBlock(kids, originX, originY, contentW, contentH, cs);
}

/** Inline formatting context — flow text + inline elements into wrapped
 * line boxes. Each "atom" (a word, an image, a `<br>`) gets its own box
 * stored in the per-parent `inlineCache` for the painter + hit-test to
 * read. Lines stack vertically at `line-height`. Returns total height
 * consumed.
 *
 * Algorithm:
 *   1. Walk inline kids depth-first collecting atoms (word / image / br).
 *   2. Pack atoms left-to-right into the current line. If the next atom
 *      won't fit, flush the line and start a new one.
 *   3. `<br>` atoms force an immediate line break.
 *   4. Place each atom at its final body-local (x, y, w, h) inside the
 *      parent's `InlineLayout`.
 *
 * Limitations (Tier 3+):
 *   - No `white-space: pre-wrap` (whitespace collapses to single space).
 *   - No inline padding/margin/border (`inline-block` would need it).
 *   - No bidi / hyphenation / kerning / per-glyph baselining.
 *   - Mixed inline + block siblings fall back to block stacking
 *     (the caller filters that out).
 */
function layoutInline(
	parent: LiveElement,
	kids: LiveElement[],
	parentCs: ComputedLiveStyle,
	originX: number,
	originY: number,
	contentW: number,
	contentH?: number,
): number {
	const parentFontSize = parentCs.fontSize ?? 14;
	const parentFontFamily = parentCs.fontFamily || 'sans-serif';
	const lineHeight = (parentCs.lineHeight ?? parentFontSize * 1.2);
	const ctx = measureCtx;
	if (!ctx) return 0;

	interface WorkAtom {
		el: LiveElement;
		text: string;
		w: number;
		h: number;
		isBr: boolean;
		isWhitespace: boolean;
		font: string;
		fontSize: number;
	}
	const work: WorkAtom[] = [];

	function tokenizeText(el: LiveElement, raw: string, font: string, fontSize: number) {
		if (!raw) return;
		ctx!.save();
		ctx!.font = font;
		try {
			let i = 0;
			while (i < raw.length) {
				const c = raw.charCodeAt(i);
				if (c <= 32) {
					while (i < raw.length && raw.charCodeAt(i) <= 32) i++;
					work.push({
						el, text: ' ', w: ctx!.measureText(' ').width,
						h: fontSize * 1.2, isBr: false, isWhitespace: true, font, fontSize,
					});
				} else {
					const start = i;
					while (i < raw.length && raw.charCodeAt(i) > 32) i++;
					const word = raw.slice(start, i);
					work.push({
						el, text: word, w: ctx!.measureText(word).width,
						h: fontSize * 1.2, isBr: false, isWhitespace: false, font, fontSize,
					});
				}
			}
		} finally { ctx!.restore(); }
	}

	function walkInline(el: LiveElement, cs: ComputedLiveStyle) {
		if (el.tagName === 'BR') {
			work.push({
				el, text: '', w: 0, h: lineHeight,
				isBr: true, isWhitespace: false, font: '', fontSize: parentFontSize,
			});
			return;
		}
		const fontSize = cs.fontSize ?? parentFontSize;
		const fontFamily = cs.fontFamily || parentFontFamily;
		const font = fontSize + 'px ' + quoteFontFamily(fontFamily);
		if (el.tagName === '#text') {
			tokenizeText(el, el.data, font, fontSize);
			return;
		}
		// IMG: replaced-inline; one indivisible atom sized to its image.
		if (el.tagName === 'IMG') {
			const styleW = typeof cs.width === 'number' ? cs.width : undefined;
			const styleH = typeof cs.height === 'number' ? cs.height : undefined;
			const loaded = el.getLoadedImage();
			const nw = loaded?.naturalWidth ?? loaded?.width ?? 0;
			const nh = loaded?.naturalHeight ?? loaded?.height ?? 0;
			let w: number, h: number;
			if (styleW !== undefined && styleH !== undefined) { w = styleW; h = styleH; }
			else if (styleW !== undefined) { w = styleW; h = nh > 0 ? styleW * (nh / Math.max(1, nw)) : styleW; }
			else if (styleH !== undefined) { h = styleH; w = nw > 0 ? styleH * (nw / Math.max(1, nh)) : styleH; }
			else if (nw > 0 && nh > 0) { w = nw; h = nh; }
			else { w = 16; h = 16; }
			work.push({
				el, text: '', w, h,
				isBr: false, isWhitespace: false, font, fontSize,
			});
			return;
		}
		// CANVAS: replaced-inline; one indivisible atom sized to its
		// width/height attrs (or style.width/.height). Mirrors IMG so
		// `text-align: center` on the parent centers the canvas in its
		// line box. The bridge-FBO → screen copy in
		// `overlayLiveAnimatedCanvases` reads the layout box stored
		// below in the placement loop.
		if (el.tagName === 'CANVAS') {
			const ds = el.getDisplaySize();
			const styleW = typeof cs.width === 'number' ? cs.width : undefined;
			const styleH = typeof cs.height === 'number' ? cs.height : undefined;
			let w: number, h: number;
			if (styleW !== undefined && styleH !== undefined) { w = styleW; h = styleH; }
			else if (styleW !== undefined) { w = styleW; h = ds.w > 0 ? styleW * (ds.h / Math.max(1, ds.w)) : styleW; }
			else if (styleH !== undefined) { h = styleH; w = ds.h > 0 ? styleH * (ds.w / Math.max(1, ds.h)) : styleH; }
			else { w = ds.w > 0 ? ds.w : 300; h = ds.h > 0 ? ds.h : 150; }
			work.push({
				el, text: '', w, h,
				isBr: false, isWhitespace: false, font, fontSize,
			});
			return;
		}
		// Generic inline element: own textContent FIRST (model limitation —
		// we don't interleave text nodes with children unless the page
		// uses createTextNode), then walk inline children.
		if (el.textContent) tokenizeText(el, el.textContent, font, fontSize);
		for (const child of el.children) {
			const ccs = getComputedLiveStyle(child);
			if (ccs.display === 'none') continue;
			walkInline(child, ccs);
		}
	}

	// Parent's own textContent flows BEFORE its inline children (model
	// limitation: we don't support trailing text after the last child
	// unless the page uses createTextNode to express it).
	if (parent.textContent && parent.tagName !== '#text') {
		const font = parentFontSize + 'px ' + quoteFontFamily(parentFontFamily);
		tokenizeText(parent, parent.textContent, font, parentFontSize);
	}

	for (const k of kids) {
		const kcs = getComputedLiveStyle(k);
		if (kcs.display === 'none') continue;
		walkInline(k, kcs);
	}

	// Pack atoms into lines. When white-space:nowrap, suppress wrapping
	// — atoms keep accumulating on the current line even when the
	// projected width exceeds contentW. Caller's overflow:hidden + the
	// painter's clip then truncate visually (the CSS truncation idiom
	// `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`).
	// `<br>` still forces a new line in nowrap mode per CSS spec.
	const noWrap = parentCs.whiteSpace === 'nowrap';
	interface Line { items: WorkAtom[]; w: number; h: number; }
	const lines: Line[] = [];
	let current: Line = { items: [], w: 0, h: 0 };
	for (const a of work) {
		if (a.isBr) {
			if (current.h === 0) current.h = a.h;
			lines.push(current);
			current = { items: [], w: 0, h: 0 };
			continue;
		}
		if (a.isWhitespace && current.items.length === 0) continue;
		const projected = current.w + a.w;
		if (!noWrap && current.items.length > 0 && projected > contentW && !a.isWhitespace) {
			while (current.items.length > 0 && current.items[current.items.length - 1].isWhitespace) {
				const trimmed = current.items.pop()!;
				current.w -= trimmed.w;
			}
			lines.push(current);
			current = { items: [], w: 0, h: 0 };
			if (a.isWhitespace) continue;
		}
		current.items.push(a);
		current.w += a.w;
		if (a.h > current.h) current.h = a.h;
	}
	if (current.items.length > 0) lines.push(current);

	// Place atoms into final InlineLayout. y advances by line height per
	// line; x by atom width within each line. text-align (or grid
	// `justify-items`, which wins when set — the `place-items: center`
	// badge idiom) positions the line horizontally within contentW.
	let align: string = parentCs.textAlign ?? 'start';
	if (parentCs.justifyItems === 'center') align = 'center';
	else if (parentCs.justifyItems === 'end') align = 'right';
	else if (parentCs.justifyItems === 'start') align = 'left';
	const placed: InlineAtom[] = [];
	let y = originY;
	for (const line of lines) {
		const lh = Math.max(line.h, lineHeight);
		let lineX = originX;
		if (align === 'center') lineX = originX + (contentW - line.w) / 2;
		else if (align === 'right' || align === 'end') lineX = originX + contentW - line.w;
		let cursor = lineX;
		for (const item of line.items) {
			const atomY = y + (lh - item.h) / 2;
			placed.push({
				el: item.el,
				x: cursor,
				y: atomY,
				w: item.w,
				h: item.h,
				text: item.text,
				font: item.font,
				fontSize: item.fontSize,
				isBr: item.isBr,
			});
			// Replaced inline atoms (IMG / CANVAS) also need a per-element
			// layout box so `getLayoutBox(el)` works for hitTestLive and
			// for the shell's `overlayLiveAnimatedCanvases` walker — both
			// query the per-element cache, not the inline-atom layout.
			const tag = item.el.tagName;
			if (tag === 'IMG' || tag === 'CANVAS') {
				storeBox(item.el, {
					x: cursor, y: atomY, w: item.w, h: item.h,
					contentX: cursor, contentY: atomY,
					contentW: item.w, contentH: item.h,
					intrinsicContentH: item.h, intrinsicContentW: item.w,
				});
			}
			cursor += item.w;
		}
		y += lh;
	}
	const total = y - originY;
	// Vertical centering: `align-items: center` on a fixed-height text box
	// (the `place-items: center` badge idiom) centers the inline content
	// block within the box. Shift every placed atom down by half the slack.
	if (parentCs.alignItems === 'center' && contentH !== undefined && contentH > total) {
		const dy = (contentH - total) / 2;
		for (const atom of placed) atom.y += dy;
	}
	const layout: InlineLayout = { atoms: placed, height: total };
	inlineCache.set(parent, layout);
	inlineCacheTouched.add(parent);
	return total;
}

/** Block stacking: each child takes the full content width and its
 * own intrinsic / explicit height. Margins add space between them
 * (no real collapse). `contentH` is the parent's definite content
 * height (or 0 if indefinite) — used as the basis for percent-height
 * resolution on children. Lil-gui's `.fill { height: 100% }` inside
 * `.slider { height: 28px }` needs this to land at 28px not 0. */
function layoutBlock(
	kids: LiveElement[],
	originX: number,
	originY: number,
	contentW: number,
	contentH: number,
	parentCs?: ComputedLiveStyle,
): number {
	let y = originY;
	let prevMarginBottom = 0;
	// Pragmatic centering for replaced inline children (IMG / CANVAS)
	// that fall into block flow because they share a parent with block
	// siblings (e.g. `.stage { text-align:center; }` containing
	// `<canvas>` + `<button>` — allInline check fails so the run goes
	// here instead of layoutInline). Real browsers center these because
	// they're inline-replaced and the parent's text-align:center centers
	// the line they sit on; we don't do anonymous-block wrapping yet so
	// we honor the centering directly when the parent asks for it.
	const parentTextAlign = parentCs?.textAlign;
	const centerReplaced = parentTextAlign === 'center';
	const rightReplaced = parentTextAlign === 'right' || parentTextAlign === 'end';
	// Float row state. `float:left` kids pack onto the current row from
	// `floatRowLeftX` rightward; `float:right` packs from `floatRowRightX`
	// leftward. `floatRowH` tracks the tallest float on the row so the
	// next non-float (or row-overflowing float) clears past it. Flushing
	// resets the cursors + advances `y` by `floatRowH`. This is a
	// pragmatic subset of CSS float — no shape wrapping, no text flowing
	// around a float — but it's enough for DDG's `.frm__select` row of
	// `width:150px; float:left` widgets to sit side-by-side instead of
	// stacking full-width.
	let floatRowLeftX = originX;
	let floatRowRightX = originX + contentW;
	let floatRowH = 0;
	const flushFloatRow = () => {
		if (floatRowH > 0) {
			y += floatRowH;
			floatRowLeftX = originX;
			floatRowRightX = originX + contentW;
			floatRowH = 0;
		}
	};
	for (const child of kids) {
		const ccs = getComputedLiveStyle(child);
		const mTop = ccs.marginTop ?? 0;
		const mBottom = ccs.marginBottom ?? 0;
		const mLeft = ccs.marginLeft ?? 0;
		const mRight = ccs.marginRight ?? 0;
		const float = ccs.float;
		const isFloat = float === 'left' || float === 'right';
		// `display:inline-block` siblings flow on the same line per CSS
		// spec until the row fills. We piggy-back on the float-row
		// mechanism — treat `inline-block` as `float:left`-equivalent
		// for sizing+packing. Only kicks in when the child has an
		// explicit width AND the parent has multiple inline-block-ish
		// kids; without that there's no point packing one item on its
		// own row. The width gate also keeps full-width inline-block
		// blocks (no explicit width) on their own row as the stack flow
		// would have done. DDG's `.frm__select` (inline-block + width:
		// 145px, no float because the float:left rule is gated to
		// .lt-ie8) used to stack vertically before this — each select
		// occupied a full-width row in the form. Real browsers flow
		// them side-by-side because inline-block.
		const isInlineBlockPack = !isFloat && ccs.display === 'inline-block';
		if (isFloat || isInlineBlockPack) {
			const childExplicitWF = resolveLength(ccs.width, contentW);
			// Floats / inline-blocks with no explicit width fall back to
			// parent allocation, which would defeat side-by-side packing.
			// Keep the existing block-stacking path for those.
			if (childExplicitWF !== undefined) {
				const childWF = clampSize(
					childExplicitWF, ccs.minWidth, ccs.maxWidth, contentW,
				);
				const slotW = floatRowRightX - floatRowLeftX;
				const needed = childWF + mLeft + mRight;
				// If the box won't fit on the current row, flush + retry
				// on a fresh row.
				if (needed > slotW && floatRowH > 0) flushFloatRow();
				const cxF = (isFloat && float === 'right')
					? floatRowRightX - mRight - childWF
					: floatRowLeftX + mLeft;
				const childExplicitHF = resolveLength(ccs.height, contentH);
				const childHF = layoutLeaf(child, ccs, cxF, y + mTop, childWF, childExplicitHF);
				const consumedH = childHF + mTop + mBottom;
				if (consumedH > floatRowH) floatRowH = consumedH;
				if (isFloat && float === 'right') floatRowRightX -= childWF + mLeft + mRight;
				else floatRowLeftX += childWF + mLeft + mRight;
				prevMarginBottom = 0;
				continue;
			}
		}
		// Non-float (or width-less float falling through): any in-flight
		// float row must flush so this child sits below the floats.
		flushFloatRow();
		// Additive margins (no collapse). Skip leading margin for first
		// child if y == originY — matches lil-gui visual.
		y += Math.max(prevMarginBottom, mTop);
		const childExplicitW = resolveLength(ccs.width, contentW);
		let childW = clampSize(
			(childExplicitW ?? (contentW - mLeft - mRight)),
			ccs.minWidth, ccs.maxWidth, contentW,
		);
		// For replaced inline elements, predict their final intrinsic
		// width so we can position the box at center / right within the
		// parent. Matches the override layoutLeaf applies for these
		// tags when no explicit CSS width is set.
		const tag = child.tagName;
		// Form widgets (`<input>`, `<button>`, `<select>`, `<textarea>`)
		// are treated as replaced-inline-like here so that:
		//   (a) buttons size to their label + padding (not the parent's
		//       full content width) — predicted below.
		//   (b) text inputs with a `size` attr keep the width
		//       applyPresentationalHints derived (already on `cs.width`).
		//   (c) parents with `text-align:center` (e.g. tier3's `<body
		//       style="text-align:center">` propagated through to the
		//       form's divs) actually CENTER the widget, like every
		//       other browser does — the existing `centerReplaced`
		//       branch below uses this flag.
		// Without this tier3's `<input size="35">` sat flush-left of
		// its div while the submit (added to the set first) centered,
		// so the column visibly went left-aligned ↔ centred mid-form.
		const isButtonInput = tag === 'INPUT' && (() => {
			const t = (child.getAttribute('type') ?? 'text').toLowerCase();
			return t === 'submit' || t === 'button' || t === 'reset';
		})();
		const isReplacedInline = tag === 'CANVAS' || tag === 'IMG'
			|| tag === 'INPUT' || tag === 'BUTTON'
			|| tag === 'SELECT' || tag === 'TEXTAREA'
			|| tag === 'IFRAME';
		if (isReplacedInline && childExplicitW === undefined) {
			if (tag === 'CANVAS') {
				const ds = child.getDisplaySize();
				if (ds.w > 0) childW = ds.w;
			} else if (tag === 'IMG') {
				const loaded = child.getLoadedImage();
				const attrW = parseFloat(child.getAttribute('width') ?? '');
				const naturalW = loaded?.naturalWidth ?? loaded?.width ?? 0;
				if (Number.isFinite(attrW) && attrW > 0) childW = attrW;
				else if (naturalW > 0) childW = naturalW;
			} else if (tag === 'IFRAME') {
				// Iframe is replaced-inline per HTML spec — sized by
				// `width`/`height` attrs (or CSS, handled above). HTML
				// spec default is 300×150 when both are missing.
				const attrW = parseFloat(child.getAttribute('width') ?? '');
				childW = Number.isFinite(attrW) && attrW > 0 ? attrW : 300;
			} else if (tag === 'BUTTON' || isButtonInput) {
				// Width = measured label width + horizontal padding.
				// `value` attribute on INPUT, textContent on BUTTON.
				// `measureCtx` is the module-level layout-measure
				// context the shell installs each frame; bail out to
				// the parent allocation if it's somehow not set yet.
				if (measureCtx) {
					const label = tag === 'BUTTON'
						? (child.textContent || '')
						: (child.getAttribute('value') || '');
					const fontPx = typeof ccs.fontSize === 'number' ? ccs.fontSize : 14;
					const fontFamily = ccs.fontFamily || 'sans-serif';
					measureCtx.save();
					try {
						measureCtx.font = fontPx + 'px ' + quoteFontFamily(fontFamily);
						const labelW = label ? measureCtx.measureText(label).width : 0;
						// 12 px of horizontal padding each side; 32 px
						// floor so a value-less submit still has a
						// tappable target.
						childW = Math.max(32, Math.round(labelW + 24));
					} finally { measureCtx.restore(); }
				}
			}
			// Other replaced-inline form widgets (text INPUT without a
			// `size` attr, SELECT, TEXTAREA without `cols`) stay at the
			// parent allocation — no good intrinsic-width signal here.
		}
		// Resolve explicit child height against parent contentH so
		// percent-heights become a concrete hHint into layoutLeaf.
		const childExplicitH = resolveLength(ccs.height, contentH);
		let cx = originX + mLeft;
		if (isReplacedInline) {
			const slotW = contentW - mLeft - mRight;
			if (centerReplaced && childW < slotW) {
				cx = originX + mLeft + (slotW - childW) / 2;
			} else if (rightReplaced && childW < slotW) {
				cx = originX + mLeft + (slotW - childW);
			}
		}
		const childH = layoutLeaf(child, ccs, cx, y, childW, childExplicitH);
		y += childH;
		prevMarginBottom = mBottom;
	}
	// Flush any trailing float row so the parent's content height
	// includes the floats (otherwise floats past the last block sibling
	// would visually overflow the parent's box).
	flushFloatRow();
	return y - originY;
}

/** Flex layout (column or row). Computes main-axis size for each
 * child from `flex-basis` / `width|height` / intrinsic, then
 * distributes leftover main space per `flex-grow` (positive
 * leftover) or `flex-shrink` (negative leftover). Cross-axis
 * stretches by default, or aligns per `align-items`. */
function layoutFlex(
	parent: LiveElement,
	kids: LiveElement[],
	parentCs: ComputedLiveStyle,
	originX: number,
	originY: number,
	contentW: number,
	contentH: number,
): number {
	// CSS spec: default `flex-direction` is `row`. (Until 2026-05-25 this
	// defaulted to `column` — every internal demo set `flex-direction:`
	// explicitly so it went unnoticed, but lil-gui's `.controller {
	// display:flex }` and `.controller .widget { display:flex }` both
	// rely on the default and stacked name+value vertically with the
	// wrong default.)
	const direction = parentCs.flexDirection || 'row';
	const isRow = direction === 'row' || direction === 'row-reverse';
	const reverse = direction === 'row-reverse' || direction === 'column-reverse';
	const gap = parentCs.gap ?? 0;
	const align = parentCs.alignItems || 'stretch';
	const justify = parentCs.justifyContent || 'flex-start';
	// CSS percentage main/cross resolution: child's percent width
	// resolves against parent's content-box WIDTH, percent height
	// against parent's content-box HEIGHT — irrespective of flex
	// direction. So we thread BOTH dims to mainAxis/crossAxis.

	// Phase 1: per-child base size + grow + shrink.
	interface FlexItem {
		el: LiveElement;
		cs: ComputedLiveStyle;
		base: number;     // main-axis size before distribute
		grow: number;
		shrink: number;
		crossSize: number; // cross-axis size before stretch
		marginMainStart: number;
		marginMainEnd: number;
		marginCrossStart: number;
		marginCrossEnd: number;
	}
	const items: FlexItem[] = kids.map((el) => {
		const cs = getComputedLiveStyle(el);
		const m = mainAxis(cs, isRow, contentW, contentH);
		const c = crossAxis(cs, isRow, contentW, contentH);
		let basis: number;
		if (m.basis !== undefined) basis = m.basis;
		else if (m.explicit !== undefined) basis = m.explicit;
		else {
			// M2.6 fix: when a flex item has no explicit main-axis size
			// AND it has children of its own, compute the intrinsic
			// main-axis size by tentatively laying out the child at the
			// parent's cross-axis width. Without this, lil-gui's
			// `.children` container (no text, no explicit height, but
			// many controllers inside) gets base=0 and the whole panel
			// body collapses.
			if (el.children.length > 0) {
				if (isRow) {
					basis = intrinsicMain(el, cs, isRow);
				} else {
					// Column main-axis = height. Tentatively lay out at
					// parent's content width; the returned height includes
					// padding so it's the right "intrinsic" basis.
					basis = layoutLeaf(el, cs, 0, 0, contentW);
				}
			} else {
				basis = intrinsicMain(el, cs, isRow);
			}
		}
		// CSS spec: clamp the flex base size against min/max BEFORE
		// distribution. Without this, a child with `flex-shrink:0` +
		// `min-width:45%` (lil-gui's `.controller > .name`) gets its
		// intrinsic ~55px through phase 1, then the widget sibling
		// (width:100%) shrinks to fill the remainder — but the name's
		// 45% clamp in phase 3 then makes the row overflow. Pre-clamp
		// gives the distribution a chance to shrink the widget against
		// the (already-clamped, larger) name.
		const clampedBase = clampMain(cs, isRow, basis, contentW, contentH);
		return {
			el, cs,
			base: clampedBase,
			grow: cs.flexGrow ?? 0,
			shrink: cs.flexShrink ?? 1,
			crossSize: c.explicit ?? intrinsicCross(el, cs, isRow),
			marginMainStart: m.marginStart,
			marginMainEnd: m.marginEnd,
			marginCrossStart: c.marginStart,
			marginCrossEnd: c.marginEnd,
		};
	});

	// Phase 2: distribute leftover main-axis space.
	const mainAvail = isRow ? contentW : contentH;
	const totalGapMain = Math.max(0, items.length - 1) * gap;
	const totalMarginMain = items.reduce((acc, i) => acc + i.marginMainStart + i.marginMainEnd, 0);
	const totalBase = items.reduce((acc, i) => acc + i.base, 0);
	const leftover = mainAvail - totalBase - totalGapMain - totalMarginMain;
	if (leftover > 0) {
		const totalGrow = items.reduce((acc, i) => acc + i.grow, 0);
		if (totalGrow > 0) {
			for (const it of items) {
				it.base += leftover * (it.grow / totalGrow);
			}
		}
	} else if (leftover < 0 && mainAvail > 0) {
		// Only shrink when there's a REAL positive space constraint. When
		// `mainAvail <= 0` the container is being measured for its auto
		// (content) size — there's no space to shrink into, so shrinking
		// here collapses every item to 0 and the container reports ~0
		// height. That's what made the audio player's `.transport` /
		// `.right-controls` flex COLUMNS (laid out by the grid with no
		// height hint, i.e. contentH = 0) collapse — the buttons then
		// rendered full-size but anchored at a zero-height container's top,
		// so the whole controls row sat high. Treat mainAvail<=0 as
		// content-sizing (keep each item's base), which also removes the
		// need for per-page `flex-shrink: 0` floors on column children.
		const totalShrinkWeight = items.reduce((acc, i) => acc + i.shrink * i.base, 0);
		if (totalShrinkWeight > 0) {
			for (const it of items) {
				it.base += leftover * (it.shrink * it.base) / totalShrinkWeight;
				if (it.base < 0) it.base = 0;
			}
		}
	}

	// Phase 3: cross-axis sizing.
	let crossAvail = isRow ? contentH : contentW;
	for (const it of items) {
		if (align === 'stretch' && !crossExplicit(it.cs, isRow) && crossAvail > 0) {
			it.crossSize = crossAvail - it.marginCrossStart - it.marginCrossEnd;
		}
		// Clamp to min/max on each axis after distribution.
		it.base = clampMain(it.cs, isRow, it.base, contentW, contentH);
		it.crossSize = clampCross(it.cs, isRow, it.crossSize, contentW, contentH);
	}
	// M2.6 fix: when called from layoutLeaf's no-height-hint path
	// (block intrinsic compute), crossAvail starts as 0 → align-items
	// centering offsets by -size/2 (negative). Replace with the max
	// item cross size + margins so centering happens within the row's
	// actual vertical extent. Same value used as the height the row
	// reports back to its parent (block stacker).
	if (crossAvail === 0) {
		for (const it of items) {
			const c = it.crossSize + it.marginCrossStart + it.marginCrossEnd;
			if (c > crossAvail) crossAvail = c;
		}
	}

	// Phase 4: justify-content for main-axis placement.
	const consumedMain = items.reduce((acc, i) => acc + i.base + i.marginMainStart + i.marginMainEnd, 0) + totalGapMain;
	let mainStart = 0;
	let mainGapExtra = 0;
	const spare = mainAvail - consumedMain;
	if (spare > 0) {
		switch (justify) {
			case 'flex-end': mainStart = spare; break;
			case 'center': mainStart = spare / 2; break;
			case 'space-between':
				mainGapExtra = items.length > 1 ? spare / (items.length - 1) : 0;
				break;
			case 'space-around':
				mainGapExtra = items.length > 0 ? spare / items.length : 0;
				mainStart = mainGapExtra / 2;
				break;
		}
	}

	// Phase 5: place + lay out children's own subtrees.
	let mainPos = (isRow ? originX : originY) + mainStart;
	const orderedItems = reverse ? [...items].reverse() : items;
	for (const it of orderedItems) {
		mainPos += it.marginMainStart;
		const crossPos = computeCrossOrigin(
			isRow ? originY : originX,
			crossAvail,
			it.crossSize,
			it.marginCrossStart,
			it.marginCrossEnd,
			align,
		);
		let cx: number, cy: number, cw: number, ch: number;
		if (isRow) {
			cx = mainPos; cy = crossPos; cw = it.base; ch = it.crossSize;
		} else {
			cx = crossPos; cy = mainPos; cw = it.crossSize; ch = it.base;
		}
		layoutLeaf(it.el, it.cs, cx, cy, cw, ch);
		mainPos += it.base + it.marginMainEnd + gap + mainGapExtra;
	}
	// Report the consumed VERTICAL extent (what `layoutBlock` needs to
	// stack the next sibling below). For column direction it's the
	// running main-axis position. For row direction it's the
	// cross-axis (height) — equal to `crossAvail` after the M2.6 fix
	// above expanded it to the tallest item.
	return isRow ? crossAvail : mainPos - originY;
}

function computeCrossOrigin(
	crossOrigin: number,
	crossAvail: number,
	crossSize: number,
	mStart: number,
	mEnd: number,
	align: string,
): number {
	const free = crossAvail - crossSize - mStart - mEnd;
	switch (align) {
		case 'flex-end': return crossOrigin + mStart + free;
		case 'center': return crossOrigin + mStart + free / 2;
		default: return crossOrigin + mStart; // flex-start, stretch
	}
}

/** CSS Grid layout — row-major placement into a column track list.
 * Supports `grid-template-columns: repeat(auto-fit, minmax(<min>, 1fr))`
 * (the home.html pattern, formerly welcome.html), `repeat(<N>, <track>)`, and explicit
 * space-separated tracks. Each row's height stretches to the tallest
 * child so backgrounds extend uniformly. Returns total height. */
function layoutGrid(
	parent: LiveElement,
	kids: LiveElement[],
	parentCs: ComputedLiveStyle,
	originX: number,
	originY: number,
	contentW: number,
	contentH: number,
): number {
	const gap = parentCs.gap ?? 0;
	// Explicit 2D grid: when `grid-template-rows` is set, resolve BOTH
	// axes to fixed track sizes and place each child by its
	// `grid-column` / `grid-row` lines (auto-flowing any unplaced child).
	// This is what full-viewport app layouts need (e.g. a visualizer /
	// controls / library three-panel grid). Without grid-template-rows
	// we keep the simpler column-only row-major auto-flow below, whose
	// rows are sized to the tallest child (welcome / apps cards).
	if (parentCs.gridTemplateRows) {
		return layoutGridExplicit(parent, kids, parentCs, originX, originY, contentW, contentH, gap);
	}
	const tracks = resolveGridTracks(parentCs.gridTemplateColumns, contentW, gap, kids.length);
	const colCount = tracks.length;
	if (colCount === 0) {
		return layoutBlock(kids, originX, originY, contentW, contentH, parentCs);
	}
	// Precompute each column's X origin within the content box.
	const colX: number[] = new Array(colCount);
	{
		let xCursor = originX;
		for (let i = 0; i < colCount; i++) {
			colX[i] = xCursor;
			xCursor += tracks[i] + gap;
		}
	}
	// Run the row-major flow from a given top, returning the consumed
	// height. Extracted so it can be re-run shifted for vertical centering
	// (below) without duplicating the placement logic.
	const runFlow = (startY: number): number => {
		let y = startY;
		let row: LiveElement[] = [];
		let rowHeight = 0;
		const flushRow = () => {
			if (row.length === 0) return;
			// Equalise heights: extend each child's LayoutBox to rowHeight so
			// backgrounds (including gradients) fill the visual row uniformly,
			// even when one card has shorter text than its siblings.
			for (const el of row) {
				const box = cache.get(el);
				if (box && box.h < rowHeight) {
					const dh = rowHeight - box.h;
					box.h = rowHeight;
					box.contentH += dh;
				}
			}
			y += rowHeight + gap;
			row = [];
			rowHeight = 0;
		};
		// Column-cursor walk so children with `grid-column: span N` claim N
		// adjacent tracks (sensors dashboard, anything using a 12-col grid +
		// per-card span). Cards without an explicit `grid-column` parse as
		// null → span=1, identical to the pre-span 1-track-per-child behavior
		// (welcome / apps cards untouched). The explicit 2D path
		// (`layoutGridExplicit`, gated on grid-template-rows) is still where
		// arbitrary `grid-row` + cell start lines go; this remains row-major
		// auto-flow.
		let colCursor = 0;
		for (let i = 0; i < kids.length; i++) {
			const child = kids[i];
			const ccs = getComputedLiveStyle(child);
			const line = parseGridLine(ccs.gridColumn, colCount);
			const span = line ? Math.min(Math.max(1, line.span), colCount) : 1;
			// Wrap to the next row when this span would overflow the current
			// one. Don't flush an already-empty row (would inject a phantom
			// trailing gap and shift the first row down by `gap`).
			if (colCursor > 0 && colCursor + span > colCount) {
				flushRow();
				colCursor = 0;
			}
			// Width = sum of the `span` track widths + the (span-1) interior
			// gaps that the spanned cell visually covers.
			let slotW = 0;
			for (let s = 0; s < span; s++) slotW += tracks[colCursor + s];
			slotW += (span - 1) * gap;
			const x = colX[colCursor];
			const h = layoutLeaf(child, ccs, x, y, slotW);
			row.push(child);
			if (h > rowHeight) rowHeight = h;
			colCursor += span;
			if (colCursor >= colCount) {
				flushRow();
				colCursor = 0;
			}
		}
		if (row.length > 0) {
			// Partial last row — no trailing gap added.
			for (const el of row) {
				const box = cache.get(el);
				if (box && box.h < rowHeight) {
					const dh = rowHeight - box.h;
					box.h = rowHeight;
					box.contentH += dh;
				}
			}
			y += rowHeight;
		} else if (kids.length > 0) {
			// Last action was a flushRow which appended a trailing gap; undo it.
			y -= gap;
		}
		return y - startY;
	};
	const consumed = runFlow(originY);
	// Vertical centering: a FIXED-height grid container (contentH known)
	// with `align-items: center` should center its content block — in CSS
	// the implicit single row stretches to the container (default
	// align-content) and `align-items: center` centers items within it.
	// The plain top-aligned flow left the controls bar sitting high with a
	// big empty band below; re-run shifted by half the slack to center it.
	// Only fires for fixed-height containers (auto-height grids pass
	// contentH = 0, so this never touches the welcome/apps card grids).
	if (parentCs.alignItems === 'center' && contentH > consumed + 0.5) {
		runFlow(originY + (contentH - consumed) / 2);
	}
	return consumed;
}

/** Explicit 2D CSS Grid: resolve fixed column + row track sizes, then
 * place each child into its grid area. A child with both `grid-column`
 * and `grid-row` lines is placed (and may span tracks, e.g.
 * `grid-row: 1 / 3`); children without explicit placement auto-flow into
 * the first free cells (row-major). Each placed child is laid out at its
 * area's exact width AND height (passed as the leaf height hint) so the
 * panels fill the viewport grid instead of collapsing to content height.
 * Returns the grid's total content height. */
function layoutGridExplicit(
	parent: LiveElement,
	kids: LiveElement[],
	parentCs: ComputedLiveStyle,
	originX: number,
	originY: number,
	contentW: number,
	contentH: number,
	gap: number,
): number {
	const cols = resolveGridTracks(parentCs.gridTemplateColumns, contentW, gap, kids.length);
	const rows = resolveGridTracks(parentCs.gridTemplateRows, contentH, gap, kids.length);
	const colCount = cols.length;
	const rowCount = rows.length;
	if (colCount === 0 || rowCount === 0) {
		return layoutBlock(kids, originX, originY, contentW, contentH, parentCs);
	}
	const colX: number[] = new Array(colCount);
	{ let c = originX; for (let i = 0; i < colCount; i++) { colX[i] = c; c += cols[i] + gap; } }
	const rowY: number[] = new Array(rowCount);
	{ let r = originY; for (let i = 0; i < rowCount; i++) { rowY[i] = r; r += rows[i] + gap; } }

	const occupied: boolean[][] = Array.from({ length: rowCount }, () => new Array(colCount).fill(false));
	const mark = (r0: number, rs: number, c0: number, cs: number) => {
		for (let r = r0; r < r0 + rs && r < rowCount; r++) {
			for (let c = c0; c < c0 + cs && c < colCount; c++) occupied[r][c] = true;
		}
	};
	// Pixel extent of `span` tracks starting at `start`, including the
	// inter-track gaps that the span swallows.
	const spanExtent = (tracks: number[], start: number, span: number): number => {
		const usable = Math.min(span, tracks.length - start);
		let sum = 0;
		for (let i = start; i < start + usable; i++) sum += tracks[i];
		if (usable > 1) sum += (usable - 1) * gap;
		return sum;
	};

	interface Placed { el: LiveElement; ccs: ComputedLiveStyle; r0: number; rs: number; c0: number; cs: number }
	const placed: Placed[] = [];
	const autoKids: { el: LiveElement; ccs: ComputedLiveStyle }[] = [];
	for (const child of kids) {
		const ccs = getComputedLiveStyle(child);
		const col = parseGridLine(ccs.gridColumn, colCount);
		const row = parseGridLine(ccs.gridRow, rowCount);
		if (col && row) {
			const c0 = clampIdx(col.start, colCount);
			const r0 = clampIdx(row.start, rowCount);
			const cs = Math.max(1, Math.min(col.span, colCount - c0));
			const rs = Math.max(1, Math.min(row.span, rowCount - r0));
			mark(r0, rs, c0, cs);
			placed.push({ el: child, ccs, r0, rs, c0, cs });
		} else {
			autoKids.push({ el: child, ccs });
		}
	}
	const cellCount = rowCount * colCount;
	let scan = 0;
	for (const a of autoKids) {
		while (scan < cellCount && occupied[Math.floor(scan / colCount)][scan % colCount]) scan++;
		const r0 = scan < cellCount ? Math.floor(scan / colCount) : 0;
		const c0 = scan < cellCount ? scan % colCount : 0;
		if (scan < cellCount) occupied[r0][c0] = true;
		placed.push({ el: a.el, ccs: a.ccs, r0, rs: 1, c0, cs: 1 });
		scan++;
	}
	for (const p of placed) {
		const w = spanExtent(cols, p.c0, p.cs);
		const h = spanExtent(rows, p.r0, p.rs);
		layoutLeaf(p.el, p.ccs, colX[p.c0], rowY[p.r0], w, h);
	}
	let total = 0;
	for (const r of rows) total += r;
	return total + Math.max(0, rowCount - 1) * gap;
}

/** Parse a `grid-column` / `grid-row` value into a 0-based start track
 * index + span count. Supports `<n>`, `<start> / <end>`,
 * `<start> / span <n>`, and `span <n>`. 1-based grid lines convert to
 * 0-based track indices (`1 / 3` → start 0, span 2). Returns null for
 * `auto` / unparseable values so the caller auto-flows the child. */
function parseGridLine(value: string | undefined, _trackCount: number): { start: number; span: number } | null {
	if (!value) return null;
	const v = value.trim().toLowerCase();
	if (!v || v === 'auto') return null;
	const parts = v.split('/').map((s) => s.trim());
	const startTok = parts[0];
	const endTok = parts[1];
	const spanOnly = /^span\s+(\d+)$/.exec(startTok);
	if (spanOnly) return { start: 0, span: Math.max(1, parseInt(spanOnly[1], 10)) };
	const startLine = parseInt(startTok, 10);
	if (!Number.isFinite(startLine)) return null;
	let span = 1;
	if (endTok) {
		const spanEnd = /^span\s+(\d+)$/.exec(endTok);
		if (spanEnd) span = Math.max(1, parseInt(spanEnd[1], 10));
		else {
			const endLine = parseInt(endTok, 10);
			if (Number.isFinite(endLine)) span = Math.max(1, endLine - startLine);
		}
	}
	return { start: Math.max(0, startLine - 1), span };
}

function clampIdx(i: number, n: number): number {
	if (i < 0) return 0;
	if (i > n - 1) return Math.max(0, n - 1);
	return i;
}

/** Resolve a `grid-template-columns` value into concrete pixel widths.
 * Falls back to a single-column track-list = [contentW] when the value
 * is missing or unparseable, so the grid still lays out as a single
 * column instead of collapsing. `itemCount` is consulted for the
 * `auto-fit` collapse rule: empty tracks (no item ever occupies them)
 * are dropped and their share of the row is redistributed to the
 * remaining `1fr` tracks. */
function resolveGridTracks(value: string | undefined, contentW: number, gap: number, itemCount: number): number[] {
	if (!value) return [contentW];
	const v = value.trim();
	// repeat(auto-fit | auto-fill, minmax(<min>, 1fr)) — compute the
	// fitting column count from the container width + min track size,
	// then (for auto-fit only) shrink the count to the number of items
	// that will actually occupy a track in any row. A column collapses
	// only when EVERY row leaves it empty; with row-major placement
	// that's equivalent to `floor((itemCount - 1) / floor(maxCols))`-style
	// reasoning, but the simpler equivalent here is
	// `min(maxCols, itemCount)` — see CSS Grid spec § 7.2.2.1.
	const autoFit = /^repeat\(\s*(auto-fit|auto-fill)\s*,\s*minmax\(\s*([0-9.]+)px\s*,\s*1fr\s*\)\s*\)$/i.exec(v);
	if (autoFit) {
		const isAutoFit = autoFit[1].toLowerCase() === 'auto-fit';
		const min = parseFloat(autoFit[2]);
		if (!Number.isFinite(min) || min <= 0) return [contentW];
		// cols × min + (cols - 1) × gap <= contentW  →  cols <= (contentW + gap) / (min + gap)
		let cols = Math.floor((contentW + gap) / (min + gap));
		if (cols < 1) cols = 1;
		if (isAutoFit && itemCount > 0 && itemCount < cols) cols = itemCount;
		const colW = (contentW - (cols - 1) * gap) / cols;
		return new Array(cols).fill(colW);
	}
	// repeat(<N>, <track>) where <track> is a fixed length or `1fr`.
	const fixedRepeat = /^repeat\(\s*(\d+)\s*,\s*(.+?)\s*\)$/i.exec(v);
	if (fixedRepeat) {
		const n = parseInt(fixedRepeat[1], 10);
		if (!Number.isFinite(n) || n <= 0) return [contentW];
		const trackStr = fixedRepeat[2].trim();
		return distributeTrackList(new Array(n).fill(trackStr), contentW, gap);
	}
	// Explicit track list (space-separated). Tokens may be `<len>` / `%`
	// / `<n>fr` / `auto` / `minmax(a, b)`. Split on top-level whitespace
	// so a `minmax(...)`'s internal space doesn't shatter the token.
	const tokens = splitTopLevelSpaces(v);
	if (tokens.length === 0) return [contentW];
	return distributeTrackList(tokens, contentW, gap);
}

/** Split a track list on top-level whitespace, keeping parenthesised
 * groups intact so `minmax(0, 1fr) minmax(280px, 360px)` splits into two
 * tokens (not four). The old `split(/\s+/)` broke every `minmax(a, b)`
 * apart at its internal space. */
function splitTopLevelSpaces(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		else if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
			if (i > start) out.push(s.slice(start, i));
			start = i + 1;
		}
	}
	if (s.length > start) out.push(s.slice(start));
	return out.filter((t) => t.length > 0);
}

interface GridTrackDesc { kind: 'fixed' | 'fr'; v: number; min: number }

/** Parse one length-ish grid track token (no fr / minmax) to px. `basis`
 * is the track-resolution extent used for `%`. */
function parseGridTrackLen(s: string, basis: number): number | undefined {
	const t = s.trim();
	const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(t);
	if (pct) return parseFloat(pct[1]) * 0.01 * basis;
	const px = /^(-?\d+(?:\.\d+)?)px$/.exec(t);
	if (px) return parseFloat(px[1]);
	if (/^-?\d/.test(t)) {
		const n = parseFloat(t);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

/** Parse a grid track token into a descriptor. `basis` (container content
 * size minus gaps) resolves `%`. Handles `<len>` / `%` / `<n>fr` / `auto`
 * / `minmax(<min>, <max>)` — `minmax(px, Nfr)` is a flexible track with a
 * px floor; `minmax(px, px)` is fixed, preferring its max. Returns null
 * for unparseable tokens (caller falls back to `1fr`). */
function parseGridTrackToken(tok: string, basis: number): GridTrackDesc | null {
	const t = tok.trim();
	const mm = /^minmax\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/i.exec(t);
	if (mm) {
		const min = parseGridTrackLen(mm[1], basis) ?? 0;
		const maxTok = mm[2].trim();
		const fr = /^(\d+(?:\.\d+)?)fr$/i.exec(maxTok);
		if (fr) return { kind: 'fr', v: parseFloat(fr[1]), min };
		const maxPx = parseGridTrackLen(maxTok, basis);
		return { kind: 'fixed', v: Math.max(min, maxPx ?? min), min };
	}
	const fr = /^(\d+(?:\.\d+)?)fr$/i.exec(t);
	if (fr) return { kind: 'fr', v: parseFloat(fr[1]), min: 0 };
	const low = t.toLowerCase();
	if (low === 'auto' || low === 'min-content' || low === 'max-content') {
		return { kind: 'fr', v: 1, min: 0 };
	}
	const px = parseGridTrackLen(t, basis);
	if (px !== undefined) return { kind: 'fixed', v: px, min: px };
	return null;
}

/** Resolve a mixed track list (px / % / Nfr / auto / minmax) to pixel
 * sizes against `contentExtent` (the container content width for columns
 * or content height for rows). Fixed tracks take their declared size;
 * remaining space is split among fr tracks by weight, each floored at its
 * `minmax` minimum. `%` tracks resolve against the post-gap available
 * extent so a `70% 30%` pair fills the container exactly with the gap
 * sitting between them. */
function distributeTrackList(tokens: string[], contentExtent: number, gap: number): number[] {
	const totalGap = Math.max(0, tokens.length - 1) * gap;
	const avail = Math.max(0, contentExtent - totalGap);
	const descs: GridTrackDesc[] = tokens.map(
		(t) => parseGridTrackToken(t, avail) ?? { kind: 'fr', v: 1, min: 0 },
	);
	let frTotal = 0;
	let fixedTotal = 0;
	for (const d of descs) {
		if (d.kind === 'fixed') fixedTotal += d.v;
		else frTotal += d.v;
	}
	const frSpace = Math.max(0, avail - fixedTotal);
	return descs.map((d) =>
		d.kind === 'fixed' ? d.v : Math.max(d.min, frTotal > 0 ? frSpace * (d.v / frTotal) : 0),
	);
}

/** Auto-layout `<table>` rendering on the live-DOM stack. Two-pass:
 * measure each cell's min-content + max-content widths, distribute the
 * table's available width across columns, then lay out each cell's
 * content within its column width. Stores a LayoutBox per cell + per
 * row so paintSubtreeLaid (which walks `cache`) renders bg/border per
 * element.
 *
 * Scope:
 *   - `<thead>` / `<tbody>` / `<tfoot>` are transparent.
 *   - `<caption>` (if first non-section child) renders as a centered
 *     block above the table.
 *   - No rowspan / colspan / border-collapse / nested table promotion.
 */
const TABLE_CELL_PAD_X = 8;
const TABLE_CELL_PAD_Y = 4;

function layoutTable(
	table: LiveElement,
	kids: LiveElement[],
	tableCs: ComputedLiveStyle,
	originX: number,
	originY: number,
	contentW: number,
): number {
	const rows: LiveElement[][] = [];
	let caption: LiveElement | null = null;
	const walkSection = (root: LiveElement) => {
		for (const child of root.children) {
			const tag = child.tagName;
			if (tag === 'CAPTION') { if (!caption) caption = child; continue; }
			if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
				walkSection(child);
				continue;
			}
			if (tag === 'TR') {
				const cells: LiveElement[] = [];
				for (const tc of child.children) {
					if (tc.tagName === 'TD' || tc.tagName === 'TH') cells.push(tc);
				}
				rows.push(cells);
			}
		}
	};
	for (const k of kids) {
		const tag = k.tagName;
		if (tag === 'CAPTION') { if (!caption) caption = k; continue; }
		if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
			walkSection(k);
			continue;
		}
		if (tag === 'TR') {
			const cells: LiveElement[] = [];
			for (const tc of k.children) {
				if (tc.tagName === 'TD' || tc.tagName === 'TH') cells.push(tc);
			}
			rows.push(cells);
		}
	}
	if (rows.length === 0) return 0;
	const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
	if (colCount === 0) return 0;

	let y = originY;

	// Optional caption block — laid out as inline content centered above.
	if (caption) {
		const capCs = getComputedLiveStyle(caption);
		const capH = layoutInline(caption, [], capCs, originX, y, contentW);
		storeBox(caption, {
			x: originX, y, w: contentW, h: capH,
			contentX: originX, contentY: y, contentW, contentH: capH,
			intrinsicContentH: capH, intrinsicContentW: contentW,
		});
		y += capH + 4;
	}

	// Measure min/max widths per column.
	const colMin = new Array<number>(colCount).fill(0);
	const colMax = new Array<number>(colCount).fill(0);
	for (const row of rows) {
		for (let c = 0; c < row.length; c++) {
			const m = measureCellWidthsLive(row[c]);
			colMin[c] = Math.max(colMin[c], m.min + TABLE_CELL_PAD_X * 2);
			colMax[c] = Math.max(colMax[c], m.max + TABLE_CELL_PAD_X * 2);
		}
	}
	const colWidths = distributeColumnWidths(colMin, colMax, contentW);

	const tableTopY = y;
	for (const row of rows) {
		const rowStartY = y;
		let rowMaxEnd = rowStartY;
		let colX = originX;
		// Pass 1: lay out cell contents and find row height.
		const cellEndYs: number[] = [];
		const cellXs: number[] = [];
		const cellWs: number[] = [];
		for (let c = 0; c < colCount; c++) {
			const cellW = colWidths[c];
			cellXs.push(colX);
			cellWs.push(cellW);
			if (c < row.length) {
				const cell = row[c];
				const cellCs = getComputedLiveStyle(cell);
				const contentX = colX + TABLE_CELL_PAD_X;
				const contentYTop = rowStartY + TABLE_CELL_PAD_Y;
				const cellContentW = cellW - TABLE_CELL_PAD_X * 2;
				// Inline-flow within the cell. Cells are typically inline;
				// nested blocks fall back via layoutChildren if present.
				const innerH = layoutCellContent(
					cell, cellCs, contentX, contentYTop, cellContentW,
				);
				const endY = contentYTop + innerH + TABLE_CELL_PAD_Y;
				cellEndYs.push(endY);
				if (endY > rowMaxEnd) rowMaxEnd = endY;
			} else {
				cellEndYs.push(rowStartY);
			}
			colX += cellW;
		}
		// Pass 2: store the per-cell LayoutBox at the equalised row height
		// so backgrounds + borders paint over the full cell, not the
		// content-tight subrect.
		const rowH = rowMaxEnd - rowStartY;
		for (let c = 0; c < colCount; c++) {
			if (c >= row.length) continue;
			const cell = row[c];
			storeBox(cell, {
				x: cellXs[c],
				y: rowStartY,
				w: cellWs[c],
				h: rowH,
				contentX: cellXs[c] + TABLE_CELL_PAD_X,
				contentY: rowStartY + TABLE_CELL_PAD_Y,
				contentW: cellWs[c] - TABLE_CELL_PAD_X * 2,
				contentH: rowH - TABLE_CELL_PAD_Y * 2,
				intrinsicContentH: cellEndYs[c] - (rowStartY + TABLE_CELL_PAD_Y),
				intrinsicContentW: cellWs[c] - TABLE_CELL_PAD_X * 2,
			});
		}
		y = rowMaxEnd;
	}

	// Store box for the table itself so paintSubtreeLaid renders its
	// border/background when set via CSS.
	storeBox(table, {
		x: originX, y: tableTopY, w: contentW, h: y - tableTopY,
		contentX: originX, contentY: tableTopY, contentW, contentH: y - tableTopY,
		intrinsicContentH: y - tableTopY, intrinsicContentW: contentW,
	});

	return y - originY;
}

/** Inline-only cell content layout. Returns intrinsic height. */
function layoutCellContent(
	cell: LiveElement,
	cellCs: ComputedLiveStyle,
	originX: number,
	originY: number,
	contentW: number,
): number {
	// Cells most often contain inline text + inline tags. Pass the cell's
	// actual children so layoutInline's kids loop walks `#text` nodes via
	// `walkInline` (which tokenizes `el.data`) — `cell.textContent` only
	// returns the cell's OWN `_text` (set via `cell.textContent = 'X'`),
	// not the concatenation of `#text` children. For parser-built cells
	// like `<th>Name</th>`, the text lives in a `#text` child, so passing
	// `[]` would produce zero atoms and the cell would render blank.
	return layoutInline(cell, cell.children, cellCs, originX, originY, contentW);
}

/** Measure cell intrinsic widths (min = widest word, max = no-wrap). */
function measureCellWidthsLive(cell: LiveElement): { min: number; max: number } {
	const ctx = measureCtx;
	if (!ctx) return { min: 0, max: 0 };
	const cellCs = getComputedLiveStyle(cell);
	const fontSize = cellCs.fontSize ?? 14;
	const fontFamily = cellCs.fontFamily || 'sans-serif';
	let max = 0;
	let min = 0;
	const visit = (el: LiveElement, parentFont: string) => {
		const cs = getComputedLiveStyle(el);
		const fs = cs.fontSize ?? fontSize;
		const ff = cs.fontFamily || fontFamily;
		const font = fs + 'px ' + ff;
		if (el.tagName === '#text') {
			ctx.font = font;
			const raw = el.data;
			const tokens = raw.split(/\s+/);
			for (const t of tokens) {
				if (!t) continue;
				const w = ctx.measureText(t).width;
				max += w + ctx.measureText(' ').width;
				if (w > min) min = w;
			}
			return;
		}
		if (el.textContent && el.tagName !== '#text') {
			ctx.font = font;
			const raw = el.textContent;
			const tokens = raw.split(/\s+/);
			for (const t of tokens) {
				if (!t) continue;
				const w = ctx.measureText(t).width;
				max += w + ctx.measureText(' ').width;
				if (w > min) min = w;
			}
		}
		for (const child of el.children) visit(child, font);
	};
	for (const child of cell.children) {
		visit(child, fontSize + 'px ' + quoteFontFamily(fontFamily));
	}
	if (cell.textContent && cell.children.length === 0) {
		ctx.font = fontSize + 'px ' + quoteFontFamily(fontFamily);
		const tokens = cell.textContent.split(/\s+/);
		for (const t of tokens) {
			if (!t) continue;
			const w = ctx.measureText(t).width;
			max += w + ctx.measureText(' ').width;
			if (w > min) min = w;
		}
	}
	return { min, max };
}

/** CSS 2.1 auto-table column-width algorithm (simplified). */
function distributeColumnWidths(
	colMin: number[],
	colMax: number[],
	available: number,
): number[] {
	const n = colMin.length;
	const totalMin = colMin.reduce((a, b) => a + b, 0);
	const totalMax = colMax.reduce((a, b) => a + b, 0);
	const out = new Array<number>(n);
	if (totalMax <= available) {
		const leftover = available - totalMax;
		for (let i = 0; i < n; i++) {
			const share = totalMax > 0 ? (colMax[i] / totalMax) * leftover : leftover / n;
			out[i] = colMax[i] + share;
		}
	} else if (totalMin <= available) {
		const slack = available - totalMin;
		const totalRange = colMax.reduce((a, b, i) => a + (b - colMin[i]), 0);
		for (let i = 0; i < n; i++) {
			const range = colMax[i] - colMin[i];
			const share = totalRange > 0 ? (range / totalRange) * slack : slack / n;
			out[i] = colMin[i] + share;
		}
	} else {
		for (let i = 0; i < n; i++) out[i] = colMin[i];
	}
	let acc = 0;
	for (let i = 0; i < n - 1; i++) {
		const w = Math.round(out[i]);
		out[i] = w;
		acc += w;
	}
	out[n - 1] = Math.max(colMin[n - 1], Math.round(available - acc));
	return out;
}

/** Lay out a single element at the given main-axis x/y with chosen w/h
 * (chosen by parent). Recurses into children. Returns the actual
 * height used (after intrinsic content adjustments). */
function layoutLeaf(
	el: LiveElement,
	cs: ComputedLiveStyle,
	x: number,
	y: number,
	w: number,
	hHint?: number,
): number {
	try {
	const pad = padding(cs);
	// Height percentages resolve against the parent's content-box height.
	// We don't have a direct parent-height handle here, so fall back to
	// `hHint` (which IS the parent's chosen height for this element).
	// When hHint is also undefined we treat percent height as auto.
	const heightBasis = hHint ?? 0;
	let explicitH = resolveLength(cs.height, heightBasis)
		?? resolveLength(el.style.height, heightBasis);
	// Void-element default heights — these have no children + no text but
	// must occupy vertical space. <br> is one font-line; <hr> + meter +
	// progress get sensible widget heights so they render even when the
	// page doesn't size them via CSS.
	const tag = el.tagName;
	let intrinsicVoidH = tag === 'BR' ? (cs.lineHeight ?? (cs.fontSize ?? 14) * 1.2)
		: tag === 'HR' ? 16
		: (tag === 'METER' || tag === 'PROGRESS') ? 16
		: 0;
	// IMG is replaced-inline per HTML spec. When it lands in a block
	// context (e.g. as a direct child of `<body>` in a non-inline-only
	// flow), layoutBlock allocates it the parent's full content width
	// and we get horizontally-stretched images. Override `w` (and set
	// intrinsicVoidH for the height) from the IMG's attribute / natural
	// dimensions — unless an explicit CSS width/height was set, in
	// which case it wins.
	if (tag === 'IMG') {
		const loaded = el.getLoadedImage();
		const naturalW = loaded?.naturalWidth ?? loaded?.width ?? 0;
		const naturalH = loaded?.naturalHeight ?? loaded?.height ?? 0;
		const attrW = parseFloat(el.getAttribute('width') ?? '');
		const attrH = parseFloat(el.getAttribute('height') ?? '');
		const explicitW = resolveLength(cs.width, w) ?? resolveLength(el.style.width, w);
		// Pick the height for intrinsicVoidH:
		//   1. attr `height` (if a positive number)
		//   2. natural height from the loaded Image
		//   3. fallback 24
		if (Number.isFinite(attrH) && attrH > 0) intrinsicVoidH = attrH;
		else if (naturalH > 0) intrinsicVoidH = naturalH;
		else intrinsicVoidH = 24;
		// Override the parent-allocated width with attr/natural width
		// when no CSS-explicit width was set. Without this, layoutBlock
		// stretches a 16×16 snowflake to 1280×16.
		if (explicitW === undefined) {
			if (explicitH !== undefined && naturalW > 0 && naturalH > 0) {
				// `width: auto` + explicit height → preserve the image's
				// aspect ratio (width = naturalAspect × height). Lets a
				// wide wordmark logo render at the right width instead of
				// being squished into a fixed square box.
				w = Math.round((naturalW / naturalH) * explicitH);
			} else if (Number.isFinite(attrW) && attrW > 0) {
				w = attrW;
			} else if (naturalW > 0) {
				w = naturalW;
			}
		}
	}
	// Phase 3b (2026-05-26): `<canvas>` is a replaced element with
	// intrinsic dims from its width/height attrs (mirrored onto
	// `_width` / `_height` via the runner's `attachOffscreen` for
	// script-managed canvases, or via the converter's `setAttribute`
	// path for inline width/height attrs). Use those for BOTH axes so
	// the layout box matches the canvas's pixel size — without this
	// the canvas stretched to parent content-width (typically the
	// whole 1280px screen) AND collapsed to 0 height, leaving the
	// painter no slot to drawImage / copyBridgeToScreen into.
	if (tag === 'CANVAS') {
		const ds = el.getDisplaySize();
		intrinsicVoidH = ds.h;
		// Override the parent-allocated width with the canvas's own
		// intrinsic width so the box doesn't stretch. CSS-explicit
		// widths still take priority via resolveLength below; this
		// just fixes the "no explicit width" default.
		const explicitW = resolveLength(cs.width, w) ?? resolveLength(el.style.width, w);
		if (explicitW === undefined && ds.w > 0) w = ds.w;
	}
	// `<iframe>` is replaced-inline per HTML spec — sized by `width`/
	// `height` attrs (or CSS). Default 300×150 when neither is given.
	// HTML `width`/`height` attrs on an iframe are equivalent to CSS
	// width/height for sizing purposes — they CAP the box, not just
	// floor it. Force `explicitH` from the attr when CSS doesn't set
	// height, so child content overflow stays clipped (via UA-default
	// `overflow: hidden` for iframe, see applyUaDefaults). Without this,
	// an iframe with `height="200"` whose grafted content is taller
	// would grow to fit (intrinsicVoidH is a floor in the third branch
	// of the h selection below) — pushing the rest of the page down.
	if (tag === 'IFRAME') {
		const wAttr = parseFloat(el.getAttribute('width') ?? '');
		const hAttr = parseFloat(el.getAttribute('height') ?? '');
		const explicitW = resolveLength(cs.width, w) ?? resolveLength(el.style.width, w);
		if (explicitH === undefined && Number.isFinite(hAttr) && hAttr > 0) {
			explicitH = hAttr;
		} else if (explicitH === undefined) {
			explicitH = 150;
		}
		if (explicitW === undefined) {
			if (Number.isFinite(wAttr) && wAttr > 0) w = wAttr;
			else w = 300;
		}
	}
	// `<svg>` sizing follows the same pattern as `<img>`:
	//   - explicit CSS width/height win (resolveLength on cs.width)
	//   - else the `width` / `height` HTML attributes win (per HTML
	//     spec, attribute-driven sizing for the SVG box)
	//   - else fall back to viewBox aspect against the parent-allocated
	//     width (the default block-level-stretch behavior)
	// Without honoring the attributes, an `<svg width="320" height="60">`
	// gets the parent's full content width (~1184px) and stretches its
	// viewBox horizontally to fill — shapes look elongated.
	if (tag === 'SVG') {
		const wAttr = parseFloat(el.getAttribute('width') ?? '');
		const hAttr = parseFloat(el.getAttribute('height') ?? '');
		const explicitW = resolveLength(cs.width, w) ?? resolveLength(el.style.width, w);
		const explicitH = resolveLength(cs.height, w) ?? resolveLength(el.style.height, w);
		// Height
		if (explicitH !== undefined) intrinsicVoidH = explicitH;
		else if (Number.isFinite(hAttr) && hAttr > 0) intrinsicVoidH = hAttr;
		else {
			const vbRaw = el.getAttribute('viewBox') ?? el.getAttribute('viewbox');
			if (vbRaw) {
				const parts = vbRaw.trim().split(/[\s,]+/).map(parseFloat);
				if (parts.length === 4 && parts.every((p) => Number.isFinite(p)) && parts[2] > 0) {
					intrinsicVoidH = Math.max(1, Math.round(w * (parts[3] / parts[2])));
				}
			}
			if (intrinsicVoidH === 0) intrinsicVoidH = 150;
		}
		// Width: respect explicit CSS, then attribute, else parent
		// allocation (the original block-level stretch behavior).
		if (explicitW === undefined && Number.isFinite(wAttr) && wAttr > 0) {
			w = wAttr;
		}
	}
	// Form widgets default to zero size when no CSS/attribute height is
	// set — that's the standard `intrinsicVoidH = 0` fallback. Without
	// these branches a tier3-style `<input size="35" type="text">`
	// renders as a zero-height (invisible) box because `size` only
	// touches width via `applyPresentationalHints`. Heights below are
	// proportional to the inherited font size + a few pixels of
	// "chrome" so the widget reads as a typical browser control on
	// either theme. Explicit CSS height still wins via the normal
	// `explicitH` branch further down.
	if (tag === 'INPUT') {
		const type = (el.getAttribute('type') ?? 'text').toLowerCase();
		const fontPx = typeof cs.fontSize === 'number' ? cs.fontSize : 14;
		if (type === 'hidden') {
			// Hidden inputs occupy no layout space (CSS spec: `display:
			// none` UA default). Force both axes to zero so a hidden
			// field doesn't push siblings around or leak a paint hit.
			intrinsicVoidH = 0;
			w = 0;
		} else if (type === 'checkbox' || type === 'radio') {
			intrinsicVoidH = Math.max(14, fontPx + 2);
		} else if (type === 'range') {
			intrinsicVoidH = Math.max(20, fontPx + 8);
		} else if (type === 'submit' || type === 'button' || type === 'reset') {
			intrinsicVoidH = Math.round(fontPx * 1.6 + 6);
		} else if (type !== 'image') {
			// text / search / email / url / tel / password / number /
			// color / date / file / month / week / time
			intrinsicVoidH = Math.round(fontPx * 1.4 + 6);
		}
	}
	if (tag === 'BUTTON') {
		const fontPx = typeof cs.fontSize === 'number' ? cs.fontSize : 14;
		intrinsicVoidH = Math.round(fontPx * 1.6 + 6);
	}
	if (tag === 'SELECT') {
		const fontPx = typeof cs.fontSize === 'number' ? cs.fontSize : 14;
		intrinsicVoidH = Math.round(fontPx * 1.4 + 6);
		// Closed-state dropdown: the painter (paintSelect) draws ONE row
		// — the selected option's label + chevron — clipped to box.h.
		// Skip layoutChildren and use intrinsicVoidH as the box height so
		// the stacked OPTIONs don't inflate it (DDG's region picker has
		// ~60 OPTIONs which previously made the SELECT ~700px tall and
		// covered the result list; the chevron also scaled with box.h,
		// producing the giant angled artifact). OPTION layout boxes are
		// never read (tap collector + text painter both skip OPTION /
		// OPTGROUP; paintSelect short-circuits descendant painting), so
		// suppressing them is safe. `size > 1` (multi-row list-box) is
		// deferred until a fixture needs it.
		const sizeAttr = parseInt(el.getAttribute('size') ?? '1', 10);
		if (!(sizeAttr > 1)) {
			const h = clampSize(
				explicitH ?? hHint ?? (pad.top + intrinsicVoidH + pad.bottom),
				cs.minHeight, cs.maxHeight, heightBasis);
			const contentH = Math.max(0, h - pad.top - pad.bottom);
			storeBox(el, {
				x, y, w, h,
				contentX: x + pad.left, contentY: y + pad.top,
				contentW: Math.max(0, w - pad.left - pad.right), contentH,
				intrinsicContentH: intrinsicVoidH,
				intrinsicContentW: Math.max(0, w - pad.left - pad.right),
			});
			return h;
		}
	}
	// `<video>` sizing follows the IMG/SVG pattern — replaced element
	// with attribute-driven defaults. HTML spec defaults are 300×150
	// when no width/height is set anywhere (matching `<canvas>`).
	// Actual frame decode + render lives in a future slice; for now
	// the element just reserves its box and the painter draws a
	// placeholder.
	if (tag === 'VIDEO') {
		const wAttr = parseFloat(el.getAttribute('width') ?? '');
		const hAttr = parseFloat(el.getAttribute('height') ?? '');
		const explicitW = resolveLength(cs.width, w) ?? resolveLength(el.style.width, w);
		// Height: explicit CSS → attribute → HTML spec default 150.
		if (Number.isFinite(hAttr) && hAttr > 0) intrinsicVoidH = hAttr;
		else intrinsicVoidH = 150;
		// Width: explicit CSS wins → attribute → HTML spec default 300.
		// (Don't fall back to parent contentW like block-level video
		// would in real browsers when no dims are set — Switch screen
		// is narrow and a full-width video placeholder per fixture
		// would dominate. 300×150 default matches <canvas>.)
		if (explicitW === undefined) {
			if (Number.isFinite(wAttr) && wAttr > 0) w = wAttr;
			else w = 300;
		}
	}
	let h: number;
	let contentH: number;
	let intrinsicH: number;
	const contentW = Math.max(0, w - pad.left - pad.right);
	if (explicitH !== undefined) {
		h = clampSize(explicitH, cs.minHeight, cs.maxHeight, heightBasis);
		contentH = Math.max(0, h - pad.top - pad.bottom);
		intrinsicH = layoutChildren(el, x + pad.left, y + pad.top, contentW, contentH);
		const textH = el.textContent ? (cs.fontSize ?? 14) * 1.2 : 0;
		intrinsicH = Math.max(intrinsicH, textH, intrinsicVoidH);
	} else if (hHint !== undefined) {
		h = clampSize(hHint, cs.minHeight, cs.maxHeight, hHint);
		contentH = Math.max(0, h - pad.top - pad.bottom);
		intrinsicH = layoutChildren(el, x + pad.left, y + pad.top, contentW, contentH);
		const textH = el.textContent ? (cs.fontSize ?? 14) * 1.2 : 0;
		intrinsicH = Math.max(intrinsicH, textH, intrinsicVoidH);
	} else {
		const innerCH = layoutChildren(el, x + pad.left, y + pad.top, contentW, 0);
		const textH = el.textContent ? (cs.fontSize ?? 14) * 1.2 : 0;
		intrinsicH = Math.max(innerCH, textH, intrinsicVoidH);
		contentH = intrinsicH;
		h = clampSize(pad.top + contentH + pad.bottom, cs.minHeight, cs.maxHeight, 0);
	}
	const box: LayoutBox = {
		x, y, w, h,
		contentX: x + pad.left, contentY: y + pad.top,
		contentW, contentH,
		intrinsicContentH: intrinsicH,
		intrinsicContentW: contentW, // M2.5 doesn't track horizontal overflow width yet
	};
	storeBox(el, box);
	return h;
	} catch (err) {
		// Robustness: one element's layout must NEVER abort the whole
		// layout pass. Before this, a throw deep in a subtree (e.g. an
		// inline <svg> inside a flex <button>) aborted layout for every
		// element AFTER it in tree order, blanking most of the page. Log
		// which element failed (console.debug — never the
		// render-mode-flipping error/log/warn/info) and store a minimal
		// fallback box so siblings + ancestors keep laying out. The
		// element's own subtree is skipped (its children get no box).
		try {
			const cls = el && el.getAttribute && el.getAttribute('class');
			const id = el && el.getAttribute && el.getAttribute('id');
			console.debug('[live-layout] layoutLeaf threw, using fallback box for',
				'<' + ((el && el.tagName) || '?').toLowerCase() + (id ? ' id=' + id : '') + (cls ? ' class=' + cls : '') + '>',
				err);
		} catch (_) { /* ignore */ }
		const fb = hHint ?? 0;
		try {
			storeBox(el, {
				x, y, w, h: fb,
				contentX: x, contentY: y, contentW: w, contentH: fb,
				intrinsicContentH: fb, intrinsicContentW: w,
			});
		} catch (_) { /* ignore */ }
		return fb;
	}
}

// =========================================================================
// Helpers
// =========================================================================

function storeBox(el: LiveElement, box: LayoutBox): void {
	cache.set(el, box);
	cacheTouched.add(el);
}

function padding(cs: ComputedLiveStyle): { top: number; right: number; bottom: number; left: number } {
	return {
		top: cs.paddingTop ?? 0,
		right: cs.paddingRight ?? 0,
		bottom: cs.paddingBottom ?? 0,
		left: cs.paddingLeft ?? 0,
	};
}

function clampSize(v: number, min: CssLength | undefined, max: CssLength | undefined, basis: number): number {
	const minPx = resolveLength(min, basis);
	const maxPx = resolveLength(max, basis);
	if (maxPx !== undefined && v > maxPx) v = maxPx;
	if (minPx !== undefined && v < minPx) v = minPx;
	return v;
}

function clampMain(cs: ComputedLiveStyle, isRow: boolean, v: number, contentW: number, contentH: number): number {
	if (isRow) return clampSize(v, cs.minWidth, cs.maxWidth, contentW);
	return clampSize(v, cs.minHeight, cs.maxHeight, contentH);
}
function clampCross(cs: ComputedLiveStyle, isRow: boolean, v: number, contentW: number, contentH: number): number {
	if (isRow) return clampSize(v, cs.minHeight, cs.maxHeight, contentH);
	return clampSize(v, cs.minWidth, cs.maxWidth, contentW);
}

function mainAxis(cs: ComputedLiveStyle, isRow: boolean, contentW: number, contentH: number) {
	if (isRow) {
		return {
			basis: cs.flexBasis,
			explicit: resolveLength(cs.width, contentW),
			marginStart: cs.marginLeft ?? 0,
			marginEnd: cs.marginRight ?? 0,
		};
	}
	return {
		basis: cs.flexBasis,
		explicit: resolveLength(cs.height, contentH),
		marginStart: cs.marginTop ?? 0,
		marginEnd: cs.marginBottom ?? 0,
	};
}

function crossAxis(cs: ComputedLiveStyle, isRow: boolean, contentW: number, contentH: number) {
	if (isRow) {
		return {
			explicit: resolveLength(cs.height, contentH),
			marginStart: cs.marginTop ?? 0,
			marginEnd: cs.marginBottom ?? 0,
		};
	}
	return {
		explicit: resolveLength(cs.width, contentW),
		marginStart: cs.marginLeft ?? 0,
		marginEnd: cs.marginRight ?? 0,
	};
}

function crossExplicit(cs: ComputedLiveStyle, isRow: boolean): boolean {
	return (isRow ? cs.height : cs.width) !== undefined;
}

/** Intrinsic main-axis size: explicit (px-only) width/height OR measured
 * text width OR `0`. Percent values contribute 0 to intrinsic size — the
 * containing block isn't known here, so we treat percent the same as
 * "no explicit size" per the CSS spec on intrinsic resolution. */
function intrinsicMain(el: LiveElement, cs: ComputedLiveStyle, isRow: boolean): number {
	if (isRow) {
		return intrinsicContentWidth(el, cs);
	}
	if (typeof cs.height === 'number') return cs.height;
	if (el.textContent) return (cs.fontSize ?? 14) * 1.2 + (cs.paddingTop ?? 0) + (cs.paddingBottom ?? 0);
	return 0;
}

/** Intrinsic border-box width of an element. Explicit `width` wins;
 * otherwise compute from children (a row flex/inline-flex container
 * SUMS child outer widths + gaps; block / grid / column-flex take the
 * MAX child width), falling back to a text measurement for leaf
 * elements. Clamped up to `min-width`. Replaces the old text-only
 * measurement that under-sized flex containers like a nav bar whose
 * width comes from its pill children's box model, not its raw text —
 * which made the parent's `space-between` overshoot and push the nav
 * off the right edge. */
/** Intrinsic content-box size of a replaced `<svg>`: CSS explicit
 * width/height win, else the `width`/`height` HTML attrs, else the
 * `viewBox` aspect resolves the missing axis from the known one (16px
 * default when neither is given). Mirrors `layoutLeaf`'s SVG sizing so an
 * inline icon reports a real box as a flex item / intrinsic child instead
 * of collapsing to its zero-extent shape children (polygon/rect/…) — that
 * collapse made `<svg>` icons inside `display:flex` buttons lay out at
 * w=h=0 and paint invisibly. */
function svgIntrinsicContentSize(el: LiveElement, cs: ComputedLiveStyle): { w: number; h: number } {
	let w = typeof cs.width === 'number' ? cs.width : undefined;
	let h = typeof cs.height === 'number' ? cs.height : undefined;
	if (w === undefined) {
		const a = parseFloat(el.getAttribute('width') ?? '');
		if (Number.isFinite(a) && a > 0) w = a;
	}
	if (h === undefined) {
		const a = parseFloat(el.getAttribute('height') ?? '');
		if (Number.isFinite(a) && a > 0) h = a;
	}
	let vbAspect: number | undefined;
	const vbRaw = el.getAttribute('viewBox') ?? el.getAttribute('viewbox');
	if (vbRaw) {
		const p = vbRaw.trim().split(/[\s,]+/).map(parseFloat);
		if (p.length === 4 && p.every((n) => Number.isFinite(n)) && p[2] > 0 && p[3] > 0) vbAspect = p[2] / p[3];
	}
	if (w === undefined && h !== undefined) w = vbAspect ? Math.round(h * vbAspect) : h;
	if (h === undefined && w !== undefined) h = vbAspect ? Math.round(w / vbAspect) : w;
	return { w: w ?? 16, h: h ?? 16 };
}

function intrinsicContentWidth(el: LiveElement, cs: ComputedLiveStyle): number {
	const padL = cs.paddingLeft ?? 0;
	const padR = cs.paddingRight ?? 0;
	if (el.tagName === 'SVG') {
		let w = svgIntrinsicContentSize(el, cs).w;
		const minW = typeof cs.minWidth === 'number' ? cs.minWidth : undefined;
		if (minW !== undefined && w < minW) w = minW;
		return w;
	}
	const explicit = typeof cs.width === 'number' ? cs.width : undefined;
	let w: number;
	if (explicit === undefined && el.tagName === 'IMG') {
		// `width: auto` image: width follows the natural aspect ratio
		// against the explicit height (matches the layoutLeaf IMG path),
		// so a flex item like a logo gets the right base size. Falls
		// back to natural width, then a square (height) before the image
		// has loaded.
		const loaded = el.getLoadedImage();
		const nW = loaded?.naturalWidth ?? loaded?.width ?? 0;
		const nH = loaded?.naturalHeight ?? loaded?.height ?? 0;
		const explicitH = typeof cs.height === 'number' ? cs.height : undefined;
		let iw: number;
		if (explicitH !== undefined && nW > 0 && nH > 0) iw = Math.round((nW / nH) * explicitH);
		else if (nW > 0) iw = nW;
		else if (explicitH !== undefined) iw = explicitH;
		else iw = 0;
		iw += padL + padR;
		const minW = typeof cs.minWidth === 'number' ? cs.minWidth : undefined;
		return minW !== undefined && iw < minW ? minW : iw;
	}
	if (explicit !== undefined) {
		w = explicit;
	} else {
		const kids = el.children.filter((c) => {
			const ccs = getComputedLiveStyle(c);
			if (ccs.display === 'none') return false;
			const pos = ccs.position ?? c.style.position;
			return pos !== 'fixed' && pos !== 'absolute';
		});
		let inner = 0;
		if (kids.length > 0) {
			const dir = cs.flexDirection || 'row';
			const isFlexRow = (cs.display === 'flex' || cs.display === 'inline-flex')
				&& (dir === 'row' || dir === 'row-reverse');
			const gap = cs.gap ?? 0;
			if (isFlexRow) {
				let count = 0;
				for (const c of kids) {
					const ccs = getComputedLiveStyle(c);
					inner += outerIntrinsicWidth(c, ccs);
					count++;
				}
				inner += gap * Math.max(0, count - 1);
			} else {
				for (const c of kids) {
					const ccs = getComputedLiveStyle(c);
					inner = Math.max(inner, outerIntrinsicWidth(c, ccs));
				}
			}
		} else if (el.textContent && measureCtx) {
			measureCtx.save();
			try {
				measureCtx.font = (cs.fontSize ?? 14) + 'px ' + quoteFontFamily(cs.fontFamily || 'sans-serif');
				inner = measureCtx.measureText(el.textContent).width;
			} catch (_) { /* leave 0 */ }
			finally { measureCtx.restore(); }
		}
		w = inner + padL + padR;
	}
	// `min-width` floors the intrinsic size (px only — % min-width has no
	// basis at intrinsic-measure time).
	const minW = typeof cs.minWidth === 'number' ? cs.minWidth : undefined;
	if (minW !== undefined && w < minW) w = minW;
	return w;
}

function outerIntrinsicWidth(el: LiveElement, cs: ComputedLiveStyle): number {
	const mL = cs.marginLeft ?? 0;
	const mR = cs.marginRight ?? 0;
	return intrinsicContentWidth(el, cs) + mL + mR;
}

/** Intrinsic border-box height of an element. Explicit `height` wins;
 * otherwise compute from children (a ROW flex/inline-flex container
 * takes the MAX child outer height; block / column-flex / grid SUM
 * them), falling back to a text line for leaves. Clamped up to
 * `min-height`. The height analogue of `intrinsicContentWidth` —
 * needed so a row-flex bar (e.g. logo + label) reports the tall
 * child's height instead of just the text line-height, which made
 * `align-items: center` center the label against a too-short row. */
function intrinsicContentHeight(el: LiveElement, cs: ComputedLiveStyle): number {
	const padT = cs.paddingTop ?? 0;
	const padB = cs.paddingBottom ?? 0;
	if (el.tagName === 'SVG') {
		let h = svgIntrinsicContentSize(el, cs).h;
		const minH = typeof cs.minHeight === 'number' ? cs.minHeight : undefined;
		if (minH !== undefined && h < minH) h = minH;
		return h;
	}
	const explicit = typeof cs.height === 'number' ? cs.height : undefined;
	let h: number;
	if (explicit !== undefined) {
		h = explicit;
	} else {
		const kids = el.children.filter((c) => {
			const ccs = getComputedLiveStyle(c);
			if (ccs.display === 'none') return false;
			const pos = ccs.position ?? c.style.position;
			return pos !== 'fixed' && pos !== 'absolute';
		});
		let inner = 0;
		if (kids.length > 0) {
			const dir = cs.flexDirection || 'row';
			const isFlex = cs.display === 'flex' || cs.display === 'inline-flex';
			const isFlexRow = isFlex && (dir === 'row' || dir === 'row-reverse');
			const isFlexCol = isFlex && (dir === 'column' || dir === 'column-reverse');
			const gap = cs.gap ?? 0;
			// Inline-flow context: when every kid is inline / inline-block
			// they flow on the same line per CSS spec (mirrors the
			// allInline routing in layoutChildren). Cross-axis height is
			// the TALLEST kid, not the SUM — without this an inline-block
			// container (e.g. DDG's `.result__extras__url`) with a span +
			// `<a>` inside reported sum-of-heights as its intrinsic, so a
			// row that's really one-line-tall claimed multi-line height
			// and pushed the snippet below by ~50px of phantom whitespace.
			let allInlineKids = true;
			for (const c of kids) {
				const ccs = getComputedLiveStyle(c);
				const d = ccs.display;
				if (d !== 'inline' && d !== 'inline-block') { allInlineKids = false; break; }
			}
			if (isFlexRow || allInlineKids) {
				// Cross axis is vertical → row height is the tallest child.
				for (const c of kids) {
					const ccs = getComputedLiveStyle(c);
					inner = Math.max(inner, outerIntrinsicHeight(c, ccs));
				}
			} else {
				// Block / column-flex / grid → children stack vertically.
				let count = 0;
				for (const c of kids) {
					const ccs = getComputedLiveStyle(c);
					inner += outerIntrinsicHeight(c, ccs);
					count++;
				}
				if (isFlexCol) inner += gap * Math.max(0, count - 1);
			}
		} else if (el.textContent) {
			inner = cs.lineHeight ?? (cs.fontSize ?? 14) * 1.2;
		} else {
			const tag = el.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
				inner = cs.lineHeight ?? (cs.fontSize ?? 14) * 1.2;
			}
		}
		h = inner + padT + padB;
	}
	const minH = typeof cs.minHeight === 'number' ? cs.minHeight : undefined;
	if (minH !== undefined && h < minH) h = minH;
	return h;
}

function outerIntrinsicHeight(el: LiveElement, cs: ComputedLiveStyle): number {
	const mT = cs.marginTop ?? 0;
	const mB = cs.marginBottom ?? 0;
	return intrinsicContentHeight(el, cs) + mT + mB;
}

/** M2.6 helper: walk a subtree looking for the max display-width of any
 * visible `<canvas>` child. Matches the original M2.0 `computeFixedSize`
 * fallback used by the painter — Stats's pattern (container has no
 * explicit size, but its visible canvas panel does). Returns 0 if no
 * canvas children. */
function canvasIntrinsicWidth(root: LiveElement): number {
	let w = 0;
	const walk = (node: LiveElement) => {
		if (node.style.display === 'none') return;
		if (node.tagName === 'CANVAS') {
			const ds = node.getDisplaySize();
			if (ds.w > w) w = ds.w;
		}
		for (const c of node.children) walk(c);
	};
	walk(root);
	return w;
}

function intrinsicCross(el: LiveElement, cs: ComputedLiveStyle, isRow: boolean): number {
	if (el.tagName === 'SVG') {
		const s = svgIntrinsicContentSize(el, cs);
		return isRow ? s.h : s.w;
	}
	if (isRow) {
		if (typeof cs.height === 'number') return cs.height;
		const padV = (cs.paddingTop ?? 0) + (cs.paddingBottom ?? 0);
		const lineH = cs.lineHeight ?? (cs.fontSize ?? 14) * 1.2;
		// Element-children containers (e.g. a logo+label flex row) get
		// their height from the children's box model — measuring just
		// `textContent` line-height ignored a tall child (the logo) and
		// made `align-items: center` center the label in a too-short row.
		const hasElementKids = el.children.some((c) => {
			const ccs = getComputedLiveStyle(c);
			return ccs.display !== 'none';
		});
		if (hasElementKids) return intrinsicContentHeight(el, cs);
		if (el.textContent) return lineH + padV;
		// Form controls reserve a line box even when empty — an empty
		// `<input>` has no textContent (its placeholder is an attribute),
		// so without this it collapsed to 0 height and rendered as a thin
		// line instead of a field.
		const tag = el.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
			return lineH + padV;
		}
		return 0;
	}
	if (typeof cs.width === 'number') return cs.width;
	if (el.textContent && measureCtx) {
		measureCtx.save();
		try {
			measureCtx.font = (cs.fontSize ?? 14) + 'px ' + quoteFontFamily(cs.fontFamily || 'sans-serif');
			return measureCtx.measureText(el.textContent).width + (cs.paddingLeft ?? 0) + (cs.paddingRight ?? 0);
		} catch (_) { /* fall through */ }
		finally { measureCtx.restore(); }
	}
	return 0;
}
