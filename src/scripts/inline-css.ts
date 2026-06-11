// Tiny inline-CSS (`style="..."` / `el.style.cssText = "..."`) parser
// for the live-DOM layer. Scope: the small handful of properties Stats
// (and likely lil-gui in a future phase) actually uses. Unknown props
// are silently dropped — this is NOT a CSS engine, just enough to
// position fixed overlays + toggle visibility.
//
// Stats uses: position, top, left, opacity, z-index, cursor.
// We also accept: right, bottom, width, height, display, background,
// background-color, color — likely needed shortly.

/** A length value that's either an absolute px count or a percentage of
 * the containing block. Per CSS spec, `width:50%` resolves against the
 * parent's content-box width (same axis); `height:50%` against the
 * parent's content-box height. Resolution happens at layout time —
 * the value reaches the layout pass in this shape so the layout can
 * thread the parent's known size in and convert. */
export type CssLength = number | CssPercent | CssMinMax;
export interface CssPercent { percent: number }
/** `min(a, b, …)` / `max(a, b, …)` — resolved at layout time once the
 * `%` basis is known. Args are themselves CssLengths (px / % / nested
 * min-max). */
export interface CssMinMax { fn: 'min' | 'max'; args: CssLength[] }

/** True iff `v` is a `{ percent: N }` length. */
export function isPercent(v: unknown): v is CssPercent {
	return typeof v === 'object' && v !== null && typeof (v as { percent?: unknown }).percent === 'number';
}

/** Resolve a CssLength against a known containing-block size (in px).
 * Returns `undefined` when the input is `undefined` so callers can use
 * `??` chaining. Numbers pass through unchanged. */
export function resolveLength(v: CssLength | undefined, basis: number): number | undefined {
	if (v === undefined) return undefined;
	if (typeof v === 'number') return v;
	if ('fn' in v) {
		const nums: number[] = [];
		for (const a of v.args) {
			const r = resolveLength(a, basis);
			if (r !== undefined) nums.push(r);
		}
		if (nums.length === 0) return undefined;
		return v.fn === 'min' ? Math.min(...nums) : Math.max(...nums);
	}
	return v.percent * 0.01 * basis;
}

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
	// Text props (M2.1).
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: number | 'normal' | 'bold';
	fontStyle?: 'normal' | 'italic' | 'oblique';
	textAlign?: 'left' | 'center' | 'right' | 'start' | 'end';
	lineHeight?: number;
	textDecoration?: 'none' | 'underline' | 'line-through' | 'overline';
	verticalAlign?: 'baseline' | 'super' | 'sub';
	listStyleType?: 'none' | 'disc' | 'circle' | 'square'
		| 'decimal' | 'lower-alpha' | 'upper-alpha'
		| 'lower-roman' | 'upper-roman';
	// Layout props (M2.3). Padding/margin are per-edge longhands so
	// cascade merge order doesn't lose individual edges. Gap is a
	// single value (no `row-gap`/`column-gap` split for M2.3).
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
	flexBasis?: number; // px only; `auto` mapped to undefined
	alignItems?: 'stretch' | 'flex-start' | 'flex-end' | 'center';
	justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around';
	boxSizing?: 'content-box' | 'border-box';
	minWidth?: CssLength;
	maxWidth?: CssLength;
	minHeight?: CssLength;
	maxHeight?: CssLength;
	// M2.5 overflow. `auto` / `scroll` enable touch-drag scrolling;
	// `hidden` clips without scroll; `visible` (default) allows
	// children to render outside the box. Per-axis longhands
	// supersede the shorthand at parse time.
	overflowX?: 'visible' | 'hidden' | 'scroll' | 'auto';
	overflowY?: 'visible' | 'hidden' | 'scroll' | 'auto';
	// Borders (M2.6). We accept the `border` / `border-{side}` shorthand
	// (`<width> <style> <color>`) and the per-side width/color longhands;
	// style is parsed but only `solid` is rendered (others fall back to
	// solid). Border widths DO NOT affect layout in this iteration —
	// they paint inside the border-box without consuming content space.
	// Sufficient for lil-gui's slider knob (`.fill { border-right: 2px
	// solid <color> }`) + folder dividers + sub-folder indent stripe.
	borderTopWidth?: number;
	borderRightWidth?: number;
	borderBottomWidth?: number;
	borderLeftWidth?: number;
	borderTopColor?: string;
	borderRightColor?: string;
	borderBottomColor?: string;
	borderLeftColor?: string;
	borderRadius?: { px: number } | { percent: number };
	/** Custom properties (`--foo`) declared on this element via inline
	 * style. Stored as the raw value string (no resolution). Merged into
	 * the element's computed-style `customProps` bag by `live-css.ts` so
	 * `var(--foo)` references in this element OR descendants resolve. */
	customProps?: Record<string, string>;
}

