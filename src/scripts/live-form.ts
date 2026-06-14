// M2.4: form widget painting + interaction for live-DOM elements.
//
// Widget tags handled here:
//   - <input type=checkbox> — paintable checkbox; tap toggles
//     `.checked` and dispatches `change`.
//   - <input type=text|number|color|range|password|search|email|url>
//     — paintable text field; tap opens the shell's KeyboardOverlay
//     and writes the returned string back to `.value` (with `input`
//     then `change` then `blur` events).
//   - <button> — paintable button; tap fires `click` (already
//     covered by the M2.0 hit-test, but the painter draws the
//     button-styled rect + label here).
//   - <select> — paint shows the current option; tap opens a popup
//     list (M2.5).
//   - <textarea> — falls through to text-field handling.
//
// Each widget is driven by the M2.3 layout box. Background + border
// come from the cascade (lil-gui sets these for its custom look);
// foreground (checkmark, label, value text) is drawn here using the
// resolved font/colour.
//
// The shell registers a keyboard opener via `setKeyboardOpener` once
// at boot. handleLiveFormTap uses it to async-open the keyboard
// without coupling this module to the shell's KeyboardOverlay class.

import { resolveCanvasFont } from './inline-css.js';
import { getComputedLiveStyle, invalidateForSiblingCascade, someStylesheetUsesSibling, type ComputedLiveStyle } from './live-css.js';
import { bumpLiveTreeVersion, getLiveRoot, type LiveElement } from './live-dom.js';
import { getLayoutBox, type LayoutBox } from './live-layout.js';
import { patchLiveCacheRegion, patchLiveDirtyRegions, syncLiveCacheVersion } from './live-overlay.js';
import { requestFullRepaint } from './live-paint-control.js';

// =========================================================================
// Keyboard opener registration (called by the shell)
// =========================================================================

/** Per-call options the shell-registered opener forwards to the
 * KeyboardOverlay. `validate` gates the Submit key + `+`-press so
 * `<input type="number">` taps can reject letter-laden input the way
 * real browsers paint a disabled Enter on their numeric soft keyboard. */
export interface KeyboardOpenOptions {
	validate?: (value: string) => boolean;
}
type KeyboardOpener = (initial: string, options?: KeyboardOpenOptions) => Promise<string | null>;
let keyboardOpener: KeyboardOpener | null = null;
export function setKeyboardOpener(fn: KeyboardOpener | null): void {
	keyboardOpener = fn;
}

// =========================================================================
// Theme-aware widget defaults — used when the page hasn't set explicit
// CSS background/color on a form widget. The shell pushes the active
// scheme via `setLiveFormColorScheme` whenever it changes; live-form
// reads the cached object instead of recomputing per paint.
// =========================================================================

interface FormWidgetTheme {
	textFieldBg: string;
	textFieldBorder: string;
	textFieldText: string;
	textFieldPlaceholder: string;
	buttonBg: string;
	buttonText: string;
	checkboxBg: string;
	checkboxBorder: string;
	checkboxCheck: string;
	selectBg: string;
	selectBorder: string;
	selectText: string;
	selectChevron: string;
}

const LIGHT_THEME: FormWidgetTheme = {
	textFieldBg: '#ffffff',
	textFieldBorder: '#bdbdbd',
	textFieldText: '#1a1a1a',
	textFieldPlaceholder: '#888888',
	buttonBg: '#f1f3f4',
	buttonText: '#1a1a1a',
	checkboxBg: '#ffffff',
	checkboxBorder: '#888888',
	checkboxCheck: '#1a73e8',
	selectBg: '#ffffff',
	selectBorder: '#bdbdbd',
	selectText: '#1a1a1a',
	selectChevron: '#5f6368',
};

const DARK_THEME: FormWidgetTheme = {
	textFieldBg: '#424242',
	textFieldBorder: '#5a6a7e',
	textFieldText: '#ebebeb',
	textFieldPlaceholder: '#9bb1d6',
	buttonBg: '#1d2c43',
	buttonText: '#e0e8f4',
	checkboxBg: '#2c3e50',
	checkboxBorder: '#5a6a7e',
	checkboxCheck: '#ffffff',
	selectBg: '#424242',
	selectBorder: '#5a6a7e',
	selectText: '#ebebeb',
	selectChevron: '#ebebeb',
};

let liveFormTheme: FormWidgetTheme = LIGHT_THEME;
export function setLiveFormColorScheme(scheme: 'light' | 'dark'): void {
	liveFormTheme = scheme === 'dark' ? DARK_THEME : LIGHT_THEME;
}

/** Filter a parsed `cs.background` string so the CSS keywords
 * `'none'` and `'transparent'` — both valid CSS but rejected by
 * Canvas2D's fillStyle setter — don't sneak past `||` fallbacks into
 * the painter. Returns `undefined` for those keywords (caller picks
 * the theme default), the original string otherwise. Without this,
 * setting `ctx.fillStyle = 'none'` silently leaves the prior stale
 * fillStyle in place and the next `fillRect` paints with whatever
 * colour the last element used. */
function resolveWidgetBg(bg: string | undefined): string | undefined {
	if (!bg || bg === 'none' || bg === 'transparent') return undefined;
	return bg;
}

