import { type LiveElement } from './live-dom.js';
import { type CssLength } from './inline-css.js';
/** One color stop in a CSS gradient. `pos` is 0..1 (fraction along
 * the gradient line); undefined means the value-resolution pass will
 * fill it in from neighbours per spec. */
export interface GradientStop {
    color: string;
    pos?: number;
    /** Pixel-positioned stop (`color 1px`). Resolved against the gradient
     * line length at paint time (so it tracks `background-size` tiling).
     * Mutually exclusive with `pos`. */
    posPx?: number;
}
/** `linear-gradient(<angle>, stops...)`. Angle stored in radians using
 * the CSS convention (0 = "to top", clockwise). */
export interface LinearGradient {
    type: 'linear';
    angleRad: number;
    stops: GradientStop[];
}
/** `radial-gradient(<shape> at <pos>, stops...)`. Position is stored
 * as a fraction of the box (0..1) along each axis; the painter scales
 * to pixel coords at fill time. */
export interface RadialGradient {
    type: 'radial';
    shape: 'circle' | 'ellipse';
    cxFrac: number;
    cyFrac: number;
    stops: GradientStop[];
}
export interface SolidBackgroundLayer {
    type: 'solid';
    color: string;
}
/** `background: url(...)` — the URL is unresolved (may be `/path`,
 * `./path`, protocol-relative `//host/path`, or absolute). The painter
 * resolves it via `resolveLiveResourceUrl` and asks the image-layer
 * cache for an `HTMLImageElement`; once loaded, the live tree version
 * bumps so the next paint can drawImage it. */
export interface ImageBackgroundLayer {
    type: 'image';
    url: string;
    /** Loose-parsed CSS position/repeat/size keywords from the same layer
     * (`no-repeat`, `center`, etc.). Painter consults these for placement;
     * unrecognized tokens are dropped. */
    repeat?: 'repeat' | 'no-repeat' | 'repeat-x' | 'repeat-y';
    position?: 'center' | 'left' | 'right' | 'top' | 'bottom';
    /** `cover` / `contain` / explicit `<w>` `<h>` (px). */
    sizeMode?: 'cover' | 'contain' | 'auto';
    sizeW?: number;
    sizeH?: number;
}
export type BackgroundLayer = LinearGradient | RadialGradient | SolidBackgroundLayer | ImageBackgroundLayer;
/** Parsed `box-shadow` longhand. CSS allows multiple shadows separated
 * by top-level commas; each is `[inset] <ox> <oy> [<blur>] [<spread>] <color>`. */
export interface BoxShadow {
    inset: boolean;
    offsetX: number;
    offsetY: number;
    blur: number;
    spread: number;
    color: string;
}
/** Resolved style for a `::before` / `::after` pseudo-element. The
 * painter consumes these instead of inheriting the host element's
 * cascade so a pseudo can have its own position / color / font-size. */
export interface PseudoStyle {
    position?: 'static' | 'relative' | 'absolute';
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
    /** Percent-form inset siblings of top/right/bottom/left. Stored
     * separately because they resolve against the host box (height for
     * top/bottom, width for left/right) at paint time, not parse time.
     * Painter prefers the px value when both are set. Common case is
     * dropdown / badge chevron pseudos using `top: 50%` to centre. */
    topPct?: number;
    rightPct?: number;
    bottomPct?: number;
    leftPct?: number;
    color?: string;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: 'normal' | 'bold' | number;
    fontStyle?: 'normal' | 'italic' | 'oblique';
    lineHeight?: number;
    background?: string;
    backgroundLayers?: BackgroundLayer[];
    backgroundSize?: {
        w: number;
        h: number;
    };
    opacity?: number;
    width?: CssLength;
    height?: CssLength;
    /** `mask-image: <gradient>` — an alpha mask applied to the pseudo's
     * painted background (e.g. a radial fade). */
    maskImage?: BackgroundLayer;
}
/** Final cascade result handed to the painter. Mirrors InlineStyle plus
 * pseudo-element content + a `vars` bag (for `var()` resolution by
 * descendants) + a `customProps` bag (own --foo declarations). */
