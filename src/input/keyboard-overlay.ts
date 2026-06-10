import { nxScreen, type NxScreenCanvas } from '@switch-web/runtime';
import {
	COMBO_BUTTONS,
	DEFAULT_CANVAS_HEIGHT,
	DEFAULT_CANVAS_WIDTH,
	KEYBOARD_LAYOUT,
} from '../browser-config.js';
import { DEFAULT_TEMPLATE, type BrowserTemplate } from '../profile/browser-template.js';
import { setKeyboardOpen } from '../scripts/live-paint-control.js';
import { playClick } from '../audio/click-sound.js';
import {
	getCursorPos,
	tickCursorMovementOnly,
} from './page-mouse-forwarder.js';
import { getButtonIndexForAction } from './button-router.js';

/** Callbacks the shell passes to `KeyboardOverlay.open()` so the page
 * behind the keyboard can be scrolled while it's up. Right-stick Y is
 * sampled in the keyboard's own poll loop (the shell's main controller
 * loop is suspended awaiting the keyboard's promise); touch swipes
 * above the panel are forwarded by the panel's own touch session. */
export interface KeyboardScrollCallbacks {
	/** Positive delta = scroll content DOWN (matches handleScroll's
	 * sign convention in browser-shell). */
	onScroll?: (delta: number) => void;
	/** Optional submit gate. When supplied, the Submit key (and the
	 * `+` button shortcut) only fire when this returns `true` for the
	 * current edit buffer. Used by `<input type="number">` to block
	 * submission of letter-laden strings the same way real browsers
	 * gray out their virtual-keyboard Enter for invalid form fields.
	 * Undefined → submit is always allowed (URL bar, search bar). */
	validate?: (value: string) => boolean;
}

interface Key {
	/** Display label. */
	label: string;
	/** Special action this key performs. Undefined means insert `label`. */
	action?: 'backspace' | 'space' | 'submit' | 'cancel';
	/** Width in "units" (1 unit = one letter-key width). Defaults to 1. */
	units?: number;
}

interface KeyRect {
	key: Key;
	x: number;
	y: number;
	width: number;
	height: number;
}

const ROWS: Key[][] = [
	[
		{ label: 'q' }, { label: 'w' }, { label: 'e' }, { label: 'r' }, { label: 't' },
		{ label: 'y' }, { label: 'u' }, { label: 'i' }, { label: 'o' }, { label: 'p' },
	],
	[
		{ label: 'a' }, { label: 's' }, { label: 'd' }, { label: 'f' }, { label: 'g' },
		{ label: 'h' }, { label: 'j' }, { label: 'k' }, { label: 'l' },
		{ label: '⌫', action: 'backspace' },
	],
	[
		{ label: 'z' }, { label: 'x' }, { label: 'c' }, { label: 'v' }, { label: 'b' },
		{ label: 'n' }, { label: 'm' }, { label: '.' }, { label: '/' }, { label: '-' },
	],
	[
		{ label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }, { label: '5' },
		{ label: '6' }, { label: '7' }, { label: '8' }, { label: '9' }, { label: ':' },
	],
	[
		{ label: 'Cancel', action: 'cancel', units: 3 },
		{ label: 'Space',  action: 'space',  units: 4 },
		{ label: 'Submit', action: 'submit', units: 3 },
	],
];

// Colours come from `BrowserTemplate.keyboard` — see
// `BrowserShell.run()` for the `setTemplate(...)` hand-off.

interface LayoutMetrics {
	rects: KeyRect[][];
	panelTop: number;
	editY: number;
	editHeight: number;
	helpY: number;
}

