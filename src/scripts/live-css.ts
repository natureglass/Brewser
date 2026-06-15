// M2.2: CSS rules + cascade + pseudo-class state for the live-DOM
// tree. Parses `<style>` textContent via css-tree, builds a per-page
// rule registry, and exposes `getComputedLiveStyle(el)` for the
// painter to read instead of just `el.style`. Cached per-element with
// invalidation hooks on classList / attribute / pseudo-state changes
// so cascade is reactive without re-walking the whole tree per frame.
//
// Scope (this milestone — enough for lil-gui's stylesheet to work):
//   - Selectors: tag, .class, #id, *, compound (multi-class same
//     element), descendant ( ), child (>), selector list (,),
//     attribute selectors (`[name]`, `[name=value]`, `[name~=value]`).
//   - Pseudo-classes: `:active` / `:focus` / `:disabled` (per-element
//     state tracker), `:hover` (always false on touch UNLESS the
//     enclosing @media (hover:hover) — which we report as false too,
//     so :hover never matches; lil-gui's stylesheet gates hover rules
//     behind that exact media query), `:checked` (reads `el.checked`
//     once M2.4 wires it; until then false), `:empty` (no children +
//     no text), `:not(<simple>)` (negation of one compound).
//   - Pseudo-elements: `:before` / `:after` with `content: "..."`.
//     Painter reads the computed-style's `before`/`after` slots and
//     paints the content string at the element's left / right edge.
//   - @media: `(pointer:coarse)` => true, `(hover:hover)` => false,
//     anything else => true (permissive). Matches Switch reality +
//     lil-gui's own `force-touch-styles` activation.
//   - Custom properties: `--name: value` cascades down the tree;
//     `var(--name, fallback)` resolves at read time by walking up.
//   - Inheritance: `color`, `font-family`, `font-size`, `font-weight`,
//     `font-style`, `text-align`, `line-height`, `cursor` inherit
//     into descendants per CSS spec.
//
// Out of scope for M2.2 (handled later):
//   - Vendor pseudo-elements (`::-webkit-*`).
//   - `@font-face` (custom font loading — M2.6 substitutes Unicode
//     glyphs for lil-gui's icon font).
//   - `calc()` / `env()` / shorthand expansion beyond simple
//     `background` / `font` keywords.
//   - `:hover` actually firing (Switch is a touch device per
//     [[citron-no-tcp-sockets]] hardware notes).

import { generate, parse, walk, type CssNode, type Rule, type Selector } from 'css-tree';
import { bumpLiveTreeVersion, type LiveElement } from './live-dom.js';
import { parseLength, resolveFontSizeKeyword, type CssLength } from './inline-css.js';
import { markLiveDirty } from './live-paint-control.js';

// =========================================================================
// Type definitions
// =========================================================================

type AttrMatcher = '=' | '~=' | '^=' | '$=' | '*=' | '|=' | 'has';
interface AttrPredicate {
	name: string;
	matcher: AttrMatcher;
	value: string;
}

type SimplePseudo =
	| { kind: 'active' }
	| { kind: 'focus' }
	| { kind: 'hover' }
	| { kind: 'disabled' }
	| { kind: 'checked' }
	| { kind: 'empty' }
	| { kind: 'not'; inner: Compound }
	/** Positional pseudo-classes. `a` and `b` express the formula
	 * `an + b` per CSS spec; e.g. `:nth-child(odd)` → a=2 b=1,
	 * `:nth-child(3)` → a=0 b=3, `:nth-child(2n+1)` → a=2 b=1.
	 * `ofType` true for `:nth-of-type`/`:first-of-type`/etc — counts
	 * only same-tag siblings. `fromEnd` true for `:nth-last-child`. */
	| { kind: 'nth'; a: number; b: number; ofType: boolean; fromEnd: boolean };

interface Compound {
	tag?: string;
	id?: string;
	classes: string[];
	attrs: AttrPredicate[];
	pseudos: SimplePseudo[];
}

// Selector combinators. `' '` = descendant, `'>'` = child, `'+'` =
// adjacent sibling, `'~'` = general sibling. Sibling combinators were
// added (2026-06-10) to support CSS-only radio-button tab UIs on the
// internal apps page: `input:checked ~ .panels .panel[data-tab="X"]`
// switches which panel is visible by reacting to the active tab's
// `:checked` flip. See matchChain for the right-to-left walk logic.
type Combinator = ' ' | '>' | '+' | '~';

interface SelectorChain {
	compounds: Compound[];
	combinators: Combinator[];
	/** `:before` / `:after` from the rightmost compound (only one allowed). */
	pseudoElement: 'before' | 'after' | null;
}

interface ParsedDecl {
	prop: string;
	value: string;
}

interface ParsedRule {
	chain: SelectorChain;
	decls: ParsedDecl[];
	/** [id, class, type] specificity tuple (no inline component here). */
	specificity: readonly [number, number, number];
	source: number;
	/** False when the rule sits inside a @media block that doesn't match
	 * our Switch-touch profile — skipped during cascade. */
	mediaActive: boolean;
}

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
	// Box-painting fields (a pseudo with `content: ""` that draws a
	// decorative background box rather than text — e.g. a tiled grid
	// overlay). The painter draws these for ::before (below host content)
	// and ::after.
	background?: string;
	backgroundLayers?: BackgroundLayer[];
	backgroundSize?: { w: number; h: number };
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
	backgroundSize?: { w: number; h: number };
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: 'normal' | 'bold' | number;
	fontStyle?: 'normal' | 'italic' | 'oblique';
	textAlign?: 'left' | 'center' | 'right' | 'start' | 'end';
	lineHeight?: number;
	textDecoration?: 'none' | 'underline' | 'line-through' | 'overline';
	verticalAlign?: 'baseline' | 'super' | 'sub';
	listStyleType?: 'none' | 'disc' | 'circle' | 'square'
		| 'decimal' | 'lower-alpha' | 'upper-alpha'
		| 'lower-roman' | 'upper-roman';
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
	// M2.6: positioning props through the cascade so class-based rules
	// like lil-gui's `.lil-gui.autoPlace { position: fixed; right: 15px; top: 0 }`
	// drive layout (previously only inline `style.position = 'fixed'` worked).
	position?: 'static' | 'fixed' | 'absolute' | 'relative';
	top?: number;
	left?: number;
	right?: number;
	bottom?: number;
	// Percentage offsets (kept separate from the px `top`/`left`/... so the
	// existing px read-sites stay plain numbers). Resolved against the
	// containing block in the absolute-layout pass — e.g. `left: 50%` for a
	// centered overlay. % on fixed/relative isn't wired (rare).
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
	transform?: { tx?: CssLength; ty?: CssLength; rotateRad?: number; scaleX?: number; scaleY?: number };
	/** Parsed `animation: <name> <duration> [<timing>] [<iter>] [<delay>]`
	 * shorthand. Picked up by the CSS-animation tick in live-dom.ts to
	 * spin up a 60Hz runtime that interpolates the keyframes for this
	 * element. Only set when both name AND duration are present. */
	animation?: { name: string; durationMs: number; iterationCount: number | 'infinite'; timing: string };
	zIndex?: number;
	// M2.3 layout.
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
	// Borders (M2.6) — paint-only; layout box-sizing ignores them.
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
	borderRadius?: { px: number } | { percent: number };
	/** Parsed `box-shadow:` list. Painter renders outer shadows behind
	 * the background, inset shadows on top of it. */
	boxShadow?: BoxShadow[];
	// M2.5 overflow.
	overflowX?: 'visible' | 'hidden' | 'scroll' | 'auto';
	overflowY?: 'visible' | 'hidden' | 'scroll' | 'auto';
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
	// SVG paint properties cascaded into computed style so authors can
	// style inline `<svg>` icons via CSS rules instead of inline
	// `fill="..."` / `stroke="..."` attributes. The svg-painter's
	// LIVE_SVG_ADAPTER consults these as a fallback when no inline attr
	// is set, and the inheritance pass below copies them down to
	// descendants (paths under an svg inherit the svg's paint, matching
	// the SVG spec).
	fill?: string;
	stroke?: string;
	strokeWidth?: string;
}

// =========================================================================
// Per-page registry
// =========================================================================

/** Map of <style> LiveElement → rules parsed from its textContent.
 * Cleared on page navigation when the documentShim re-resets. */
const styleSheets = new Map<LiveElement, ParsedRule[]>();
/** Reserved cascade slot per `<style>` LiveElement. Slots are integers
 * that pre-encode DOM-order position among `<head>` stylesheets so
 * async `<link rel=stylesheet>` rules can slot in at their original
 * head position even though their fetch resolves after inline
 * `<style>` blocks already registered.
 *
 * Without this, an external sheet that loaded async always ended up
 * with HIGHER source numbers than inline `<style>`, so on equal-
 * specificity tiebreaks the external rule won. Real browsers resolve
 * by DOM order — an inline `<style>` AFTER a `<link>` overrides the
 * link even if it parsed first. The login page repro: a `<link rel=
 * stylesheet>` to main.css with `.app-grid { repeat(4,...) }` was
 * winning over a subsequent inline `<style>` with `.signin-grid {
 * repeat(3,...) }` because of registration order.
 *
 * Slot 0 is reserved for "no slot assigned" (falls back to the
 * monotonic counter, used by page scripts that mutate stylesheets
 * post-load and for the kb scope). DOM-walk-time reservations start
 * at slot 1. */
const sheetSlot = new WeakMap<LiveElement, number>();
let nextSheetSlot = 1;
/** Multiplier separating sheets in cascade-source space. 1M rules per
 * sheet is the cap; pages we ship are nowhere near. */
const SHEET_SOURCE_STRIDE = 1_000_000;
/** Monotonic source counter for rules in sheets that have no reserved
 * slot. Bumped past the maximum reserved slot range so unreserved
 * sheets always sort AFTER reserved ones in source order. (Reserves
 * happen first during head-walk; runtime-added sheets register later
 * and naturally cascade-win the tiebreak — same as real browsers'
 * document-order rule for runtime `document.head.appendChild(style)`.) */
let nextSource = 0;
/** Computed-style cache. Invalidated on classList / attr / pseudo-state
 * changes (see `invalidateLiveStyle`). */
const computedCache = new WeakMap<LiveElement, ComputedLiveStyle>();
/** Per-element pseudo-class state. */
const activeElements = new WeakSet<LiveElement>();
const focusElements = new WeakSet<LiveElement>();
/** (2026-06-10) Engine-mouse hover state. Touch never sets this; only the
 * page-mouse-forwarder's `updateHover` does. Tracks the LEAF element under
 * the cursor — ancestor `:hover` rules are evaluated by the matcher via
 * the optional virtual-pseudo path, but the source-of-truth set only
 * contains the deepest hit. (Real browsers propagate `:hover` to all
 * ancestors of the hovered element; we keep it leaf-only to match the
 * existing `:active` convention in this file.) */
const hoverElements = new WeakSet<LiveElement>();

/** Phase 2.5.1 perf fix (2026-05-25): track which stylesheets contain
 * rules that reference :active / :focus / :checked pseudo-classes. When
 * a sheet has none, the corresponding `setPseudoActive` / `setPseudoFocus`
 * / `setInputChecked-attribute-mirror` invalidation is a no-op visually
 * — no cascade rule reacts to the state change. Skipping the
 * `invalidateLiveStyle` call avoids a full-rebuild trigger per tap.
 * Without this, EVERY tap (radio / checkbox / link / div / anywhere)
 * caused a ~1-2 second freeze because:
 *   1. touchstart fires setPseudoActive(true) → bump
 *   2. handleFormTap mutations + patchAndSync (sync version)
 *   3. touchend fires setPseudoActive(false) → bump AFTER sync
 *   4. next paint sees mismatch → full cache rebuild = ~80-150 ms × Citron
 */
const stylesheetsWithActive = new Set<LiveElement>();
const stylesheetsWithFocus = new Set<LiveElement>();
const stylesheetsWithChecked = new Set<LiveElement>();
const stylesheetsWithHover = new Set<LiveElement>();
/** (2026-06-10) Stylesheets containing at least one rule with a
 * sibling combinator (`+` or `~`). A `:checked` flip on a radio button
 * can change the cascade of LATER siblings (e.g. `input:checked ~
 * .panel`); the radio-click fast path in live-form.ts patches only the
 * radios themselves and would leave those panels stale. Pages with no
 * sibling rules keep the fast path; pages with sibling rules pay the
 * cost of a full rebuild on each radio click — acceptable since taps
 * on tab UIs are rare. */
const stylesheetsWithSibling = new Set<LiveElement>();

function rulesUsePseudo(rules: ParsedRule[], kind: 'active' | 'focus' | 'checked' | 'hover'): boolean {
	for (const rule of rules) {
		for (const compound of rule.chain.compounds) {
			for (const pseudo of compound.pseudos) {
				if (pseudo.kind === kind) return true;
				if (pseudo.kind === 'not' && pseudo.inner.pseudos.some((p) => p.kind === kind)) {
					return true;
				}
			}
		}
	}
	return false;
}

/** True iff any rule's selector chain uses `+` or `~`. Used to gate
 * the radio-click fast path: when the cascade depends on sibling
 * traversal, a localised patch is insufficient and a full rebuild is
 * required. */
function rulesUseSibling(rules: ParsedRule[]): boolean {
	for (const rule of rules) {
		for (const c of rule.chain.combinators) {
			if (c === '+' || c === '~') return true;
		}
	}
	return false;
}