const NUM_PROPS = new Set([
	'top', 'left', 'right', 'bottom', 'opacity', 'z-index',
	'font-size', 'line-height',
	// M2.3 layout per-edge longhands + simple numeric.
	'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'gap', 'flex-grow', 'flex-shrink', 'flex-basis',
]);

/** Length-bearing props that accept both px and percent. Width/height
 * percentages resolve against the parent's content-box (same-axis).
 * Min/max-* follow the same axis rule. Per CSS spec, padding/margin
 * percentages ALSO resolve against width — we don't support those yet
 * since no in-tree consumer uses them. */
const LENGTH_PROPS = new Set([
	'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
]);

const STRING_PROPS = new Set([
	'position', 'display', 'cursor', 'background', 'background-color', 'color',
	'font-family', 'font-weight', 'font-style', 'text-align',
	'text-decoration', 'text-decoration-line', 'vertical-align',
	'list-style-type', 'list-style',
	// M2.3 layout keywords.
	'flex-direction', 'align-items', 'justify-content', 'box-sizing',
	// M2.5 overflow keywords.
	'overflow', 'overflow-x', 'overflow-y',
]);

/** Shorthand props (parsed specially — value tokens expand to multiple
 * longhand props on the InlineStyle). */
const SHORTHAND_PROPS = new Set([
	'padding', 'margin', 'flex',
	'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
]);

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
export function parseCssText(text: string): InlineStyle {
	const out: InlineStyle = {};
	if (!text) return out;
	for (const decl of text.split(';')) {
		const i = decl.indexOf(':');
		if (i < 0) continue;
		const prop = decl.slice(0, i).trim().toLowerCase();
		const raw = decl.slice(i + 1).trim();
		if (!prop || !raw) continue;
		applyDecl(out, prop, raw);
	}
	return out;
}

/** Apply one parsed `name: value` to `style`. Exported so the per-prop
 * setters on `LiveElement.style` (e.g. `style.position = 'fixed'`) can
 * funnel through the same coercion path as cssText. */
