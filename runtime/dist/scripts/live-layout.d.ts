/// <reference types="@nx.js/runtime" />
import type { LiveElement } from './live-dom.js';
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
export declare function setLayoutMeasureCtx(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null): void;
/** Phase 2.5 inline-formatting context (2026-05-25): per-block-parent
 * inline-flow result. Multiple atoms can map to the same source element
 * (a text node spanning several words / several lines), so we can't key
 * the layout boxes by element. Instead the parent block stores a
 * structure of atoms, and the painter / hit-test walk it. */
export interface InlineAtom {
    /** Source element — text node, inline element, IMG, or BR. */
    el: LiveElement;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Text content for this atom (single word or `' '` for whitespace,
     * empty for IMG / BR / non-text inline). */
    text: string;
    /** Canvas `font` string used to measure + render the text. */
    font: string;
    fontSize: number;
    /** True for `<br>`; the painter skips drawing but the layout already
     * advanced the y cursor by line-height. */
    isBr: boolean;
    /** True for `display: inline-block` non-replaced elements. The painter
     * dispatches these to `paintSubtreeLaid` so the box decoration (bg /
     * border / padding) paints, then its own laid-out children paint inside.
     * `(x, y, w, h)` is the border box; `mLeft` / `mRight` are CSS
     * horizontal margins consumed in the line outside that box. */
    isInlineBlock?: boolean;
    mLeft?: number;
    mRight?: number;
    /** Set when this atom represents an emoji grapheme cluster. The
     * painter dispatches to `getEmojiImage(emojiKey)` and `drawImage`s
     * the cached Twemoji PNG into `(x, y, w, h)` instead of `fillText`. */
    emojiKey?: string;
}
export interface InlineLayout {
    atoms: InlineAtom[];
    /** Total height consumed (cumulative line-height). */
    height: number;
}
export declare function resetLayoutCache(): void;
export declare function getLayoutBox(el: LiveElement): LayoutBox | undefined;
/** Phase 2.5: read the inline-flow result for a block-level parent.
 * Painter detects "has inline-layout" → paint atoms; otherwise recurse
 * into children as usual. */
export declare function getInlineLayout(el: LiveElement): InlineLayout | undefined;
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
export declare function layoutFixedRoot(root: LiveElement, originX: number, originY: number, availableWidth: number, availableHeight: number): LayoutBox;
/** Walk the live tree and collect every element with
 * `position: absolute`. Used by the painter's post-flow pass to lay
 * out + paint absolutes against their nearest positioned ancestor's
 * box. Order-preserving (document order) so z-index ties break
 * deterministically. */
export declare function collectAbsolutes(root: LiveElement): LiveElement[];
/** Resolve the containing-block ancestor for a `position: absolute`
 * element: nearest non-static positioned ancestor with a layout box;
 * falls back to `fallbackRoot` (typically body) so absolutes without
 * a positioned ancestor anchor to the viewport-equivalent. */
export declare function findAbsoluteContainingBlock(el: LiveElement, fallbackRoot: LiveElement): LiveElement;
/** Lay out a `position: absolute` element against the supplied
 * containing-block rect (typically `cb.content{X,Y,W,H}`). Resolves
 * top/left/right/bottom + width/height from the cascade with `auto`
 * defaults: width = content - left - right, height = intrinsic. */
export declare function layoutAbsoluteRoot(el: LiveElement, cbContentX: number, cbContentY: number, cbContentW: number, cbContentH: number): LayoutBox;
/**
 * Returns the paint-time top-border cutout for a fieldset, or undefined
 * when the fieldset has no <legend> (or its layout hasn't run yet).
 * Read by `live-overlay.ts paintBorders`.
 */
export declare function getFieldsetLegendCutout(el: LiveElement): {
    x: number;
    w: number;
} | undefined;
//# sourceMappingURL=live-layout.d.ts.map