function chainUsesPseudo(chain: SelectorChain, kind: 'active' | 'focus' | 'checked' | 'hover'): boolean {
	for (const compound of chain.compounds) {
		for (const pseudo of compound.pseudos) {
			if (pseudo.kind === kind) return true;
			if (pseudo.kind === 'not' && pseudo.inner.pseudos.some((p) => p.kind === kind)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Per-element guard for `setPseudoActive` invalidation. Iterates only
 * the rules that mention `:active` in their selector; for each, asks
 * "does this rule's match status differ between (this element is
 * :active) and (this element is NOT :active)?" — i.e., does the
 * cascade FOR THIS element actually depend on its :active state?
 *
 * The "two-run differ" check (with vs. without virtualActiveOn)
 * handles both positive selectors (`.btn:active`) and negated ones
 * (`.btn:not(:active)`) correctly: in either case the rule changes
 * its match result when :active flips, and we return true to
 * trigger invalidation. Rules whose match doesn't depend on
 * el's :active (e.g. `.other:active` on an unrelated div tap) skip
 * the invalidation entirely — fixing the "tap anywhere causes a
 * full repaint" symptom on pages whose author CSS has a few
 * `:active` rules targeting specific classes.
 */
// 2026-06-10 BUG FIX: these gate functions used to compare a forced-on
// match against an "actual state" match (without override). That was
// broken because the caller `setPseudoActive` / `setPseudoFocus` /
// `setPseudoHover` mutated the underlying set (`activeElements.add(el)`
// etc.) BEFORE invoking the gate, so the "actual state" check already
// reflected the new value. The forced-on result then matched the now-
// already-on actual state → the gate returned `false` → invalidation
// skipped → cascade never re-resolved → press visual never painted.
// (Same bug applied symmetrically on the off direction.)
//
// Fix: force the off side explicitly too, so the comparison is "would
// rule X match the same in active=on vs active=off on `el`?" — fully
// independent of the underlying set's current state. The mutation
// order in the callers no longer matters.
function someActiveRuleAffectsElement(el: LiveElement): boolean {
	for (const rules of styleSheets.values()) {
		for (const rule of rules) {
			if (!chainUsesPseudo(rule.chain, 'active')) continue;
			const withActive = matchChain(rule.chain, el, { activeOn: el });
			const withoutActive = matchChain(rule.chain, el, { activeOff: el });
			if (withActive !== withoutActive) return true;
		}
	}
	return false;
}

function someFocusRuleAffectsElement(el: LiveElement): boolean {
	for (const rules of styleSheets.values()) {
		for (const rule of rules) {
			if (!chainUsesPseudo(rule.chain, 'focus')) continue;
			const withFocus = matchChain(rule.chain, el, { focusOn: el });
			const withoutFocus = matchChain(rule.chain, el, { focusOff: el });
			if (withFocus !== withoutFocus) return true;
		}
	}
	return false;
}

/** Same shape as `someActiveRuleAffectsElement`/`...Focus...` — checks
 * whether toggling `:hover` on `el` would change ANY rule's match result
 * against `el`. Used by `setPseudoHover` to skip invalidation when the
 * page's CSS doesn't react to hover on this element. */
function someHoverRuleAffectsElement(el: LiveElement): boolean {
	for (const rules of styleSheets.values()) {
		for (const rule of rules) {
			if (!chainUsesPseudo(rule.chain, 'hover')) continue;
			const withHover = matchChain(rule.chain, el, { hoverOn: el });
			const withoutHover = matchChain(rule.chain, el, { hoverOff: el });
			if (withHover !== withoutHover) return true;
		}
	}
	return false;
}

/** Reset all M2.2 state. Called by `resetLiveRoot` on navigation so
 * a leaving page's rules + caches don't bleed into the next. */
export function resetLiveCss(): void {
	styleSheets.clear();
	// sheetSlot is a WeakMap so entries die with their LiveElements
	// after resetLiveRoot drops the live tree; explicit clear isn't
	// possible and isn't needed. Reset the counters so the next page
	// starts fresh at slot 1.
	nextSheetSlot = 1;
	nextSource = 0;
	stylesheetsWithActive.clear();
	stylesheetsWithFocus.clear();
	stylesheetsWithChecked.clear();
	stylesheetsWithHover.clear();
	stylesheetsWithSibling.clear();
	// WeakMap/WeakSet entries die with the LiveElements they referenced.
}

/** Reserve a cascade slot for `styleEl` in DOM-order position. Called
 * by `html-to-live`'s head-walk for both inline `<style>` and `<link
 * rel=stylesheet>` placeholders BEFORE either registers any rules.
 * The returned slot is stable across re-registrations of the same
 * element (e.g. an async `<link>` populating its placeholder after
 * fetch). Idempotent — repeated calls return the same slot. */
export function reserveStylesheetSlot(styleEl: LiveElement): number {
	let slot = sheetSlot.get(styleEl);
	if (slot === undefined) {
		slot = nextSheetSlot++;
		sheetSlot.set(styleEl, slot);
	}
	return slot;
}

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
export function clearStylesheetSlot(styleEl: LiveElement): void {
	sheetSlot.delete(styleEl);
}

/** Register (or re-register) the rules parsed from `<style>` element
 * `styleEl`'s textContent. Called by LiveStyleElement on textContent /
 * innerHTML assignment and on appendChild into document.head. */
export function registerStyleSheet(styleEl: LiveElement, cssText: string): void {
	// Source-base derives from the sheet's reserved slot if any (head-walk
	// reserved it), else from the monotonic post-reserved counter. Either
	// way, rules within this sheet get consecutive source numbers
	// (baseSource + i), preserving intra-sheet ordering.
	const slot = sheetSlot.get(styleEl);
	const baseSource = (slot !== undefined)
		? slot * SHEET_SOURCE_STRIDE
		: (nextSheetSlot * SHEET_SOURCE_STRIDE) + nextSource;
	const rules = parseStyleSheet(cssText, baseSource);
	if (slot === undefined) nextSource += rules.length;
	styleSheets.set(styleEl, rules);
	// Track per-stylesheet pseudo-class usage so setPseudoActive /
	// setPseudoFocus can skip invalidation on pages with no matching rule.
	if (rulesUsePseudo(rules, 'active')) stylesheetsWithActive.add(styleEl);
	else stylesheetsWithActive.delete(styleEl);
	if (rulesUsePseudo(rules, 'focus')) stylesheetsWithFocus.add(styleEl);
	else stylesheetsWithFocus.delete(styleEl);
	if (rulesUsePseudo(rules, 'checked')) stylesheetsWithChecked.add(styleEl);
	else stylesheetsWithChecked.delete(styleEl);
	if (rulesUsePseudo(rules, 'hover')) stylesheetsWithHover.add(styleEl);
	else stylesheetsWithHover.delete(styleEl);
	if (rulesUseSibling(rules)) stylesheetsWithSibling.add(styleEl);
	else stylesheetsWithSibling.delete(styleEl);
	// Whole cache invalid — any element's computed style could change.
	computedCache.delete(styleEl);
	clearComputedCache();
	bumpLiveTreeVersion();
}

/** Drop the rules for a <style> element (e.g. it was removed from
 * the tree). */
export function unregisterStyleSheet(styleEl: LiveElement): void {
	if (styleSheets.delete(styleEl)) {
		stylesheetsWithActive.delete(styleEl);
		stylesheetsWithFocus.delete(styleEl);
		stylesheetsWithChecked.delete(styleEl);
		stylesheetsWithHover.delete(styleEl);
		stylesheetsWithSibling.delete(styleEl);
		clearComputedCache();
		bumpLiveTreeVersion();
	}
}

/** True iff at least one registered stylesheet has a rule matching the
 * named pseudo-class. Used by the pseudo-state setters to skip invalid-
 * ation when no cascade rule reacts to the state. (2026-05-25) */
export function someStylesheetUsesActive(): boolean { return stylesheetsWithActive.size > 0; }
export function someStylesheetUsesFocus(): boolean { return stylesheetsWithFocus.size > 0; }
export function someStylesheetUsesChecked(): boolean { return stylesheetsWithChecked.size > 0; }
export function someStylesheetUsesHover(): boolean { return stylesheetsWithHover.size > 0; }
/** True iff some registered stylesheet uses a `+` or `~` combinator.
 * The radio-click fast path in live-form.ts consults this — when true,
 * the cascade for sibling subtrees can change with the `:checked`
 * flip, so a localised patch isn't enough and the caller must force a
 * full rebuild. */
export function someStylesheetUsesSibling(): boolean { return stylesheetsWithSibling.size > 0; }

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
export function invalidateForSiblingCascade(_el: LiveElement): void {
	if (stylesheetsWithSibling.size === 0) return;
	clearComputedCache();
	resetLayoutCachesForSiblingCascade();
	bumpLiveTreeVersion();
}

// Layout cache lives in live-layout.ts but we need to clear it from
// here. The setter is wired by live-layout.ts at module load so this
// module doesn't have to import from layout (which would create a
// cycle via live-css → live-layout → live-css).
let layoutCacheResetFn: (() => void) | null = null;
export function setLayoutCacheResetFn(fn: () => void): void {
	layoutCacheResetFn = fn;
}
function resetLayoutCachesForSiblingCascade(): void {
	if (layoutCacheResetFn) layoutCacheResetFn();
}

/** Invalidate the computed-style cache for one element (and its
 * descendants — they may have inherited from it). Cheap to call on
 * every classList toggle / attribute change.
 *
 * Phase 1.5: when called with a specific element, also bumps the
 * live-tree version so paintLiveOverlay knows to invalidate its cached
 * layout boxes. The null-el path (per-frame global clear from
 * paintLiveOverlay itself) does NOT bump — that's the very call we're
 * trying to make optional. */
export function invalidateLiveStyle(el?: LiveElement | null): void {
	if (!el) {
		clearComputedCache();
		return;
	}
	walkInvalidate(el);
	markLiveDirty(el);
	// 2026-06-14: pass `el` so per-modal mutations route the bump to
	// `modalTreeVersion` instead of the host's `liveTreeVersion`. Without
	// this, every `setAttribute` / `classList` change inside a modal
	// subtree (each calls `invalidateLiveStyle(el)`) was still bumping
	// the host version, defeating most of the host-cache-warmth win the
	// modal-layer quarantine was meant to deliver.
	bumpLiveTreeVersion(el);
}

function walkInvalidate(el: LiveElement): void {
	computedCache.delete(el);
	for (const c of el.children) walkInvalidate(c);
}

function clearComputedCache(): void {
	// WeakMap has no .clear() and isn't iterable; track every element
	// inserted (`touchedSinceClear`) so we can delete each entry on
	// global invalidation (e.g. a new stylesheet was registered).
	// Stale entries left over from elements that aren't in the tracker
	// still die naturally when the LiveElement is GC'd.
	touchedSinceClear.forEach((e) => computedCache.delete(e));
	touchedSinceClear.clear();
}

const touchedSinceClear = new Set<LiveElement>();

/** Per-element press refcount. Bumped on each `setPseudoActive(el, true)`
 * call and decremented on `setPseudoActive(el, false)`. The element
 * appears in `activeElements` (and `:active` selectors match) while the
 * count is > 0. Needed because beginLivePress propagates `:active` up
 * the ancestor chain (so `.app-card:active` matches when the user taps
 * an `<img>` inside the card) — two rapid taps on sibling leaves under
 * the same ancestor would both set, then one timer would PREMATURELY
 * clear the still-pressed shared ancestor without refcounting. */
const activeRefcount = new WeakMap<LiveElement, number>();
/** Pseudo-class state setters wired by the touch handler. Setting
 * also invalidates the element so the next paint walk re-resolves. */
export function setPseudoActive(el: LiveElement | null, on: boolean): void {
	if (!el) return;
	const prev = activeRefcount.get(el) ?? 0;
	const next = on ? prev + 1 : Math.max(0, prev - 1);
	if (next === 0) activeRefcount.delete(el);
	else activeRefcount.set(el, next);
	// Mutate the source-of-truth WeakSet only on the 0↔1 transition;
	// intermediate count changes don't flip the element's `:active`
	// match state, so no cascade invalidation either.
	const wasActive = prev > 0;
	const isActive = next > 0;
	if (wasActive === isActive) return;
	if (isActive) activeElements.add(el);
	else activeElements.delete(el);
	// Per-element gate (2026-06-09): the previous gate was page-wide
	// — "ANY stylesheet has ANY :active rule" — which fired
	// invalidation on every tap once a page (e.g. the welcome page's
	// main.css) had any :active rules at all, even when the tapped
	// element couldn't possibly match one of them. The per-element
	// check below asks the strict question — "would toggling el's
	// :active state actually change SOME rule's match result against
	// el?" — and skips invalidation when the answer is no. Result:
	// taps on body / text / non-interactive divs no longer trigger
	// a cascade rebuild + full repaint.
	if (stylesheetsWithActive.size > 0 && someActiveRuleAffectsElement(el)) {
		invalidateLiveStyle(el);
	}
}
export function setPseudoFocus(el: LiveElement | null, on: boolean): void {
	if (!el) return;
	if (on) focusElements.add(el);
	else focusElements.delete(el);
	if (stylesheetsWithFocus.size > 0 && someFocusRuleAffectsElement(el)) {
		invalidateLiveStyle(el);
	}
}
/** Engine-mouse hover sink. The page-mouse-forwarder calls this on hover
 * transitions; touch never does. Same per-element guard as `setPseudoActive`
 * — only invalidate when the page actually has a `:hover` rule whose match
 * depends on this element's hover state, otherwise idle cursor motion over
 * any non-styled element would force a cascade rebuild every frame. */
export function setPseudoHover(el: LiveElement | null, on: boolean): void {
	if (!el) return;
	if (on) hoverElements.add(el);
	else hoverElements.delete(el);
	if (stylesheetsWithHover.size > 0 && someHoverRuleAffectsElement(el)) {
		invalidateLiveStyle(el);
	}
}
export function isPseudoActive(el: LiveElement): boolean { return activeElements.has(el); }
export function isPseudoFocus(el: LiveElement): boolean { return focusElements.has(el); }
export function isPseudoHover(el: LiveElement): boolean { return hoverElements.has(el); }

// =========================================================================
// UA default stylesheet
// =========================================================================

/** Per-tag baseline styles applied before any author rule. Real browsers
 * ship a much bigger UA stylesheet (html.spec.whatwg.org/Rendering); we
 * implement only the slice the DOM-elements showcase exercises:
 * inline-formatting fallbacks (`<strong>` bold, `<em>` italic, `<u>`
 * underline, …), heading sizes + bold, monospace for code/kbd/samp/pre,
 * `<mark>` highlight bg, `<small>` smaller font. Anything author CSS sets
 * overrides these. Returned object is mutated into the per-call `computed`
 * accumulator. */
function applyUaDefaults(computed: ComputedLiveStyle, tag: string, el: LiveElement): void {
	// Text nodes participate in inline-formatting context.
	if (tag === '#text') { computed.display = 'inline'; return; }
	switch (tag) {
		// Inline-formatting tags (Phase 2.5 inline flow, 2026-05-25):
		// `display: inline` is the UA default for text-level elements.
		// Live layout's IFC detection (`layoutChildren` → `layoutInline`)
		// flows these as words within their parent block's line boxes.
		// `<address>` stays block per HTML spec.
		case 'STRONG':
		case 'B':
			computed.display = 'inline';
			computed.fontWeight = 'bold'; return;
		case 'EM':
		case 'I':
		case 'DFN':
		case 'CITE':
		case 'VAR':
			computed.display = 'inline';
			computed.fontStyle = 'italic'; return;
		case 'ADDRESS':
			computed.fontStyle = 'italic'; return;
		case 'U':
		case 'INS':
			computed.display = 'inline';
			computed.textDecoration = 'underline'; return;
		case 'DEL':
		case 'S':
		case 'STRIKE':
			computed.display = 'inline';
			computed.textDecoration = 'line-through'; return;
		case 'A':
			computed.display = 'inline';
			computed.color = '#7eda9f';
			computed.textDecoration = 'underline';
			return;
		case 'MARK':
			computed.display = 'inline';
			computed.background = '#ffd35e';
			computed.color = '#1a1a1a';
			return;
		case 'SUP':
			computed.display = 'inline';
			computed.verticalAlign = 'super';
			computed.fontSize = 11;
			return;
		case 'SUB':
			computed.display = 'inline';
			computed.verticalAlign = 'sub';
			computed.fontSize = 11;
			return;
		case 'SMALL':
			computed.display = 'inline';
			computed.fontSize = 13; return;
		case 'SPAN':
		case 'ABBR':
		case 'Q':
		case 'TIME':
		case 'BDO':
		case 'BDI':
			computed.display = 'inline'; return;
		case 'CODE':
		case 'KBD':
		case 'SAMP':
		case 'TT':
			computed.display = 'inline';
			computed.fontFamily = 'monospace'; return;

		// Block formatting.
		case 'PRE':
			computed.fontFamily = 'monospace';
			computed.marginTop = 8;
			computed.marginBottom = 8;
			return;
		// Heading UA defaults: ONLY margins + bold. Font-size dropped on
		// purpose so author CSS (a `.card h2 { font-size:26px }` etc.) can
		// control size directly without competing against a baked-in number
		// — the previous defaults (32/24/19/16/14/12) were close to common
		// author values, making small bumps look like they "did nothing"
		// when actually a hardcoded UA size was winning. With no UA size,
		// h1-h6 fall back to the inherited body font-size unless author
		// CSS sets one, which matches what authors usually expect.
		case 'H1':
			computed.fontWeight = 'bold';
			computed.marginTop = 16; computed.marginBottom = 12;
			return;
		case 'H2':
			computed.fontWeight = 'bold';
			computed.marginTop = 14; computed.marginBottom = 10;
			return;
		case 'H3':
			computed.fontWeight = 'bold';
			computed.marginTop = 12; computed.marginBottom = 8;
			return;
		case 'H4':
			computed.fontWeight = 'bold';
			computed.marginTop = 10; computed.marginBottom = 8;
			return;
		case 'H5':
			computed.fontWeight = 'bold';
			computed.marginTop = 10; computed.marginBottom = 6;
			return;
		case 'H6':
			computed.fontWeight = 'bold';
			computed.marginTop = 10; computed.marginBottom = 6;
			return;
		case 'P':
			computed.marginTop = 8; computed.marginBottom = 8;
			return;
		// `<iframe>` — UA default is `overflow: auto` so embedded content
		// that exceeds the iframe's declared box height is scrollable
		// (with a visible scrollbar) instead of just being clipped. The
		// existing inner-scroll architecture handles this via
		// scrollOverlayEls + per-container offscreen cache + paintLive-
		// ScrollbarV (see [[swb-live-dom-inner-scroll]]). The iframe
		// element gets added to `scrollOut` by collectPaintOps;
		// grafted children render into a per-container offscreen
		// (sized contentW × intrinsicContentH) and the visible slice
		// is blitted on top of the iframe's bg / border. Touch-swipe
		// over the iframe scrolls via `findScrollableAncestor`.
		case 'IFRAME':
			computed.overflowX = 'auto';
			computed.overflowY = 'auto';
			return;
		case 'BLOCKQUOTE':
			computed.marginTop = 8; computed.marginBottom = 8;
			computed.marginLeft = 24; computed.marginRight = 24;
			return;
		case 'FIGURE':
			computed.marginTop = 8; computed.marginBottom = 8;
			computed.marginLeft = 24; computed.marginRight = 24;
			return;
		case 'FIGCAPTION':
			computed.fontStyle = 'italic';
			computed.textAlign = 'center';
			return;
		case 'HR':
			computed.marginTop = 8; computed.marginBottom = 8;
			return;
		case 'BR':
			// BR is inline so it participates in line-box flow and forces
			// a line break per HTML spec. Detected by tag in layoutInline.
			computed.display = 'inline';
			return;
		case 'IMG':
			// IMG is replaced-inline per HTML spec — flows in line boxes
			// at its natural / explicit size. Layout treats it as a leaf
			// atom in the line.
			computed.display = 'inline';
			return;
		case 'CANVAS':
			// CANVAS is replaced-inline per HTML spec — without this, a
			// block-layout canvas inside `<div style="text-align:center">`
			// won't honor the centering directive (block children ignore
			// text-align). Layout treats it as a leaf atom in the line,
			// mirroring IMG.
			computed.display = 'inline';
			return;
		// Lists (Batch C, 2026-05-25). Padding-left reserves room for
		// the marker; LI itself has no own padding. `list-style-type` is
		// inherited so nested lists pick up the ancestor's setting unless
		// overridden; `<ol type="...">` is honored by the painter as a
		// fallback when CSS doesn't set list-style-type.
		case 'UL':
			computed.listStyleType = 'disc';
			computed.marginTop = 8; computed.marginBottom = 8;
			computed.paddingLeft = 30;
			return;
		case 'OL':
			computed.listStyleType = 'decimal';
			computed.marginTop = 8; computed.marginBottom = 8;
			computed.paddingLeft = 30;
			return;
		// Table widgets — layoutTable handles the actual cell grid.
		// `display: table` triggers the layoutChildren dispatch.
		case 'TABLE':
			computed.display = 'table';
			computed.marginTop = 12; computed.marginBottom = 12;
			return;
		case 'TH':
			computed.fontWeight = 'bold';
			computed.textAlign = 'center';
			return;
		case 'CAPTION':
			computed.fontStyle = 'italic';
			computed.textAlign = 'center';
			return;
		// Form widgets — vertical UA margins so stacked widgets don't
		// fuse together. Real Chrome/Firefox/Safari ship `margin: 0`
		// on `<input>`/`<button>` and rely on inline-block line-height
		// for visual breathing room, but our engine renders form
		// widgets as block-level via layoutLeaf, so the gap has to be
		// added explicitly. 3 + 3 = 6 px between adjacent widgets
		// matches what tier3-style pages look like in a real browser.
		// Author CSS still overrides via the normal cascade.
		// `<input type=hidden>` zero-sizes itself in layoutLeaf so the
		// margin doesn't push siblings around for hidden fields.
		//
		// SKIP when the parent is a flex container — there the widget
		// is a flex item, not a block-level box, and the UA margin
		// fights phase-3 cross-axis stretch (was: a `<input>` flex
		// item in a row container ended up centered with crossSize
		// reduced by `margin-top + margin-bottom = 6 px`, so the input
		// rendered ~6 px shorter than its sibling DIVs even though the
		// row's `align-items: stretch` was meant to give them all the
		// same height). Author CSS can still set explicit margins for
		// the flex case via the normal cascade.
		case 'INPUT':
		case 'BUTTON':
		case 'SELECT':
		case 'TEXTAREA': {
			if (el.parent) {
				const parentCs = getComputedLiveStyle(el.parent);
				if (parentCs.display === 'flex' || parentCs.display === 'inline-flex') {
					return;
				}
			}
			computed.marginTop = 3;
			computed.marginBottom = 3;
			return;
		}
		// Non-rendered elements. STYLE is the load-bearing one — body-
		// level `<style>` blocks were rendering their CSS source as
		// visible text (Google's `/search` "Update je browser" page
		// surfaced this as a `.MAeEl{font-size:16px…}` strip at the
		// top). SCRIPT/HEAD/TITLE/META/LINK/NOSCRIPT are mostly already
		// filtered by `html-to-live.SKIP_TAGS`, but page scripts can
		// create them dynamically (e.g. `document.createElement
		// ('script')`), and matching the spec UA defaults here means
		// such nodes never paint regardless of how they entered the
		// tree.
		case 'STYLE':
		case 'SCRIPT':
		case 'HEAD':
		case 'TITLE':
		case 'META':
		case 'LINK':
		case 'NOSCRIPT':
			computed.display = 'none';
			return;
	}
}

/**
 * Apply HTML presentational hint attributes to `computed`.
 *
 * Pre-CSS layouts (and Google's tier3 mobile page) lean heavily on
 * `<img width=N>`, `<table width=N%>`, `<td width=N>`, `<input size=N>`
 * etc. for sizing. Per HTML5 these are "presentational hints" that
 * contribute to the cascade at user-agent specificity, so author CSS
 * still wins — modelled by writing into `computed` between
 * `applyUaDefaults` and the matched-rule pass.
 *
 * Only the hints actually surfaced by tier3 + common legacy markup are
 * covered; obscure ones (`<font color>`, `<basefont>`, `<marquee>`,
 * etc.) are intentionally omitted.
 */
function applyPresentationalHints(computed: ComputedLiveStyle, el: LiveElement): void {
	const tag = el.tagName;

	if (tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO' || tag === 'OBJECT' || tag === 'EMBED') {
		setLenAttr(computed, 'width', el.getAttribute('width'));
		setLenAttr(computed, 'height', el.getAttribute('height'));
		return;
	}

	if (tag === 'TABLE') {
		setLenAttr(computed, 'width', el.getAttribute('width'));
		setLenAttr(computed, 'height', el.getAttribute('height'));
		return;
	}

	if (tag === 'TD' || tag === 'TH') {
		setLenAttr(computed, 'width', el.getAttribute('width'));
		setLenAttr(computed, 'height', el.getAttribute('height'));
		// Cell horizontal alignment defaults: legacy `<td align=…>`
		// hint. `justify` is dropped — `computed.textAlign` doesn't
		// support it and the engine has no justify rasterisation path.
		const align = (el.getAttribute('align') ?? '').toLowerCase();
		if (align === 'left' || align === 'right' || align === 'center') {
			computed.textAlign = align;
		}
		return;
	}

	if (tag === 'TR') {
		setLenAttr(computed, 'height', el.getAttribute('height'));
		return;
	}

	if (tag === 'HR') {
		setLenAttr(computed, 'width', el.getAttribute('width'));
		return;
	}

	if (tag === 'INPUT') {
		const type = (el.getAttribute('type') ?? 'text').toLowerCase();
		if (type === 'image') {
			setLenAttr(computed, 'width', el.getAttribute('width'));
			setLenAttr(computed, 'height', el.getAttribute('height'));
			return;
		}
		// Text-family inputs: HTML's `size` attribute is roughly "N
		// characters wide." We don't have proper character-width metrics
		// at cascade time, so approximate with the font size (or the 14px
		// default) × ~0.55. Matches what real browsers do within ±20% and
		// makes tier3's `<input size=35>` paint visibly.
		if (
			type === 'text' || type === 'search' || type === 'email' || type === 'url'
			|| type === 'tel' || type === 'password' || type === '' || type === 'number'
		) {
			const sizeStr = el.getAttribute('size');
			if (sizeStr) {
				const n = parseInt(sizeStr, 10);
				if (Number.isFinite(n) && n > 0) {
					const fontPx = typeof computed.fontSize === 'number' ? computed.fontSize : 14;
					// 4px each side of internal padding so the value text
					// has breathing room inside the painted box.
					computed.width = Math.round(n * fontPx * 0.55 + 8);
				}
			}
		}
		return;
	}

	if (tag === 'TEXTAREA') {
		const colsStr = el.getAttribute('cols');
		const rowsStr = el.getAttribute('rows');
		if (colsStr) {
			const n = parseInt(colsStr, 10);
			if (Number.isFinite(n) && n > 0) {
				const fontPx = typeof computed.fontSize === 'number' ? computed.fontSize : 14;
				computed.width = Math.round(n * fontPx * 0.55 + 8);
			}
		}
		if (rowsStr) {
			const n = parseInt(rowsStr, 10);
			if (Number.isFinite(n) && n > 0) {
				const fontPx = typeof computed.fontSize === 'number' ? computed.fontSize : 14;
				const lineH = typeof computed.lineHeight === 'number' ? computed.lineHeight : 1.2;
				computed.height = Math.round(n * fontPx * lineH + 8);
			}
		}
		return;
	}
}

/** Parse an HTML width/height-style attribute value (`"150"`, `"100%"`,
 * `"150px"`) and write it to `computed[key]` as a CssLength. Numeric
 * values without a unit are pixels per HTML spec, which `parseLength`
 * already handles via `parsePxOrNum`. */
function setLenAttr(
	computed: ComputedLiveStyle,
	key: 'width' | 'height',
	raw: string | null,
): void {
	if (!raw) return;
	const v = parseLength(raw.trim());
	if (v === undefined) return;
	computed[key] = v;
}

// =========================================================================
// Cascade resolver
// =========================================================================

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
export function getComputedLiveStyle(el: LiveElement): ComputedLiveStyle {
	const cached = computedCache.get(el);
	if (cached) return cached;

	const computed: ComputedLiveStyle = {};

	// 0. Apply per-tag UA default styles BEFORE author rules so user
	//    stylesheets can override them. Spec-correct UA stylesheet would
	//    use specificity 0 (matched-by-tag) — we model that by simply
	//    layering defaults first and letting matched rules overwrite.
	applyUaDefaults(computed, el.tagName, el);
	// 0a. Apply HTML presentational hints (`<img width=…>`, `<table
	//    width=…%>`, `<input size=…>`, …). Per HTML5 these contribute at
	//    UA-stylesheet specificity (lower than any author rule), so we
	//    layer them right after the UA defaults and before matched
	//    author rules. Critical for external HTML like google.com's
	//    tier3 page, which uses these attributes instead of inline
	//    style for table/cell widths and input size.
	applyPresentationalHints(computed, el);

	// 1. Walk all rules across all sheets that match this element.
	const matched: { rule: ParsedRule; pseudo: 'before' | 'after' | null }[] = [];
	for (const rules of styleSheets.values()) {
		for (const rule of rules) {
			if (!rule.mediaActive) continue;
			if (matchChain(rule.chain, el)) {
				matched.push({ rule, pseudo: rule.chain.pseudoElement });
			}
		}
	}
	// Sort ascending (lowest first) so highest specificity applies last.
	matched.sort((a, b) => {
		const cmp = compareSpec(a.rule.specificity, b.rule.specificity);
		return cmp !== 0 ? cmp : a.rule.source - b.rule.source;
	});

	// 2. Layer rule declarations. Two passes per CSS spec: first
	//    collect every `--custom-prop` across all matched rules so var()
	//    refs in subsequent decls see the FINAL cascade-resolved values.
	//    The lil-gui pattern that motivates this:
	//      `.lil-gui { --font-size:11px; font-size:var(--font-size); }`
	//      `@media (pointer:coarse) .lil-gui.allow-touch-styles { --font-size:13px }`
	//    Single-pass would resolve var(--font-size) to 11px during the
	//    first rule and never see the touch override.
	const parentComputed = el.parent ? getComputedLiveStyle(el.parent) : undefined;
	const customProps: Record<string, string> = {};
	let beforeContent: string | undefined;
	let afterContent: string | undefined;
	let beforeStyle: PseudoStyle | undefined;
	let afterStyle: PseudoStyle | undefined;
	// Pass A: collect custom-prop declarations across ALL matched rules,
	// in cascade order. Store values AS-IS (no var/calc resolution yet)
	// so a `--checkbox-size: calc(var(--widget-height)*0.75)` decl from
	// the base rule doesn't get frozen against the base --widget-height
	// before the touch override raises it. Real browsers resolve custom
	// props lazily at use site; we do the same in Pass B.
	if (parentComputed?.customProps) {
		Object.assign(customProps, parentComputed.customProps);
	}
	for (const { rule, pseudo } of matched) {
		if (pseudo) continue;
		for (const decl of rule.decls) {
			if (decl.prop.startsWith('--')) {
				customProps[decl.prop] = decl.value;
			}
		}
	}
	// Pass B: pseudo + non-custom declarations.
	for (const { rule, pseudo } of matched) {
		if (pseudo === 'before' || pseudo === 'after') {
			const slot: PseudoStyle = (pseudo === 'before')
				? (beforeStyle ??= {})
				: (afterStyle ??= {});
			for (const decl of rule.decls) {
				if (decl.prop === 'content') {
					const text = unquoteCssString(decl.value);
					if (pseudo === 'before') beforeContent = text;
					else afterContent = text;
					continue;
				}
				applyDeclToPseudoStyle(slot, decl, parentComputed, customProps, el);
			}
			continue;
		}
		for (const decl of rule.decls) {
			if (decl.prop.startsWith('--')) continue; // already in customProps
			applyDeclToComputed(computed, customProps, decl, el, parentComputed);
		}
	}

	// 3. Inline style wins over the cascade for the same prop.
	const inline = el.style;
	if (inline.color !== undefined) computed.color = inline.color;
	if (inline.background !== undefined) computed.background = inline.background;
	if (inline.fontFamily !== undefined) computed.fontFamily = inline.fontFamily;
	if (inline.fontSize !== undefined) computed.fontSize = inline.fontSize;
	if (inline.fontWeight !== undefined) computed.fontWeight = inline.fontWeight;
	if (inline.fontStyle !== undefined) computed.fontStyle = inline.fontStyle;
	if (inline.textAlign !== undefined) computed.textAlign = inline.textAlign;
	if (inline.lineHeight !== undefined) computed.lineHeight = inline.lineHeight;
	if (inline.textDecoration !== undefined) computed.textDecoration = inline.textDecoration;
	if (inline.verticalAlign !== undefined) computed.verticalAlign = inline.verticalAlign;
	if (inline.listStyleType !== undefined) computed.listStyleType = inline.listStyleType;
	if (inline.cursor !== undefined) computed.cursor = inline.cursor;
	if (inline.opacity !== undefined) computed.opacity = inline.opacity;
	if (inline.display !== undefined) computed.display = inline.display;
	if (inline.width !== undefined) computed.width = inline.width;
	if (inline.height !== undefined) computed.height = inline.height;
	if (inline.paddingTop !== undefined) computed.paddingTop = inline.paddingTop;
	if (inline.paddingRight !== undefined) computed.paddingRight = inline.paddingRight;
	if (inline.paddingBottom !== undefined) computed.paddingBottom = inline.paddingBottom;
	if (inline.paddingLeft !== undefined) computed.paddingLeft = inline.paddingLeft;
	if (inline.marginTop !== undefined) computed.marginTop = inline.marginTop;
	if (inline.marginRight !== undefined) computed.marginRight = inline.marginRight;
	if (inline.marginBottom !== undefined) computed.marginBottom = inline.marginBottom;
	if (inline.marginLeft !== undefined) computed.marginLeft = inline.marginLeft;
	if (inline.gap !== undefined) computed.gap = inline.gap;
	if (inline.flexDirection !== undefined) computed.flexDirection = inline.flexDirection;
	if (inline.flexGrow !== undefined) computed.flexGrow = inline.flexGrow;
	if (inline.flexShrink !== undefined) computed.flexShrink = inline.flexShrink;
	if (inline.flexBasis !== undefined) computed.flexBasis = inline.flexBasis;
	if (inline.alignItems !== undefined) computed.alignItems = inline.alignItems;
	if (inline.justifyContent !== undefined) computed.justifyContent = inline.justifyContent;
	if (inline.boxSizing !== undefined) computed.boxSizing = inline.boxSizing;
	if (inline.minWidth !== undefined) computed.minWidth = inline.minWidth;
	if (inline.maxWidth !== undefined) computed.maxWidth = inline.maxWidth;
	if (inline.minHeight !== undefined) computed.minHeight = inline.minHeight;
	if (inline.maxHeight !== undefined) computed.maxHeight = inline.maxHeight;
	if (inline.overflowX !== undefined) computed.overflowX = inline.overflowX;
	if (inline.overflowY !== undefined) computed.overflowY = inline.overflowY;
	if (inline.borderTopWidth !== undefined) computed.borderTopWidth = inline.borderTopWidth;
	if (inline.borderRightWidth !== undefined) computed.borderRightWidth = inline.borderRightWidth;
	if (inline.borderBottomWidth !== undefined) computed.borderBottomWidth = inline.borderBottomWidth;
	if (inline.borderLeftWidth !== undefined) computed.borderLeftWidth = inline.borderLeftWidth;
	if (inline.borderTopColor !== undefined) computed.borderTopColor = inline.borderTopColor;
	if (inline.borderRightColor !== undefined) computed.borderRightColor = inline.borderRightColor;
	if (inline.borderBottomColor !== undefined) computed.borderBottomColor = inline.borderBottomColor;
	if (inline.borderLeftColor !== undefined) computed.borderLeftColor = inline.borderLeftColor;
	if (inline.borderRadius !== undefined) computed.borderRadius = inline.borderRadius;
	if (inline.position !== undefined) computed.position = inline.position;
	if (inline.top !== undefined) computed.top = inline.top;
	if (inline.left !== undefined) computed.left = inline.left;
	if (inline.right !== undefined) computed.right = inline.right;
	if (inline.bottom !== undefined) computed.bottom = inline.bottom;
	if (inline.zIndex !== undefined) computed.zIndex = inline.zIndex;

	// 4. Inherit unset inheritable props from parent's computed.
	if (parentComputed) {
		if (computed.color === undefined && parentComputed.color !== undefined) computed.color = parentComputed.color;
		if (computed.fontFamily === undefined && parentComputed.fontFamily !== undefined) computed.fontFamily = parentComputed.fontFamily;
		if (computed.fontSize === undefined && parentComputed.fontSize !== undefined) computed.fontSize = parentComputed.fontSize;
		if (computed.fontWeight === undefined && parentComputed.fontWeight !== undefined) computed.fontWeight = parentComputed.fontWeight;
		if (computed.fontStyle === undefined && parentComputed.fontStyle !== undefined) computed.fontStyle = parentComputed.fontStyle;
		if (computed.textAlign === undefined && parentComputed.textAlign !== undefined) computed.textAlign = parentComputed.textAlign;
		if (computed.lineHeight === undefined && parentComputed.lineHeight !== undefined) computed.lineHeight = parentComputed.lineHeight;
		// `white-space` is inheritable per CSS spec — a `nowrap` on a
		// container scopes to all its descendants' text runs. DDG sets
		// it on `.result__extras__url` and expects the inner `<a>`'s
		// text to inherit; without inheritance the URL still wraps.
		if (computed.whiteSpace === undefined && parentComputed.whiteSpace !== undefined) computed.whiteSpace = parentComputed.whiteSpace;
		// text-decoration is spec'd as not-inherited, but per CSS 2.1 it
		// propagates to descendants visually because the decoration is
		// drawn over the descendant's text. We model this by inheriting
		// it down — that matches how a browser renders `<p style="text-
		// decoration:underline">foo <span>bar</span></p>` (both underlined).
		if (computed.textDecoration === undefined && parentComputed.textDecoration !== undefined) computed.textDecoration = parentComputed.textDecoration;
		// `list-style-type` is inherited per CSS spec so nested <ul>/<ol>
		// pick up an ancestor's marker style. (Real browsers reset back
		// to disc for `<ul ul>` but our showcase doesn't depend on that.)
		if (computed.listStyleType === undefined && parentComputed.listStyleType !== undefined) computed.listStyleType = parentComputed.listStyleType;
		if (computed.cursor === undefined && parentComputed.cursor !== undefined) computed.cursor = parentComputed.cursor;
		// SVG paint properties cascade down the tree (path inherits from
		// its parent svg / g) so authors can set `fill` / `stroke` on the
		// outer `<svg>` (or even higher) and have the leaves pick it up.
		// Matches the SVG spec's inheritance of presentation attributes.
		if (computed.fill === undefined && parentComputed.fill !== undefined) computed.fill = parentComputed.fill;
		if (computed.stroke === undefined && parentComputed.stroke !== undefined) computed.stroke = parentComputed.stroke;
		if (computed.strokeWidth === undefined && parentComputed.strokeWidth !== undefined) computed.strokeWidth = parentComputed.strokeWidth;
	}

	// 5. Inline `--foo` custom properties (highest cascade priority —
	// inline overrides stylesheet rules per spec). Merged AFTER the
	// cascade-rule sweep so `el.style.setProperty('--foo', …)` wins
	// over `<style>#el { --foo: … }`. Late re-resolution below
	// catches inline regular-prop string fields (background, color)
	// that came in verbatim from parseCssText with `var()` refs not
	// yet evaluated by applyDeclToComputed.
	if (inline.customProps) {
		Object.assign(customProps, inline.customProps);
	}
	if (computed.background && computed.background.indexOf('var(') >= 0) {
		computed.background = resolveVarRefs(computed.background, el, parentComputed, customProps);
	}
	if (computed.color && computed.color.indexOf('var(') >= 0) {
		computed.color = resolveVarRefs(computed.color, el, parentComputed, customProps);
	}
	if (Object.keys(customProps).length > 0) computed.customProps = customProps;
	if (beforeContent !== undefined) computed.before = beforeContent;
	if (afterContent !== undefined) computed.after = afterContent;
	if (beforeStyle) computed.beforeStyle = beforeStyle;
	if (afterStyle) computed.afterStyle = afterStyle;

	computedCache.set(el, computed);
	touchedSinceClear.add(el);
	return computed;
}

function applyDeclToComputed(
	computed: ComputedLiveStyle,
	customProps: Record<string, string>,
	decl: ParsedDecl,
	el: LiveElement,
	parentComputed: ComputedLiveStyle | undefined,
): void {
	const prop = decl.prop;
	// M2.6 fix: pass `customProps` so var() refs can resolve against
	// declarations earlier in the same element's cascade. lil-gui has
	// `.lil-gui { --bg:#1f1f1f; background:var(--bg); }` — without
	// own-customProps lookup the var falls back to empty string.
	const value = resolveVarRefs(decl.value, el, parentComputed, customProps);
	if (prop.startsWith('--')) {
		customProps[prop] = value;
		return;
	}
	switch (prop) {
		case 'color': computed.color = value; return;
		// SVG paint properties — passed through as raw resolved strings
		// (var() refs already resolved by resolveVarRefs above). The
		// svg-painter applies them at paint time via the cascade
		// fallback in LIVE_SVG_ADAPTER.
		case 'fill':         computed.fill = value;        return;
		case 'stroke':       computed.stroke = value;      return;
		case 'stroke-width': computed.strokeWidth = value; return;
		case 'background':
		case 'background-color': {
			computed.background = value;
			// Multi-layer / gradient parse. `parseBackgroundLayers` returns
			// undefined for plain colours so we don't waste paint cycles
			// on the gradient path for solid fills.
			const layers = parseBackgroundLayers(value);
			if (layers) computed.backgroundLayers = layers;
			else computed.backgroundLayers = undefined;
			return;
		}
		case 'background-image': {
			// Standalone `background-image:` — common pattern when sites set
			// position/size separately via background-position/etc. and only
			// the image url() goes here. parseBackgroundLayers handles the
			// url() extraction.
			const layers = parseBackgroundLayers(value);
			if (layers) computed.backgroundLayers = layers;
			return;
		}
		case 'background-size': {
			computed.backgroundSize = parseBackgroundSize(value);
			return;
		}
		case 'font-family': computed.fontFamily = stripQuoted(value); return;
		case 'font-size': {
			// CSS font-size accepts (in order of precedence here):
			//   1. Absolute keywords (`small`, `x-small`, `medium`, …) — fixed
			//      px values per the CSS 2.1 specification.
			//   2. Relative keywords (`smaller`, `larger`) — resolve against
			//      the parent's computed font-size with the spec's ~1.2x
			//      ratio. Use the parent's value as the base (the element's
			//      own font-size is what we're computing here).
			//   3. Numeric lengths (`Npx`, `Nem`, …) — em resolves against
			//      the parent's font-size, NOT the element's own (since we
			//      are defining the element's own).
			const v = value.trim().toLowerCase();
			const kw = resolveFontSizeKeyword(v);
			if (kw !== undefined) { computed.fontSize = kw; return; }
			const parentSize = parentComputed?.fontSize ?? 16;
			if (v === 'larger') { computed.fontSize = Math.round(parentSize * 1.2); return; }
			if (v === 'smaller') { computed.fontSize = Math.round(parentSize / 1.2); return; }
			const n = parsePxOrNum(value, { emBase: parentSize });
			if (n !== undefined) computed.fontSize = n;
			return;
		}
		case 'font-weight': {
			const v = value.trim().toLowerCase();
			if (v === 'bold') computed.fontWeight = 'bold';
			else if (v === 'normal') computed.fontWeight = 'normal';
			else {
				const n = parseInt(v, 10);
				if (Number.isFinite(n)) computed.fontWeight = n;
			}
			return;
		}
		case 'font-style': {
			const v = value.trim().toLowerCase();
			if (v === 'italic' || v === 'oblique' || v === 'normal') computed.fontStyle = v;
			return;
		}
		case 'text-align': {
			const v = value.trim().toLowerCase();
			if (v === 'left' || v === 'center' || v === 'right' || v === 'start' || v === 'end') computed.textAlign = v;
			return;
		}
		case 'text-decoration':
		case 'text-decoration-line': {
			for (const tok of value.toLowerCase().split(/\s+/)) {
				if (tok === 'none' || tok === 'underline' ||
				    tok === 'line-through' || tok === 'overline') {
					computed.textDecoration = tok;
					return;
				}
			}
			return;
		}
		case 'vertical-align': {
			const v = value.trim().toLowerCase();
			if (v === 'baseline' || v === 'super' || v === 'sub') {
				computed.verticalAlign = v;
			}
			return;
		}
		case 'list-style-type':
		case 'list-style': {
			for (const tok of value.toLowerCase().split(/\s+/)) {
				if (tok === 'none' || tok === 'disc' || tok === 'circle' ||
				    tok === 'square' || tok === 'decimal' ||
				    tok === 'lower-alpha' || tok === 'upper-alpha' ||
				    tok === 'lower-roman' || tok === 'upper-roman') {
					computed.listStyleType = tok;
					return;
				}
			}
			return;
		}
		case 'line-height': {
			// em on non-font-size lengths resolves against the element's
			// OWN font-size (or parent's if not yet set in this cascade
			// pass).
			const fs = computed.fontSize ?? parentComputed?.fontSize ?? 16;
			const trimmed = value.trim();
			// CSS spec: a UNITLESS line-height is a multiplier of font-size,
			// not raw px. `body { line-height: 1.6 }` with default 16px
			// font-size = 25.6px line height. Pre-2026-05-31 we treated
			// `1.6` as 1.6 px which collapsed all body text into nearly
			// zero-line-height (DDG html-mode looked "squashed").
			//
			// Inheritance trade-off: per spec, descendants inherit the
			// bare multiplier and re-resolve against their OWN font-size.
			// We resolve at parse time and propagate the resulting px,
			// so children with a different font-size get the parent's
			// resolved value rather than re-multiplying. Close enough
			// for most pages; full spec-compliance would require tracking
			// "is multiplier" through inheritance + a post-cascade resolve.
			if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
				computed.lineHeight = parseFloat(trimmed) * fs;
				return;
			}
			const n = parsePxOrNum(value, { emBase: fs });
			if (n !== undefined) computed.lineHeight = n;
			return;
		}
		case 'cursor': computed.cursor = value; return;
		case 'opacity': {
			const n = parseFloat(value);
			if (Number.isFinite(n)) computed.opacity = Math.max(0, Math.min(1, n));
			return;
		}
		case 'display': {
			const v = value.trim().toLowerCase();
			if (v === 'block' || v === 'inline' || v === 'inline-block'
				|| v === 'flex' || v === 'inline-flex' || v === 'grid' || v === 'none') computed.display = v;
			return;
		}
		case 'float': {
			const v = value.trim().toLowerCase();
			if (v === 'left' || v === 'right' || v === 'none') computed.float = v;
			return;
		}
		case 'grid-template-columns': {
			computed.gridTemplateColumns = value.trim();
			return;
		}
		case 'grid-template-rows': {
			computed.gridTemplateRows = value.trim();
			return;
		}
		case 'grid-column': {
			computed.gridColumn = value.trim();
			return;
		}
		case 'grid-row': {
			computed.gridRow = value.trim();
			return;
		}
		case 'width': {
			const len = parseLength(value);
			if (len !== undefined) computed.width = len;
			return;
		}
		case 'height': {
			const len = parseLength(value);
			if (len !== undefined) computed.height = len;
			return;
		}
		// M2.3 layout longhands. Shorthand expansion (padding/margin/flex)
		// is done in inline-css.ts before parse handles the value, so by
		// the time we get here every padding/margin is already a longhand.
		// The cascade still sees the longhand names because the css-tree
		// parser passes them through directly when the stylesheet uses
		// them.
		case 'padding-top':    return assignNum(computed, 'paddingTop', value);
		case 'padding-right':  return assignNum(computed, 'paddingRight', value);
		case 'padding-bottom': return assignNum(computed, 'paddingBottom', value);
		case 'padding-left':   return assignNum(computed, 'paddingLeft', value);
		case 'padding':        return assignBoxComputed(computed, 'padding', value);
		case 'margin-top':     return assignNum(computed, 'marginTop', value);
		case 'margin-right':   return assignNum(computed, 'marginRight', value);
		case 'margin-bottom':  return assignNum(computed, 'marginBottom', value);
		case 'margin-left':    return assignNum(computed, 'marginLeft', value);
		case 'margin':         return assignBoxComputed(computed, 'margin', value);
		case 'gap':            return assignNum(computed, 'gap', value);
		case 'flex-direction': {
			const v = value.trim().toLowerCase();
			if (v === 'row' || v === 'column' || v === 'row-reverse' || v === 'column-reverse') {
				computed.flexDirection = v;
			}
			return;
		}
		case 'flex-grow':   return assignNum(computed, 'flexGrow', value);
		case 'flex-shrink': return assignNum(computed, 'flexShrink', value);
		case 'flex-basis': {
			const v = value.trim().toLowerCase();
			if (v === 'auto') return;
			return assignNum(computed, 'flexBasis', value);
		}
		case 'flex':           return assignFlexShorthand(computed, value);
		case 'align-items': {
			const v = value.trim().toLowerCase();
			if (v === 'stretch' || v === 'flex-start' || v === 'flex-end' || v === 'center') {
				computed.alignItems = v;
			} else if (v === 'start') computed.alignItems = 'flex-start';
			else if (v === 'end') computed.alignItems = 'flex-end';
			return;
		}
		case 'justify-items': {
			computed.justifyItems = parseJustifyItems(value);
			return;
		}
		case 'place-items': {
			// Shorthand: `<align-items> [<justify-items>]`. One value sets
			// both axes. Powers the `place-items: center` badge idiom (center
			// a text-only grid box's content both ways).
			const toks = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const a = toks[0];
			const j = toks[1] ?? toks[0];
			if (a === 'center') computed.alignItems = 'center';
			else if (a === 'start' || a === 'flex-start') computed.alignItems = 'flex-start';
			else if (a === 'end' || a === 'flex-end') computed.alignItems = 'flex-end';
			else if (a === 'stretch') computed.alignItems = 'stretch';
			computed.justifyItems = parseJustifyItems(j);
			return;
		}
		case 'justify-content': {
			const v = value.trim().toLowerCase();
			if (v === 'flex-start' || v === 'flex-end' || v === 'center' ||
			    v === 'space-between' || v === 'space-around') {
				computed.justifyContent = v;
			}
			return;
		}
		case 'box-sizing': {
			const v = value.trim().toLowerCase();
			if (v === 'content-box' || v === 'border-box') {
				computed.boxSizing = v;
			}
			return;
		}
		case 'min-width':  return assignLen(computed, 'minWidth', value);
		case 'max-width':  return assignLen(computed, 'maxWidth', value);
		case 'min-height': return assignLen(computed, 'minHeight', value);
		case 'max-height': return assignLen(computed, 'maxHeight', value);
		case 'overflow': {
			const v = parseOverflowVal(value);
			if (v) { computed.overflowX = v; computed.overflowY = v; }
			return;
		}
		case 'position': {
			const v = value.trim().toLowerCase();
			if (v === 'static' || v === 'fixed' || v === 'absolute' || v === 'relative') {
				computed.position = v;
			}
			return;
		}
		case 'top':    return assignPosEdge(computed, 'top', value);
		case 'left':   return assignPosEdge(computed, 'left', value);
		case 'right':  return assignPosEdge(computed, 'right', value);
		case 'bottom': return assignPosEdge(computed, 'bottom', value);
		case 'inset':  return assignInset(computed, value);
		case 'transform': {
			const tf = parseTransformTranslate(value);
			if (tf) computed.transform = tf;
			return;
		}
		case 'animation': {
			const an = parseAnimationShorthand(value);
			if (an) computed.animation = an;
			return;
		}
		case 'animation-name': {
			const trimmed = value.trim();
			if (!trimmed) return;
			computed.animation = {
				name: trimmed,
				durationMs: computed.animation?.durationMs ?? 0,
				iterationCount: computed.animation?.iterationCount ?? 1,
				timing: computed.animation?.timing ?? 'linear',
			};
			return;
		}
		case 'animation-duration': {
			const tm = /^([\d.]+)(ms|s)$/i.exec(value.trim());
			if (!tm) return;
			const n = parseFloat(tm[1]);
			if (!Number.isFinite(n)) return;
			const durationMs = tm[2] === 's' ? n * 1000 : n;
			computed.animation = {
				name: computed.animation?.name ?? '',
				durationMs,
				iterationCount: computed.animation?.iterationCount ?? 1,
				timing: computed.animation?.timing ?? 'linear',
			};
			return;
		}
		case 'animation-iteration-count': {
			const v = value.trim().toLowerCase();
			const iter: number | 'infinite' = v === 'infinite' ? 'infinite' : Math.max(0, parseFloat(v) || 1);
			computed.animation = {
				name: computed.animation?.name ?? '',
				durationMs: computed.animation?.durationMs ?? 0,
				iterationCount: iter,
				timing: computed.animation?.timing ?? 'linear',
			};
			return;
		}
		case 'z-index': {
			const n = parsePxOrNum(value);
			if (n !== undefined) computed.zIndex = Math.trunc(n);
			return;
		}
		case 'overflow-x': {
			const v = parseOverflowVal(value);
			if (v) computed.overflowX = v;
			return;
		}
		case 'overflow-y': {
			const v = parseOverflowVal(value);
			if (v) computed.overflowY = v;
			return;
		}
		case 'white-space': {
			const v = value.trim().toLowerCase();
			if (v === 'normal' || v === 'nowrap' || v === 'pre' || v === 'pre-wrap') {
				computed.whiteSpace = v;
			}
			return;
		}
		// Border longhands.
		case 'border-top-width':    return assignNum(computed, 'borderTopWidth', value);
		case 'border-right-width':  return assignNum(computed, 'borderRightWidth', value);
		case 'border-bottom-width': return assignNum(computed, 'borderBottomWidth', value);
		case 'border-left-width':   return assignNum(computed, 'borderLeftWidth', value);
		case 'border-top-color':    computed.borderTopColor = value; return;
		case 'border-right-color':  computed.borderRightColor = value; return;
		case 'border-bottom-color': computed.borderBottomColor = value; return;
		case 'border-left-color':   computed.borderLeftColor = value; return;
		case 'border-width': {
			const n = parsePxOrNum(value);
			if (n === undefined) return;
			computed.borderTopWidth = n; computed.borderRightWidth = n;
			computed.borderBottomWidth = n; computed.borderLeftWidth = n;
			return;
		}
		case 'border-color': {
			computed.borderTopColor = value; computed.borderRightColor = value;
			computed.borderBottomColor = value; computed.borderLeftColor = value;
			return;
		}
		case 'border':
		case 'border-top':
		case 'border-right':
		case 'border-bottom':
		case 'border-left':
			applyBorderShorthandToComputed(computed, prop, value);
			return;
		case 'box-shadow': {
			const shadows = parseBoxShadow(value);
			if (shadows) computed.boxShadow = shadows;
			else if (value.trim().toLowerCase() === 'none') computed.boxShadow = undefined;
			return;
		}
		case 'border-radius': {
			const first = value.trim().split(/\s+/)[0];
			if (!first) return;
			const pct = /^(\d+(?:\.\d+)?)%$/.exec(first);
			if (pct) {
				const n = parseFloat(pct[1]);
				if (Number.isFinite(n)) computed.borderRadius = { percent: n / 100 };
				return;
			}
			const px = /^(\d+(?:\.\d+)?)(px)?$/i.exec(first);
			if (px) {
				const n = parseFloat(px[1]);
				if (Number.isFinite(n)) computed.borderRadius = { px: Math.round(n) };
			}
			return;
		}
	}
}

/** Apply one declaration to a pseudo-element style slot. Only handles
 * the subset of properties that make sense on a pseudo today —
 * position/offsets, color, font longhands, and line-height. Anything
 * else is silently ignored (the pseudo paints inside the host's box
 * so layout-affecting props would have no consumer). */
function applyDeclToPseudoStyle(
	slot: PseudoStyle,
	decl: ParsedDecl,
	parentComputed: ComputedLiveStyle | undefined,
	customProps: Record<string, string>,
	el: LiveElement,
): void {
	const value = resolveVarRefs(decl.value, el, parentComputed, customProps);
	const emBase = parentComputed?.fontSize ?? 16;
	switch (decl.prop) {
		case 'position': {
			const v = value.trim().toLowerCase();
			if (v === 'static' || v === 'relative' || v === 'absolute') slot.position = v;
			return;
		}
		case 'top': { assignPseudoEdge(slot, 'top', value, emBase); return; }
		case 'right': { assignPseudoEdge(slot, 'right', value, emBase); return; }
		case 'bottom': { assignPseudoEdge(slot, 'bottom', value, emBase); return; }
		case 'left': { assignPseudoEdge(slot, 'left', value, emBase); return; }
		case 'inset': return assignInsetPseudo(slot, value);
		case 'background':
		case 'background-color': {
			slot.background = value;
			const layers = parseBackgroundLayers(value);
			if (layers) slot.backgroundLayers = layers;
			return;
		}
		case 'background-size': { slot.backgroundSize = parseBackgroundSize(value); return; }
		case 'opacity': {
			const n = parseFloat(value);
			if (Number.isFinite(n)) slot.opacity = Math.max(0, Math.min(1, n));
			return;
		}
		case 'width': { const len = parseLength(value); if (len !== undefined) slot.width = len; return; }
		case 'height': { const len = parseLength(value); if (len !== undefined) slot.height = len; return; }
		case 'mask-image':
		case '-webkit-mask-image': {
			const m = parseMaskImage(value);
			if (m) slot.maskImage = m;
			return;
		}
		case 'color': slot.color = value; return;
		case 'font-size': {
			const n = parsePxOrNum(value, { emBase });
			if (n !== undefined) slot.fontSize = n;
			return;
		}
		case 'font-family': slot.fontFamily = stripQuoted(value); return;
		case 'font-weight': {
			const v = value.trim().toLowerCase();
			if (v === 'bold') slot.fontWeight = 'bold';
			else if (v === 'normal') slot.fontWeight = 'normal';
			else {
				const n = parseInt(v, 10);
				if (Number.isFinite(n)) slot.fontWeight = n;
			}
			return;
		}
		case 'font-style': {
			const v = value.trim().toLowerCase();
			if (v === 'italic' || v === 'oblique' || v === 'normal') slot.fontStyle = v;
			return;
		}
		case 'line-height': {
			const fs = slot.fontSize ?? emBase;
			const trimmed = value.trim();
			// Unitless line-height = multiplier × font-size (same trap as
			// the regular cascade's case).
			if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
				slot.lineHeight = parseFloat(trimmed) * fs;
				return;
			}
			const n = parsePxOrNum(value, { emBase: fs });
			if (n !== undefined) slot.lineHeight = n;
			return;
		}
	}
}

/** Mirror of inline-css.applyBorderShorthand for the computed-style
 * cascade path. Tokens are detected by shape: a length-shaped token is
 * the width, recognised style keywords are the style (only `solid`
 * renders; `none` clears the width), anything else is the color. */
function applyBorderShorthandToComputed(
	computed: ComputedLiveStyle,
	prop: 'border' | 'border-top' | 'border-right' | 'border-bottom' | 'border-left',
	value: string,
): void {
	const STYLE_KEYWORDS = new Set([
		'none', 'hidden', 'solid', 'dashed', 'dotted', 'double',
		'groove', 'ridge', 'inset', 'outset',
	]);
	const tokens = value.trim().split(/\s+/).filter(Boolean);
	let width: number | undefined;
	let isNone = false;
	let color: string | undefined;
	for (const t of tokens) {
		const lower = t.toLowerCase();
		if (STYLE_KEYWORDS.has(lower)) {
			if (lower === 'none' || lower === 'hidden') isNone = true;
			continue;
		}
		const w = parsePxOrNum(t);
		if (w !== undefined && width === undefined) { width = w; continue; }
		if (color === undefined) color = t;
	}
	if (isNone) { width = 0; color = undefined; }
	const widthVal = width ?? 0;
	const setSide = (side: 'Top' | 'Right' | 'Bottom' | 'Left') => {
		(computed as Record<string, unknown>)['border' + side + 'Width'] = widthVal;
		if (color !== undefined) (computed as Record<string, unknown>)['border' + side + 'Color'] = color;
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

function parseOverflowVal(value: string): 'visible' | 'hidden' | 'scroll' | 'auto' | undefined {
	const v = value.trim().toLowerCase();
	if (v === 'visible' || v === 'hidden' || v === 'scroll' || v === 'auto') return v;
	return undefined;
}

function assignNum<K extends keyof ComputedLiveStyle>(
	computed: ComputedLiveStyle,
	key: K,
	value: string,
): void {
	const n = parsePxOrNum(value);
	if (n !== undefined) (computed as Record<string, unknown>)[key as string] = n;
}

function assignLen<K extends 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight'>(
	computed: ComputedLiveStyle,
	key: K,
	value: string,
): void {
	const v = parseLength(value);
	if (v !== undefined) (computed as Record<string, unknown>)[key as string] = v;
}

function assignBoxComputed(
	computed: ComputedLiveStyle,
	prefix: 'padding' | 'margin',
	value: string,
): void {
	const tokens = value.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return;
	const nums: number[] = [];
	for (const t of tokens) {
		// `auto` (margin centering) resolves to 0 in this engine — we
		// don't implement auto-margin centering, and the elements that
		// use it (`margin: 0 auto …`) are full-width blocks where it's a
		// no-op anyway. Treating it as 0 (instead of bailing on the whole
		// shorthand) means the OTHER components — notably the bottom
		// margin in `margin: 0 auto 58px` — still apply.
		const n = t.toLowerCase() === 'auto' ? 0 : parsePxOrNum(t);
		if (n === undefined) return;
		nums.push(n);
	}
	let t: number, r: number, b: number, l: number;
	switch (nums.length) {
		case 1: t = r = b = l = nums[0]; break;
		case 2: t = b = nums[0]; r = l = nums[1]; break;
		case 3: t = nums[0]; r = l = nums[1]; b = nums[2]; break;
		default: t = nums[0]; r = nums[1]; b = nums[2]; l = nums[3]; break;
	}
	const cap = prefix === 'padding' ? 'Padding' : 'Margin';
	(computed as Record<string, unknown>)[cap.toLowerCase() === 'padding' ? 'paddingTop' : 'marginTop'] = t;
	(computed as Record<string, unknown>)[cap.toLowerCase() === 'padding' ? 'paddingRight' : 'marginRight'] = r;
	(computed as Record<string, unknown>)[cap.toLowerCase() === 'padding' ? 'paddingBottom' : 'marginBottom'] = b;
	(computed as Record<string, unknown>)[cap.toLowerCase() === 'padding' ? 'paddingLeft' : 'marginLeft'] = l;
}

/** Parse the four `inset` shorthand values (TRBL, same expansion as
 * padding/margin) into top/right/bottom/left. `auto` leaves that edge
 * unset (we don't implement auto offset resolution). Used for both
 * normal elements and pseudo-elements (`inset: 0` to fill the host). */
function expandInsetTokens(value: string): (number | undefined)[] | undefined {
	const tokens = value.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	const nums: (number | undefined)[] = [];
	for (const t of tokens) {
		if (t.toLowerCase() === 'auto') { nums.push(undefined); continue; }
		const n = parsePxOrNum(t);
		if (n === undefined) return undefined;
		nums.push(n);
	}
	let top: number | undefined, right: number | undefined,
		bottom: number | undefined, left: number | undefined;
	switch (nums.length) {
		case 1: top = right = bottom = left = nums[0]; break;
		case 2: top = bottom = nums[0]; right = left = nums[1]; break;
		case 3: top = nums[0]; right = left = nums[1]; bottom = nums[2]; break;
		default: top = nums[0]; right = nums[1]; bottom = nums[2]; left = nums[3]; break;
	}
	return [top, right, bottom, left];
}

/** Assign a positional edge (`top`/`left`/`right`/`bottom`). A `%` value
 * goes to the parallel `*Pct` field (resolved against the containing block
 * in the absolute-layout pass); anything else stays a px number in the
 * primary field. Setting one form clears the other so a re-cascade can't
 * leave both. */
function assignPosEdge(
	computed: ComputedLiveStyle,
	edge: 'top' | 'left' | 'right' | 'bottom',
	value: string,
): void {
	const t = value.trim();
	const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(t);
	const pctKey = (edge + 'Pct') as 'topPct' | 'leftPct' | 'rightPct' | 'bottomPct';
	if (pct) {
		computed[pctKey] = parseFloat(pct[1]);
		computed[edge] = undefined;
		return;
	}
	const n = parsePxOrNum(value);
	if (n !== undefined) {
		computed[edge] = n;
		computed[pctKey] = undefined;
	}
}

/** Parse `transform:` into translate (`tx`/`ty` as CssLength for own-box
 * resolution at layout time), `rotateRad` (radians) and `scaleX`/`scaleY`.
 * Returns undefined when none of the supported functions match. Functions:
 * translate/translateX/translateY/rotate/scale/scaleX/scaleY.
 * Skew/matrix/perspective are ignored. */
function parseTransformTranslate(value: string): { tx?: CssLength; ty?: CssLength; rotateRad?: number; scaleX?: number; scaleY?: number } | undefined {
	let tx: CssLength | undefined;
	let ty: CssLength | undefined;
	let rotateRad: number | undefined;
	let scaleX: number | undefined;
	let scaleY: number | undefined;
	const re = /(translate[XY]?|rotate|scale[XY]?)\s*\(([^)]*)\)/gi;
	let m: RegExpExecArray | null;
	let saw = false;
	while ((m = re.exec(value)) !== null) {
		const fn = m[1].toLowerCase();
		const args = m[2].split(',').map((s) => s.trim()).filter(Boolean);
		if (fn === 'translatex') { const v = parseLength(args[0] ?? ''); if (v !== undefined) { tx = v; saw = true; } }
		else if (fn === 'translatey') { const v = parseLength(args[0] ?? ''); if (v !== undefined) { ty = v; saw = true; } }
		else if (fn === 'translate') {
			const vx = parseLength(args[0] ?? '');
			if (vx !== undefined) { tx = vx; saw = true; }
			if (args.length > 1) { const vy = parseLength(args[1]); if (vy !== undefined) { ty = vy; saw = true; } }
		}
		else if (fn === 'rotate') {
			const rad = parseAngle(args[0] ?? '');
			if (rad !== undefined) { rotateRad = rad; saw = true; }
		}
		else if (fn === 'scalex') { const n = parseFloat(args[0] ?? ''); if (Number.isFinite(n)) { scaleX = n; saw = true; } }
		else if (fn === 'scaley') { const n = parseFloat(args[0] ?? ''); if (Number.isFinite(n)) { scaleY = n; saw = true; } }
		else if (fn === 'scale') {
			const sx = parseFloat(args[0] ?? '');
			if (Number.isFinite(sx)) { scaleX = sx; saw = true; }
			const sy = args.length > 1 ? parseFloat(args[1]) : sx;
			if (Number.isFinite(sy)) { scaleY = sy; saw = true; }
		}
	}
	return saw ? { tx, ty, rotateRad, scaleX, scaleY } : undefined;
}

/** Parse a CSS angle (`Ndeg`/`Nrad`/`Nturn`/`Ngrad`) into radians.
 * Bare numbers (no unit) → degrees. */
function parseAngle(value: string): number | undefined {
	const m = /^(-?\d*\.?\d+)(deg|rad|turn|grad)?$/i.exec(value.trim());
	if (!m) return undefined;
	const n = parseFloat(m[1]);
	if (!Number.isFinite(n)) return undefined;
	const unit = (m[2] || 'deg').toLowerCase();
	if (unit === 'rad') return n;
	if (unit === 'turn') return n * 2 * Math.PI;
	if (unit === 'grad') return n * (Math.PI / 200);
	return n * (Math.PI / 180);
}

/** Parse `animation: <name> <duration> [<timing>] [<iter>]` shorthand
 * into the runtime-consumable shape. Tier-1: timing function string is
 * recorded but the runtime ignores it (linear only). Returns undefined
 * when name or duration is missing. */
function parseAnimationShorthand(value: string): { name: string; durationMs: number; iterationCount: number | 'infinite'; timing: string } | undefined {
	const parts = value.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return undefined;
	let name: string | undefined;
	let durationMs: number | undefined;
	let iterationCount: number | 'infinite' = 1;
	let timing = 'linear';
	for (const p of parts) {
		const lower = p.toLowerCase();
		if (lower === 'infinite') { iterationCount = 'infinite'; continue; }
		const tm = /^([\d.]+)(ms|s)$/i.exec(lower);
		if (tm) {
			const n = parseFloat(tm[1]);
			if (Number.isFinite(n) && durationMs === undefined) {
				durationMs = (tm[2] === 's' ? n * 1000 : n);
			}
			continue;
		}
		if (/^[\d.]+$/.test(lower)) { iterationCount = Math.max(0, parseFloat(lower)); continue; }
		if (lower === 'linear' || lower === 'ease' || lower === 'ease-in'
			|| lower === 'ease-out' || lower === 'ease-in-out'
			|| lower === 'step-start' || lower === 'step-end'
			|| lower.startsWith('cubic-bezier(') || lower.startsWith('steps(')) {
			timing = lower;
			continue;
		}
		if (name === undefined) name = p;
	}
	if (!name || durationMs === undefined) return undefined;
	return { name, durationMs, iterationCount, timing };
}

// =========================================================================
// @keyframes registry
// =========================================================================
//
// Each registered `@keyframes` block becomes a map from percentage (0..1)
// to the partial style declarations at that frame. The CSS-animation tick
// in live-dom.ts interpolates between the two flanking frames each tick.
//
// Tier-1: only `transform` (rotate + scale only — translate is layout-time
// and can't animate cleanly here) and `opacity` are interpolated; all
// other properties at a keyframe are silently ignored.

export type KeyframeStop = { offset: number; rotateRad?: number; scaleX?: number; scaleY?: number; opacity?: number };
const keyframesRegistry: Map<string, KeyframeStop[]> = new Map();

export function getKeyframes(name: string): KeyframeStop[] | undefined {
	return keyframesRegistry.get(name);
}

function parseKeyframeSelectorList(prelude: string): number[] {
	const out: number[] = [];
	for (const raw of prelude.split(',')) {
		const tok = raw.trim().toLowerCase();
		if (tok === 'from') out.push(0);
		else if (tok === 'to') out.push(1);
		else if (tok.endsWith('%')) {
			const n = parseFloat(tok);
			if (Number.isFinite(n)) out.push(Math.max(0, Math.min(1, n / 100)));
		}
	}
	return out;
}

// =========================================================================
// @font-face registry
// =========================================================================
//
// The nx.js runtime already maintains a `fonts` FontFaceSet (a real-DOM
// `document.fonts` equivalent). Canvas-context-2d's font setter does
// `findFont(fonts, parsed)` then early-returns silently for unrecognised
// families — see [[reference-nxjs-canvas-font-fallback]]. ALL we need to
// do here is parse `@font-face { font-family: X; src: url(Y); }` and
// populate `fonts` with `new FontFace(X, ttfBytes)`. The canvas (and the
// swb DOM text painter, which uses the same ctx.font setter) will then
// find the font automatically on the next paint.

declare const Switch: { readFileSync?(path: string): ArrayBuffer | null };

interface FontFaceCtor {
	new (family: string, source: ArrayBuffer | Uint8Array): unknown;
}
interface FontFaceSetLike { add(face: unknown): unknown }

const registeredFontFamilies = new Set<string>();

function fetchFontBytesSync(url: string): ArrayBuffer | null {
	if (url.startsWith('sdmc:/') || url.startsWith('romfs:/')) {
		try {
			const sw = (globalThis as { Switch?: { readFileSync?: (p: string) => ArrayBuffer | null } }).Switch;
			if (sw?.readFileSync) {
				const ab = sw.readFileSync(url);
				return ab ?? null;
			}
		} catch (_) { /* fall through */ }
		return null;
	}
	// blob: / http(s) / brewser:// — async fetch path. Returns null so the
	// caller falls through to fetchFontBytesAsync.
	return null;
}

/** Async fetch fallback for @font-face URLs that aren't synchronously
 * readable (blob:, brewser://, http(s)). Cocos Creator's runtime font
 * loader appends `<style>@font-face { src: url("blob:UUID") }</style>`
 * with TTF bytes from URL.createObjectURL on an assetManager-loaded TTF
 * Blob; without this path the family never registers, `fonts.load()` never
 * resolves, and Cocos's Label render pipeline gates forever (no fillText).
 *
 * Resolves to the font bytes on success, throws on network / non-2xx /
 * unparseable. Called fire-and-forget from registerFontFace — once bytes
 * arrive we construct + add a FontFace into globalThis.fonts and Cocos's
 * 100ms-interval `fonts.load()` poll picks it up on the next iteration.
 */
async function fetchFontBytesAsync(url: string): Promise<ArrayBuffer> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error('http ' + resp.status + ' for ' + url);
	return await resp.arrayBuffer();
}