export function applyDecl(style: InlineStyle, propRaw: string, valueRaw: string): void {
	// Custom properties (`--foo`) — keep the original case (CSS spec
	// says custom property names are CASE-SENSITIVE, unlike regular
	// property names). Store the raw value string; var() resolution
	// happens later when the computed style is read.
	if (propRaw.startsWith('--')) {
		const bag = style.customProps ?? (style.customProps = {});
		bag[propRaw] = valueRaw.trim();
		return;
	}
	const prop = propRaw.toLowerCase();
	const value = valueRaw.trim();
	// Border longhand/shorthand helpers — applied before the LENGTH/NUM
	// branches so the regex-driven parsing kicks in.
	if (prop === 'border-top-width' || prop === 'border-right-width' ||
	    prop === 'border-bottom-width' || prop === 'border-left-width') {
		const n = parsePxOrNum(value);
		if (n === undefined) return;
		switch (prop) {
			case 'border-top-width': style.borderTopWidth = n; return;
			case 'border-right-width': style.borderRightWidth = n; return;
			case 'border-bottom-width': style.borderBottomWidth = n; return;
			case 'border-left-width': style.borderLeftWidth = n; return;
		}
	}
	if (prop === 'border-top-color' || prop === 'border-right-color' ||
	    prop === 'border-bottom-color' || prop === 'border-left-color') {
		switch (prop) {
			case 'border-top-color': style.borderTopColor = value; return;
			case 'border-right-color': style.borderRightColor = value; return;
			case 'border-bottom-color': style.borderBottomColor = value; return;
			case 'border-left-color': style.borderLeftColor = value; return;
		}
	}
	if (prop === 'border-width') {
		const n = parsePxOrNum(value);
		if (n === undefined) return;
		style.borderTopWidth = n; style.borderRightWidth = n;
		style.borderBottomWidth = n; style.borderLeftWidth = n;
		return;
	}
	if (prop === 'border-color') {
		style.borderTopColor = value; style.borderRightColor = value;
		style.borderBottomColor = value; style.borderLeftColor = value;
		return;
	}
	if (prop === 'border-radius') {
		const first = value.split(/\s+/)[0];
		if (!first) return;
		const pct = /^(\d+(?:\.\d+)?)%$/.exec(first);
		if (pct) {
			const n = parseFloat(pct[1]);
			if (Number.isFinite(n)) style.borderRadius = { percent: n / 100 };
			return;
		}
		const n = parsePxOrNum(first);
		if (n !== undefined) style.borderRadius = { px: n };
		return;
	}
	if (LENGTH_PROPS.has(prop)) {
		const len = parseLength(value);
		if (len === undefined) return;
		switch (prop) {
			case 'width': style.width = len; return;
			case 'height': style.height = len; return;
			case 'min-width': style.minWidth = len; return;
			case 'max-width': style.maxWidth = len; return;
			case 'min-height': style.minHeight = len; return;
			case 'max-height': style.maxHeight = len; return;
		}
	}
	if (prop === 'font-size') {
		// Absolute CSS keywords (`small`, `x-small`, …) come first so the
		// numeric branch below isn't tried with a non-numeric input.
		// Relative keywords (`smaller`, `larger`) require parent context
		// and are deliberately not handled here — see
		// `resolveFontSizeKeyword` doc.
		const kw = resolveFontSizeKeyword(value);
		if (kw !== undefined) { style.fontSize = kw; return; }
		const n = parsePxOrNum(value);
		if (n !== undefined) style.fontSize = n;
		return;
	}
	if (NUM_PROPS.has(prop)) {
		const n = parsePxOrNum(value);
		if (n === undefined) return;
		switch (prop) {
			case 'top': style.top = n; return;
			case 'left': style.left = n; return;
			case 'right': style.right = n; return;
			case 'bottom': style.bottom = n; return;
			case 'opacity': style.opacity = clamp01(n); return;
			case 'z-index': style.zIndex = Math.trunc(n); return;
			case 'font-size': style.fontSize = n; return;
			case 'line-height': {
				// Unitless line-height is a font-size MULTIPLIER per CSS
				// spec (see [[reference-swb-white-space-nowrap]] sibling
				// for the broader unit story). Resolve at parse time using
				// the same-element inline font-size if set, else 16px.
				// Inline-style line-height with units (px / em / rem)
				// already came out of parsePxOrNum resolved to a number.
				const trimmed = value.trim();
				if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
					style.lineHeight = parseFloat(trimmed) * (style.fontSize ?? 16);
				} else {
					style.lineHeight = n;
				}
				return;
			}
			case 'padding-top': style.paddingTop = n; return;
			case 'padding-right': style.paddingRight = n; return;
			case 'padding-bottom': style.paddingBottom = n; return;
			case 'padding-left': style.paddingLeft = n; return;
			case 'margin-top': style.marginTop = n; return;
			case 'margin-right': style.marginRight = n; return;
			case 'margin-bottom': style.marginBottom = n; return;
			case 'margin-left': style.marginLeft = n; return;
			case 'gap': style.gap = n; return;
			case 'flex-grow': style.flexGrow = n; return;
			case 'flex-shrink': style.flexShrink = n; return;
			case 'flex-basis': style.flexBasis = n; return;
		}
	}
	if (SHORTHAND_PROPS.has(prop)) {
		applyShorthand(style, prop, value);
		return;
	}
	if (STRING_PROPS.has(prop)) {
		switch (prop) {
			case 'position': {
				if (value === 'static' || value === 'fixed' ||
				    value === 'absolute' || value === 'relative') {
					style.position = value;
				}
				return;
			}
			case 'display': {
				if (value === 'block' || value === 'inline' ||
				    value === 'inline-block' || value === 'flex' ||
				    value === 'inline-flex' || value === 'grid' || value === 'none') {
					style.display = value;
				}
				return;
			}
			case 'cursor': style.cursor = value; return;
			case 'background':
			case 'background-color': style.background = value; return;
			case 'color': style.color = value; return;
			case 'font-family': style.fontFamily = value; return;
			case 'font-weight': {
				if (value === 'normal' || value === 'bold') {
					style.fontWeight = value;
				} else {
					const n = parseInt(value, 10);
					if (Number.isFinite(n)) style.fontWeight = n;
				}
				return;
			}
			case 'font-style': {
				if (value === 'normal' || value === 'italic' || value === 'oblique') {
					style.fontStyle = value;
				}
				return;
			}
			case 'text-align': {
				if (value === 'left' || value === 'center' || value === 'right' ||
				    value === 'start' || value === 'end') {
					style.textAlign = value;
				}
				return;
			}
			case 'text-decoration':
			case 'text-decoration-line': {
				// Accept the shorthand or longhand; ignore color/style sub-tokens
				// (only `<line>` is honored by the painter). Lookup is on the
				// first recognised keyword in the value — `underline solid red`
				// resolves to underline.
				for (const tok of value.toLowerCase().split(/\s+/)) {
					if (tok === 'none' || tok === 'underline' ||
					    tok === 'line-through' || tok === 'overline') {
						style.textDecoration = tok;
						return;
					}
				}
				return;
			}
			case 'vertical-align': {
				const v = value.toLowerCase();
				if (v === 'baseline' || v === 'super' || v === 'sub') {
					style.verticalAlign = v;
				}
				return;
			}
			case 'list-style-type':
			case 'list-style': {
				// `list-style` shorthand: scan tokens for a recognised
				// list-style-type keyword and use the first match. The
				// other components (position, image) are not supported.
				for (const tok of value.toLowerCase().split(/\s+/)) {
					if (tok === 'none' || tok === 'disc' || tok === 'circle' ||
					    tok === 'square' || tok === 'decimal' ||
					    tok === 'lower-alpha' || tok === 'upper-alpha' ||
					    tok === 'lower-roman' || tok === 'upper-roman') {
						style.listStyleType = tok;
						return;
					}
				}
				return;
			}
			case 'flex-direction': {
				if (value === 'row' || value === 'column' ||
				    value === 'row-reverse' || value === 'column-reverse') {
					style.flexDirection = value;
				}
				return;
			}
			case 'align-items': {
				if (value === 'stretch' || value === 'flex-start' ||
				    value === 'flex-end' || value === 'center') {
					style.alignItems = value;
				}
				return;
			}
			case 'justify-content': {
				if (value === 'flex-start' || value === 'flex-end' ||
				    value === 'center' || value === 'space-between' ||
				    value === 'space-around') {
					style.justifyContent = value;
				}
				return;
			}
			case 'box-sizing': {
				if (value === 'content-box' || value === 'border-box') {
					style.boxSizing = value;
				}
				return;
			}
			case 'overflow': {
				const v = parseOverflowValue(value);
				if (v) { style.overflowX = v; style.overflowY = v; }
				return;
			}
			case 'overflow-x': {
				const v = parseOverflowValue(value);
				if (v) style.overflowX = v;
				return;
			}
			case 'overflow-y': {
				const v = parseOverflowValue(value);
				if (v) style.overflowY = v;
				return;
			}
		}
	}
}