function computeLayout(canvasWidth: number, canvasHeight: number): LayoutMetrics {
	const { topY, editPreviewHeight, rowHeight, rowGap, keyGap, sidePadding } = KEYBOARD_LAYOUT;
	const usableWidth = canvasWidth - 2 * sidePadding;
	const unit = (usableWidth - 9 * keyGap) / 10;
	const keyboardTop = topY + editPreviewHeight;

	const rects: KeyRect[][] = ROWS.map((row, rowIndex) => {
		const rowY = keyboardTop + rowIndex * (rowHeight + rowGap);
		const totalUnits = row.reduce((sum, key) => sum + (key.units ?? 1), 0);
		const measuredWidth = totalUnits * unit + (row.length - 1) * keyGap;
		let x = sidePadding + (usableWidth - measuredWidth) / 2;
		return row.map((key) => {
			const width = (key.units ?? 1) * unit + ((key.units ?? 1) - 1) * keyGap;
			const rect: KeyRect = { key, x, y: rowY, width, height: rowHeight };
			x += width + keyGap;
			return rect;
		});
	});

	const lastRow = rects[rects.length - 1];
	const helpY = lastRow[0].y + lastRow[0].height + 8;
	void canvasHeight; // currently unused but kept so the signature documents intent

	return {
		rects,
		panelTop: topY,
		editY: topY + 12,
		editHeight: editPreviewHeight - 24,
		helpY,
	};
}

const HELP_TEXT = 'D-pad: move  ·  A: select  ·  Y: backspace  ·  B: cancel  ·  +: submit  ·  touch: tap';

/**
 * Draw the standard backspace icon (`⌫` U+232B) as a canvas path
 * centered at (cx, cy). The Unicode glyph tofus in the Switch font
 * so we render it manually — same approach as the M2.4 form-widget
 * checkmark + dropdown chevron. Shape: a left-pointing pentagon
 * outline with an × inside.
 */
function drawBackspaceIcon(
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	color: string,
): void {
	const w = 22, h = 16;
	const halfW = w / 2, halfH = h / 2;
	const tipX = cx - halfW;
	const bodyLeft = cx - halfW + 6;
	const bodyRight = cx + halfW;
	ctx.save();
	try {
		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		// Pentagon outline: triangle-pointing-left + rectangle.
		ctx.beginPath();
		ctx.moveTo(tipX, cy);
		ctx.lineTo(bodyLeft, cy - halfH);
		ctx.lineTo(bodyRight, cy - halfH);
		ctx.lineTo(bodyRight, cy + halfH);
		ctx.lineTo(bodyLeft, cy + halfH);
		ctx.closePath();
		ctx.stroke();
		// × inside the rectangle portion.
		const xPad = 3;
		ctx.beginPath();
		ctx.moveTo(bodyLeft + xPad, cy - halfH + xPad);
		ctx.lineTo(bodyRight - xPad, cy + halfH - xPad);
		ctx.moveTo(bodyLeft + xPad, cy + halfH - xPad);
		ctx.lineTo(bodyRight - xPad, cy - halfH + xPad);
		ctx.stroke();
	} finally { ctx.restore(); }
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 1;
	return Math.max(0, Math.min(1, n));
}

/**
 * Custom on-canvas keyboard. Replaces the native nx.js `VirtualKeyboard`
 * because the system applet renders outside the app canvas (Citron can't
 * draw it correctly, and we can't constrain its geometry from JS). Drawn
 * entirely within the app's 1280×720 frame; positioned at the bottom half
 * of the screen with a typing preview above.
 *
 * Input model:
 *   - D-pad / left stick: move focused key
 *   - A: activate focused key
 *   - Y: backspace
 *   - B: cancel
 *   - +: submit
 *   - Touchscreen: tap a key rectangle to activate it
 */
export class KeyboardOverlay {
	private readonly canvas: NxScreenCanvas;
	private readonly ctx: CanvasRenderingContext2D;
	private readonly layout: LayoutMetrics;
	private readonly flatRects: KeyRect[];
	private template: BrowserTemplate = DEFAULT_TEMPLATE;
	private panelBackground: Image | null = null;
	/** Submit-gate validator for the in-flight session — set in `open`,
	 * cleared on resolve. `render` reads it to paint the Submit key in
	 * the disabled palette when the current buffer would be rejected,
	 * which is the user-visible counterpart to the `activate`/`plus`
	 * gates below. Undefined / `null` → Submit always renders enabled. */
	private validate: ((value: string) => boolean) | null = null;

	constructor() {
		this.canvas = nxScreen();
		this.ctx = this.canvas.getContext('2d');
		const width = this.canvas.width || DEFAULT_CANVAS_WIDTH;
		const height = this.canvas.height || DEFAULT_CANVAS_HEIGHT;
		this.layout = computeLayout(width, height);
		this.flatRects = this.layout.rects.flat();
	}