function addFontFaceToSet(family: string, bytes: ArrayBuffer | Uint8Array, source: string): void {
	try {
		const FontFaceCtor = (globalThis as unknown as { FontFace?: FontFaceCtor }).FontFace;
		const fonts = (globalThis as unknown as { fonts?: FontFaceSetLike }).fonts;
		if (!FontFaceCtor || !fonts) return;
		const face = new FontFaceCtor(family, bytes);
		fonts.add(face);
		console.debug('[font-face] registered family=' + family + ' bytes=' + (bytes as ArrayBuffer).byteLength + ' source=' + source);
	} catch (err) {
		console.debug('[font-face] FontFace ctor threw for family=' + family + ': ' + ((err as { message?: string })?.message || err));
	}
}

function extractFirstUrl(src: string): string | undefined {
	// `src: url("/path.ttf") format('truetype'), local("Foo");`
	// Tier-1: grab the first `url(...)`, strip quotes, ignore format() and local().
	const m = /url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(src);
	return m ? m[2].trim() : undefined;
}

function registerFontFace(blockNode: CssNode): void {
	let family: string | undefined;
	let src: string | undefined;
	const block = blockNode as { children: { forEach: (cb: (c: CssNode) => void) => void } };
	if (!block.children || typeof block.children.forEach !== 'function') return;
	block.children.forEach((decl) => {
		const d = decl as { type: string; property?: string; value?: CssNode };
		if (d.type !== 'Declaration' || !d.property || !d.value) return;
		const prop = d.property.toLowerCase();
		const val = safeGenerate(d.value).trim();
		if (prop === 'font-family') {
			family = val.replace(/^['"]|['"]$/g, '');
		} else if (prop === 'src') {
			src = val;
		}
	});
	if (!family || !src) return;
	const url = extractFirstUrl(src);
	if (!url) return;
	const key = family.toLowerCase();
	if (registeredFontFamilies.has(key)) return; // already registered (or fetch already in flight)
	registeredFontFamilies.add(key); // mark NOW to dedupe concurrent re-registrations from style re-parses
	const familyResolved = family;
	const bytes = fetchFontBytesSync(url);
	if (bytes) {
		addFontFaceToSet(familyResolved, bytes, 'sync:' + url);
		return;
	}
	// blob: / brewser:// / http(s): async path. Cocos's font loader polls
	// `fonts.load(family)` every 100ms with a JP-ms timeout, so we register
	// fire-and-forget — the next poll iteration after bytes arrive picks
	// up the freshly-added FontFace.
	fetchFontBytesAsync(url).then(
		(b) => addFontFaceToSet(familyResolved, b, 'async:' + url),
		(err) => {
			console.debug('[font-face] async fetch failed family=' + familyResolved + ' url=' + url + ': ' + ((err as { message?: string })?.message || err));
			registeredFontFamilies.delete(key); // allow caller to retry
		},
	);
}

function registerKeyframes(name: string, blockNode: CssNode): void {
	const stops: KeyframeStop[] = [];
	const block = blockNode as { children: { forEach: (cb: (c: CssNode) => void) => void } };
	if (!block.children || typeof block.children.forEach !== 'function') return;
	block.children.forEach((kf) => {
		const kfRule = kf as { type: string; prelude?: CssNode; block?: CssNode };
		if (kfRule.type !== 'Rule') return;
		const preludeStr = kfRule.prelude ? safeGenerate(kfRule.prelude) : '';
		const offsets = parseKeyframeSelectorList(preludeStr);
		if (offsets.length === 0 || !kfRule.block) return;
		const decls: Record<string, string> = Object.create(null);
		const inner = kfRule.block as { children: { forEach: (cb: (c: CssNode) => void) => void } };
		inner.children?.forEach((decl) => {
			const d = decl as { type: string; property?: string; value?: CssNode };
			if (d.type !== 'Declaration' || !d.property || !d.value) return;
			decls[d.property.toLowerCase()] = safeGenerate(d.value).trim();
		});
		const stopBase: Omit<KeyframeStop, 'offset'> = {};
		if (decls['transform']) {
			const tf = parseTransformTranslate(decls['transform']);
			if (tf) {
				if (tf.rotateRad !== undefined) stopBase.rotateRad = tf.rotateRad;
				if (tf.scaleX !== undefined) stopBase.scaleX = tf.scaleX;
				if (tf.scaleY !== undefined) stopBase.scaleY = tf.scaleY;
			}
		}
		if (decls['opacity']) {
			const n = parseFloat(decls['opacity']);
			if (Number.isFinite(n)) stopBase.opacity = n;
		}
		for (const off of offsets) stops.push({ offset: off, ...stopBase });
	});
	stops.sort((a, b) => a.offset - b.offset);
	if (stops.length > 0) keyframesRegistry.set(name, stops);
}

/** Normalize a `justify-items` / `place-items` inline-axis token. `flex-*`
 * spellings map to start/end; unrecognized → undefined. */
function parseJustifyItems(value: string): 'start' | 'end' | 'center' | 'stretch' | undefined {
	const v = value.trim().toLowerCase();
	if (v === 'center' || v === 'stretch' || v === 'start' || v === 'end') return v;
	if (v === 'flex-start' || v === 'left') return 'start';
	if (v === 'flex-end' || v === 'right') return 'end';
	return undefined;
}

function assignInset(computed: ComputedLiveStyle, value: string): void {
	const edges = expandInsetTokens(value);
	if (!edges) return;
	const [top, right, bottom, left] = edges;
	if (top !== undefined) computed.top = top;
	if (right !== undefined) computed.right = right;
	if (bottom !== undefined) computed.bottom = bottom;
	if (left !== undefined) computed.left = left;
}

function assignInsetPseudo(slot: PseudoStyle, value: string): void {
	const edges = expandInsetTokens(value);
	if (!edges) return;
	const [top, right, bottom, left] = edges;
	if (top !== undefined) slot.top = top;
	if (right !== undefined) slot.right = right;
	if (bottom !== undefined) slot.bottom = bottom;
	if (left !== undefined) slot.left = left;
}

/** Parse `background-size` only for the fixed-px-tile case (`42px 42px`
 * or `42px`), which drives gradient TILING in the painter. One value
 * sets both axes; `auto` for the second axis mirrors the first. Returns
 * undefined for `cover` / `contain` / `auto` / `%` sizes (the painter
 * then fills the box once, as before). */
function parseBackgroundSize(value: string): { w: number; h: number } | undefined {
	const t = value.trim().toLowerCase();
	if (!t || t === 'cover' || t === 'contain' || t === 'auto') return undefined;
	const tokens = t.split(/\s+/).filter(Boolean);
	const px = (s: string): number | undefined => {
		const m = /^(\d+(?:\.\d+)?)px$/.exec(s);
		return m ? parseFloat(m[1]) : undefined;
	};
	const w = px(tokens[0]);
	if (w === undefined || w <= 0) return undefined;
	const second = tokens[1];
	const h = second === undefined || second === 'auto' ? w : px(second);
	if (h === undefined || h <= 0) return undefined;
	return { w, h };
}

/** Parse `mask-image` / `-webkit-mask-image` when it's a single gradient
 * (the only mask form we render — used as an alpha fade over a pseudo's
 * background). Returns undefined for `none` / url() / unsupported forms. */
function parseMaskImage(value: string): BackgroundLayer | undefined {
	const t = value.trim();
	const lin = /^linear-gradient\((.+)\)$/i.exec(t);
	if (lin) return parseLinearGradient(lin[1]);
	const rad = /^radial-gradient\((.+)\)$/i.exec(t);
	if (rad) return parseRadialGradient(rad[1]);
	return undefined;
}

function assignFlexShorthand(computed: ComputedLiveStyle, value: string): void {
	const tokens = value.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return;
	if (tokens.length === 1) {
		const sole = tokens[0].toLowerCase();
		// `flex: auto` = `0 1 auto`; `flex: none` = `0 0 auto`.
		// Reset all three sub-props per CSS spec — including basis to
		// `auto` (undefined in our model). Without this, a prior rule's
		// `flex: 1` setting flexBasis=0 sticks around even when a higher-
		// specificity rule with `flex: none` applies. Symptom: checkbox
		// row, `.row .widget { flex: 1 }` (lower spec) layered with
		// `.row input[type=checkbox] { flex: none; width: 24 }` (higher
		// spec) — basis=0 lingers from .widget rule, so the checkbox's
		// flex base = 0 instead of width:24 → invisible to hit-test.
		if (sole === 'auto') {
			computed.flexGrow = 1; computed.flexShrink = 1; computed.flexBasis = undefined; return;
		}
		if (sole === 'none') {
			computed.flexGrow = 0; computed.flexShrink = 0; computed.flexBasis = undefined; return;
		}
		const g = parsePxOrNum(tokens[0]);
		if (g !== undefined) { computed.flexGrow = g; computed.flexShrink = 1; computed.flexBasis = 0; }
		return;
	}
	const g = parsePxOrNum(tokens[0]);
	const s = parsePxOrNum(tokens[1]);
	if (g !== undefined) computed.flexGrow = g;
	if (s !== undefined) computed.flexShrink = s;
	if (tokens.length >= 3) {
		const b = parsePxOrNum(tokens[2]);
		if (b !== undefined) computed.flexBasis = b;
	}
}

/** Resolve `var(--name)` / `var(--name, fallback)` references in a
 * value string by checking (1) the element's OWN customProps bag
 * being accumulated this resolve pass (so earlier declarations in
 * the same rule are visible), (2) the parent chain via parentComputed.
 * Multiple var()s in one value are all resolved. */
function resolveVarRefs(
	value: string,
	el: LiveElement,
	parentComputed: ComputedLiveStyle | undefined,
	ownCustomProps?: Record<string, string>,
): string {
	// Iterate until stable so nested vars like `var(--checkbox-size)` →
	// `calc(var(--widget-height)*0.75)` → `calc(28px*0.75)` fully unfold
	// before downstream parsing. Cap at 8 passes so a self-referential
	// var can't infinite-loop.
	let out = value;
	for (let i = 0; i < 8 && out.indexOf('var(') >= 0; i++) {
		const next = out.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\s*\)/gi, (_m, name, fallback) => {
			if (ownCustomProps && name in ownCustomProps) return ownCustomProps[name];
			const v = lookupVar(el, name, parentComputed);
			if (v !== undefined) return v;
			return (fallback || '').trim();
		});
		if (next === out) break;
		out = next;
	}
	// `calc()` evaluation. lil-gui leans on `calc(var(--w)*0.75)` for
	// --checkbox-size + a few title/line-height expressions. Without
	// this, higher-specificity rules that set `width: var(...)` to a
	// calc value silently no-op (parseLength rejects the literal) and
	// the prior lower-spec `width: 100%` sticks — that's why the
	// showSunDisc checkbox fills the row instead of rendering as a
	// 21px square.
	if (out.indexOf('calc(') >= 0) out = evaluateCalcExpressions(out);
	return out;
}