function parseOverflowValue(v: string): 'visible' | 'hidden' | 'scroll' | 'auto' | undefined {
	const t = v.trim().toLowerCase();
	if (t === 'visible' || t === 'hidden' || t === 'scroll' || t === 'auto') return t;
	return undefined;
}

/** Expand a CSS shorthand (`padding: 4px 8px`, `margin: 0`, `flex: 1`)
 * into the equivalent per-edge longhands on `style`. M2.3 surface:
 * 1, 2, 3, or 4-value padding/margin shorthand + simple `flex` parsing
 * (`<grow>` | `<grow> <shrink>` | `<grow> <shrink> <basis>`). */
function applyShorthand(style: InlineStyle, prop: string, value: string): void {
	const tokens = value.split(/\s+/).map((t) => t.trim()).filter(Boolean);
	if (tokens.length === 0) return;
	if (prop === 'padding' || prop === 'margin') {
		const nums = tokens.map((t) => parsePxOrNum(t));
		if (nums.some((n) => n === undefined)) return;
		const [t, r, b, l] = expandBoxShorthand(nums as number[]);
		if (prop === 'padding') {
			style.paddingTop = t; style.paddingRight = r;
			style.paddingBottom = b; style.paddingLeft = l;
		} else {
			style.marginTop = t; style.marginRight = r;
			style.marginBottom = b; style.marginLeft = l;
		}
		return;
	}
	if (prop === 'border' || prop === 'border-top' || prop === 'border-right' ||
	    prop === 'border-bottom' || prop === 'border-left') {
		applyBorderShorthand(style, prop, value, tokens);
		return;
	}
	if (prop === 'flex') {
		// `flex: 1` => grow:1 shrink:1 basis:0
		// `flex: 1 0` => grow:1 shrink:0 basis:0
		// `flex: 1 0 50px` => grow:1 shrink:0 basis:50
		// `flex: auto` / `flex: none` => map to common cases
		if (tokens.length === 1) {
			const sole = tokens[0].toLowerCase();
			if (sole === 'auto') { style.flexGrow = 1; style.flexShrink = 1; style.flexBasis = undefined; return; }
			if (sole === 'none') { style.flexGrow = 0; style.flexShrink = 0; style.flexBasis = undefined; return; }
			const g = parsePxOrNum(tokens[0]);
			if (g !== undefined) { style.flexGrow = g; style.flexShrink = 1; style.flexBasis = 0; }
			return;
		}
		const g = parsePxOrNum(tokens[0]);
		const s = parsePxOrNum(tokens[1]);
		if (g !== undefined) style.flexGrow = g;
		if (s !== undefined) style.flexShrink = s;
		if (tokens.length >= 3) {
			const b = parsePxOrNum(tokens[2]);
			if (b !== undefined) style.flexBasis = b;
		}
		return;
	}
}