	/** Hand the shell-loaded template to the keyboard so its panel,
	 * edit preview, keys, and help text take their colours from
	 * `template.keyboard`. Until this is called the keyboard falls
	 * back to `DEFAULT_TEMPLATE`. */
	setTemplate(template: BrowserTemplate): void {
		this.template = template;
	}

	/** Optional background image painted across the keyboard panel
	 * (stretched). `null` (or never set) means draw the panelBg
	 * fill alone. The image sits between the panelBg fill and the
	 * keys/edit preview so transparency falls back to the colour. */
	setPanelBackground(image: Image | null): void {
		this.panelBackground = image;
	}

	async open(
		initial = '',
		callbacks: KeyboardScrollCallbacks = {},
	): Promise<string | null> {
		const state: KeyboardState = {
			value: initial,
			cursor: initial.length,
			focusRow: 0,
			focusCol: 0,
		};
		// Stash the session validator so `render` can paint the Submit
		// key in disabled style without threading the callback through
		// every notifyChange tick. Cleared in the resolve path below.
		this.validate = callbacks.validate ?? null;
		// Flag the paint pipeline that the keyboard owns the screen — the
		// live-overlay's `paintLiveOverlay` early-returns on this flag so
		// rAF/video ticks don't clobber the keyboard pixels. Cleared in
		// the resolve path below so the next idle tick repaints the page.
		// Note: live-form's `<input>` tap path used to do this in its own
		// try/finally; that responsibility now lives here so both the URL
		// bar path and the `<input>` path are gated uniformly.
		setKeyboardOpen(true);
		this.render(state);

		return new Promise<string | null>((resolve) => {
			const session = new KeyboardSession(
				this.canvas,
				this.layout.rects,
				this.flatRects,
				state,
				(newState) => {
					this.render(newState);
				},
				(value) => {
					setKeyboardOpen(false);
					this.validate = null;
					resolve(value);
				},
				this.layout.panelTop,
				callbacks,
			);
			session.start();
		});
	}