// =========================================================================
// Per-element state — `.value` for inputs, `.checked` for checkboxes.
// Stored in WeakMaps so widget state survives even though LiveElement
// doesn't natively own these properties (we monkey-patch getters in
// live-dom.ts).
// =========================================================================

const valueMap = new WeakMap<LiveElement, string>();
const checkedMap = new WeakMap<LiveElement, boolean>();

export function getInputValue(el: LiveElement): string {
	return valueMap.get(el) ?? el.attrs.value ?? '';
}
export function setInputValue(el: LiveElement, v: string): void {
	valueMap.set(el, v);
	// Phase 1.5: value writes change widget paint output (text field
	// content, range thumb position, etc.) but DON'T fire any other
	// invalidation hook. Bump version so the live-overlay cache rebuilds.
	bumpLiveTreeVersion();
}
export function getInputChecked(el: LiveElement): boolean {
	const stored = checkedMap.get(el);
	if (stored !== undefined) return stored;
	return el.hasAttribute('checked');
}
export function setInputChecked(el: LiveElement, v: boolean): void {
	checkedMap.set(el, v);
	bumpLiveTreeVersion();
}

function inputType(el: LiveElement): string {
	return (el.getAttribute('type') || 'text').toLowerCase();
}

/** Does this tag draw via the form-widget painter (instead of the
 * generic text/bg painter)? SUMMARY + LABEL aren't really form widgets,
 * but they share the "tap → default action" contract that controller-
 * shortcuts routes through `handleFormTap`. SUMMARY toggles its parent
 * details; LABEL forwards the tap to its `for=` target. Without
 * inclusion in this set, tapping them would only dispatch a click event
 * without firing the default action. */
export function isFormWidget(el: LiveElement): boolean {
	const t = el.tagName;
	return t === 'INPUT' || t === 'BUTTON' || t === 'SELECT' ||
		t === 'TEXTAREA' || t === 'SUMMARY' || t === 'LABEL';
}

// =========================================================================
// Painter
// =========================================================================

/** Paint a form widget element given its computed style + layout box.
 * Returns true if the element was handled (caller skips the generic
 * painter); false to fall through to the regular div/text path. */
export function paintFormWidget(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	/** When true, the caller already painted the box background +
	 * border + shadow (rich CSS bg path), so the widget should draw
	 * only its foreground (label / value text). */
	skipBg = false,
): boolean {
	const tag = el.tagName;
	if (tag === 'INPUT') {
		const type = inputType(el);
		// Hidden inputs are layout-suppressed (layoutLeaf sets 0×0) AND
		// the form-data-set algorithm still includes their `value` on
		// submit, but they must not paint anything visible. Without
		// this short-circuit the default branch below would route them
		// to `paintTextField` and draw a stray field rectangle wherever
		// the parent layout placed the (zero-size) box.
		if (type === 'hidden') return true;
		switch (type) {
			case 'checkbox': paintCheckbox(ctx, el, cs, box); return true;
			case 'radio':    paintRadio(ctx, el, cs, box); return true;
			case 'range':    paintRange(ctx, el, cs, box); return true;
			case 'color':    paintColorSwatch(ctx, el, cs, box); return true;
			case 'button':
			case 'submit':   paintButton(ctx, el, cs, box, skipBg); return true;
			default:         paintTextField(ctx, el, cs, box, skipBg); return true;
		}
	}
	if (tag === 'BUTTON') { paintButton(ctx, el, cs, box, skipBg); return true; }
	if (tag === 'SELECT') { paintSelect(ctx, el, cs, box); return true; }
	if (tag === 'TEXTAREA') { paintTextField(ctx, el, cs, box, skipBg); return true; }
	return false;
}

function paintCheckbox(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const checked = getInputChecked(el);
	const bg = resolveWidgetBg(cs.background) ?? liveFormTheme.checkboxBg;
	const color = cs.color || liveFormTheme.checkboxCheck;
	ctx.fillStyle = bg;
	ctx.fillRect(box.x, box.y, box.w, box.h);
	// Subtle border so an empty checkbox is visually distinct from
	// surrounding panel bg of the same colour.
	ctx.strokeStyle = liveFormTheme.checkboxBorder;
	ctx.lineWidth = 1;
	ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
	if (checked) {
		// Draw the checkmark via canvas paths instead of an Unicode
		// glyph — the Switch font doesn't reliably have `✓` U+2713
		// even though the [[nxjs-font-glyph-coverage]] memory suggested
		// it should. Path-based drawing scales with box size and has
		// no font dependency.
		ctx.save();
		try {
			ctx.strokeStyle = color;
			ctx.lineWidth = Math.max(2, Math.min(box.w, box.h) * 0.12);
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';
			ctx.beginPath();
			// Three-point checkmark: short stroke down-right + long up-right.
			ctx.moveTo(box.x + box.w * 0.22, box.y + box.h * 0.52);
			ctx.lineTo(box.x + box.w * 0.43, box.y + box.h * 0.72);
			ctx.lineTo(box.x + box.w * 0.78, box.y + box.h * 0.30);
			ctx.stroke();
		} finally { ctx.restore(); }
	}
}

/** Batch B (2026-05-25): `<input type=radio>` paints as a circle outline
 * with a filled inner disc when checked. Name-group exclusivity is
 * handled in `handleFormTap`. */