/** Parse `border` / `border-{side}` shorthand. Format is `<width>
 * <style> <color>` in any order; tokens are detected by shape. Width:
 * a length (Npx or N). Style: `none` / `solid` / `dashed` / `dotted` /
 * `hidden` etc. — only `solid` actually renders, others paint as
 * `solid` (lil-gui only uses solid). Color: anything that's not a
 * width or style token. `border: 0` or `border: none` clears widths.
 */
function applyBorderShorthand(
	style: InlineStyle,
	prop: 'border' | 'border-top' | 'border-right' | 'border-bottom' | 'border-left',
	value: string,
	tokens: string[],
): void {
	const STYLE_KEYWORDS = new Set([
		'none', 'hidden', 'solid', 'dashed', 'dotted', 'double',
		'groove', 'ridge', 'inset', 'outset',
	]);
	let width: number | undefined;
	let isNone = false;
	let color: string | undefined;
	for (const t of tokens) {
		const lower = t.toLowerCase();
		if (STYLE_KEYWORDS.has(lower)) {
			if (lower === 'none' || lower === 'hidden') isNone = true;
			continue;
		}
		// Length tokens take priority over color when ambiguous.
		const w = parsePxOrNum(t);
		if (w !== undefined && width === undefined) {
			width = w;
			continue;
		}
		// Anything else is the color value.
		if (color === undefined) color = t;
	}
	if (isNone) { width = 0; color = undefined; }
	const widthVal = width ?? 0;
	const setSide = (side: 'Top' | 'Right' | 'Bottom' | 'Left') => {
		(style as Record<string, unknown>)['border' + side + 'Width'] = widthVal;
		if (color !== undefined) (style as Record<string, unknown>)['border' + side + 'Color'] = color;
	};
	if (prop === 'border') {
		setSide('Top'); setSide('Right'); setSide('Bottom'); setSide('Left');
		return;
	}
	if (prop === 'border-top') setSide('Top');
	else if (prop === 'border-right') setSide('Right');
	else if (prop === 'border-bottom') setSide('Bottom');
	else if (prop === 'border-left') setSide('Left');
}

/** CSS box shorthand expansion: 1→TRBL, 2→TB/RL, 3→T/RL/B, 4→TRBL. */
function expandBoxShorthand(values: number[]): [number, number, number, number] {
	switch (values.length) {
		case 1: return [values[0], values[0], values[0], values[0]];
		case 2: return [values[0], values[1], values[0], values[1]];
		case 3: return [values[0], values[1], values[2], values[1]];
		default: return [values[0], values[1], values[2], values[3]];
	}
}

/**
 * Resolve the canvas-2d `font` string for a LiveStyle. Avoids the
 * bold/italic prefix because nx.js's font parser falls back to a
 * different (larger default-size) font on the `bold ... sans-serif`
 * form ([[nxjs-font-no-bold-italic]]). Caller synthesizes bold via
 * double-draw and italic via skew transform at paint time.
 *
 * Defaults match common HUD/Stats usage: 14px sans-serif.
 */