	private render(state: KeyboardState): void {
		const ctx = this.ctx;
		const canvasW = this.canvas.width || DEFAULT_CANVAS_WIDTH;
		const canvasH = this.canvas.height || DEFAULT_CANVAS_HEIGHT;
		const kb = this.template.keyboard;

		// Panel background with a top border. Bg fill goes down first
		// as a fallback so any transparent area of the optional image
		// still gets a solid colour. The image is stretched to fit
		// the panel rect (below the 2px top border).
		ctx.fillStyle = kb.panelBorder;
		ctx.fillRect(0, this.layout.panelTop, canvasW, 2);
		ctx.fillStyle = kb.panelBg;
		const panelY = this.layout.panelTop + 2;
		const panelH = canvasH - this.layout.panelTop - 2;
		ctx.fillRect(0, panelY, canvasW, panelH);
		if (this.panelBackground) {
			ctx.drawImage(this.panelBackground, 0, panelY, canvasW, panelH);
		}

		// Edit preview with cursor.
		ctx.fillStyle = kb.editBg;
		ctx.fillRect(20, this.layout.editY, canvasW - 40, this.layout.editHeight);
		ctx.fillStyle = kb.editText;
		ctx.font = '28px system-ui';
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'start';
		const editPaddingX = 16;
		const editCenterY = this.layout.editY + this.layout.editHeight / 2;
		ctx.fillText(state.value, 20 + editPaddingX, editCenterY);
		const cursorX = 20 + editPaddingX + ctx.measureText(state.value.slice(0, state.cursor)).width;
		ctx.fillStyle = kb.editCursor;
		ctx.fillRect(cursorX, this.layout.editY + 8, 2, this.layout.editHeight - 16);

		// Keys. `transparency` (0 = opaque, 1 = invisible) is applied
		// as `globalAlpha` for the whole key-drawing pass so both the
		// rect fill and the label dim together — readable bg image
		// shows through, but the panel bg + edit preview + help text
		// outside this block stay fully opaque.
		ctx.textAlign = 'center';
		const keyAlpha = clamp01(1 - kb.transparency);
		const prevAlpha = ctx.globalAlpha;
		ctx.globalAlpha = keyAlpha;
		// Pre-compute whether Submit should render in the disabled
		// palette (validator rejects current buffer). Tied to the same
		// gate `activate('submit')` + the pollLoop's `+`-press path read,
		// so the user always sees the correct affordance before tapping.
		const submitDisabled = !!this.validate && !this.validate(state.value);
		for (let r = 0; r < this.layout.rects.length; r++) {
			for (let c = 0; c < this.layout.rects[r].length; c++) {
				const rect = this.layout.rects[r][c];
				const focused = r === state.focusRow && c === state.focusCol;
				const isAction = Boolean(rect.key.action);
				const isSubmit = rect.key.action === 'submit';
				if (isSubmit && submitDisabled) {
					// Disabled Submit: muted bg (regular key colour, not
					// the brighter action colour) + dimmed label, matching
					// the .settings-save[disabled] treatment on the HTML
					// settings page. Skip the focus highlight so a hover
					// over the key doesn't suggest interactivity.
					ctx.fillStyle = kb.keyBg;
					ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
					ctx.fillStyle = kb.helpText;
					ctx.font = '20px system-ui';
					ctx.fillText(rect.key.label, rect.x + rect.width / 2, rect.y + rect.height / 2);
					continue;
				}
				ctx.fillStyle = focused
					? (isAction ? kb.keyActionFocusBg : kb.keyFocusBg)
					: (isAction ? kb.keyActionBg : kb.keyBg);
				ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

				ctx.fillStyle = isAction ? kb.keyActionText : kb.keyText;
				if (rect.key.action === 'backspace') {
					// Draw the backspace symbol as a canvas path — the
					// Unicode `⌫` U+232B glyph tofus in the Switch font.
					// Same approach used for checkbox ✓ + select chevron.
					drawBackspaceIcon(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2, kb.keyActionText);
				} else {
					ctx.font = isAction ? '20px system-ui' : '24px system-ui';
					ctx.fillText(rect.key.label, rect.x + rect.width / 2, rect.y + rect.height / 2);
				}
			}
		}
		ctx.globalAlpha = prevAlpha;
		ctx.textAlign = 'start';

		// Help footer.
		if (this.layout.helpY + 18 <= canvasH) {
			ctx.fillStyle = kb.helpText;
			ctx.font = '14px system-ui';
			ctx.textBaseline = 'top';
			ctx.fillText(HELP_TEXT, 24, this.layout.helpY);
		}
	}
}

interface KeyboardState {
	value: string;
	cursor: number;
	focusRow: number;
	focusCol: number;
}

interface ButtonSnapshot {
	a: boolean;
	b: boolean;
	y: boolean;
	plus: boolean;
	left: boolean;
	right: boolean;
	up: boolean;
	down: boolean;
}

const nativeSetTimeout = setTimeout.bind(globalThis);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => nativeSetTimeout(resolve, ms));
}

function activePad(): Gamepad | null {
	return navigator.getGamepads().find((gamepad) => gamepad && gamepad.connected) ?? null;
}

function readButtons(): ButtonSnapshot {
	const pad = activePad();
	const button = (i: number): boolean => Boolean(pad?.buttons[i]?.pressed);

	// Keyboard interaction is mouse + touch ONLY. Both `a` (activate
	// hovered key) and `b` (cancel) come from `config.json buttonMapping`
	// via the button-router so the user's remaps stay consistent across
	// the whole shell. Previously `b` was hardcoded to `COMBO_BUTTONS.b`,
	// which collided with `leftClick="A"` (both resolve to the same
	// gamepad index in this codebase's mapping) — pressing one physical
	// button fired BOTH activation AND cancel. `+` (Plus) still submits.
	const leftClickIdx = getButtonIndexForAction('leftClick');
	const rightClickIdx = getButtonIndexForAction('rightClick');
	return {
		a: leftClickIdx >= 0 ? button(leftClickIdx) : false,
		b: rightClickIdx >= 0 ? button(rightClickIdx) : false,
		y: false,
		plus: button(COMBO_BUTTONS.plus),
		left: false,
		right: false,
		up: false,
		down: false,
	};
}