export interface ComputedLiveStyle {
    color?: string;
    background?: string;
    /** Parsed gradient + solid layers from `background:` shorthand. When
     * present, the painter consumes this instead of `background`. Layers
     * are stored bottom-first (paint order) — CSS lists first-on-top, we
     * reverse at parse time so the painter can just iterate forward. */
    backgroundLayers?: BackgroundLayer[];
    /** Parsed `background-size` when it's a fixed px tile (`42px 42px` /
     * `42px`). Drives gradient TILING in the painter — each layer repeats
     * across the box in tiles of this size. `cover`/`contain`/`auto` /
     * percentage sizes leave this undefined (painter fills the box once). */
    backgroundSize?: {
        w: number;
        h: number;
    };
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: 'normal' | 'bold' | number;
    fontStyle?: 'normal' | 'italic' | 'oblique';
    textAlign?: 'left' | 'center' | 'right' | 'start' | 'end';
    lineHeight?: number;
    textDecoration?: 'none' | 'underline' | 'line-through' | 'overline';
    textDecorationStyle?: 'solid' | 'dotted' | 'dashed' | 'double' | 'wavy';
    verticalAlign?: 'baseline' | 'super' | 'sub';
    listStyleType?: 'none' | 'disc' | 'circle' | 'square' | 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';
    cursor?: string;
    opacity?: number;
    display?: 'block' | 'inline' | 'inline-block' | 'flex' | 'inline-flex' | 'grid' | 'table' | 'none';
    /** CSS `float`. Layout honours `left` / `right` in layoutBlock by
     * packing consecutive floated kids onto the same row until the row
     * fills, then flushing. `none` (the default) lets the kid stack
     * normally. Floats with no explicit width fall back to parent
     * allocation — i.e. equivalent to not being floated. */
    float?: 'left' | 'right' | 'none';
    /** Raw `grid-template-columns:` value (parsed at layout time). The
     * layout module supports `repeat(auto-fit, minmax(<len>, 1fr))`,
     * `repeat(<N>, <track>)`, and explicit space-separated track lists
     * (each track a `<len>` / `%` / `<n>fr` / `auto` / `minmax(a, b)`). */
    gridTemplateColumns?: string;
    /** Raw `grid-template-rows:` value (parsed at layout time, same track
     * grammar as columns but resolved against the container's content
     * HEIGHT). Presence switches the grid into explicit 2D mode, where
     * children honour `gridColumn` / `gridRow` placement; absence keeps
     * the row-major auto-flow + content-sized rows behaviour. */
    gridTemplateRows?: string;
    /** Raw `grid-column:` / `grid-row:` placement, e.g. `"1"`, `"2"`,
     * `"1 / 3"`, `"span 2"`. Parsed at layout time into a start line +
     * span over the explicit track grid. */
    gridColumn?: string;
    gridRow?: string;
    width?: CssLength;
    height?: CssLength;
    position?: 'static' | 'fixed' | 'absolute' | 'relative';
    top?: number;
    left?: number;
    right?: number;
    bottom?: number;
    topPct?: number;
    leftPct?: number;
    rightPct?: number;
    bottomPct?: number;
    /** Parsed `transform`. `tx`/`ty` are translate values (baked into the
     * box position in the absolute-layout pass; `%` resolves against the
     * element's OWN box). `rotateRad` / `scaleX` / `scaleY` are applied
     * at PAINT time by the live-overlay wrapper — ctx.translate(center)
     * → ctx.rotate → ctx.scale → ctx.translate(-center). Both static
     * inline transforms AND animated CSS keyframe transforms land here
     * (the animation runtime overwrites `rotateRad` per frame via
     * `_animatedTransform`, leaving this static value untouched). */
    transform?: {
        tx?: CssLength;
        ty?: CssLength;
        rotateRad?: number;
        scaleX?: number;
        scaleY?: number;
    };
    /** Parsed `animation: <name> <duration> [<timing>] [<iter>] [<delay>]`
     * shorthand. Picked up by the CSS-animation tick in live-dom.ts to
     * spin up a 60Hz runtime that interpolates the keyframes for this
     * element. Only set when both name AND duration are present. */
    animation?: {
        name: string;
        durationMs: number;
        iterationCount: number | 'infinite';
        timing: string;
    };
    zIndex?: number;
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    marginTop?: number;
    marginRight?: number;
    marginBottom?: number;
    marginLeft?: number;
    gap?: number;
    flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
    flexGrow?: number;
    flexShrink?: number;
    flexBasis?: number;
    alignItems?: 'stretch' | 'flex-start' | 'flex-end' | 'center';
    /** `justify-items` (grid inline-axis alignment). Used to center a
     * text-only grid box's content (the `place-items: center` badge idiom).
     * Stored separately from `text-align` so it can override it. */
    justifyItems?: 'start' | 'end' | 'center' | 'stretch';
    justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around';
    boxSizing?: 'content-box' | 'border-box';
    minWidth?: CssLength;
    maxWidth?: CssLength;
    minHeight?: CssLength;
    maxHeight?: CssLength;
    borderTopWidth?: number;
    borderRightWidth?: number;
    borderBottomWidth?: number;
    borderLeftWidth?: number;
    borderTopColor?: string;
    borderRightColor?: string;
    borderBottomColor?: string;
    borderLeftColor?: string;
    /** Uniform `border-radius` — { px } or { percent: 0..1 }. Resolved
     * per-box by the painter; clamped to half the shorter side. */
    borderRadius?: {
        px: number;
    } | {
        percent: number;
    };
    /** Parsed `box-shadow:` list. Painter renders outer shadows behind
     * the background, inset shadows on top of it. */
    boxShadow?: BoxShadow[];
    overflowX?: 'visible' | 'hidden' | 'clip' | 'scroll' | 'auto';
    overflowY?: 'visible' | 'hidden' | 'clip' | 'scroll' | 'auto';
    /** CSS `white-space`. `nowrap` keeps an inline run on a single line
     * (used with `overflow:hidden` + `text-overflow:ellipsis` to truncate
     * long URLs / labels). Other values fall back to the default wrap
     * behaviour — `pre` / `pre-wrap` not implemented (text collapses
     * whitespace either way). */
    whiteSpace?: 'normal' | 'nowrap' | 'pre' | 'pre-wrap';
    /** `content` from `:before` rules. */
    before?: string;
    /** `content` from `:after` rules. */
    after?: string;
    /** Non-content properties from `::before` rules — position / font /
     * color etc. so the painter can place the pseudo independently. */
    beforeStyle?: PseudoStyle;
    /** Non-content properties from `::after` rules. */
    afterStyle?: PseudoStyle;
    /** Cascaded `--foo` declarations on THIS element. */
    customProps?: Record<string, string>;
    fill?: string;
    stroke?: string;
    strokeWidth?: string;
}
/** Reset all M2.2 state. Called by `resetLiveRoot` on navigation so
 * a leaving page's rules + caches don't bleed into the next. */