export function resolveCanvasFont(style: InlineStyle): string {
	const sz = (style.fontSize !== undefined && style.fontSize > 0) ? style.fontSize : 14;
	return sz + 'px ' + quoteFontFamily(style.fontFamily || 'sans-serif');
}

/** Normalize a font-family value into a form that HTML5 canvas's `font`
 * setter will accept on nx.js.
 *
 * Two non-obvious behaviours this works around:
 *
 *  1. Multi-word family names MUST be quoted. `"30px Chakra Petch"` is
 *     parsed by the canvas font parser as `size=30px`, `family=Chakra`,
 *     `garbage=Petch` → the entire declaration is rejected and the canvas
 *     falls back to its default `10px sans-serif`. CSS strips the source
 *     quotes before this engine sees the family string, so we add them
 *     back here.
 *
 *  2. nx.js canvas rejects the entire font declaration when the named
 *     family isn't a registered FontFace — including the size. Real
 *     browsers fall back family-only and keep the size; nx.js drops to
 *     `10px sans-serif` wholesale. To make sure the SIZE still applies on
 *     custom-font pages (e.g. CSS using `'Chakra Petch'`), we always
 *     append a generic family (`sans-serif`) as a trailing fallback if the
 *     family stack doesn't already end in one. That way the parser
 *     accepts the declaration via the generic, and the engine still
 *     reports the requested size. */
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded']);

export function quoteFontFamily(family: string): string {
	const f = family.trim();
	if (!f) return 'sans-serif';
	// Split a comma-separated stack (`'Outfit', sans-serif` etc.). The CSS
	// parser passes through the comma form when there are multiple families.
	const parts = f.split(',').map((p) => p.trim()).filter(Boolean);
	const out: string[] = [];
	for (let raw of parts) {
		// Strip any existing matched quotes around this part so we can
		// re-emit with consistent double quotes.
		if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
			raw = raw.slice(1, -1);
		}
		if (!raw) continue;
		// Generics stay unquoted (required by the canvas parser).
		if (GENERIC_FAMILIES.has(raw.toLowerCase())) {
			out.push(raw.toLowerCase());
		} else if (/\s/.test(raw)) {
			out.push('"' + raw + '"');
		} else {
			out.push(raw);
		}
	}
	// Guarantee a generic fallback so unknown-family declarations still apply
	// their size. See workaround #2 in the doc-comment above.
	const lastLower = out[out.length - 1]?.toLowerCase() ?? '';
	if (!GENERIC_FAMILIES.has(lastLower)) out.push('sans-serif');
	return out.join(', ');
}

/** True iff the resolved weight is bold (numeric ≥600 or 'bold'). */
export function isBoldWeight(style: InlineStyle): boolean {
	if (style.fontWeight === 'bold') return true;
	if (typeof style.fontWeight === 'number') return style.fontWeight >= 600;
	return false;
}

/** True iff the resolved style is italic or oblique. */
export function isItalicStyle(style: InlineStyle): boolean {
	return style.fontStyle === 'italic' || style.fontStyle === 'oblique';
}