/** Walk a CSS value, evaluating each top-level `calc(...)` sub-expression
 * via {@link evalCalcInner}. Replaces the calc segment with `<n>px` (or
 * `<n>` for unitless results). Leaves the rest of the value untouched.
 * Non-nested only — lil-gui doesn't nest calcs. Anything unparseable
 * stays in place so downstream parseLength can still reject cleanly. */
function evaluateCalcExpressions(value: string): string {
	let out = '';
	let i = 0;
	while (i < value.length) {
		const calcStart = value.indexOf('calc(', i);
		if (calcStart < 0) { out += value.slice(i); break; }
		out += value.slice(i, calcStart);
		// Find matching close paren.
		let depth = 1;
		let j = calcStart + 5;
		for (; j < value.length && depth > 0; j++) {
			if (value[j] === '(') depth++;
			else if (value[j] === ')') depth--;
		}
		const inner = value.slice(calcStart + 5, j - 1);
		const result = evalCalcInner(inner);
		if (result !== undefined) {
			// Trim trailing -0 noise; emit `Npx` for definite lengths.
			out += result + 'px';
		} else {
			out += value.slice(calcStart, j);
		}
		i = j;
	}
	return out;
}

/** Evaluate a single calc() body. Supports the four standard operators
 * with standard precedence: multiplication and division collapse first,
 * then addition and subtraction. Operands are either `Npx` lengths or
 * unitless numbers. Returns the resulting number (px). Returns
 * `undefined` for any expression we can't fully resolve. */