function paintRadio(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const checked = getInputChecked(el);
	const bg = cs.background || '#2c3e50';
	const color = cs.color || '#ffffff';
	const cx = box.x + box.w / 2;
	const cy = box.y + box.h / 2;
	const r = Math.min(box.w, box.h) / 2 - 1;
	ctx.save();
	try {
		ctx.fillStyle = bg;
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = '#5a6a7e';
		ctx.lineWidth = 1;
		ctx.stroke();
		if (checked) {
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
			ctx.fill();
		}
	} finally { ctx.restore(); }
}

/** Batch B (2026-05-25): `<input type=range>` paints as a horizontal
 * track with the filled portion left of the thumb. Reads `min` / `max`
 * / `value` attributes (defaults 0/100/midpoint). Tap-to-position is in
 * `handleFormTap`. */
function paintRange(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const min = parseFloat(el.getAttribute('min') ?? '0') || 0;
	const max = parseFloat(el.getAttribute('max') ?? '100') || 100;
	const valueStr = getInputValue(el);
	// parseFloat first; only fall back to the midpoint when the value is
	// genuinely absent/non-numeric. A plain `|| midpoint` treated a real
	// value of 0 as falsy and snapped the thumb to the centre (the audio
	// player's seek bar showed mid-track at 0:00).
	const parsedValue = parseFloat(valueStr);
	const value = Number.isFinite(parsedValue) ? parsedValue : ((min + max) / 2);
	const range = max - min || 1;
	const frac = Math.max(0, Math.min(1, (value - min) / range));
	const trackBg = cs.background || '#2c3e50';
	const fillColor = cs.color || '#7eda9f';
	const trackH = Math.max(2, Math.min(6, box.h / 4));
	const trackY = box.y + box.h / 2 - trackH / 2;
	const thumbR = Math.min(box.h / 2 - 1, 9);
	const thumbX = box.x + thumbR + (box.w - thumbR * 2) * frac;
	const thumbY = box.y + box.h / 2;
	ctx.save();
	try {
		// Track background
		ctx.fillStyle = trackBg;
		ctx.fillRect(box.x, trackY, box.w, trackH);
		// Filled portion left of the thumb
		ctx.fillStyle = fillColor;
		ctx.fillRect(box.x, trackY, thumbX - box.x, trackH);
		// Thumb
		ctx.fillStyle = fillColor;
		ctx.beginPath();
		ctx.arc(thumbX, thumbY, thumbR, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = '#5a6a7e';
		ctx.lineWidth = 1;
		ctx.stroke();
	} finally { ctx.restore(); }
}

function paintColorSwatch(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const v = getInputValue(el) || '#000000';
	ctx.fillStyle = v;
	ctx.fillRect(box.x, box.y, box.w, box.h);
	// 1-px border to differentiate from neighbouring solid bg.
	ctx.strokeStyle = cs.color || '#ffffff';
	ctx.lineWidth = 1;
	ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
}

/** Resolve `border-radius` to a px radius clamped to half the shorter
 * side (mirrors live-overlay's resolver; kept local to avoid an import
 * cycle between live-form and live-overlay). */
function formBorderRadius(cs: ComputedLiveStyle, w: number, h: number): number {
	const v = cs.borderRadius;
	if (!v || w <= 0 || h <= 0) return 0;
	const maxR = Math.min(w, h) / 2;
	if ('px' in v) return Math.max(0, Math.min(v.px, maxR));
	return Math.max(0, Math.min(v.percent * Math.min(w, h), maxR));
}

/** Trace a rounded-rect path and fill it with the current fillStyle. */
function fillRoundedRectPath(
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
	ctx.fill();
}

/** Trace a rounded-rect path and stroke it with the current strokeStyle. */
function strokeRoundedRectPath(
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
	ctx.stroke();
}

function paintButton(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	skipBg = false,
): void {
	const color = cs.color || liveFormTheme.buttonText;
	if (!skipBg) {
		// Solid-bg path. Rich CSS backgrounds (gradients) are painted by
		// the caller before dispatch; here `cs.background` is a plain
		// colour (or the default). Using it as fillStyle directly would
		// silently no-op for a gradient string — hence the skipBg gate.
		ctx.fillStyle = resolveWidgetBg(cs.background) ?? liveFormTheme.buttonBg;
		// Honor `border-radius` on solid-bg buttons (icon buttons use
		// rounded corners). A plain fillRect ignored it, leaving square
		// chips; round the fill when a radius is set.
		const r = formBorderRadius(cs, box.w, box.h);
		if (r > 0) {
			fillRoundedRectPath(ctx, box.x, box.y, box.w, box.h, r);
		} else {
			ctx.fillRect(box.x, box.y, box.w, box.h);
		}
	}
	// Label: <button>'s textContent or <input>'s value attribute.
	const label = el.tagName === 'BUTTON'
		? (el.textContent || '')
		: (el.getAttribute('value') || '');
	if (label) {
		ctx.save();
		try {
			ctx.font = resolveCanvasFont({ fontSize: cs.fontSize, fontFamily: cs.fontFamily });
			ctx.fillStyle = color;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'center';
			ctx.fillText(label, box.x + box.w / 2, box.y + box.h / 2);
		} finally { ctx.restore(); }
	}
}

function paintTextField(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	skipBg = false,
): void {
	const color = cs.color || liveFormTheme.textFieldText;
	// Honor `border-radius` — without this, every `<input type=text>` /
	// `<textarea>` paints with square corners regardless of the cascade
	// rule. Matches the rounded-corner treatment paintSelect / paintButton
	// already give their backgrounds. `radius === 0` falls through to the
	// flat-rect fast path so non-rounded fields cost no extra work.
	const radius = formBorderRadius(cs, box.w, box.h);
	if (!skipBg) {
		ctx.fillStyle = resolveWidgetBg(cs.background) ?? liveFormTheme.textFieldBg;
		if (radius > 0) {
			fillRoundedRectPath(ctx, box.x, box.y, box.w, box.h, radius);
		} else {
			ctx.fillRect(box.x, box.y, box.w, box.h);
		}
		// Default: paint a 1 px border in the theme colour so the field
		// is visible against a same-colour body bg (white field on
		// white tier3 page). Author CSS can override the width and
		// colour via the cascade — `border-width: 0` explicitly
		// suppresses the border (the page wants a borderless field),
		// any other value flows through `cs.borderTopWidth`/`Color`.
		// Previously the gate was `(borderTopWidth ?? 0) === 0`, which
		// conflated "page said nothing" with "page set 0" and dropped
		// the default border for every page that didn't explicitly
		// style its inputs.
		const borderWidth = cs.borderTopWidth ?? 1;
		if (borderWidth > 0) {
			ctx.strokeStyle = cs.borderTopColor ?? liveFormTheme.textFieldBorder;
			ctx.lineWidth = borderWidth;
			const off = borderWidth / 2;
			if (radius > 0) {
				strokeRoundedRectPath(ctx, box.x + off, box.y + off, box.w - borderWidth, box.h - borderWidth, Math.max(0, radius - off));
			} else {
				ctx.strokeRect(box.x + off, box.y + off, box.w - borderWidth, box.h - borderWidth);
			}
		}
	}
	const value = getInputValue(el);
	// Fall back to the `placeholder` attribute (muted) when empty, so an
	// empty search field shows its prompt instead of nothing.
	const placeholder = el.getAttribute('placeholder') || '';
	const text = value || placeholder;
	if (text) {
		ctx.save();
		try {
			ctx.font = resolveCanvasFont({ fontSize: cs.fontSize, fontFamily: cs.fontFamily });
			ctx.fillStyle = value ? color : (cs.color ? withAlpha(cs.color, 0.6) : liveFormTheme.textFieldPlaceholder);
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'left';
			// Clip to box; pad 3px inside.
			ctx.beginPath();
			ctx.rect(box.x + 2, box.y + 1, box.w - 4, box.h - 2);
			ctx.clip();
			ctx.fillText(text, box.x + 6, box.y + box.h / 2);
		} finally { ctx.restore(); }
	}
}

/** Best-effort muted variant of a colour for placeholder text. Falls
 * back to the input colour itself if we can't parse it. */
function withAlpha(color: string, alpha: number): string {
	const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
	if (hex) {
		const n = parseInt(hex[1], 16);
		const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
		return `rgba(${r},${g},${b},${alpha})`;
	}
	return '#9bb1d6';
}

/** Read the user-visible text of an OPTION (or any leaf element).
 * Falls back to walking #text children when the element's own `_text`
 * field is empty — the case for OPTIONs parsed from real-world markup
 * like `<option>All Regions</option>`. */
function readOptionLabel(el: LiveElement): string {
	if (el.textContent) return el.textContent;
	let s = '';
	for (const c of el.children) {
		if (c.tagName === '#text') s += c.data;
	}
	return s;
}

function paintSelect(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	// Respect explicit `background:none` / `border:none` from the page
	// (DDG html-mode sets both on the underlying <select>; the wrapper
	// .frm__select provides chevron + spacing). When the page makes
	// these decisions intentionally, painting our theme chrome over
	// them makes the widget look heavier than designed. Undefined =
	// no rule → use theme defaults so a bare <select> on a page with
	// no styling still reads as a tappable control.
	const bgRaw = cs.background;
	const bgExplicitlyNone = bgRaw === 'none' || bgRaw === 'transparent';
	const bg = bgExplicitlyNone ? null : (resolveWidgetBg(bgRaw) ?? liveFormTheme.selectBg);
	// `border:none` sets borderTopWidth to 0 (per applyBorderShorthand).
	// Undefined = the page didn't touch the border → theme default.
	const borderTouched = cs.borderTopWidth !== undefined;
	const showBorder = !borderTouched || (cs.borderTopWidth ?? 0) > 0;
	const color = cs.color || liveFormTheme.selectText;
	const radius = formBorderRadius(cs, box.w, box.h);
	if (bg) {
		ctx.fillStyle = bg;
		if (radius > 0) {
			fillRoundedRectPath(ctx, box.x, box.y, box.w, box.h, radius);
		} else {
			ctx.fillRect(box.x, box.y, box.w, box.h);
		}
	}
	if (showBorder) {
		ctx.strokeStyle = cs.borderTopColor || liveFormTheme.selectBorder;
		ctx.lineWidth = 1;
		if (radius > 0) {
			// Re-trace the path for stroke — fillRoundedRectPath consumes the
			// path with fill(), so stroke() would re-stroke a stale path.
			strokeRoundedRectPath(
				ctx, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1,
				Math.max(0, radius - 0.5),
			);
		} else {
			ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
		}
	}
	// Display the currently-selected option's text. The selected index
	// is read from the SELECT's `value` attribute (M2.5 popup writes
	// this on selection).
	const selectedValue = getInputValue(el);
	let labelText = '';
	for (const child of el.children) {
		if (child.tagName !== 'OPTION') continue;
		// `textContent` getter on LiveElement returns only the element's
		// own `_text` field — for an OPTION parsed from markup like
		// `<option>All Regions</option>`, the label is on a `#text`
		// child, not the OPTION itself, so the getter returns '' and the
		// label would be invisible. Walk the OPTION's children for the
		// text payload directly.
		const optLabel = readOptionLabel(child);
		const optValue = child.getAttribute('value') ?? optLabel;
		if (optValue === selectedValue || labelText === '') {
			labelText = optLabel;
			if (optValue === selectedValue) break;
		}
	}
	ctx.save();
	try {
		ctx.font = resolveCanvasFont({ fontSize: cs.fontSize, fontFamily: cs.fontFamily });
		ctx.fillStyle = color;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		ctx.beginPath();
		ctx.rect(box.x + 2, box.y + 1, box.w - 18, box.h - 2);
		ctx.clip();
		ctx.fillText(labelText, box.x + 4, box.y + box.h / 2);
	} finally { ctx.restore(); }
	// Dropdown chevron at the right edge. Draw as a path triangle
	// instead of relying on `▼` U+25BC which tofu'd in Citron despite
	// [[nxjs-font-glyph-coverage]] suggesting it should be in font.
	// Path-based drawing scales with box size and works reliably.
	ctx.save();
	try {
		// Chevron drawn as a thin "˅" stroke (two lines meeting at a
		// point) instead of a filled triangle — matches the lighter look
		// of native browser dropdowns. The capped-at-28-px shorter side
		// keeps the chevron sensible if a future layout regression hands
		// paintSelect a giant box.
		ctx.strokeStyle = cs.color || liveFormTheme.selectChevron;
		ctx.lineWidth = 1.5;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		const cx = box.x + box.w - 10;
		const cy = box.y + box.h / 2;
		const cap = Math.min(box.w, box.h, 28) * 0.3;
		const tw = Math.max(4, cap);  // chevron arm half-width
		const th = tw * 0.55;          // chevron drop
		ctx.beginPath();
		ctx.moveTo(cx - tw, cy - th / 2);
		ctx.lineTo(cx, cy + th / 2);
		ctx.lineTo(cx + tw, cy - th / 2);
		ctx.stroke();
	} finally { ctx.restore(); }
}

// =========================================================================
// Tap handler — called from controller-shortcuts.ts touch dispatch.
// =========================================================================

/** Returns true if `el` is a form widget and the tap was consumed
 * (caller should not fire a generic `click` after this). False means
 * the caller should fall through to the normal click dispatch.
 *
 * `tapX` (optional, screen space) is used by `<input type=range>` to
 * compute the new value from the tap position. Callers that don't have
 * a tap position (e.g. synthetic click from a label-for forward) can
 * omit it — range falls back to bumping the value by one step.
 *
 * Phase 1.5+1.6 follow-up (2026-05-25): every consumed tap flags
 * `requestFullRepaint()` so the shell's `onTick` (in browser-shell.ts)
 * notices and refreshes the screen even when the page has no rAF loop
 * driving paints. Without this, the live-overlay cache rebuilds happen
 * on the NEXT scroll instead of immediately — taps "feel dead." */
export async function handleFormTap(el: LiveElement, tapX?: number, clickAlreadyFired = false): Promise<boolean> {
	if (el.hasAttribute('disabled')) return true;
	requestFullRepaint();
	const tag = el.tagName;
	if (tag === 'LABEL') {
		// `<label for="X">` forwards the tap to the input with id="X"
		// (HTML5 spec). When `for` is missing, fall back to the first
		// form-widget descendant (the "labeled control" pattern of
		// wrapping the input inside the label).
		const forId = el.getAttribute('for');
		let target: LiveElement | null = null;
		if (forId) target = findById(getLiveRoot(), forId);
		if (!target) target = findFirstFormWidget(el);
		if (target && target !== el) {
			// Forwarded from the label tap: the touch dispatcher fired `click`
			// on the LABEL, not on this target, so let the target fire its own.
			return await handleFormTap(target, tapX, false);
		}
		return true;
	}
	if (tag === 'INPUT') {
		const type = inputType(el);
		if (type === 'checkbox') {
			const next = !getInputChecked(el);
			setInputChecked(el, next);
			// Mirror to attribute so the M2.2 :checked selector picks it up.
			el.toggleAttribute('checked', next);
			fireEvent(el, 'change');
			patchAndSync(el);
			return true;
		}
		if (type === 'radio') {
			// Name-group exclusivity: every other radio in the same form
			// (or document, if not in a form) with the same `name` clears
			// its checked state when this one becomes checked. Already-
			// checked radios re-tapped stay checked (no toggle-off — that
			// matches real browser behavior; users uncheck by picking a
			// different radio).
			const patched: LiveElement[] = [];
			const name = el.getAttribute('name');
			if (name) {
				const group = findRadioGroup(getLiveRoot(), name);
				for (const sib of group) {
					if (sib === el) continue;
					if (getInputChecked(sib)) {
						setInputChecked(sib, false);
						sib.toggleAttribute('checked', false);
						fireEvent(sib, 'change');
						patched.push(sib);
					}
				}
			}
			if (!getInputChecked(el)) {
				setInputChecked(el, true);
				el.toggleAttribute('checked', true);
				fireEvent(el, 'change');
				patched.push(el);
			}
			// Sibling-combinator rules (e.g. `input:checked ~ .panel`)
			// make the cascade for LATER siblings depend on `:checked`.
			// The patchAndSync fast path only repaints the radios; to
			// reflect a cascade flip in siblings (tab UIs), force a full
			// rebuild by skipping the cache-version sync and letting the
			// implicit `bumpLiveTreeVersion` from `setAttribute('checked')`
			// trigger paintLiveOverlay's full pass on the next frame.
			if (someStylesheetUsesSibling()) {
				// `setAttribute('checked')` above already bumped the tree
				// version + invalidated each radio's OWN subtree cascade,
				// but the panels (which match via `input:checked ~ .panel`)
				// keep their cached cascade — `walkInvalidate(radio)`
				// doesn't reach siblings. Without a global cascade clear
				// the radio's box (which is `display:none`, so has no
				// rect) would let `patchLiveDirtyRegions` declare "no
				// visible regions changed" + sync the cache version,
				// silently dropping the rebuild. Clear the whole cache
				// + mark the document root dirty so the next paint
				// re-lays-out the body subtree with the fresh `:checked`
				// state and the panels re-cascade. Costs a full rebuild
				// per tab tap — acceptable.
				for (const e of patched) invalidateForSiblingCascade(e);
				requestFullRepaint();
			} else {
				patchAndSync(...patched);
			}
			return true;
		}
		if (type === 'range') {
			const min = parseFloat(el.getAttribute('min') ?? '0') || 0;
			const max = parseFloat(el.getAttribute('max') ?? '100') || 100;
			const step = parseFloat(el.getAttribute('step') ?? '1') || 1;
			let next: number;
			if (typeof tapX === 'number') {
				const lb = getLayoutBox(el);
				if (lb && lb.w > 0) {
					const frac = Math.max(0, Math.min(1, (tapX - lb.x) / lb.w));
					next = min + frac * (max - min);
				} else {
					next = (min + max) / 2;
				}
			} else {
				// No tap position — bump by one step (gamepad-friendly).
				const cur = parseFloat(getInputValue(el)) || min;
				next = Math.min(max, cur + step);
			}
			// Snap to step.
			next = min + Math.round((next - min) / step) * step;
			next = Math.max(min, Math.min(max, next));
			setInputValue(el, String(next));
			fireEvent(el, 'input');
			fireEvent(el, 'change');
			patchAndSync(el);
			return true;
		}
		if (type === 'button' || type === 'submit') {
			fireEvent(el, 'click');
			return true;
		}
		if (type === 'color') {
			// Quick-cycle a small palette per tap. Full color picker UI
			// is deferred to M2.5; this is enough for lil-gui to exercise
			// the change event chain.
			const palette = ['#ff5555', '#55ff55', '#5555ff', '#ffd35e', '#7eda9f', '#ffffff', '#000000'];
			const cur = getInputValue(el);
			const idx = palette.indexOf(cur);
			const next = palette[(idx + 1) % palette.length];
			setInputValue(el, next);
			fireEvent(el, 'input');
			fireEvent(el, 'change');
			patchAndSync(el);
			return true;
		}
		// text / number / email / search / url / password
		return await openKeyboardAndApply(el);
	}
	if (tag === 'TEXTAREA') return await openKeyboardAndApply(el);
	if (tag === 'SELECT') {
		// Cycle through options on tap. M2.5 will replace with a real
		// popup overlay; cycling is the simplest stand-in that still
		// fires `change` reliably for lil-gui's option controller.
		const options = el.children.filter((c) => c.tagName === 'OPTION');
		if (options.length === 0) return true;
		const cur = getInputValue(el);
		let idx = options.findIndex((o) => (o.getAttribute('value') ?? o.textContent) === cur);
		if (idx < 0) idx = 0;
		const next = options[(idx + 1) % options.length];
		const nextValue = next.getAttribute('value') ?? next.textContent;
		setInputValue(el, nextValue);
		fireEvent(el, 'change');
		patchAndSync(el);
		return true;
	}
	if (tag === 'BUTTON') {
		// The touch dispatcher (controller-shortcuts) already dispatched
		// `click` on this element before calling us (see the SUMMARY note
		// below), so re-firing here would run the page's handler TWICE — for
		// a play/pause toggle that meant Stop immediately re-Played ("audio
		// keeps playing"). Only fire when we WEREN'T preceded by that
		// dispatch (e.g. a label-for forward).
		if (!clickAlreadyFired) fireEvent(el, 'click');
		// Targeted repaint of exactly what the click handler mutated (color
		// toggle, status, active-row highlight, …) so a tap doesn't rebuild
		// the whole page cache.
		patchLiveDirtyRegions();
		return true;
	}
	if (tag === 'SUMMARY') {
		// Default action: toggle the parent <details>.open attribute and
		// fire the spec-named `toggle` event on the details element. The
		// outer touchend dispatch already fired `click` on summary itself,
		// so we only emit `toggle` here. invalidateLiveStyle is automatic
		// via toggleAttribute, so the layout's "closed details hides non-
		// summary kids" filter kicks in on the next paint.
		const details = el.parent;
		if (details && details.tagName === 'DETAILS') {
			details.toggleAttribute('open');
			fireEvent(details, 'toggle');
		}
		return true;
	}
	return false;
}

/** Build a per-input validator the keyboard uses to gate its Submit
 * key. Returns `null` when the input doesn't impose constraints (text
 * / URL / search fields) so the keyboard reuses the always-allow path
 * shared with the URL bar + search box. For `<input type="number">`
 * the validator accepts only a strict JS-style numeric literal —
 * matches `sanitizeKeyboardResult`'s acceptance set so anything the
 * sanitizer would empty-out is also rejected up-front. */
function buildKeyboardValidator(el: LiveElement): ((value: string) => boolean) | null {
	if (el.tagName !== 'INPUT') return null;
	const type = inputType(el);
	if (type !== 'number') return null;
	return (value: string): boolean => {
		const t = value.trim();
		if (t === '') return false;
		return /^-?\d+(?:\.\d+)?$/.test(t);
	};
}

/** Filter / clamp the keyboard's raw result against the input's
 * declared type. Mirrors how real browsers treat an unparseable
 * `<input type="number">` submission: the slot ends up empty rather
 * than holding `"foo"`. For valid numeric input the value is also
 * clamped to `[min, max]` when those attributes are set so a typed
 * `9999` in a `max="1000"` field commits as `"1000"` — same shape as
 * the Settings page's shell-side `loadConfig` clamps. */
function sanitizeKeyboardResult(el: LiveElement, raw: string): string {
	if (el.tagName !== 'INPUT') return raw;
	const type = inputType(el);
	if (type === 'number') {
		const trimmed = raw.trim();
		// Match a JS-parseable signed number with optional fraction.
		// Anything else (letters, multiple dots, stray punctuation)
		// → empty string, same as Chrome's behaviour on a bad submit.
		if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return '';
		let n = parseFloat(trimmed);
		if (!Number.isFinite(n)) return '';
		const min = parseFloat(el.getAttribute('min') ?? '');
		const max = parseFloat(el.getAttribute('max') ?? '');
		if (Number.isFinite(min) && n < min) n = min;
		if (Number.isFinite(max) && n > max) n = max;
		// Trunc when both bounds are integer-shaped (matches
		// loadConfig's `maxHistory` integer handling).
		if (Number.isInteger(min) && Number.isInteger(max)) n = Math.trunc(n);
		return String(n);
	}
	return raw;
}

export async function openKeyboardAndApply(el: LiveElement): Promise<boolean> {
	if (!keyboardOpener) return false;
	const cur = getInputValue(el);
	// The keyboard itself manages the `isKeyboardOpen` flag now (set on
	// entry, cleared on the resolve path) so the URL bar and `<input>`
	// paths are gated uniformly. It also calls `requestFullRepaint()` on
	// close so the next idle tick blits the page back over the panel.
	const validate = buildKeyboardValidator(el);
	let result: string | null;
	try {
		result = await keyboardOpener(cur, validate ? { validate } : undefined);
	} catch (_) {
		result = null;
	}
	if (result === null) {
		fireEvent(el, 'blur');
		return true;
	}
	// Spec-style validation pass before commit. The brewser keyboard is
	// a single alphanumeric layout (no per-input-mode variant), so a
	// user typing into `<input type="number">` can still hit letter
	// keys. Real browsers reject non-conforming text by leaving
	// `.value` empty on submit; mirror that here for `type="number"`
	// (and friends), plus enforce `min`/`max` clamps so the on-disk
	// value is always within the field's declared bounds. Other input
	// types pass through unchanged.
	result = sanitizeKeyboardResult(el, result);
	setInputValue(el, result);
	fireEvent(el, 'input');
	fireEvent(el, 'change');
	fireEvent(el, 'blur');
	// Patch the text-field cell so the user sees the typed value the
	// instant the keyboard closes — `setInputValue` bumped the tree
	// version, so without this patch the next paint would do a full
	// rebuild. Sync the cache version after patching so the rebuild is
	// skipped.
	patchAndSync(el);
	// 2026-06-14 kb-commit lag fix: `KeyboardOverlay.finish()` already
	// did one repaint via `repaintDriver()` at close time — but that
	// fired BEFORE this resume point (we're inside the macrotask the
	// finish() `setTimeout(() => resolve(result), 0)` deferred). The
	// shell's main-loop `onTick` then consumed any pending repaint
	// request from `setKeyboardOpen(false)` BEFORE `setInputValue`
	// landed, so its blit showed the stale value. Re-request a repaint
	// here so the next `onTick` blits the freshly-patched cache (which
	// holds the new text) to the screen. Without this the typed value
	// only became visible after the next unrelated tap re-painted.
	requestFullRepaint();
	return true;
}

/** Phase 1.6.1: patch the live-overlay cache for each mutated element
 * then sync the cache version so the next paint blits the cache as-is
 * instead of doing a full rebuild. Used by every non-SUMMARY tap
 * handler so the visual response feels instant — patching one box is
 * ~ms vs. ~80-150 ms for re-cascading the whole tree. SUMMARY is the
 * exception because expand/collapse shifts sibling layout, and a
 * partial patch would leave the cache visually inconsistent. */
function patchAndSync(...els: LiveElement[]): void {
	for (const el of els) patchLiveCacheRegion(el);
	syncLiveCacheVersion();
}

/** Walk `root`'s subtree for the first element with `id === target`. */
function findById(root: LiveElement, target: string): LiveElement | null {
	if (root.attrs.id === target) return root;
	for (const c of root.children) {
		const found = findById(c, target);
		if (found) return found;
	}
	return null;
}

/** Walk `root`'s subtree for the first form-widget descendant — used by
 * `<label>` without `for=` to forward the tap to the wrapped input. */
function findFirstFormWidget(root: LiveElement): LiveElement | null {
	for (const c of root.children) {
		if (isFormWidget(c)) return c;
		const found = findFirstFormWidget(c);
		if (found) return found;
	}
	return null;
}

/** Walk `root` collecting every `<input type=radio name="X">`. Used by
 * the radio tap handler to enforce name-group exclusivity. */
function findRadioGroup(root: LiveElement, name: string): LiveElement[] {
	const out: LiveElement[] = [];
	const visit = (el: LiveElement) => {
		if (el.tagName === 'INPUT'
			&& (el.getAttribute('type') ?? '').toLowerCase() === 'radio'
			&& el.getAttribute('name') === name) {
			out.push(el);
		}
		for (const c of el.children) visit(c);
	};
	visit(root);
	return out;
}

function fireEvent(el: LiveElement, type: string): void {
	try {
		el.dispatchEvent({ type, target: el, currentTarget: el });
	} catch (_) { /* swallow */ }
}

// =========================================================================
// Form submission — build the URL a `<form>` would navigate to when its
// submit button is tapped. Used by live-overlay's `findTapIntent` so
// `<input type=submit>` / `<button type=submit>` taps turn into a
// `navigate` intent through the same path that `<a href>` taps use.
// =========================================================================

/** Walk up from `start` to the enclosing `<form>` (or `null` if none).
 * Used to resolve a submit-button tap to its owning form. */
export function findEnclosingForm(start: LiveElement): LiveElement | null {
	for (let n: LiveElement | null = start; n; n = n.parent) {
		if (n.tagName === 'FORM') return n;
	}
	return null;
}

/** Build the URL a `<form>` would navigate to when submitted by
 * `submitter` (a submit button / submit input — null if the form was
 * submitted by some other means, e.g. an Enter keypress on a text
 * field). Returns `null` when the form has no `action` AND no enclosing
 * page to default it against — in that case the caller should skip
 * navigation.
 *
 * GET method: serialise every named, non-disabled, successful control
 * into the action URL's query string per HTML's
 * application/x-www-form-urlencoded algorithm. The action itself can be
 * relative — the shell resolves it against the current page URL the
 * same way it does for `<a href>`.
 *
 * POST method: we don't yet have a request-body navigation path, so we
 * navigate to the action URL with no body. The result will be wrong
 * for sites that expect form data in a POST, but it won't crash and it
 * leaves the door open for a real POST-navigation slice later.
 */
export function buildFormSubmitUrl(
	form: LiveElement,
	submitter: LiveElement | null,
): string | null {
	const rawAction = (form.getAttribute('action') ?? '').trim();
	const method = (form.getAttribute('method') ?? 'GET').toUpperCase();
	const action = rawAction || '';

	if (method !== 'GET') {
		return action || null;
	}

	const params: string[] = [];
	const visit = (el: LiveElement): void => {
		const tag = el.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
			appendControlValue(el, submitter, params);
		}
		for (const c of el.children) visit(c);
	};
	visit(form);

	const qs = params.join('&');
	if (!qs) return action || null;
	if (!action) return '?' + qs;
	const sep = action.includes('?') ? '&' : '?';
	return action + sep + qs;
}