/** Serialise an InlineStyle back to css text — only the set fields. */
export function serializeStyle(style: InlineStyle): string {
	const parts: string[] = [];
	if (style.position !== undefined) parts.push('position:' + style.position);
	if (style.top !== undefined) parts.push('top:' + style.top + 'px');
	if (style.left !== undefined) parts.push('left:' + style.left + 'px');
	if (style.right !== undefined) parts.push('right:' + style.right + 'px');
	if (style.bottom !== undefined) parts.push('bottom:' + style.bottom + 'px');
	if (style.width !== undefined) parts.push('width:' + serializeLen(style.width));
	if (style.height !== undefined) parts.push('height:' + serializeLen(style.height));
	if (style.display !== undefined) parts.push('display:' + style.display);
	if (style.opacity !== undefined) parts.push('opacity:' + style.opacity);
	if (style.zIndex !== undefined) parts.push('z-index:' + style.zIndex);
	if (style.cursor !== undefined) parts.push('cursor:' + style.cursor);
	if (style.background !== undefined) parts.push('background:' + style.background);
	if (style.color !== undefined) parts.push('color:' + style.color);
	if (style.fontFamily !== undefined) parts.push('font-family:' + style.fontFamily);
	if (style.fontSize !== undefined) parts.push('font-size:' + style.fontSize + 'px');
	if (style.fontWeight !== undefined) parts.push('font-weight:' + style.fontWeight);
	if (style.fontStyle !== undefined) parts.push('font-style:' + style.fontStyle);
	if (style.textAlign !== undefined) parts.push('text-align:' + style.textAlign);
	if (style.lineHeight !== undefined) parts.push('line-height:' + style.lineHeight);
	if (style.textDecoration !== undefined) parts.push('text-decoration:' + style.textDecoration);
	if (style.verticalAlign !== undefined) parts.push('vertical-align:' + style.verticalAlign);
	if (style.listStyleType !== undefined) parts.push('list-style-type:' + style.listStyleType);
	if (style.paddingTop !== undefined) parts.push('padding-top:' + style.paddingTop + 'px');
	if (style.paddingRight !== undefined) parts.push('padding-right:' + style.paddingRight + 'px');
	if (style.paddingBottom !== undefined) parts.push('padding-bottom:' + style.paddingBottom + 'px');
	if (style.paddingLeft !== undefined) parts.push('padding-left:' + style.paddingLeft + 'px');
	if (style.marginTop !== undefined) parts.push('margin-top:' + style.marginTop + 'px');
	if (style.marginRight !== undefined) parts.push('margin-right:' + style.marginRight + 'px');
	if (style.marginBottom !== undefined) parts.push('margin-bottom:' + style.marginBottom + 'px');
	if (style.marginLeft !== undefined) parts.push('margin-left:' + style.marginLeft + 'px');
	if (style.gap !== undefined) parts.push('gap:' + style.gap + 'px');
	if (style.flexDirection !== undefined) parts.push('flex-direction:' + style.flexDirection);
	if (style.flexGrow !== undefined) parts.push('flex-grow:' + style.flexGrow);
	if (style.flexShrink !== undefined) parts.push('flex-shrink:' + style.flexShrink);
	if (style.flexBasis !== undefined) parts.push('flex-basis:' + style.flexBasis + 'px');
	if (style.alignItems !== undefined) parts.push('align-items:' + style.alignItems);
	if (style.justifyContent !== undefined) parts.push('justify-content:' + style.justifyContent);
	if (style.boxSizing !== undefined) parts.push('box-sizing:' + style.boxSizing);
	if (style.minWidth !== undefined) parts.push('min-width:' + serializeLen(style.minWidth));
	if (style.maxWidth !== undefined) parts.push('max-width:' + serializeLen(style.maxWidth));
	if (style.minHeight !== undefined) parts.push('min-height:' + serializeLen(style.minHeight));
	if (style.maxHeight !== undefined) parts.push('max-height:' + serializeLen(style.maxHeight));
	if (style.overflowX !== undefined) parts.push('overflow-x:' + style.overflowX);
	if (style.overflowY !== undefined) parts.push('overflow-y:' + style.overflowY);
	return parts.join(';');
}

/** Viewport size for `vh` / `vw` units. Defaults to the Switch's
 * 1280×720 content area; the shell can override via `setCssViewport`. */
let cssVpW = 1280;
let cssVpH = 720;
export function setCssViewport(w: number, h: number): void {
	cssVpW = w;
	cssVpH = h;
}
/** Read the current `vh` / `vw` basis. Used by the HTML-driven
 * keyboard's paint pass to save/restore the global viewport around
 * its scoped layout — its `min-height: 100vh` etc. need to resolve
 * against the keyboard-area height, not the host page's full
 * content viewport. */
export function getCssViewport(): { w: number; h: number } {
	return { w: cssVpW, h: cssVpH };
}

function parsePxOrNum(s: string): number | undefined {
	const t = s.trim();
	// Viewport units. `vh`/`vw` resolve against the content viewport.
	// (Without this, `parseFloat('100vh')` silently returned 100 and the
	// value was treated as 100px.)
	const vh = /^(-?\d+(?:\.\d+)?)vh$/.exec(t);
	if (vh) return parseFloat(vh[1]) * 0.01 * cssVpH;
	const vw = /^(-?\d+(?:\.\d+)?)vw$/.exec(t);
	if (vw) return parseFloat(vw[1]) * 0.01 * cssVpW;
	// `em` / `rem` — both resolve against the CSS default 16px base here
	// since this parser doesn't see the element's computed font-size. The
	// live-css cascade has a richer parsePxOrNum that uses the actual
	// parent font-size for *typographic* sites; this fallback covers
	// length props (min-height/min-width/etc.) that get plumbed through
	// inline-css's parseLength wrapper without that context. DDG's
	// `.result__extras { min-height: 1.57em }` resolved to 1.57px under
	// the pre-em parser, which collapsed the flex container so the next
	// sibling (snippet) stacked on top of the URL row.
	const em = /^(-?\d+(?:\.\d+)?)em$/.exec(t);
	if (em) return parseFloat(em[1]) * 16;
	const rem = /^(-?\d+(?:\.\d+)?)rem$/.exec(t);
	if (rem) return parseFloat(rem[1]) * 16;
	const px = t.endsWith('px') ? t.slice(0, -2).trim() : t;
	const n = parseFloat(px);
	return Number.isFinite(n) ? n : undefined;
}