function rising(prev: ButtonSnapshot, next: ButtonSnapshot, name: keyof ButtonSnapshot): boolean {
	return next[name] && !prev[name];
}

/** Move-threshold (px) past which a touch above the keyboard panel is
 * treated as a page-scroll swipe instead of a tap-to-cancel. Mirrors
 * the SWIPE_MOVE_THRESHOLD in controller-shortcuts.ts so the gesture
 * cutoff matches the rest of the browser. */
const PAGE_SWIPE_MOVE_THRESHOLD = 6;

/** Right-stick Y axis on the standard nx.js gamepad mapping (same
 * constant as controller-shortcuts.ts; duplicated here so the keyboard
 * doesn't reach into that module just for scroll). */
const RIGHT_STICK_Y_AXIS = 3;
const STICK_DEADZONE = 0.15;
/** Max scroll px per pollLoop tick at full right-stick deflection.
 * Pollloop runs at ~16ms = ~60 Hz, so full deflection = ~600 px/s,
 * comparable to the shell's main-loop scroll cadence. */
const MAX_SCROLL_PER_TICK = 10;

function readStickScroll(pad: Gamepad | null): number {
	const axis = pad?.axes[RIGHT_STICK_Y_AXIS] ?? 0;
	const abs = Math.abs(axis);
	if (abs < STICK_DEADZONE) return 0;
	const normalized = (abs - STICK_DEADZONE) / (1 - STICK_DEADZONE);
	return Math.sign(axis) * Math.round(normalized * normalized * MAX_SCROLL_PER_TICK);
}

/** Per-touch session for a swipe that started ABOVE the keyboard panel.
 * Opened on touchstart-outside-panel; drives onScroll deltas on
 * touchmove; resolved on touchend (cancel-keyboard if the gesture stayed
 * a tap, just close the session if it grew into a swipe). */
interface PageSwipeSession {
	startY: number;
	lastY: number;
	moved: boolean;
}

class KeyboardSession {
	private running = true;
	private touchStartHandler?: (event: TouchEvent) => void;
	private touchMoveHandler?: (event: TouchEvent) => void;
	private touchEndHandler?: (event: TouchEvent) => void;
	/** Swipe-tracking state for the current finger when it landed above
	 * the panel. `null` means no outside-panel touch is in flight (the
	 * touch either hit a key, or already lifted). */
	private pageSwipe: PageSwipeSession | null = null;

	constructor(
		private readonly canvas: NxScreenCanvas,
		private readonly rects: KeyRect[][],
		private readonly flatRects: KeyRect[],
		private readonly state: KeyboardState,
		private readonly notifyChange: (state: KeyboardState) => void,
		private readonly resolve: (value: string | null) => void,
		private readonly panelTop: number,
		private readonly callbacks: KeyboardScrollCallbacks,
	) {}

	start(): void {
		this.installTouchHandler();
		void this.pollLoop();
	}

	private finish(value: string | null): void {
		if (!this.running) return;
		this.running = false;
		if (this.touchStartHandler) {
			this.canvas.removeEventListener('touchstart', this.touchStartHandler);
			this.touchStartHandler = undefined;
		}
		if (this.touchMoveHandler) {
			this.canvas.removeEventListener('touchmove', this.touchMoveHandler);
			this.touchMoveHandler = undefined;
		}
		if (this.touchEndHandler) {
			this.canvas.removeEventListener('touchend', this.touchEndHandler);
			this.touchEndHandler = undefined;
		}
		this.pageSwipe = null;
		// Defer to the next macrotask so the navigation that consumes this
		// value doesn't start *inside* the touch-event dispatch (Submit-by-tap)
		// or the pollLoop's iteration (Submit-by-Plus). Without this, the
		// page bundle that runs during navigation ends up evaluating while
		// we're still unwinding the dispatch, which Citron handles poorly
		// (frame loop stalls, FPS drops to 0).
		nativeSetTimeout(() => this.resolve(value), 0);
	}