/** Append `name=value` pairs for one form control following HTML's
 * "constructing the form data set" rules — restricted to the control
 * types the engine actually paints. `submitter` lets us include the
 * activated submit button's own (name, value) pair (other submit /
 * reset / button inputs are skipped). */
function appendControlValue(
	el: LiveElement,
	submitter: LiveElement | null,
	out: string[],
): void {
	const name = el.getAttribute('name');
	if (!name) return;
	if (el.hasAttribute('disabled')) return;

	const tag = el.tagName;
	const type = tag === 'INPUT'
		? (el.getAttribute('type') ?? 'text').toLowerCase()
		: tag === 'TEXTAREA' ? 'textarea' : 'select';

	if (type === 'submit' || type === 'image' || type === 'button' || type === 'reset') {
		if (el !== submitter) return;
		const v = el.getAttribute('value') ?? '';
		out.push(encodeURIComponent(name) + '=' + encodeURIComponent(v));
		return;
	}
	if (type === 'checkbox' || type === 'radio') {
		if (!getInputChecked(el)) return;
		const v = getInputValue(el) || 'on';
		out.push(encodeURIComponent(name) + '=' + encodeURIComponent(v));
		return;
	}
	if (type === 'file') {
		// We don't support file uploads; omit the field per spec.
		return;
	}
	const v = getInputValue(el);
	out.push(encodeURIComponent(name) + '=' + encodeURIComponent(v));
}
