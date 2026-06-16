/** A length value that's either an absolute px count or a percentage of
 * the containing block. Per CSS spec, `width:50%` resolves against the
 * parent's content-box width (same axis); `height:50%` against the
 * parent's content-box height. Resolution happens at layout time —
 * the value reaches the layout pass in this shape so the layout can
 * thread the parent's known size in and convert. */
export type CssLength = number | CssPercent | CssMinMax;
export interface CssPercent {
    percent: number;
}
/** `min(a, b, …)` / `max(a, b, …)` — resolved at layout time once the
 * `%` basis is known. Args are themselves CssLengths (px / % / nested
 * min-max). */
export interface CssMinMax {
    fn: 'min' | 'max';
    args: CssLength[];
}
/** True iff `v` is a `{ percent: N }` length. */
export declare function isPercent(v: unknown): v is CssPercent;
/** Resolve a CssLength against a known containing-block size (in px).
 * Returns `undefined` when the input is `undefined` so callers can use
 * `??` chaining. Numbers pass through unchanged. */
export declare function resolveLength(v: CssLength | undefined, basis: number): number | undefined;
/** Mutable record of the inline-style fields we understand. */
export interface InlineStyle {
    position?: 'static' | 'fixed' | 'absolute' | 'relative';
    top?: number;
    left?: number;
    right?: number;
    bottom?: number;
    width?: CssLength;
    height?: CssLength;
    display?: 'block' | 'inline' | 'inline-block' | 'flex' | 'inline-flex' | 'grid' | 'table' | 'none';
    opacity?: number;
    zIndex?: number;
    cursor?: string;
    background?: string;
    color?: string;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number | 'normal' | 'bold';
    fontStyle?: 'normal' | 'italic' | 'oblique';
    textAlign?: 'left' | 'center' | 'right' | 'start' | 'end';
    lineHeight?: number;
    textDecoration?: 'none' | 'underline' | 'line-through' | 'overline';
    verticalAlign?: 'baseline' | 'super' | 'sub';
    listStyleType?: 'none' | 'disc' | 'circle' | 'square' | 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';
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
    justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around';
    boxSizing?: 'content-box' | 'border-box';
    minWidth?: CssLength;
    maxWidth?: CssLength;
    minHeight?: CssLength;
    maxHeight?: CssLength;
    overflowX?: 'visible' | 'hidden' | 'clip' | 'scroll' | 'auto';
    overflowY?: 'visible' | 'hidden' | 'clip' | 'scroll' | 'auto';
    borderTopWidth?: number;
    borderRightWidth?: number;
    borderBottomWidth?: number;
    borderLeftWidth?: number;
    borderTopColor?: string;
    borderRightColor?: string;
    borderBottomColor?: string;
    borderLeftColor?: string;
    borderRadius?: {
        px: number;
    } | {
        percent: number;
    };
    /** Custom properties (`--foo`) declared on this element via inline
     * style. Stored as the raw value string (no resolution). Merged into
     * the element's computed-style `customProps` bag by `live-css.ts` so
     * `var(--foo)` references in this element OR descendants resolve. */
    customProps?: Record<string, string>;
}
/**
 * Parse a `style="..."` text into partial InlineStyle. Recognised
 * unit-bearing values: `Npx` (or unitless N) → number; everything else
 * passes through as string. `opacity` is parsed as float (0-1).
 *
 * Examples (real Stats):
 *   `position:fixed;top:0;left:0;cursor:pointer;opacity:0.9;z-index:10000`
 *   `width:80px;height:48px`
 *
 * Whitespace around `:` and `;` is tolerated. Empty declarations are
 * skipped. Returns a fresh InlineStyle each call.
 */
export declare function parseCssText(text: string): InlineStyle;
/** Apply one parsed `name: value` to `style`. Exported so the per-prop
 * setters on `LiveElement.style` (e.g. `style.position = 'fixed'`) can
 * funnel through the same coercion path as cssText. */
export declare function applyDecl(style: InlineStyle, propRaw: string, valueRaw: string): void;
/**
 * Resolve the canvas-2d `font` string for a LiveStyle. Avoids the
 * bold/italic prefix because nx.js's font parser falls back to a
 * different (larger default-size) font on the `bold ... sans-serif`
 * form ([[nxjs-font-no-bold-italic]]). Caller synthesizes bold via
 * double-draw and italic via skew transform at paint time.
 *
 * Defaults match common HUD/Stats usage: 14px sans-serif.
 */
export declare function resolveCanvasFont(style: InlineStyle): string;
export declare function quoteFontFamily(family: string): string;
/** True iff the resolved weight is bold (numeric ≥600 or 'bold'). */
export declare function isBoldWeight(style: InlineStyle): boolean;
/** True iff the resolved style is italic or oblique. */
export declare function isItalicStyle(style: InlineStyle): boolean;
/** Serialise an InlineStyle back to css text — only the set fields. */
export declare function serializeStyle(style: InlineStyle): string;
export declare function setCssViewport(w: number, h: number): void;
/** Read the current `vh` / `vw` basis. Used by the HTML-driven
 * keyboard's paint pass to save/restore the global viewport around
 * its scoped layout — its `min-height: 100vh` etc. need to resolve
 * against the keyboard-area height, not the host page's full
 * content viewport. */
export declare function getCssViewport(): {
    w: number;
    h: number;
};
/** CSS `font-size` absolute keyword → px. Values follow the web-standard
 * mapping that real browsers ship (medium = 16px is the spec default; the
 * other keywords are the historical 9/10/13/18/24/32/48 ratios from CSS
 * 2.1). Returns undefined for non-keyword input so the caller can fall
 * through to `Npx` / unit parsing. `smaller` / `larger` are NOT handled
 * here — they need the parent's computed font-size as context, which the
 * inline-style parser doesn't have. The live-CSS cascade (live-css.ts)
 * handles those separately at apply time. */
export declare function resolveFontSizeKeyword(value: string): number | undefined;
/** Parse a length value: `Npx`, unitless `N` → number; `N%` → percent;
 * `Nvh`/`Nvw` → px against the viewport; `min(...)`/`max(...)`/`clamp(...)`
 * → a CssMinMax resolved at layout time. */
export declare function parseLength(s: string): CssLength | undefined;
/** Cssprop-name to JS-property-name (kebab→camel). Used by the
 * setter trap on `LiveElement.style` to support both forms — Stats
 * writes `.cssText`, `style.display` etc., but addons may write
 * `style['z-index']`. */
export declare function cssToJsProp(name: string): string;
export declare function jsToCssProp(name: string): string;
//# sourceMappingURL=inline-css.d.ts.map