function evalCalcInner(body: string): number | undefined {
	// Tokenise into numbers (possibly with px) and operators.
	const tokens: (number | string)[] = [];
	let i = 0;
	while (i < body.length) {
		const c = body[i];
		if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
		if (c === '+' || c === '*' || c === '/') {
			tokens.push(c); i++; continue;
		}
		if (c === '-') {
			// Could be a subtraction or a unary sign. Treat as binary if
			// preceded by a number; unary otherwise.
			const last = tokens[tokens.length - 1];
			if (typeof last === 'number') { tokens.push('-'); i++; continue; }
			// fall through to number parse below — minus stays in the
			// numeric span.
		}
		// Parse a number. Allow leading `-`/`+`. Match `\d+(.\d+)?` plus
		// optional `px` suffix.
		const m = /^[+-]?\d+(?:\.\d+)?(px)?/.exec(body.slice(i));
		if (!m) return undefined;
		const n = parseFloat(m[0]);
		if (!Number.isFinite(n)) return undefined;
		tokens.push(n);
		i += m[0].length;
	}
	if (tokens.length === 0) return undefined;
	// First pass: collapse `*` and `/`.
	for (let k = 1; k < tokens.length - 1; k++) {
		const op = tokens[k];
		if (op === '*' || op === '/') {
			const a = tokens[k - 1];
			const b = tokens[k + 1];
			if (typeof a !== 'number' || typeof b !== 'number') return undefined;
			const r = op === '*' ? a * b : (b === 0 ? 0 : a / b);
			tokens.splice(k - 1, 3, r);
			k -= 1;
		}
	}
	// Second pass: collapse `+` and `-`.
	let acc = tokens[0];
	if (typeof acc !== 'number') return undefined;
	for (let k = 1; k < tokens.length; k += 2) {
		const op = tokens[k];
		const rhs = tokens[k + 1];
		if (typeof rhs !== 'number') return undefined;
		if (op === '+') acc += rhs;
		else if (op === '-') acc -= rhs;
		else return undefined;
	}
	return acc;
}