/** Split a CSS function's argument list at TOP-LEVEL commas (so a
 * nested `min(…, …)` inside a `max(…)` isn't split apart). */
function splitTopLevelArgs(s: string): string[] {
	const out: string[] = [];
	let depth = 0, start = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
	}
	out.push(s.slice(start));
	return out;
}

/** CSS `font-size` absolute keyword → px. Values follow the web-standard
 * mapping that real browsers ship (medium = 16px is the spec default; the
 * other keywords are the historical 9/10/13/18/24/32/48 ratios from CSS
 * 2.1). Returns undefined for non-keyword input so the caller can fall
 * through to `Npx` / unit parsing. `smaller` / `larger` are NOT handled
 * here — they need the parent's computed font-size as context, which the
 * inline-style parser doesn't have. The live-CSS cascade (live-css.ts)
 * handles those separately at apply time. */
export function resolveFontSizeKeyword(value: string): number | undefined {
	const v = value.trim().toLowerCase();
	switch (v) {
		case 'xx-small': return 9;
		case 'x-small': return 10;
		case 'small': return 13;
		case 'medium': return 16;
		case 'large': return 18;
		case 'x-large': return 24;
		case 'xx-large': return 32;
		case 'xxx-large': return 48;
	}
	return undefined;
}

/** Parse a length value: `Npx`, unitless `N` → number; `N%` → percent;
 * `Nvh`/`Nvw` → px against the viewport; `min(...)`/`max(...)`/`clamp(...)`
 * → a CssMinMax resolved at layout time. */
export function parseLength(s: string): CssLength | undefined {
	const t = s.trim();
	// `clamp(min, preferred, max)` ≡ `max(min, min(preferred, max))`.
	// Expressed via the existing min/max CssMinMax nodes so resolveLength
	// handles it at layout time once the `%` / `vw` bases are known.
	const clampFn = /^clamp\(([\s\S]+)\)$/i.exec(t);
	if (clampFn) {
		const parts = splitTopLevelArgs(clampFn[1]).map((p) => parseLength(p.trim()));
		if (parts.length === 3 && parts.every((p) => p !== undefined)) {
			const [min, preferred, max] = parts as CssLength[];
			return { fn: 'max', args: [min, { fn: 'min', args: [preferred, max] }] };
		}
		return undefined;
	}
	const fn = /^(min|max)\(([\s\S]+)\)$/i.exec(t);
	if (fn) {
		const args: CssLength[] = [];
		for (const part of splitTopLevelArgs(fn[2])) {
			const a = parseLength(part.trim());
			if (a !== undefined) args.push(a);
		}
		if (args.length === 0) return undefined;
		return { fn: fn[1].toLowerCase() as 'min' | 'max', args };
	}
	if (t.endsWith('%')) {
		const n = parseFloat(t.slice(0, -1).trim());
		return Number.isFinite(n) ? { percent: n } : undefined;
	}
	return parsePxOrNum(t);
}

function serializeLen(v: CssLength): string {
	if (typeof v === 'number') return v + 'px';
	if ('fn' in v) return v.fn + '(' + v.args.map(serializeLen).join(', ') + ')';
	return v.percent + '%';
}

function clamp01(n: number): number {
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

/** Cssprop-name to JS-property-name (kebab→camel). Used by the
 * setter trap on `LiveElement.style` to support both forms — Stats
 * writes `.cssText`, `style.display` etc., but addons may write
 * `style['z-index']`. */
export function cssToJsProp(name: string): string {
	if (name.indexOf('-') < 0) return name;
	return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

export function jsToCssProp(name: string): string {
	return name.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}