	private activate(rect: KeyRect): void {
		// Audible feedback for every virtual-keyboard key activation —
		// covers touch (`touchStartHandler`) and mouse (`pollLoop` A on
		// hovered rect) alike, since both routes call `activate()`. Gated
		// globally by the `clickSounds` flag inside `playClick`.
		playClick();
		const action = rect.key.action;
		if (action === 'submit') {
			// Validator gate — when the caller (e.g. number-typed input)
			// declares the current buffer unsubmittable, swallow the tap
			// but keep the keyboard open. No state change, just the
			// click feedback above, mirroring how real browsers paint a
			// disabled Enter key.
			if (this.callbacks.validate && !this.callbacks.validate(this.state.value)) {
				return;
			}
			this.finish(this.state.value);
			return;
		}
		if (action === 'cancel') {
			this.finish(null);
			return;
		}
		if (action === 'backspace') {
			if (this.state.cursor > 0) {
				this.state.value = this.state.value.slice(0, this.state.cursor - 1) + this.state.value.slice(this.state.cursor);
				this.state.cursor -= 1;
			}
		} else if (action === 'space') {
			this.state.value = `${this.state.value.slice(0, this.state.cursor)} ${this.state.value.slice(this.state.cursor)}`;
			this.state.cursor += 1;
		} else {
			const inserted = rect.key.label;
			this.state.value = `${this.state.value.slice(0, this.state.cursor)}${inserted}${this.state.value.slice(this.state.cursor)}`;
			this.state.cursor += inserted.length;
		}
		this.notifyChange(this.state);
	}

	private moveFocus(dr: number, dc: number): void {
		let r = this.state.focusRow + dr;
		let c = this.state.focusCol + dc;
		if (r < 0) r = 0;
		if (r >= this.rects.length) r = this.rects.length - 1;
		const rowLen = this.rects[r].length;
		if (c < 0) c = 0;
		if (c >= rowLen) c = rowLen - 1;
		this.state.focusRow = r;
		this.state.focusCol = c;
		this.notifyChange(this.state);
	}

	private installTouchHandler(): void {
		this.touchStartHandler = (event: TouchEvent) => {
			const touch = event.touches[0] ?? event.changedTouches[0];
			if (!touch) return;
			// Activate the hit key (shared mouse/touch path — see
			// `activateAt`). If the tap landed on a key, we're done.
			if (this.activateAt(touch.clientX, touch.clientY)) return;
			// Touch outside the keyboard panel. Open a swipe session: the
			// touchend handler will cancel the keyboard if the gesture
			// stayed a tap, but a swipe past PAGE_SWIPE_MOVE_THRESHOLD
			// becomes a page scroll (driven by onScroll) and the cancel is
			// suppressed. The main canvas's own touch handler also fires
			// for this event (registered first) — its live-DOM hit-test
			// is gated off while the keyboard is open so a tap on content
			// won't queue a stray `click` (e.g. on the welcome page where
			// bookmark cards extend behind the panel), but the chrome
			// strip's static dispatch still runs so a tap on the back /
			// forward / star buttons both cancels the keyboard AND fires
			// the chrome action in one gesture.
			if (touch.clientY < this.panelTop) {
				this.pageSwipe = { startY: touch.clientY, lastY: touch.clientY, moved: false };
			}
		};
		this.touchMoveHandler = (event: TouchEvent) => {
			if (!this.pageSwipe) return;
			const touch = event.touches[0] ?? event.changedTouches[0];
			if (!touch) return;
			const y = touch.clientY;
			// Incremental delta since the last touchmove — pass to the shell
			// as a scroll delta with the same sign convention as page-level
			// swipes elsewhere: finger DOWN reveals content above → scrollY
			// decreases → negative delta. The main canvas's pageScrollSession
			// route is gated off while the keyboard is open, so this is the
			// sole driver for swipe-to-scroll-page during keyboard input.
			const incDy = y - this.pageSwipe.lastY;
			this.pageSwipe.lastY = y;
			if (Math.abs(y - this.pageSwipe.startY) > PAGE_SWIPE_MOVE_THRESHOLD) {
				this.pageSwipe.moved = true;
			}
			if (incDy !== 0 && this.callbacks.onScroll) {
				this.callbacks.onScroll(-incDy);
			}
		};
		this.touchEndHandler = () => {
			if (!this.pageSwipe) return;
			const wasSwipe = this.pageSwipe.moved;
			this.pageSwipe = null;
			// Tap (no movement past the threshold) above the panel cancels
			// the keyboard — same UX as before this change. The chrome /
			// content link listeners already fired for this touch in the
			// main canvas dispatcher; their queued input takes precedence
			// over a plain cancel (peekPendingInput check in the shell).
			if (!wasSwipe) this.finish(null);
		};
		this.canvas.addEventListener('touchstart', this.touchStartHandler);
		this.canvas.addEventListener('touchmove', this.touchMoveHandler);
		this.canvas.addEventListener('touchend', this.touchEndHandler);
	}