function lookupVar(
	_el: LiveElement,
	name: string,
	parentComputed: ComputedLiveStyle | undefined,
): string | undefined {
	// parentComputed is the parent's *resolved* style which already has
	// parent's parent's vars merged into customProps — one level lookup
	// is enough.
	if (parentComputed?.customProps && name in parentComputed.customProps) {
		return parentComputed.customProps[name];
	}
	return undefined;
}

function unquoteCssString(v: string): string {
	const t = v.trim();
	if (t.length >= 2 && (t.startsWith('"') && t.endsWith('"') || t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	return t;
}

function stripQuoted(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && (t.startsWith('"') && t.endsWith('"') || t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	return t;
}

function firstFamilyToken(value: string): string {
	// Legacy: kept for inline-style call sites that haven't migrated.
	// New cascade path keeps the full comma-separated family list so
	// nx.js's parse-css-font + findFont can walk to `sans-serif` at the
	// end of lil-gui's chain (canvas-rendering-context-2d.ts:112). The
	// old "pick first token" path threw away the working fallback and
	// silently no-op'd font selection.
	const i = value.indexOf(',');
	return (i < 0 ? value : value.slice(0, i)).trim();
}

/** Split a CSS value at TOP-LEVEL commas, respecting nested parens
 * (so e.g. `rgba(1,2,3)` stays as one token). Returns trimmed parts. */
function splitTopLevelCommas(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(s.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(s.slice(start).trim());
	return out.filter((p) => p.length > 0);
}

/** Parse one CSS color stop: `<color> [<percent|length>]`. Splits the
 * trailing position off from the color while respecting nested parens
 * inside e.g. `rgba(...)`. */
function parseGradientStop(s: string): GradientStop | undefined {
	const t = s.trim();
	if (!t) return undefined;
	// Walk from the END to find the last whitespace-separated token that
	// is a position (ends in % or is a length). The rest is the color.
	let depth = 0;
	let lastSpaceAtZero = -1;
	for (let i = t.length - 1; i >= 0; i--) {
		const ch = t[i];
		if (ch === ')') depth++;
		else if (ch === '(') depth--;
		else if (depth === 0 && /\s/.test(ch)) { lastSpaceAtZero = i; break; }
	}
	if (lastSpaceAtZero >= 0) {
		const tail = t.slice(lastSpaceAtZero + 1).trim();
		const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(tail);
		if (pct) {
			return { color: t.slice(0, lastSpaceAtZero).trim(), pos: parseFloat(pct[1]) / 100 };
		}
		// Pixel-positioned stop (`color 1px`). Kept as a raw px value and
		// resolved against the gradient line length at paint time — this is
		// what makes a `background-size`-tiled grid (`color 1px, transparent
		// 1px` per 42px tile) render as crisp 1px lines rather than a smooth
		// fade across the whole box.
		const pxStop = /^(-?\d+(?:\.\d+)?)px$/.exec(tail);
		if (pxStop) {
			return { color: t.slice(0, lastSpaceAtZero).trim(), posPx: parseFloat(pxStop[1]) };
		}
	}
	return { color: t, pos: undefined };
}

/** Distribute any unset `.pos` values across `stops` per CSS gradient
 * spec: first defaults to 0, last to 1, interior runs of unset values
 * are evenly spaced between their bracketing set values. A px-positioned
 * stop (`posPx`) counts as already-positioned — its fraction is resolved
 * at paint time against the gradient line length, so it's left untouched
 * here (and never has a `pos` default forced onto it). */
function fillGradientStopPositions(stops: GradientStop[]): void {
	if (stops.length === 0) return;
	const positioned = (s: GradientStop): boolean => s.pos !== undefined || s.posPx !== undefined;
	if (!positioned(stops[0])) stops[0].pos = 0;
	if (!positioned(stops[stops.length - 1])) stops[stops.length - 1].pos = 1;
	// Monotonic clamp: a positioned stop never goes earlier than the
	// previous positioned one (CSS specifies that backwards-positioned
	// stops are clamped forward, smoothing the gradient). Only fraction
	// stops participate; px stops resolve later so we can't compare here.
	let lastPos = stops[0].pos ?? 0;
	for (const stop of stops) {
		if (stop.pos !== undefined) {
			if (stop.pos < lastPos) stop.pos = lastPos;
			else lastPos = stop.pos;
		}
	}
	// Distribute unset interior runs (stops with neither pos nor posPx).
	let i = 0;
	while (i < stops.length) {
		if (positioned(stops[i])) { i++; continue; }
		let j = i;
		while (j < stops.length && !positioned(stops[j])) j++;
		const startPos = stops[i - 1].pos ?? 0;
		const endPos = stops[j]?.pos ?? 1;
		const span = (endPos - startPos) / (j - i + 1);
		for (let k = i; k < j; k++) {
			stops[k].pos = startPos + span * (k - i + 1);
		}
		i = j;
	}
}

/** Parse `linear-gradient(<angle>?, <stops>)`. Defaults angle to
 * `to bottom` (180deg) per CSS. Supports `<n>deg` / `<n>turn` /
 * `<n>rad` and `to <side>` / `to <corner>` keywords. */
function parseLinearGradient(inner: string): LinearGradient | undefined {
	const parts = splitTopLevelCommas(inner);
	if (parts.length === 0) return undefined;
	let angleRad = Math.PI; // "to bottom" — default per spec
	let stopsStart = 0;
	const head = parts[0].trim();
	const degM = /^(-?\d+(?:\.\d+)?)deg$/.exec(head);
	const turnM = /^(-?\d+(?:\.\d+)?)turn$/.exec(head);
	const radM = /^(-?\d+(?:\.\d+)?)rad$/.exec(head);
	if (degM) {
		angleRad = parseFloat(degM[1]) * Math.PI / 180;
		stopsStart = 1;
	} else if (turnM) {
		angleRad = parseFloat(turnM[1]) * 2 * Math.PI;
		stopsStart = 1;
	} else if (radM) {
		angleRad = parseFloat(radM[1]);
		stopsStart = 1;
	} else if (head.startsWith('to ')) {
		const dir = head.slice(3).trim().toLowerCase();
		const map: Record<string, number> = {
			'top': 0, 'right': 90, 'bottom': 180, 'left': 270,
			'top right': 45, 'right top': 45,
			'bottom right': 135, 'right bottom': 135,
			'bottom left': 225, 'left bottom': 225,
			'top left': 315, 'left top': 315,
		};
		if (map[dir] !== undefined) {
			angleRad = map[dir] * Math.PI / 180;
			stopsStart = 1;
		}
	}
	const stops: GradientStop[] = [];
	for (let i = stopsStart; i < parts.length; i++) {
		const stop = parseGradientStop(parts[i]);
		if (stop) stops.push(stop);
	}
	if (stops.length < 2) return undefined;
	fillGradientStopPositions(stops);
	return { type: 'linear', angleRad, stops };
}

/** Parse `radial-gradient(<shape> at <pos>, <stops>)`. Position keywords
 * (`top left`, `center`, etc.) map to box fractions; `circle` and
 * `ellipse` keywords pick the shape; size keywords (`closest-corner`
 * etc.) are recognised but the painter defaults to farthest-corner. */
function parseRadialGradient(inner: string): RadialGradient | undefined {
	const parts = splitTopLevelCommas(inner);
	if (parts.length === 0) return undefined;
	let shape: 'circle' | 'ellipse' = 'ellipse';
	let cxFrac = 0.5;
	let cyFrac = 0.5;
	let stopsStart = 0;
	const head = parts[0].trim().toLowerCase();
	// If the first token has no comma-separated color before the first
	// space, it's a shape/position descriptor.
	const looksLikeColor = /^(#|rgb|rgba|hsl|hsla|var\(|transparent|currentcolor)/i.test(head)
		|| /^[a-z]+$/i.test(head) && !/^(circle|ellipse|at|closest|farthest|center|top|bottom|left|right)$/i.test(head);
	if (!looksLikeColor && (head.includes('circle') || head.includes('ellipse') || head.includes(' at '))) {
		if (/\bcircle\b/.test(head)) shape = 'circle';
		else if (/\bellipse\b/.test(head)) shape = 'ellipse';
		const atIdx = head.indexOf(' at ');
		if (atIdx >= 0) {
			const posStr = head.slice(atIdx + 4).trim();
			const posTokens = posStr.split(/\s+/);
			const xToken = posTokens[0] ?? 'center';
			const yToken = posTokens[1] ?? 'center';
			const tokenToFrac = (tok: string, axis: 'x' | 'y'): number => {
				if (tok === 'left' || tok === 'top') return 0;
				if (tok === 'right' || tok === 'bottom') return 1;
				if (tok === 'center') return 0.5;
				const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(tok);
				if (pct) return parseFloat(pct[1]) / 100;
				return axis === 'x' ? 0.5 : 0.5;
			};
			cxFrac = tokenToFrac(xToken, 'x');
			cyFrac = tokenToFrac(yToken, 'y');
		}
		stopsStart = 1;
	}
	const stops: GradientStop[] = [];
	for (let i = stopsStart; i < parts.length; i++) {
		const stop = parseGradientStop(parts[i]);
		if (stop) stops.push(stop);
	}
	if (stops.length < 2) return undefined;
	fillGradientStopPositions(stops);
	return { type: 'radial', shape, cxFrac, cyFrac, stops };
}

/** Parse a `background:` value into ordered layers (paint order:
 * index 0 = bottom, last = top). Returns undefined for plain colors
 * so the painter falls back to `cs.background` string path. */
export function parseBackgroundLayers(value: string): BackgroundLayer[] | undefined {
	const parts = splitTopLevelCommas(value);
	const layers: BackgroundLayer[] = [];
	let sawRichLayer = false;
	for (const part of parts) {
		const t = part.trim();
		const linM = /^linear-gradient\((.+)\)$/i.exec(t);
		if (linM) {
			const lg = parseLinearGradient(linM[1]);
			if (lg) { layers.push(lg); sawRichLayer = true; continue; }
		}
		const radM = /^radial-gradient\((.+)\)$/i.exec(t);
		if (radM) {
			const rg = parseRadialGradient(radM[1]);
			if (rg) { layers.push(rg); sawRichLayer = true; continue; }
		}
		// `url("...")` anywhere in this layer's tokens — pull it out and
		// loosely parse the surrounding `no-repeat` / `center` / `contain`
		// / `cover` / `<size>` keywords. Anything we don't recognize is
		// dropped; missing keywords get sensible defaults at paint time.
		const urlM = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(t);
		if (urlM) {
			const url = urlM[2].trim();
			const rest = t.replace(urlM[0], ' ').trim();
			const img: ImageBackgroundLayer = { type: 'image', url };
			// Repeat keywords.
			if (/\bno-repeat\b/i.test(rest)) img.repeat = 'no-repeat';
			else if (/\brepeat-x\b/i.test(rest)) img.repeat = 'repeat-x';
			else if (/\brepeat-y\b/i.test(rest)) img.repeat = 'repeat-y';
			else if (/\brepeat\b/i.test(rest)) img.repeat = 'repeat';
			// Position keyword (single — we don't track per-axis yet).
			if (/\bcenter\b/i.test(rest)) img.position = 'center';
			else if (/\bleft\b/i.test(rest)) img.position = 'left';
			else if (/\bright\b/i.test(rest)) img.position = 'right';
			else if (/\btop\b/i.test(rest)) img.position = 'top';
			else if (/\bbottom\b/i.test(rest)) img.position = 'bottom';
			// Size keyword or explicit `<w> <h>` (px) — CSS allows them after
			// `/`, e.g. `center / auto 36px`. Honour `auto N px` (auto width,
			// fixed height) and `N px N px` (both fixed). `cover` / `contain`
			// override.
			if (/\bcover\b/i.test(rest)) img.sizeMode = 'cover';
			else if (/\bcontain\b/i.test(rest)) img.sizeMode = 'contain';
			else {
				const sizeMatch = /\/\s*(auto|(\d+(?:\.\d+)?)px)\s+(auto|(\d+(?:\.\d+)?)px)/i.exec(rest);
				if (sizeMatch) {
					img.sizeMode = 'auto';
					if (sizeMatch[2]) img.sizeW = parseFloat(sizeMatch[2]);
					if (sizeMatch[4]) img.sizeH = parseFloat(sizeMatch[4]);
				}
			}
			layers.push(img);
			sawRichLayer = true;
			continue;
		}
		// Solid color (or anything we don't understand — pass through
		// as a colour and let the painter assign to fillStyle).
		layers.push({ type: 'solid', color: t });
	}
	if (!sawRichLayer) return undefined;
	// CSS lists first-on-top; the painter wants bottom-first so it can
	// iterate forward.
	return layers.reverse();
}

/** Parse a `box-shadow:` value into structured shadows. Returns
 * undefined if no token parses (the caller leaves the existing value
 * alone instead of clearing it on a partial parse). */
export function parseBoxShadow(value: string): BoxShadow[] | undefined {
	const parts = splitTopLevelCommas(value);
	const out: BoxShadow[] = [];
	for (const part of parts) {
		const sh = parseOneShadow(part);
		if (sh) out.push(sh);
	}
	return out.length > 0 ? out : undefined;
}

function parseOneShadow(s: string): BoxShadow | undefined {
	// Tokenise while respecting nested parens (for rgb()/rgba()/hsl()/etc).
	const tokens: string[] = [];
	let depth = 0;
	let start = -1;
	const t = s.trim();
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		const isSep = /\s/.test(ch) && depth === 0;
		if (start < 0 && !isSep) start = i;
		else if (start >= 0 && isSep) {
			tokens.push(t.slice(start, i));
			start = -1;
		}
	}
	if (start >= 0) tokens.push(t.slice(start));
	if (tokens.length === 0) return undefined;
	let inset = false;
	if (tokens[0].toLowerCase() === 'inset') { inset = true; tokens.shift(); }
	else if (tokens[tokens.length - 1]?.toLowerCase() === 'inset') {
		inset = true; tokens.pop();
	}
	// Collect length-shaped leading tokens (up to 4: offsetX, offsetY,
	// blur, spread). Whatever remains is the colour (which may itself
	// be a single token like `rgba(...)` or `#abc`).
	const lengths: number[] = [];
	while (tokens.length > 0 && lengths.length < 4) {
		const head = tokens[0];
		const n = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(head);
		if (!n) break;
		lengths.push(parseFloat(n[1]));
		tokens.shift();
	}
	if (lengths.length < 2) return undefined;
	const color = tokens.join(' ').trim() || 'black';
	return {
		inset,
		offsetX: lengths[0],
		offsetY: lengths[1],
		blur: lengths[2] ?? 0,
		spread: lengths[3] ?? 0,
		color,
	};
}

/** Assign top/right/bottom/left to a pseudo, splitting into px vs percent
 * fields so the painter can resolve percent edges against the host box
 * at paint time. Px wins when both are set on the same edge — matches
 * a real browser's "last value wins, but absolute beats relative".
 * Without this, `top: 50%` was silently dropped (parsePxOrNum returns
 * undefined for percent) and chevron pseudos defaulted to `top: 0` —
 * which on a dropdown like DDG's region picker put the chevron right
 * on the input row's bottom edge. */
function assignPseudoEdge(
	slot: PseudoStyle,
	edge: 'top' | 'right' | 'bottom' | 'left',
	value: string,
	emBase: number,
): void {
	const t = value.trim();
	const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(t);
	if (pct) {
		const n = parseFloat(pct[1]);
		if (Number.isFinite(n)) {
			(slot as Record<string, number>)[edge + 'Pct'] = n;
			(slot as Record<string, number | undefined>)[edge] = undefined;
		}
		return;
	}
	const n = parsePxOrNum(t, { emBase });
	if (n !== undefined) {
		(slot as Record<string, number>)[edge] = n;
		(slot as Record<string, number | undefined>)[edge + 'Pct'] = undefined;
	}
}

function parsePxOrNum(value: string, ctx?: { emBase?: number; remBase?: number }): number | undefined {
	const t = value.trim();
	// em is relative to the element's own (or parent's) font-size; rem to
	// the root. Default base 16px matches the CSS spec's initial value.
	const rem = /^(-?\d+(?:\.\d+)?)rem$/.exec(t);
	if (rem) return parseFloat(rem[1]) * (ctx?.remBase ?? 16);
	const em = /^(-?\d+(?:\.\d+)?)em$/.exec(t);
	if (em) return parseFloat(em[1]) * (ctx?.emBase ?? 16);
	const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(t);
	return m ? parseFloat(m[1]) : undefined;
}

function compareSpec(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

// =========================================================================
// Stylesheet parser (uses css-tree)
// =========================================================================

function parseStyleSheet(cssText: string, baseSource: number): ParsedRule[] {
	const out: ParsedRule[] = [];
	let ast: CssNode;
	try {
		ast = parse(cssText, { positions: false });
	} catch (_) {
		return out;
	}
	walkRulesWithMedia(ast, true, (rule, mediaActive) => {
		collectRule(rule, out, mediaActive, baseSource);
	});
	return out;
}

/** Walk the AST, calling `visit` for every Rule node and tracking
 * whether we're inside an @media block that matches the Switch-touch
 * profile. */
function walkRulesWithMedia(
	node: CssNode,
	mediaActive: boolean,
	visit: (rule: Rule, mediaActive: boolean) => void,
): void {
	if (node.type === 'StyleSheet' || node.type === 'Block') {
		const children = (node as { children: { forEach: (cb: (c: CssNode) => void) => void } }).children;
		children.forEach((child) => walkRulesWithMedia(child, mediaActive, visit));
		return;
	}
	if (node.type === 'Atrule') {
		const at = node as { name?: string; prelude?: CssNode; block?: CssNode };
		const name = (at.name || '').toLowerCase();
		if (name === 'media') {
			const q = at.prelude ? safeGenerate(at.prelude) : '';
			const innerActive = mediaActive && matchMediaQuery(q);
			if (at.block) walkRulesWithMedia(at.block, innerActive, visit);
			return;
		}
		if (name === 'keyframes' || name === '-webkit-keyframes') {
			const animName = at.prelude ? safeGenerate(at.prelude).trim() : '';
			if (animName && at.block) registerKeyframes(animName, at.block);
			return;
		}
		if (name === 'font-face') {
			if (at.block) registerFontFace(at.block);
			return;
		}
		// Other at-rules (@supports) — skip their inner Rule nodes for M2.2.
		return;
	}
	if (node.type === 'Rule') {
		visit(node as Rule, mediaActive);
		return;
	}
}

function safeGenerate(node: CssNode): string {
	try { return generate(node); } catch (_) { return ''; }
}

/** Viewport size used to evaluate dimensional media features
 * (`max-width` / `min-width` / `max-height` / `min-height`). Defaults
 * to the Switch's 1280×720 content area; the shell can override via
 * `setMediaViewport` if it ever lays content out at a different size.
 * Read at stylesheet-parse time (the viewport is fixed per page load),
 * so a change only takes effect on the next `registerStyleSheet`. */
let mediaVpW = 1280;
let mediaVpH = 720;
export function setMediaViewport(w: number, h: number): void {
	mediaVpW = w;
	mediaVpH = h;
}

/** User-preferred colour scheme used to evaluate
 * `@media (prefers-color-scheme: light | dark)`. Defaults to `light`,
 * matching the wider web's expected default; the shell overrides from
 * `config.json` at startup and on any runtime toggle. Read at
 * stylesheet-parse time, so changes take effect on the next
 * `registerStyleSheet`. */
let mediaColorScheme: 'light' | 'dark' = 'light';
export function setMediaColorScheme(scheme: 'light' | 'dark'): void {
	mediaColorScheme = scheme;
}

/** Match a media-query string against our Switch profile.
 *   - `(pointer:coarse)` => true (Switch is touch)
 *   - `(hover:hover)`   => false (no real hover; lil-gui gates its
 *                         hover-only rules behind this)
 *   - `(max-width:Npx)` / `(min-width:Npx)` / `*-height` => compared
 *      against the 1280×720 content viewport. Previously these fell to
 *      the permissive `return true`, so a desktop-style stylesheet with
 *      `@media (max-width: 620px)` overrides applied them ALL at once on
 *      the 1280px screen (last one wins) — collapsing multi-column grids
 *      to one column, stacking flex bars, etc.
 *   - `screen` / no query => true
 *   - anything else => true (permissive — better to apply than skip)
 */
function matchMediaQuery(q: string): boolean {
	const raw = q.toLowerCase();
	const t = raw.replace(/\s+/g, '');
	if (!t || t === 'all' || t === 'screen') return true;
	if (t.indexOf('(hover:hover)') >= 0) return false;
	if (t.indexOf('(hover:none)') >= 0) return true;
	if (t.indexOf('(pointer:coarse)') >= 0) return true;
	if (t.indexOf('(pointer:fine)') >= 0) return false;
	// `prefers-color-scheme` opts the page into a theme variant. Compare
	// against the user's config-driven preference (`light` default). A
	// query without a token value (e.g. `(prefers-color-scheme)`) just
	// tests for support — match true so author CSS that uses the bare
	// feature still applies.
	if (t.indexOf('(prefers-color-scheme:light)') >= 0) return mediaColorScheme === 'light';
	if (t.indexOf('(prefers-color-scheme:dark)') >= 0) return mediaColorScheme === 'dark';
	if (t.indexOf('(prefers-color-scheme:no-preference)') >= 0) return false;

	// Dimensional features. A media-query list is comma-separated (OR);
	// each branch is `and`-joined terms (AND). Evaluate every recognized
	// `(max|min)-(width|height): Npx` term; unrecognized terms in a
	// branch are ignored (treated as satisfied). If the page used any
	// dimensional feature but no branch matched, the rule is inactive.
	const dimRe = /\((max|min)-(width|height)\s*:\s*(\d+(?:\.\d+)?)px\)/g;
	if (dimRe.test(raw)) {
		for (const branch of raw.split(',')) {
			let branchOk = true;
			let sawTerm = false;
			const re = /\((max|min)-(width|height)\s*:\s*(\d+(?:\.\d+)?)px\)/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(branch)) !== null) {
				sawTerm = true;
				const limit = parseFloat(m[3]);
				const actual = m[2] === 'width' ? mediaVpW : mediaVpH;
				const ok = m[1] === 'max' ? actual <= limit : actual >= limit;
				if (!ok) { branchOk = false; break; }
			}
			if (sawTerm && branchOk) return true;
		}
		return false;
	}
	return true;
}

function collectRule(rule: Rule, out: ParsedRule[], mediaActive: boolean, baseSource: number): void {
	if (!rule.prelude || rule.prelude.type !== 'SelectorList') return;
	if (!rule.block || rule.block.type !== 'Block') return;

	const decls: ParsedDecl[] = [];
	rule.block.children.forEach((child) => {
		if (child.type !== 'Declaration') return;
		const d = child as { property?: string; value?: CssNode };
		const prop = (d.property || '').toLowerCase();
		const value = d.value ? safeGenerate(d.value).trim() : '';
		if (prop && value) decls.push({ prop, value });
	});
	if (decls.length === 0) return;

	rule.prelude.children.forEach((selectorNode) => {
		if (selectorNode.type !== 'Selector') return;
		const chain = parseSelectorChain(selectorNode);
		if (!chain) return;
		out.push({
			chain,
			decls,
			specificity: computeChainSpecificity(chain),
			source: baseSource + out.length,
			mediaActive,
		});
	});
}

function parseSelectorChain(selector: Selector): SelectorChain | null {
	const compounds: Compound[] = [];
	const combinators: Combinator[] = [];
	let current: Compound = newCompound();
	let hasContent = false;
	let pseudoElement: 'before' | 'after' | null = null;
	let aborted = false;

	const flush = () => {
		if (hasContent) {
			compounds.push(current);
			current = newCompound();
			hasContent = false;
		}
	};

	selector.children.forEach((rawChild) => {
		if (aborted) return;
		const child = rawChild as {
			type: string;
			name?: string | { name?: string };
			matcher?: string;
			value?: { type: string; value?: string; name?: string };
			children?: { forEach: (cb: (n: CssNode) => void) => void };
		};
		switch (child.type) {
			case 'TypeSelector': {
				const name = String(child.name).toLowerCase();
				if (name !== '*') current.tag = name;
				hasContent = true;
				break;
			}
			case 'ClassSelector': {
				current.classes.push(String(child.name));
				hasContent = true;
				break;
			}
			case 'IdSelector': {
				current.id = String(child.name);
				hasContent = true;
				break;
			}
			case 'AttributeSelector': {
				const a = parseAttrSelector(child);
				if (!a) { aborted = true; return; }
				current.attrs.push(a);
				hasContent = true;
				break;
			}
			case 'PseudoClassSelector': {
				// css-tree categorises the legacy single-colon `:before`
				// and `:after` syntax as PseudoClassSelector, NOT
				// PseudoElementSelector — even though CSS spec treats
				// them as pseudo-elements for backwards compat. Detect
				// here so lil-gui's `.title:before { content: "▾" }`
				// rule reaches the cascade. Without this branch the
				// whole selector aborts as "unsupported".
				const rawName = typeof child.name === 'string'
					? child.name
					: (child.name as { name?: string } | undefined)?.name;
				const lower = String(rawName ?? '').toLowerCase();
				if (lower === 'before' || lower === 'after') {
					pseudoElement = lower;
					hasContent = true;
					break;
				}
				const p = parsePseudoClass(child);
				if (p === 'unsupported') { aborted = true; return; }
				if (p) current.pseudos.push(p);
				hasContent = true;
				break;
			}
			case 'PseudoElementSelector': {
				const name = String(typeof child.name === 'string' ? child.name : child.name?.name || '').toLowerCase();
				if (name === 'before' || name === 'after') {
					pseudoElement = name;
					hasContent = true;
				} else {
					// ::-webkit-* and friends — drop the whole selector.
					aborted = true;
				}
				break;
			}
			case 'Combinator': {
				const name = String(child.name);
				if (name === ' ' || name === '>' || name === '+' || name === '~') {
					flush();
					combinators.push(name as Combinator);
				} else {
					aborted = true;
				}
				break;
			}
			case 'WhiteSpace':
				break;
			default:
				aborted = true;
		}
	});
	if (aborted) return null;
	flush();
	if (compounds.length === 0) return null;
	return { compounds, combinators, pseudoElement };
}

function newCompound(): Compound {
	return { classes: [], pseudos: [], attrs: [] };
}

function parseAttrSelector(node: {
	name?: string | { name?: string };
	matcher?: string;
	value?: { type: string; value?: string; name?: string };
}): AttrPredicate | null {
	const rawName = typeof node.name === 'string' ? node.name : node.name?.name;
	if (!rawName) return null;
	const name = rawName.toLowerCase();
	const matcher = (node.matcher ?? 'has') as AttrMatcher;
	if (
		matcher !== 'has' && matcher !== '=' && matcher !== '~=' &&
		matcher !== '^=' && matcher !== '$=' && matcher !== '*=' && matcher !== '|='
	) {
		return null;
	}
	let value = '';
	if (node.value) {
		if (node.value.type === 'String') {
			value = node.value.value || '';
			if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);
		} else if (node.value.type === 'Identifier') {
			value = node.value.name || '';
		}
	}
	return { name, matcher, value };
}

/** Returns a SimplePseudo (matched), null (recognised but no-op like
 * `:root`), or `'unsupported'` (kill the selector). */
function parsePseudoClass(node: {
	name?: string | { name?: string };
	children?: { forEach: (cb: (n: CssNode) => void) => void };
}): SimplePseudo | null | 'unsupported' {
	const rawName = typeof node.name === 'string' ? node.name : node.name?.name;
	if (!rawName) return 'unsupported';
	const name = rawName.toLowerCase();
	switch (name) {
		case 'active': return { kind: 'active' };
		case 'focus': return { kind: 'focus' };
		case 'hover': return { kind: 'hover' };
		case 'disabled': return { kind: 'disabled' };
		case 'checked': return { kind: 'checked' };
		case 'empty': return { kind: 'empty' };
		case 'root': return null; // matches always — we treat the host as the root
		case 'not': {
			if (!node.children) return 'unsupported';
			// css-tree wraps :not's arg as a SelectorList → Selector → compound
			// children. Grab the first inner Selector and parse as one compound.
			let innerCompound: Compound | null = null;
			node.children.forEach((c) => {
				if (innerCompound) return;
				if (c.type === 'SelectorList') {
					const list = c as { children: { forEach: (cb: (n: CssNode) => void) => void } };
					list.children.forEach((sub) => {
						if (innerCompound) return;
						if (sub.type === 'Selector') {
							const chain = parseSelectorChain(sub as Selector);
							if (chain && chain.compounds.length === 1) {
								innerCompound = chain.compounds[0];
							}
						}
					});
				}
			});
			return innerCompound ? { kind: 'not', inner: innerCompound } : 'unsupported';
		}
		case 'first-child':
			return { kind: 'nth', a: 0, b: 1, ofType: false, fromEnd: false };
		case 'last-child':
			return { kind: 'nth', a: 0, b: 1, ofType: false, fromEnd: true };
		case 'first-of-type':
			return { kind: 'nth', a: 0, b: 1, ofType: true, fromEnd: false };
		case 'last-of-type':
			return { kind: 'nth', a: 0, b: 1, ofType: true, fromEnd: true };
		case 'only-child': {
			// Equivalent to `:first-child:last-child`. We model as a single
			// pseudo that the matcher checks both ways via the fromEnd flag
			// — but our SimplePseudo can only hold one, so report as a
			// special encoding: a=0,b=1,ofType=false, with both ends
			// implicitly tested. Easier: just emit a no-op `unsupported`
			// for now and revisit. Real usage on our pages is zero.
			return 'unsupported';
		}
		case 'nth-child':
		case 'nth-last-child':
		case 'nth-of-type':
		case 'nth-last-of-type': {
			const formula = node.children ? parseNthArg(node.children) : null;
			if (!formula) return 'unsupported';
			const ofType = name === 'nth-of-type' || name === 'nth-last-of-type';
			const fromEnd = name === 'nth-last-child' || name === 'nth-last-of-type';
			return { kind: 'nth', a: formula.a, b: formula.b, ofType, fromEnd };
		}
		default:
			return 'unsupported';
	}
}

/** Parse the argument of `:nth-child(...)` etc. Returns `{a, b}` for
 * the formula `an + b`. Recognises `odd` (2n+1), `even` (2n), plain
 * integers, and `An+B` AnPlusB form via css-tree's Nth node. Anything
 * else returns null and the caller treats the rule as unsupported. */
function parseNthArg(
	children: { forEach: (cb: (n: CssNode) => void) => void },
): { a: number; b: number } | null {
	let result: { a: number; b: number } | null = null;
	const intOr = (raw: unknown, fallback: number): number => {
		if (raw == null) return fallback;
		const n = parseInt(String(raw), 10);
		return Number.isFinite(n) ? n : fallback;
	};
	children.forEach((c) => {
		if (result) return;
		const cc = c as unknown as {
			type?: string;
			name?: string;
			value?: string;
			nth?: { type?: string; name?: string; a?: unknown; b?: unknown };
		};
		if (cc.type === 'Nth' && cc.nth) {
			const nth = cc.nth;
			if (nth.type === 'Identifier') {
				const ident = (nth.name || '').toLowerCase();
				if (ident === 'odd') result = { a: 2, b: 1 };
				else if (ident === 'even') result = { a: 2, b: 0 };
			} else if (nth.type === 'AnPlusB') {
				// css-tree stores a/b as strings ("2", "-1") or null.
				// `null a` means "An missing → a=0"; `null b` means b=0.
				const a = nth.a == null ? 0 : intOr(nth.a, NaN);
				const b = nth.b == null ? 0 : intOr(nth.b, NaN);
				if (Number.isFinite(a) && Number.isFinite(b)) {
					result = { a, b };
				}
			}
		} else if (cc.type === 'Identifier') {
			// Some css-tree versions emit `:nth-child(odd)` as a bare
			// Identifier child instead of an Nth wrapper.
			const ident = (cc.name || '').toLowerCase();
			if (ident === 'odd') result = { a: 2, b: 1 };
			else if (ident === 'even') result = { a: 2, b: 0 };
		} else if (cc.type === 'Number') {
			const n = intOr(cc.value, NaN);
			if (Number.isFinite(n)) result = { a: 0, b: n };
		}
	});
	return result;
}

function computeChainSpecificity(chain: SelectorChain): readonly [number, number, number] {
	let id = 0;
	let cls = 0;
	let type = 0;
	for (const compound of chain.compounds) {
		if (compound.id) id++;
		cls += compound.classes.length + compound.attrs.length + compound.pseudos.length;
		if (compound.tag) type++;
	}
	// Pseudo-elements add to type per CSS spec.
	if (chain.pseudoElement) type++;
	return [id, cls, type] as const;
}

// =========================================================================
// Selector matcher
// =========================================================================

/** Optional virtual pseudo-class state for "what-if" matcher runs.
 * Used by `someActiveRuleAffectsElement` / `someFocusRuleAffectsElement`
 * to test whether toggling :active / :focus on a specific element would
 * change the cascade for that element — without actually mutating the
 * element's pseudo state. `null` (the default) means "use the real
 * activeElements / focusElements sets." A non-null value pretends the
 * named element is :active / :focus in addition to whatever the real
 * sets contain. */
interface VirtualPseudoOverride {
	activeOn?: LiveElement | null;
	activeOff?: LiveElement | null;
	focusOn?: LiveElement | null;
	focusOff?: LiveElement | null;
	hoverOn?: LiveElement | null;
	hoverOff?: LiveElement | null;
}

function matchChain(chain: SelectorChain, el: LiveElement, vp?: VirtualPseudoOverride): boolean {
	const { compounds, combinators } = chain;
	if (!matchCompound(compounds[compounds.length - 1], el, vp)) return false;

	let current: LiveElement | null = el;
	for (let i = compounds.length - 2; i >= 0; i--) {
		const combinator = combinators[i];
		const left = compounds[i];
		if (combinator === '>') {
			const p: LiveElement | null = current?.parent ?? null;
			if (!p || !matchCompound(left, p, vp)) return false;
			current = p;
		} else if (combinator === '+') {
			// Adjacent sibling — left must be the immediately-preceding
			// element sibling of current. Text nodes are skipped so the
			// "adjacency" matches what authors mean by `A + B` in CSS.
			const sib = prevElementSibling(current);
			if (!sib || !matchCompound(left, sib, vp)) return false;
			current = sib;
		} else if (combinator === '~') {
			// General sibling — left must be SOME prior element sibling
			// of current. Walk back through the parent's children until
			// we find a match or run out of earlier siblings.
			let sib: LiveElement | null = prevElementSibling(current);
			let matched = false;
			while (sib) {
				if (matchCompound(left, sib, vp)) {
					matched = true;
					current = sib;
					break;
				}
				sib = prevElementSibling(sib);
			}
			if (!matched) return false;
		} else {
			// descendant
			let a: LiveElement | null = current?.parent ?? null;
			let matched = false;
			while (a) {
				if (matchCompound(left, a, vp)) {
					matched = true;
					current = a;
					break;
				}
				a = a.parent;
			}
			if (!matched) return false;
		}
	}
	return true;
}

/** Previous ELEMENT sibling of `el` (text nodes skipped). Used by the
 * `+` / `~` matcher; `null` if `el` is the first element child or has
 * no parent. */
function prevElementSibling(el: LiveElement | null): LiveElement | null {
	if (!el) return null;
	const parent = el.parent;
	if (!parent) return null;
	const siblings = parent.children;
	const idx = siblings.indexOf(el);
	if (idx <= 0) return null;
	for (let i = idx - 1; i >= 0; i--) {
		if (siblings[i].tagName !== '#text') return siblings[i];
	}
	return null;
}

function matchCompound(compound: Compound, el: LiveElement, vp?: VirtualPseudoOverride): boolean {
	if (compound.tag && compound.tag !== el.tagName.toLowerCase()) return false;
	if (compound.id && el.attrs.id !== compound.id) return false;
	for (const cls of compound.classes) {
		if (!el.classList.contains(cls)) return false;
	}
	for (const attr of compound.attrs) {
		if (!matchAttr(attr, el)) return false;
	}
	for (const pseudo of compound.pseudos) {
		if (!matchPseudo(pseudo, el, vp)) return false;
	}
	return true;
}

function matchAttr(attr: AttrPredicate, el: LiveElement): boolean {
	const v = el.getAttribute(attr.name);
	if (v === null) return false;
	switch (attr.matcher) {
		case 'has': return true;
		case '=':   return v === attr.value;
		case '~=':  return v.split(/\s+/).includes(attr.value);
		case '^=':  return v.startsWith(attr.value);
		case '$=':  return v.endsWith(attr.value);
		case '*=':  return v.indexOf(attr.value) >= 0;
		case '|=':  return v === attr.value || v.startsWith(attr.value + '-');
	}
}

function matchPseudo(pseudo: SimplePseudo, el: LiveElement, vp?: VirtualPseudoOverride): boolean {
	switch (pseudo.kind) {
		case 'active':
			if (vp && vp.activeOff === el) return false;
			if (vp && vp.activeOn === el) return true;
			return activeElements.has(el);
		case 'focus':
			if (vp && vp.focusOff === el) return false;
			if (vp && vp.focusOn === el) return true;
			return focusElements.has(el);
		case 'hover':
			// (2026-06-10) Engine-mouse hover sink. Touch never sets this;
			// the page-mouse-forwarder writes the cursor's current leaf
			// hit on every hover transition. `(hover:hover)` media query
			// still reports `false` so lil-gui-style hover gating keeps
			// working; only direct `:hover` selectors on engine-mouse
			// hits resolve true here.
			if (vp && vp.hoverOff === el) return false;
			if (vp && vp.hoverOn === el) return true;
			return hoverElements.has(el);
		case 'disabled': return el.hasAttribute('disabled');
		case 'checked': {
			// `<input>` element with `checked` attribute or .checked
			// JS property. M2.4 form widgets will set the property; for
			// M2.2 we only check the attribute.
			if (el.tagName !== 'INPUT') return false;
			return el.hasAttribute('checked');
		}
		case 'empty':    return el.children.length === 0 && !el.textContent;
		case 'not':      return !matchCompound(pseudo.inner, el, vp);
		case 'nth': {
			// Compute 1-based index among element siblings (text nodes
			// excluded — per CSS spec :nth-* counts ELEMENT children).
			// For `ofType`, count only same-tag siblings.
			const parent = el.parent;
			if (!parent) return false;
			const siblings: LiveElement[] = [];
			for (const sib of parent.children) {
				if (sib.tagName === '#text') continue;
				if (pseudo.ofType && sib.tagName !== el.tagName) continue;
				siblings.push(sib);
			}
			const rawIdx = siblings.indexOf(el);
			if (rawIdx < 0) return false;
			// 1-based; `:nth-last-*` counts from the end.
			const idx = pseudo.fromEnd ? siblings.length - rawIdx : rawIdx + 1;
			// Spec formula: `an + b` for some integer n >= 0.
			// If a === 0: idx must equal b.
			// If a !== 0: (idx - b) / a must be a non-negative integer.
			if (pseudo.a === 0) return idx === pseudo.b;
			const diff = idx - pseudo.b;
			if (pseudo.a > 0) {
				return diff >= 0 && diff % pseudo.a === 0;
			}
			// Negative a (e.g. `:nth-child(-n+3)` selects first 3).
			return diff <= 0 && (-diff) % (-pseudo.a) === 0;
		}
	}
}