export declare function resetLiveCss(): void;
/** Reserve a cascade slot for `styleEl` in DOM-order position. Called
 * by `html-to-live`'s head-walk for both inline `<style>` and `<link
 * rel=stylesheet>` placeholders BEFORE either registers any rules.
 * The returned slot is stable across re-registrations of the same
 * element (e.g. an async `<link>` populating its placeholder after
 * fetch). Idempotent — repeated calls return the same slot. */
export declare function reserveStylesheetSlot(styleEl: LiveElement): number;
/** Drop the cascade slot reservation for `styleEl` so the next
 * `reserveStylesheetSlot` call assigns a fresh slot. Used by the
 * cross-navigation toolbar / keyboard re-registration path:
 * `resetLiveCss` (called from `resetLiveRoot` on navigation) wipes
 * the cascade state but leaves the `sheetSlot` WeakMap entries alive
 * for any LiveElements that survived (the toolbar + keyboard roots
 * are separate from the host root and survive `resetLiveRoot`). If
 * those entries kept their pre-reset slot numbers, the new page's
 * inline `<style>` blocks would collide with them at slot=1, 2, … and
 * cascade tiebreaks would become ambiguous. Clearing + re-reserving
 * gives the surviving sheets fresh slots at the front of the new
 * cascade so the new page's slots land AFTER them. */
export declare function clearStylesheetSlot(styleEl: LiveElement): void;
/** Register (or re-register) the rules parsed from `<style>` element
 * `styleEl`'s textContent. Called by LiveStyleElement on textContent /
 * innerHTML assignment and on appendChild into document.head. */
export declare function registerStyleSheet(styleEl: LiveElement, cssText: string): void;
/** Drop the rules for a <style> element (e.g. it was removed from
 * the tree). */
export declare function unregisterStyleSheet(styleEl: LiveElement): void;
/** True iff at least one registered stylesheet has a rule matching the
 * named pseudo-class. Used by the pseudo-state setters to skip invalid-
 * ation when no cascade rule reacts to the state. (2026-05-25) */
export declare function someStylesheetUsesActive(): boolean;
export declare function someStylesheetUsesFocus(): boolean;
export declare function someStylesheetUsesChecked(): boolean;
export declare function someStylesheetUsesHover(): boolean;
/** True iff some registered stylesheet uses a `+` or `~` combinator.
 * The radio-click fast path in live-form.ts consults this — when true,
 * the cascade for sibling subtrees can change with the `:checked`
 * flip, so a localised patch isn't enough and the caller must force a
 * full rebuild. */
