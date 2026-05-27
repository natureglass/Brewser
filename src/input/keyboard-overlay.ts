import { nxScreen, type NxScreenCanvas } from '@switch-web/runtime';
import {
	COMBO_BUTTONS,
	DEFAULT_CANVAS_HEIGHT,
	DEFAULT_CANVAS_WIDTH,
	KEYBOARD_LAYOUT,
} from '../browser-config.js';
import { DEFAULT_TEMPLATE, type BrowserTemplate } from '../profile/browser-template.js';

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

	async open(initial = ''): Promise<string | null> {
		const state: KeyboardState = {
			value: initial,
			cursor: initial.length,
			focusRow: 0,
			focusCol: 0,
		};
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
				resolve,
				this.layout.panelTop,
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
		for (let r = 0; r < this.layout.rects.length; r++) {
			for (let c = 0; c < this.layout.rects[r].length; c++) {
				const rect = this.layout.rects[r][c];
				const focused = r === state.focusRow && c === state.focusCol;
				const isAction = Boolean(rect.key.action);
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
	const axis = (i: number): number => pad?.axes[i] ?? 0;

	return {
		a: button(COMBO_BUTTONS.a),
		b: button(COMBO_BUTTONS.b),
		y: button(COMBO_BUTTONS.y),
		plus: button(COMBO_BUTTONS.plus),
		left: button(COMBO_BUTTONS.dpadLeft) || axis(0) < -0.55,
		right: button(COMBO_BUTTONS.dpadRight) || axis(0) > 0.55,
		up: button(COMBO_BUTTONS.dpadUp) || axis(1) < -0.55,
		down: button(COMBO_BUTTONS.dpadDown) || axis(1) > 0.55,
	};
}

function rising(prev: ButtonSnapshot, next: ButtonSnapshot, name: keyof ButtonSnapshot): boolean {
	return next[name] && !prev[name];
}

class KeyboardSession {
	private running = true;
	private touchHandler?: (event: TouchEvent) => void;

	constructor(
		private readonly canvas: NxScreenCanvas,
		private readonly rects: KeyRect[][],
		private readonly flatRects: KeyRect[],
		private readonly state: KeyboardState,
		private readonly notifyChange: (state: KeyboardState) => void,
		private readonly resolve: (value: string | null) => void,
		private readonly panelTop: number,
	) {}

	start(): void {
		this.installTouchHandler();
		void this.pollLoop();
	}

	private finish(value: string | null): void {
		if (!this.running) return;
		this.running = false;
		if (this.touchHandler) {
			this.canvas.removeEventListener('touchstart', this.touchHandler);
			this.touchHandler = undefined;
		}
		// Defer to the next macrotask so the navigation that consumes this
		// value doesn't start *inside* the touch-event dispatch (Submit-by-tap)
		// or the pollLoop's iteration (Submit-by-Plus). Without this, the
		// page bundle that runs during navigation ends up evaluating while
		// we're still unwinding the dispatch, which Citron handles poorly
		// (frame loop stalls, FPS drops to 0).
		nativeSetTimeout(() => this.resolve(value), 0);
	}

	private activate(rect: KeyRect): void {
		const action = rect.key.action;
		if (action === 'submit') {
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
		this.touchHandler = (event: TouchEvent) => {
			const touch = event.touches[0] ?? event.changedTouches[0];
			if (!touch) return;
			for (let r = 0; r < this.rects.length; r++) {
				for (let c = 0; c < this.rects[r].length; c++) {
					const rect = this.rects[r][c];
					if (
						touch.clientX >= rect.x &&
						touch.clientX <= rect.x + rect.width &&
						touch.clientY >= rect.y &&
						touch.clientY <= rect.y + rect.height
					) {
						this.state.focusRow = r;
						this.state.focusCol = c;
						this.activate(rect);
						return;
					}
				}
			}
			// Tap outside the keyboard panel — treat as cancel so the page
			// underneath becomes interactive again. The chrome strip / content
			// link listener fires for the same touch event (registered first),
			// so a link tap is already queued by the time we get here.
			if (touch.clientY < this.panelTop) {
				this.finish(null);
			}
		};
		this.canvas.addEventListener('touchstart', this.touchHandler);
	}

	private async pollLoop(): Promise<void> {
		let prev = readButtons();
		while (this.running) {
			await delay(70);
			if (!this.running) return;
			const next = readButtons();

			if (rising(prev, next, 'left')) this.moveFocus(0, -1);
			if (rising(prev, next, 'right')) this.moveFocus(0, 1);
			if (rising(prev, next, 'up')) this.moveFocus(-1, 0);
			if (rising(prev, next, 'down')) this.moveFocus(1, 0);

			if (rising(prev, next, 'a')) {
				const rect = this.rects[this.state.focusRow]?.[this.state.focusCol];
				if (rect) this.activate(rect);
			}
			if (rising(prev, next, 'b')) {
				this.finish(null);
				return;
			}
			if (rising(prev, next, 'y')) {
				const backspace = this.flatRects.find((r) => r.key.action === 'backspace');
				if (backspace) this.activate(backspace);
			}
			if (rising(prev, next, 'plus')) {
				this.finish(this.state.value);
				return;
			}

			prev = next;
		}
	}
}
