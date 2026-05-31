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
import { getComputedLiveStyle, type ComputedLiveStyle } from './live-css.js';
import { bumpLiveTreeVersion, getLiveRoot, type LiveElement } from './live-dom.js';
import { getLayoutBox, type LayoutBox } from './live-layout.js';
import { patchLiveCacheRegion, patchLiveDirtyRegions, syncLiveCacheVersion } from './live-overlay.js';
import { requestFullRepaint } from './live-paint-control.js';

// =========================================================================
// Keyboard opener registration (called by the shell)
// =========================================================================

type KeyboardOpener = (initial: string) => Promise<string | null>;
let keyboardOpener: KeyboardOpener | null = null;
export function setKeyboardOpener(fn: KeyboardOpener | null): void {
	keyboardOpener = fn;
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
	const bg = cs.background || '#2c3e50';
	const color = cs.color || '#ffffff';
	ctx.fillStyle = bg;
	ctx.fillRect(box.x, box.y, box.w, box.h);
	// Subtle border so an empty checkbox is visually distinct from
	// surrounding panel bg of the same colour.
	ctx.strokeStyle = '#5a6a7e';
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

function paintButton(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
	skipBg = false,
): void {
	const color = cs.color || '#e0e8f4';
	if (!skipBg) {
		// Solid-bg path. Rich CSS backgrounds (gradients) are painted by
		// the caller before dispatch; here `cs.background` is a plain
		// colour (or the default). Using it as fillStyle directly would
		// silently no-op for a gradient string — hence the skipBg gate.
		ctx.fillStyle = cs.background || '#1d2c43';
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
	const color = cs.color || '#ebebeb';
	if (!skipBg) {
		ctx.fillStyle = cs.background || '#424242';
		ctx.fillRect(box.x, box.y, box.w, box.h);
		// Subtle border so the field reads as input-like vs. plain bg —
		// but only when the page didn't ask for `border: none`.
		const noBorder = (cs.borderTopWidth ?? 0) === 0
			&& (cs.borderLeftWidth ?? 0) === 0
			&& cs.borderTopColor === undefined;
		if (!noBorder) {
			ctx.strokeStyle = '#5a6a7e';
			ctx.lineWidth = 1;
			ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
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
			ctx.fillStyle = value ? color : (cs.color ? withAlpha(cs.color, 0.6) : '#9bb1d6');
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

function paintSelect(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	cs: ComputedLiveStyle,
	box: LayoutBox,
): void {
	const bg = cs.background || '#424242';
	const color = cs.color || '#ebebeb';
	ctx.fillStyle = bg;
	ctx.fillRect(box.x, box.y, box.w, box.h);
	ctx.strokeStyle = '#5a6a7e';
	ctx.lineWidth = 1;
	ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
	// Display the currently-selected option's text. The selected index
	// is read from the SELECT's `value` attribute (M2.5 popup writes
	// this on selection).
	const selectedValue = getInputValue(el);
	let labelText = '';
	for (const child of el.children) {
		if (child.tagName !== 'OPTION') continue;
		const optValue = child.getAttribute('value') ?? child.textContent;
		if (optValue === selectedValue || labelText === '') {
			labelText = child.textContent;
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
		ctx.fillStyle = color;
		const cx = box.x + box.w - 10;
		const cy = box.y + box.h / 2;
		const tw = Math.max(6, Math.min(box.w, box.h) * 0.35); // triangle width
		const th = tw * 0.6;                                    // triangle height
		ctx.beginPath();
		ctx.moveTo(cx - tw / 2, cy - th / 2);
		ctx.lineTo(cx + tw / 2, cy - th / 2);
		ctx.lineTo(cx, cy + th / 2);
		ctx.closePath();
		ctx.fill();
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
			patchAndSync(...patched);
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

async function openKeyboardAndApply(el: LiveElement): Promise<boolean> {
	if (!keyboardOpener) return false;
	const cur = getInputValue(el);
	// The keyboard itself manages the `isKeyboardOpen` flag now (set on
	// entry, cleared on the resolve path) so the URL bar and `<input>`
	// paths are gated uniformly. It also calls `requestFullRepaint()` on
	// close so the next idle tick blits the page back over the panel.
	let result: string | null;
	try {
		result = await keyboardOpener(cur);
	} catch (_) {
		result = null;
	}
	if (result === null) {
		fireEvent(el, 'blur');
		return true;
	}
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