export declare function someStylesheetUsesSibling(): boolean;
/** Invalidate the cascade across the entire document when a
 * `:checked`/`:focus`/`:active` flip on `el` can change the match
 * result of sibling-combinator rules elsewhere in the tree.
 *
 * The targeted `invalidateLiveStyle(el)` path only clears `el`'s own
 * subtree — siblings (and their descendants) keep their cached
 * `getComputedLiveStyle` result, AND their cached layout boxes /
 * inline-flow atom lists. So a `input:checked ~ .panel` rule's flip
 * wouldn't reach the panels or the tab labels (whose color depends on
 * the rule), even though the radio attribute did change.
 *
 * Strategy: clear the WHOLE computed-style cache AND every cached
 * layout box + inline-flow result, then bump the tree version. We do
 * NOT mark the root dirty — the dirty-region patch is too narrow for
 * this case (the radio is `display:none` so has no box; pinning
 * `layoutFixedRoot` to body's old box keeps stale `inlineCache`
 * entries for the labels even after re-layout). Instead we let the
 * version bump trigger paintLiveOverlay's full-rebuild branch, which
 * itself calls `resetLayoutCache()` + `layoutFixedRoot(root, 0, 0,
 * viewportW, viewportH)` and rebuilds the paint-ops list from
 * scratch — a guaranteed-correct refresh.
 *
 * Cheap-ish (O(touched-set-size) + clear caches); only paid when the
 * page actually has sibling rules. */
export declare function invalidateForSiblingCascade(_el: LiveElement): void;
export declare function setLayoutCacheResetFn(fn: () => void): void;
/** Invalidate the computed-style cache for one element (and its
 * descendants — they may have inherited from it). Cheap to call on
 * every classList toggle / attribute change.
 *
 * Phase 1.5: when called with a specific element, also bumps the
 * live-tree version so paintLiveOverlay knows to invalidate its cached
 * layout boxes. The null-el path (per-frame global clear from
 * paintLiveOverlay itself) does NOT bump — that's the very call we're
 * trying to make optional. */
export declare function invalidateLiveStyle(el?: LiveElement | null): void;
/** Pseudo-class state setters wired by the touch handler. Setting
 * also invalidates the element so the next paint walk re-resolves. */
export declare function setPseudoActive(el: LiveElement | null, on: boolean): void;
export declare function setPseudoFocus(el: LiveElement | null, on: boolean): void;
/** Engine-mouse hover sink. The page-mouse-forwarder calls this on hover
 * transitions; touch never does. Same per-element guard as `setPseudoActive`
 * — only invalidate when the page actually has a `:hover` rule whose match
 * depends on this element's hover state, otherwise idle cursor motion over
 * any non-styled element would force a cascade rebuild every frame. */
export declare function setPseudoHover(el: LiveElement | null, on: boolean): void;
export declare function isPseudoActive(el: LiveElement): boolean;
export declare function isPseudoFocus(el: LiveElement): boolean;
export declare function isPseudoHover(el: LiveElement): boolean;
/**
 * Resolve the computed style for `el` — walks all stylesheets, finds
 * applicable rules, sorts by specificity + source, and layers
 * declarations into a single ComputedLiveStyle. Then layers the
 * element's INLINE `el.style` on top (highest precedence). Then
 * applies inheritance from the parent.
 *
 * Cached per-element. Callers can ignore the cache and always call —
 * paint walks usually hit the cache on the second and subsequent
 * frames after the rules settle.
 */
export declare function getComputedLiveStyle(el: LiveElement): ComputedLiveStyle;
export type KeyframeStop = {
    offset: number;
    rotateRad?: number;
    scaleX?: number;
    scaleY?: number;
    opacity?: number;
};
export declare function getKeyframes(name: string): KeyframeStop[] | undefined;
/** Parse a `background:` value into ordered layers (paint order:
 * index 0 = bottom, last = top). Returns undefined for plain colors
 * so the painter falls back to `cs.background` string path. */
export declare function parseBackgroundLayers(value: string): BackgroundLayer[] | undefined;
/** Parse a `box-shadow:` value into structured shadows. Returns
 * undefined if no token parses (the caller leaves the existing value
 * alone instead of clearing it on a partial parse). */
export declare function parseBoxShadow(value: string): BoxShadow[] | undefined;
export declare function setMediaViewport(w: number, h: number): void;
export declare function setMediaColorScheme(scheme: 'light' | 'dark'): void;
//# sourceMappingURL=live-css.d.ts.map