	private async pollLoop(): Promise<void> {
		// Interaction model while the keyboard is up: MOUSE + TOUCH ONLY.
		// D-pad navigation, A-on-focused-key, and Y-backspace are
		// intentionally absent — `readButtons` returns `false` for those
		// inputs. `a` here is the user's leftClick button (router-resolved)
		// and only activates the keyboard key the cursor is hovering over;
		// presses with the cursor outside any rect are ignored.
		//
		// Delay tracks the shell's `waitForControllerInput` cadence:
		// `0` while the stick is moving the cursor so it doesn't visibly
		// drag, `16` ms otherwise.
		let prev = readButtons();
		while (this.running) {
			if (!this.running) return;
			const next = readButtons();

			if (rising(prev, next, 'a')) {
				const { x, y } = getCursorPos();
				this.activateAt(x, y);
			}
			if (rising(prev, next, 'b')) {
				this.finish(null);
				return;
			}
			if (rising(prev, next, 'plus')) {
				// Mirror the Submit-key gate so the `+` shortcut also
				// honors validator rejection. Without this, an invalid
				// buffer the user can't tap-Submit could still be plus-
				// submitted, defeating the disabled-Submit affordance.
				// Swallow the press silently — falling through to the
				// scroll + cursor tick path keeps `prev` updated so the
				// next plus-rising is detected correctly.
				const allow = !this.callbacks.validate || this.callbacks.validate(this.state.value);
				if (allow) {
					this.finish(this.state.value);
					return;
				}
			}

			// Right-stick Y → page scroll behind the keyboard. The shell's
			// main loop is suspended awaiting this keyboard's promise, so
			// its onScroll path doesn't fire; we sample the axis here and
			// forward to the callback. handleScroll() in the shell does the
			// clip-to-panelTop repaint when isKeyboardOpen() is true.
			if (this.callbacks.onScroll) {
				const stickDelta = readStickScroll(activePad());
				if (stickDelta !== 0) this.callbacks.onScroll(stickDelta);
			}

			// Keep the software cursor alive while the keyboard owns the
			// loop. Movement-only variant — A is hit-tested here against
			// the keyboard rects above, so the cursor module must NOT
			// dispatch A as a regular page mousedown/click. Return value
			// drives the active-poll cadence below.
			const cursorMoved = tickCursorMovementOnly();

			prev = next;
			await delay(cursorMoved ? 0 : 16);
		}
	}

	/** Hit-test (x, y) against the keyboard rects; if the point lands on
	 * a key, set focus to that row/col (drives the "pressed" visual via
	 * the `focused` check in `render`) and call `activate`. Returns the
	 * activated rect, or null if (x, y) missed the panel. Shared by the
	 * mouse path (`pollLoop` A-rising with cursor coords) and the touch
	 * path (`touchStartHandler`), so both routes produce the same visible
	 * key-press flash + audible click. */
	private activateAt(x: number, y: number): KeyRect | null {
		for (let r = 0; r < this.rects.length; r++) {
			for (let c = 0; c < this.rects[r].length; c++) {
				const rect = this.rects[r][c];
				if (
					x >= rect.x && x <= rect.x + rect.width &&
					y >= rect.y && y <= rect.y + rect.height
				) {
					this.state.focusRow = r;
					this.state.focusCol = c;
					this.activate(rect);
					return rect;
				}
			}
		}
		return null;
	}
}
