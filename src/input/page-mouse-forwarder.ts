// Page-mouse forwarder. Renders a software cursor driven by the left
// joycon stick and dispatches MouseEvent + PointerEvent on the
// LiveElement under the cursor. Mirrors the architecture of
// `page-touch-forwarder.ts` but with a persistent cursor singleton:
// touch is event-driven (one event per finger tap) while a mouse is
// state-driven (cursor exists continuously, button state and position
// transition through every paint frame).
//
// Why this lives entirely TS-side: `gamepad.c` already surfaces the
// left-stick at `navigator.getGamepads()[0].axes[0..1]`, and the screen
// 2D context is the same `ctx` every other paint step writes to — a
// cursor blit after `paintLiveOverlay` lands on top of every other
// pixel without a new GL bridge or C-side hook. See
// `[[reference-swb-touch-wiring]]` for the sibling pattern.

import { nxScreen } from '@switch-web/runtime';
import {
	getLiveRoot,
	getLiveViewport,
	getLiveWindow,
	hitTestLive,
	pageHasListenerFor,
	type LiveElement,
} from '../scripts/live-dom.js';
import { getComputedLiveStyle } from '../scripts/live-css.js';
import { getButtonIndexForAction } from './button-router.js';
import {
	abortLivePress,
	beginLivePress,
	dispatchChromeTap,
	endLivePress,
	type LivePressHandle,
} from './live-input-dispatch.js';

// Screen dimensions match the static framebuffer the canvas-runner's
// synthesized parent reports (1280×720). Updating this requires the
// same change in `canvas-runner.ts buildCanvasShim`.
const SCREEN_W = 1280;
const SCREEN_H = 720;

// Deadzone matches the right-stick scroll deadzone in
// `controller-shortcuts.ts`. Below this the stick is treated as neutral
// so a stick that doesn't fully recenter doesn't drift the cursor.
const STICK_DEADZONE = 0.15;
// Max cursor delta per tick at full stick deflection (1.0). Linear
// response with FLOAT sub-pixel accumulation in cursor.x/y — only
// rounded at draw time. This avoids the multi-pixel jumps of the prior
// integer-per-tick model: now every deflection past the deadzone moves
// the cursor proportionally each tick (60 Hz), and the eye sees smooth
// motion rather than 25-px steps. At 18 px/tick × 60 Hz = ~1080 px/s
// at full deflection — comfortable fast pan; small deflections produce
// sub-pixel deltas that visually transition smoothly across pixel
// boundaries every few ticks.
const CURSOR_SPEED_PX_PER_TICK = 18;
// Milliseconds since the last stick motion / A-press after which the
// software cursor hides itself and stops consuming B/ZR. Re-engaged on
// the next motion or A-press. Configurable from `config.json
// mouseIdleMs` via `setCursorIdleMs(ms)`; defaults to 3000 ms so the
// behavior is sane even before the shell finishes wiring config.
let cursorIdleMs = 3000;
export function setCursorIdleMs(ms: number): void {
	// Permissive bounds — 0 hides instantly after motion stops; very
	// large values mean "effectively always visible". Negative or NaN
	// inputs from a corrupt config snap to the default.
	if (!Number.isFinite(ms) || ms < 0) {
		cursorIdleMs = 3000;
		return;
	}
	cursorIdleMs = ms;
}

// Click button indices are looked up at runtime via the button-router
// (`getButtonIndexForAction`) so the user can remap A/B/ZR (or any
// other button) to leftClick / rightClick / middleClick via
// `config.json buttonMapping`. -1 = nothing bound to that action.

const LEFT_STICK_X_AXIS = 0;
const LEFT_STICK_Y_AXIS = 1;

// MouseEvent.button values per spec — 0/1/2 = left/middle/right.
const MOUSE_BUTTON_LEFT = 0;
const MOUSE_BUTTON_MIDDLE = 1;
const MOUSE_BUTTON_RIGHT = 2;

// MouseEvent.buttons bitmask values per spec — 1/4/2 = left/middle/right
// (note the unusual middle vs right ordering — this is the actual spec).
const BUTTONS_MASK_LEFT = 1;
const BUTTONS_MASK_RIGHT = 2;
const BUTTONS_MASK_MIDDLE = 4;

interface CursorState {
	x: number;
	y: number;
	visible: boolean;
	lastMotionAt: number;
	buttonsDown: { left: boolean; middle: boolean; right: boolean };
	// CSS-set cursor sprite. When null we render the default arrow.
	sprite: CursorSprite | null;
	// Pending sprite URL → image load. Tracks in-flight fetches so a
	// rapid succession of cursor changes doesn't fight itself.
	pendingSpriteUrl: string | null;
}

interface CursorSprite {
	image: unknown;
	hotX: number;
	hotY: number;
	width: number;
	height: number;
	url: string;
}

const cursor: CursorState = {
	x: SCREEN_W / 2,
	y: SCREEN_H / 2,
	visible: false,
	lastMotionAt: 0,
	buttonsDown: { left: false, middle: false, right: false },
	sprite: null,
	pendingSpriteUrl: null,
};

let installed = false;
let nextPointerId = 1000; // Avoid colliding with touch-forwarder pointer IDs (starts at 1).
const mousePointerId = nextPointerId++;

// Chrome-zone awareness so B-over-chrome stays shell-back (the
// conventional "Back" affordance). The shell mirrors its current
// chrome y-range here via `setMouseChromeRegion`; the values default to
// the conservative "top 56px" range until the shell pushes a real
// value. In fullscreen-canvas / video-fullscreen / fullscreen-page
// modes there's no chrome to defer to, so B/ZR consume freely.
let chromeY0 = 0;
let chromeY1 = 56;
let chromeMode: 'normal' | 'fullscreen-page' | 'fullscreen-canvas' | 'video-fullscreen' = 'normal';
export function setMouseChromeRegion(y0: number, y1: number): void {
	chromeY0 = y0;
	chromeY1 = y1;
}
export function setMouseChromeMode(mode: typeof chromeMode): void {
	chromeMode = mode;
}
function cursorInChromeZone(): boolean {
	if (chromeMode !== 'normal') return false;
	return cursor.y >= chromeY0 && cursor.y < chromeY1;
}

// Cache: URL → decoded sprite. Avoids re-fetching the same cursor every
// time a hover changes the CSS-set cursor back to one we've already
// loaded.
const spriteCache = new Map<string, CursorSprite>();

// Tracks the LiveElement the cursor is currently over so we fire
// mouseenter / mouseleave / mouseover / mouseout transitions on motion.
let lastHoverEl: LiveElement | null = null;

// Active engine-mouse left-button press handle. Set on aRising over a
// LiveElement in the content area; cleared on aFalling. Held across
// ticks so the eventual `endLivePress` (and the deferred :active clear
// inside it) fires on the SAME element the press opened on, even if
// the cursor drifts onto a different element during the hold. */
let activeMousePress: LivePressHandle | null = null;

// Tracks the previous frame's button snapshot for edge detection — A
// rising = mousedown+click, A falling = mouseup. Set lazily on first
// tick.
interface ButtonSnapshot { a: boolean; b: boolean; zr: boolean }
let prevButtons: ButtonSnapshot = { a: false, b: false, zr: false };

// Default arrow geometry — drawn in code so no asset needs to ship. A
// classic top-left arrow with a white border + black fill, sized to be
// readable on the Switch's 1280×720 framebuffer.
const DEFAULT_CURSOR_PATH: { x: number; y: number }[] = [
	{ x: 0, y: 0 },
	{ x: 0, y: 16 },
	{ x: 4, y: 12 },
	{ x: 7, y: 18 },
	{ x: 9, y: 17 },
	{ x: 6, y: 11 },
	{ x: 11, y: 11 },
];

export function installPageMouseForwarder(): void {
	if (installed) return;
	installed = true;
	console.debug('[page-mouse-fwd] installed');
	// Hook screen touchstart so the cursor jumps to wherever the user
	// just tapped — the cursor stays "where the last user action was"
	// regardless of input method. Touch handlers elsewhere (chrome
	// strip, keyboard panel, page-touch-forwarder) keep running too;
	// this listener is purely position-state, no event consumption.
	try {
		const screen = nxScreen();
		screen.addEventListener('touchstart', (event: TouchEvent) => {
			const t = event.touches[0] ?? event.changedTouches[0];
			if (!t) return;
			setCursorPos(t.clientX, t.clientY);
		});
	} catch (e) {
		console.debug('[page-mouse-fwd] touch listener install failed: ' + String(e));
	}
}

/** Snap the cursor to (x, y) and re-engage it. Used by the touch
 * listener so a tap visibly moves the cursor to the touch point, and
 * usable by future modal owners that want to anchor the cursor before
 * showing UI. Clamped to the framebuffer; ignored if coords are NaN. */
export function setCursorPos(x: number, y: number): void {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return;
	cursor.x = Math.max(0, Math.min(SCREEN_W - 1, x));
	cursor.y = Math.max(0, Math.min(SCREEN_H - 1, y));
	cursor.visible = true;
	cursor.lastMotionAt = performance.now();
	syncCursorOverlay();
}

/** Read the active gamepad. Mirrors `controller-shortcuts.ts activePad`. */
function activePad(): Gamepad | null {
	return navigator.getGamepads().find((g) => g && g.connected) ?? null;
}

function isButtonPressed(pad: Gamepad | null, idx: number): boolean {
	return Boolean(pad?.buttons[idx]?.pressed);
}

function readStickAxis(pad: Gamepad | null, axis: number): number {
	const raw = pad?.axes[axis] ?? 0;
	const abs = Math.abs(raw);
	if (abs < STICK_DEADZONE) return 0;
	// Linear response — quadratic squashed small-deflection motion to
	// sub-pixel deltas, which felt totally stuck on hardware. Linear
	// keeps the cursor responsive at every position past the deadzone.
	const normalized = (abs - STICK_DEADZONE) / (1 - STICK_DEADZONE);
	return Math.sign(raw) * normalized;
}

/** Float pixel delta this tick. Cursor.x/y accumulate sub-pixel
 * fractions and are only rounded at draw time — guarantees smooth
 * motion at every deflection magnitude. */
function axisToPixelStep(norm: number): number {
	if (norm === 0) return 0;
	return norm * CURSOR_SPEED_PX_PER_TICK;
}

/**
 * Per-tick driver. Called from `controller-shortcuts.ts` onTick (once
 * per main-loop iteration). Returns true if the cursor state changed
 * (motion or button edge) — the caller uses this signal to drop into
 * the active-poll cadence + request a repaint.
 *
 * Button-edge return values: A consumed always; B/ZR consumed only when
 * a page mouse listener is registered (so non-mouse-aware pages keep B
 * = shell-back and ZR = shell-address-bar).
 */
export interface MouseTickResult {
	cursorChanged: boolean;
	consumedA: boolean;
	consumedB: boolean;
	consumedZR: boolean;
}

let diagTickCount = 0;
let diagLastLogAt = 0;
// Last rounded screen pixel the cursor occupied. Used to decide
// `cursorChanged` — we only signal a repaint when the integer pixel
// position changes, so sub-pixel float motion can accumulate quietly
// without spamming repaints between visible transitions.
let lastDrawnPxX = -1;
let lastDrawnPxY = -1;

/**
 * Movement-only cursor tick used by modal owners (the on-canvas keyboard,
 * future modals) that have suspended the shell's main loop and therefore
 * are not driving `tickMouseInput`. Reads the left stick, integrates
 * position + visibility + idle, and syncs the engine overlay — but does
 * NOT consume A/B/ZR as mouse buttons (the modal owner reads buttons for
 * its own UI). Keeps the cursor smoothly movable on top of the modal
 * without double-claiming clicks.
 *
 * Returns `true` when the cursor moved this tick — callers should use it
 * to drop their poll delay to the shell's active cadence (0 ms) instead
 * of the idle 16 ms, otherwise the cursor visibly drags compared with
 * the non-modal case.
 */
/** Resync `prevButtons` to the CURRENT physical button state and clear
 * any per-cursor tracked button bookkeeping. Called by the on-screen
 * keyboard's `finish()` path so the FIRST `tickMouseInput` call after
 * the kb closes doesn't dispatch spurious rising / falling edges for
 * buttons that the user pressed during the kb's lifetime (the shell's
 * `waitForControllerInput` loop — which is what drives `tickMouseInput`
 * — is suspended on the kb promise, so `prevButtons` doesn't see those
 * presses and would otherwise compare a stale `false` against a held
 * `true` on the first post-kb tick).
 *
 * Concrete bug this prevents: user opens kb, presses B to close it
 * while the cursor sits over an app card; without this sync, the
 * shell's resumed loop sees `bRising=true` and dispatches
 * `mousedown(right)+mouseup(right)+contextmenu(right)` on the card. The
 * same class of bug also triggers a spurious `aRising` + later
 * `aFalling` if A is held during kb close → `beginLivePress` /
 * `endLivePress` → synthesized `click` on the card → unwanted modal
 * open. Resetting `cursor.buttonsDown` belt-and-suspenders prevents the
 * aFalling fallback branch (no `activeMousePress`) from also firing a
 * stray click. Aborting any leaked `activeMousePress` guards against a
 * press handle held across the kb open (shouldn't normally happen
 * because `endLivePress` clears it before the kb opens, but cheap to
 * defend against). */
export function syncMouseButtonsToCurrent(): void {
	const pad = activePad();
	const leftIdx = getButtonIndexForAction('leftClick');
	const rightIdx = getButtonIndexForAction('rightClick');
	const middleIdx = getButtonIndexForAction('middleClick');
	const aDown = leftIdx >= 0 ? isButtonPressed(pad, leftIdx) : false;
	const bDown = rightIdx >= 0 ? isButtonPressed(pad, rightIdx) : false;
	const zrDown = middleIdx >= 0 ? isButtonPressed(pad, middleIdx) : false;
	prevButtons = { a: aDown, b: bDown, zr: zrDown };
	cursor.buttonsDown.left = false;
	cursor.buttonsDown.right = false;
	cursor.buttonsDown.middle = false;
	if (activeMousePress) {
		abortLivePress(activeMousePress);
		activeMousePress = null;
	}
}

export function tickCursorMovementOnly(): boolean {
	const pad = activePad();
	const now = performance.now();
	const dxNorm = readStickAxis(pad, LEFT_STICK_X_AXIS);
	const dyNorm = readStickAxis(pad, LEFT_STICK_Y_AXIS);
	const dxPx = axisToPixelStep(dxNorm);
	const dyPx = axisToPixelStep(dyNorm);
	const moved = dxPx !== 0 || dyPx !== 0;
	if (moved) {
		cursor.x = Math.max(0, Math.min(SCREEN_W - 1, cursor.x + dxPx));
		cursor.y = Math.max(0, Math.min(SCREEN_H - 1, cursor.y + dyPx));
		cursor.visible = true;
		cursor.lastMotionAt = now;
	} else if (cursor.visible && now - cursor.lastMotionAt > cursorIdleMs && !anyButtonDown()) {
		cursor.visible = false;
	}
	if (cursor.visible || overlayRegistered) {
		syncCursorOverlay();
	}
	return moved;
}

export function tickMouseInput(): MouseTickResult {
	const pad = activePad();
	const now = performance.now();

	const dxNorm = readStickAxis(pad, LEFT_STICK_X_AXIS);
	const dyNorm = readStickAxis(pad, LEFT_STICK_Y_AXIS);
	const dxPx = axisToPixelStep(dxNorm);
	const dyPx = axisToPixelStep(dyNorm);
	const moved = dxPx !== 0 || dyPx !== 0;

	diagTickCount++;
	// Throttled log so we can see whether the gamepad is producing
	// non-zero axes at all and whether the cursor is integrating them.
	// First 30 ticks then every ~2s.
	if (diagTickCount <= 30 || now - diagLastLogAt > 2000) {
		diagLastLogAt = now;
		const rawX = pad?.axes[LEFT_STICK_X_AXIS] ?? 0;
		const rawY = pad?.axes[LEFT_STICK_Y_AXIS] ?? 0;
		console.debug(
			'[page-mouse-fwd] tick=' + diagTickCount
			+ ' padConnected=' + (pad ? 'yes' : 'no')
			+ ' rawXY=[' + rawX.toFixed(3) + ',' + rawY.toFixed(3) + ']'
			+ ' normXY=[' + dxNorm.toFixed(3) + ',' + dyNorm.toFixed(3) + ']'
			+ ' stepXY=[' + dxPx.toFixed(2) + ',' + dyPx.toFixed(2) + ']'
			+ ' cursor=[' + cursor.x.toFixed(2) + ',' + cursor.y.toFixed(2) + ']'
			+ ' vis=' + cursor.visible,
		);
	}

	let cursorChanged = false;

	if (moved) {
		cursor.x = Math.max(0, Math.min(SCREEN_W - 1, cursor.x + dxPx));
		cursor.y = Math.max(0, Math.min(SCREEN_H - 1, cursor.y + dyPx));
		cursor.visible = true;
		cursor.lastMotionAt = now;
		// Only request a repaint when the rounded pixel position
		// actually changes — sub-pixel accumulation between pixel
		// transitions doesn't need a redraw.
		const newPxX = Math.round(cursor.x);
		const newPxY = Math.round(cursor.y);
		if (newPxX !== lastDrawnPxX || newPxY !== lastDrawnPxY) {
			cursorChanged = true;
		}
	} else if (cursor.visible && now - cursor.lastMotionAt > cursorIdleMs && !anyButtonDown()) {
		// Idle timeout — hide the cursor visually AND stop consuming
		// B/ZR so they fall through to shell shortcuts. Re-engages on
		// next stick motion or A press, both of which flip
		// `cursor.visible` back to true and reset `lastMotionAt`.
		cursor.visible = false;
		cursorChanged = true;
	}

	// Dispatch mousemove on every position change so page hover handlers
	// fire continuously, matching real browser behavior.
	if (moved) dispatchMouseMove();

	// Hover transitions — fire mouseover / mouseenter / mouseout /
	// mouseleave when the LiveElement under the cursor changes. Done
	// even on stationary cursor in case the page's layout shifted
	// (animated UI moved an element under the pointer).
	updateHover();

	// --- Button edges ---
	// Indices come from the button-router so the user can remap which
	// joycon button serves which click via `config.json buttonMapping`.
	// -1 from the router → no button is bound to that mouse action.
	const leftIdx = getButtonIndexForAction('leftClick');
	const rightIdx = getButtonIndexForAction('rightClick');
	const middleIdx = getButtonIndexForAction('middleClick');
	const aDown = leftIdx >= 0 ? isButtonPressed(pad, leftIdx) : false;
	const bDown = rightIdx >= 0 ? isButtonPressed(pad, rightIdx) : false;
	const zrDown = middleIdx >= 0 ? isButtonPressed(pad, middleIdx) : false;

	let consumedA = false;
	let consumedB = false;
	let consumedZR = false;

	const aRising = aDown && !prevButtons.a;
	const aFalling = !aDown && prevButtons.a;
	const bRising = bDown && !prevButtons.b;
	const bFalling = !bDown && prevButtons.b;
	const zrRising = zrDown && !prevButtons.zr;
	const zrFalling = !zrDown && prevButtons.zr;

	if (aRising || aFalling || bRising || bFalling || zrRising || zrFalling) {
		console.debug(
			'[page-mouse-fwd] button edge'
			+ ' A=' + (aRising ? 'down' : aFalling ? 'up' : '-')
			+ ' B=' + (bRising ? 'down' : bFalling ? 'up' : '-')
			+ ' ZR=' + (zrRising ? 'down' : zrFalling ? 'up' : '-')
			+ ' at=[' + Math.round(cursor.x) + ',' + Math.round(cursor.y) + ']',
		);
	}

	// A button → always consumed by the mouse layer. Left click is the
	// primary mouse action and the router skips shell dispatch when
	// A is bound to leftClick.
	//
	// 2026-06-10: chrome + live-DOM dispatch unified via
	// `live-input-dispatch`. Chrome zone calls `dispatchChromeTap`
	// directly (no more synth-touch on nxScreen). Content area opens
	// a `beginLivePress` on the LiveElement under the cursor so the
	// shell-side intent path (navigate / button-action / summary /
	// video-control / form-tap) runs identically to touch. The press
	// handle is held across the A-hold; `endLivePress` on aFalling
	// fires the click event, runs the intent dispatch, and schedules
	// the deferred `:active` clear so the user sees the pressed
	// visual for at least ~120 ms even on instant taps.
	if (aRising) {
		cursor.buttonsDown.left = true;
		cursor.visible = true;
		cursor.lastMotionAt = now;
		if (cursorInChromeZone()) {
			// Chrome strip — single-shot dispatch on press. No
			// LiveElement press lifecycle (chrome isn't part of the
			// live tree).
			dispatchChromeTap(cursor.x, cursor.y);
		} else {
			const hit = hitElementUnderCursor();
			if (hit) {
				// Content-area press on a live-DOM element. The press
				// handle owns mousedown + :active toggle + intent
				// dispatch lifecycle.
				activeMousePress = beginLivePress(hit, cursor.x, cursor.y, 'mouse');
				// Window-side + pointer events still go out so engines
				// that listen on window or via the unified Pointer API
				// see the press (Cocos's input system, for instance).
				dispatchPointerOnTarget(hit, 'pointerdown', MOUSE_BUTTON_LEFT);
				dispatchMouseButtonOnWindow('mousedown', MOUSE_BUTTON_LEFT, hit);
			} else {
				// Full-canvas page (engine handles its own hit testing
				// via window listeners) — fall back to the prior
				// dispatch shape, which dispatches on the primary
				// CANVAS LiveElement + window.
				dispatchMouseButton('mousedown', MOUSE_BUTTON_LEFT);
			}
		}
		consumedA = true;
		cursorChanged = true;
	} else if (aFalling) {
		// Capture BEFORE clearing — the fallback else branch below
		// only fires `mouseup+click` when we actually dispatched a
		// `mousedown` on the rising edge. Without this gate, an
		// `aFalling` whose matching `aRising` never ran through
		// `tickMouseInput` (e.g., A was already held when the function
		// resumed after `syncMouseButtonsToCurrent` cleared `prevButtons`
		// + `cursor.buttonsDown` on kb close) would synthesize a `click`
		// on whatever sits under the cursor — exactly the "card modal
		// opens after closing kb with B while a finger fumbled A" bug.
		// The `activeMousePress` branch above is already safe (it only
		// runs when a press was opened earlier inside this function).
		const wasLeftDown = cursor.buttonsDown.left;
		cursor.buttonsDown.left = false;
		if (activeMousePress) {
			const hit = hitElementUnderCursor();
			// Pointer-event sibling on whichever live target the cursor
			// is over now (mouseup-on-different-element semantics
			// match real-browser behaviour where mouseup fires at the
			// release position, not the press position).
			if (hit) dispatchPointerOnTarget(hit, 'pointerup', MOUSE_BUTTON_LEFT);
			dispatchMouseButtonOnWindow('mouseup', MOUSE_BUTTON_LEFT, hit);
			// If the cursor drifted off the press target, abort
			// rather than fire click+intent on a stale element. This
			// matches the desktop browser convention where a press
			// that drags off cancels the click.
			if (hit && hit === activeMousePress.el) {
				const unhandled = endLivePress(activeMousePress, cursor.x, cursor.y);
				// Single-vs-double tap discrimination lives in the
				// touch controller — the engine-mouse path has no
				// double-tap timer today, so video-frame-tap fires a
				// straight play/pause toggle on the controller's
				// behalf. `dbltap-action` is a touch-only gesture
				// (the cursor can't dbltap meaningfully).
				if (unhandled?.kind === 'video-frame-tap') {
					// No double-tap timer for the cursor path —
					// surface as a play/pause toggle via the regular
					// video-control route by no-op'ing for now.
					// (Touch handles this case via
					// `handleVideoFrameTap` which itself swallows the
					// first tap; the cursor user can use the on-video
					// controls bar instead.)
				}
				dispatchMouseButtonOnWindow('click', MOUSE_BUTTON_LEFT, hit);
			} else {
				abortLivePress(activeMousePress);
			}
			activeMousePress = null;
		} else if (cursorInChromeZone()) {
			// Chrome dispatch already fired on the rising edge; nothing
			// to do on falling.
		} else if (wasLeftDown) {
			// No press was open (e.g., page-canvas-only mode). Mirror
			// the legacy dispatch path. Gated on `wasLeftDown` so a
			// rising edge we never saw can't generate a fallback click.
			dispatchMouseButton('mouseup', MOUSE_BUTTON_LEFT);
			dispatchMouseButton('click', MOUSE_BUTTON_LEFT);
		}
		consumedA = true;
		cursorChanged = true;
	}

	// B / ZR — gated on page-side mouse listeners. If the page wants
	// mouse events, we consume the press; otherwise the shell's
	// existing rising-edge handler fires (back / address-bar).
	const pageWantsMouse = pageHasListenerFor('mousedown')
		|| pageHasListenerFor('mouseup')
		|| pageHasListenerFor('click')
		|| pageHasListenerFor('pointerdown')
		|| pageHasListenerFor('pointerup');
	// B / ZR fall through to shell back / address-bar when the cursor
	// sits in the chrome strip on a normal-mode page. Without this gate
	// any page that registers a mouse listener at boot (Cocos
	// Creator's input system does this on every page) would steal B
	// even when the user has the cursor over the back button.
	const allowPageButtonConsume = pageWantsMouse && !cursorInChromeZone();

	if (bRising && allowPageButtonConsume) {
		cursor.buttonsDown.right = true;
		dispatchMouseButton('mousedown', MOUSE_BUTTON_RIGHT);
		consumedB = true;
		cursorChanged = true;
	} else if (bFalling && cursor.buttonsDown.right) {
		cursor.buttonsDown.right = false;
		dispatchMouseButton('mouseup', MOUSE_BUTTON_RIGHT);
		dispatchMouseButton('contextmenu', MOUSE_BUTTON_RIGHT);
		consumedB = true;
		cursorChanged = true;
	}

	if (zrRising && allowPageButtonConsume) {
		cursor.buttonsDown.middle = true;
		dispatchMouseButton('mousedown', MOUSE_BUTTON_MIDDLE);
		consumedZR = true;
		cursorChanged = true;
	} else if (zrFalling && cursor.buttonsDown.middle) {
		cursor.buttonsDown.middle = false;
		dispatchMouseButton('mouseup', MOUSE_BUTTON_MIDDLE);
		consumedZR = true;
		cursorChanged = true;
	}

	prevButtons = { a: aDown, b: bDown, zr: zrDown };

	// Push the resolved cursor state to the engine overlay. Cheap when
	// nothing visual changed (position-only branch is two ints over the
	// C boundary), and cheaper still when even the rounded pixel didn't
	// move. Done unconditionally — the engine composites the overlay
	// every present anyway, so keeping its state fresh per input tick
	// avoids visual lag between `tickMouseInput` and the next repaint.
	if (cursor.visible || overlayRegistered) {
		syncCursorOverlay();
	}

	return { cursorChanged, consumedA, consumedB, consumedZR };
}

function anyButtonDown(): boolean {
	return cursor.buttonsDown.left || cursor.buttonsDown.middle || cursor.buttonsDown.right;
}

function currentButtonsMask(): number {
	let m = 0;
	if (cursor.buttonsDown.left) m |= BUTTONS_MASK_LEFT;
	if (cursor.buttonsDown.right) m |= BUTTONS_MASK_RIGHT;
	if (cursor.buttonsDown.middle) m |= BUTTONS_MASK_MIDDLE;
	return m;
}

// 2026-06-10: `getLiveViewport()` returns the same viewport object the
// shell pushes per-frame via `setLiveViewport`. In normal mode it has
// `y = chromeHeight` (typically 56) and `height = SCREEN_H - chrome`;
// in fullscreen-page / fullscreen-canvas / video-fullscreen it covers
// the whole screen. The touch path reads it via `liveViewport` for
// hit-testing, and the cursor now does the same — without this, the
// mouse hit-test was using a hardcoded (0, 0, 1280, 720) viewport so
// every body-flow element it tested lived 56px higher than where the
// painter actually drew it. Users had to click 56px above buttons in
// content area to register the hit.

function hitElementUnderCursor(): LiveElement | null {
	try {
		return hitTestLive(getLiveRoot(), cursor.x, cursor.y, getLiveViewport());
	} catch (_) {
		return null;
	}
}

/** Find the primary CANVAS LiveElement in the live tree — same rule as
 * `page-touch-forwarder.ts`: last CANVAS in document order. Used as the
 * fallback dispatch target when no live-DOM element is under the cursor
 * (full-screen game canvas case). */
function findPrimaryCanvas(): LiveElement | null {
	const canvases: LiveElement[] = [];
	const walk = (el: LiveElement) => {
		if (el.tagName === 'CANVAS') canvases.push(el);
		for (const c of el.children) walk(c);
	};
	walk(getLiveRoot());
	return canvases.length ? canvases[canvases.length - 1] : null;
}

function buildMouseEvent(type: string, button: number): Record<string, unknown> {
	return {
		type,
		clientX: cursor.x,
		clientY: cursor.y,
		pageX: cursor.x,
		pageY: cursor.y,
		screenX: cursor.x,
		screenY: cursor.y,
		offsetX: cursor.x,
		offsetY: cursor.y,
		movementX: 0,
		movementY: 0,
		button,
		buttons: currentButtonsMask(),
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		metaKey: false,
		detail: 1,
		bubbles: true,
		cancelable: true,
		isTrusted: true,
		preventDefault: () => { /* no-op */ },
		stopPropagation: () => { /* no-op */ },
	};
}

function buildPointerEvent(type: string, button: number): Record<string, unknown> {
	return {
		...buildMouseEvent(type, button),
		type,
		pointerId: mousePointerId,
		pointerType: 'mouse',
		isPrimary: true,
		width: 1,
		height: 1,
		pressure: anyButtonDown() ? 0.5 : 0,
		tangentialPressure: 0,
		tiltX: 0,
		tiltY: 0,
		twist: 0,
	};
}

function dispatchMouseMove(): void {
	const target = hitElementUnderCursor() ?? findPrimaryCanvas();
	const win = getLiveWindow();
	if (target) {
		const mEv = buildMouseEvent('mousemove', 0);
		mEv.target = target;
		mEv.currentTarget = target;
		(target as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(mEv);
		const pEv = buildPointerEvent('pointermove', 0);
		pEv.target = target;
		pEv.currentTarget = target;
		(target as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(pEv);
	}
	const winMv = buildMouseEvent('mousemove', 0);
	winMv.target = target ?? win;
	winMv.currentTarget = win;
	win.dispatchEvent(winMv as { type: string; [k: string]: unknown });
	const winPv = buildPointerEvent('pointermove', 0);
	winPv.target = target ?? win;
	winPv.currentTarget = win;
	win.dispatchEvent(winPv as { type: string; [k: string]: unknown });
}

function dispatchMouseButton(type: string, button: number): void {
	const target = hitElementUnderCursor() ?? findPrimaryCanvas();
	const win = getLiveWindow();
	// pointer<down|up> mirrors mouse<down|up>. `click` and `contextmenu`
	// have no pointer counterpart.
	const pointerType = type === 'mousedown' ? 'pointerdown'
		: type === 'mouseup' ? 'pointerup'
			: null;
	if (target) {
		const mEv = buildMouseEvent(type, button);
		mEv.target = target;
		mEv.currentTarget = target;
		(target as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(mEv);
		if (pointerType) {
			const pEv = buildPointerEvent(pointerType, button);
			pEv.target = target;
			pEv.currentTarget = target;
			(target as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(pEv);
		}
	}
	dispatchMouseButtonOnWindow(type, button, target);
}

/** Dispatch the window-side mouseup/mousedown/click + pointer pair only.
 * Used by the new press flow (`beginLivePress`/`endLivePress` emit on
 * the live target themselves; the window still needs the events for
 * page-script window-level listeners like Cocos's input system). */
function dispatchMouseButtonOnWindow(
	type: string,
	button: number,
	target: LiveElement | null,
): void {
	const win = getLiveWindow();
	const pointerType = type === 'mousedown' ? 'pointerdown'
		: type === 'mouseup' ? 'pointerup'
			: null;
	const winEv = buildMouseEvent(type, button);
	winEv.target = target ?? win;
	winEv.currentTarget = win;
	win.dispatchEvent(winEv as { type: string; [k: string]: unknown });
	if (pointerType) {
		const winPe = buildPointerEvent(pointerType, button);
		winPe.target = target ?? win;
		winPe.currentTarget = win;
		win.dispatchEvent(winPe as { type: string; [k: string]: unknown });
	}
}

/** Dispatch a pointerdown / pointerup on the live target only. The
 * matching mouseevent already fires inside `beginLivePress` /
 * `endLivePress`; this completes the pair so engines reading either API
 * see the same input. */
function dispatchPointerOnTarget(
	target: LiveElement,
	pointerType: 'pointerdown' | 'pointerup',
	button: number,
): void {
	const pEv = buildPointerEvent(pointerType, button);
	pEv.target = target;
	pEv.currentTarget = target;
	(target as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(pEv);
}

function updateHover(): void {
	const hit = hitElementUnderCursor();
	if (hit === lastHoverEl) {
		// Even if hit didn't change, peek the computed cursor — the
		// page may have updated style.cursor on the same element
		// (Cocos's hover-driven cursor swap).
		applyHoverElementCursor(hit);
		return;
	}
	if (lastHoverEl) {
		dispatchTo(lastHoverEl, 'mouseout', 0);
		dispatchTo(lastHoverEl, 'mouseleave', 0);
		dispatchTo(lastHoverEl, 'pointerout', 0);
		dispatchTo(lastHoverEl, 'pointerleave', 0);
	}
	lastHoverEl = hit;
	if (hit) {
		dispatchTo(hit, 'mouseover', 0);
		dispatchTo(hit, 'mouseenter', 0);
		dispatchTo(hit, 'pointerover', 0);
		dispatchTo(hit, 'pointerenter', 0);
	}
	// 2026-06-10: `setPseudoHover(...)` was wired here briefly so CSS
	// `:hover` rules would visualize for the engine-mouse cursor. The
	// per-frame cascade invalidation + repaint that triggered tanked
	// system FPS on real hardware (every cursor motion across an
	// interactive element forced a full live-overlay rebuild). The
	// pseudo plumbing in live-css.ts stays in place for a future
	// finer-grained reintroduction, but for now hover is mouse-event-
	// only (page-script may still react to mouseover / pointerenter).
	applyHoverElementCursor(hit);
}

function applyHoverElementCursor(el: LiveElement | null): void {
	if (!el) return;
	try {
		const cs = getComputedLiveStyle(el);
		const v = cs.cursor;
		if (typeof v === 'string') setCursorFromCss(v);
	} catch (_) { /* style read failed — keep current cursor */ }
}

function dispatchTo(el: LiveElement, type: string, button: number): void {
	const ev = type.startsWith('pointer')
		? buildPointerEvent(type, button)
		: buildMouseEvent(type, button);
	ev.target = el;
	ev.currentTarget = el;
	(el as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(ev);
}

// ---- CSS cursor parsing + sprite loading ----

/**
 * Parse a CSS `cursor` value and update the global cursor sprite.
 * Supports `auto`, `default`, `none`, `pointer` (uses default arrow),
 * and `url(<URL>) [<hotX> <hotY>], <fallback>`. Any unrecognized form
 * falls back to the default arrow.
 *
 * Called from:
 *  - CanvasShim style.cursor setter (canvas-runner.ts)
 *  - applyHoverElementCursor (each frame's hover transition)
 */
export function setCursorFromCss(value: string | null | undefined): void {
	console.debug('[page-mouse-fwd] setCursorFromCss value=' + JSON.stringify(value));
	if (!value) {
		cursor.sprite = null;
		cursor.pendingSpriteUrl = null;
		return;
	}
	const trimmed = String(value).trim();
	const lower = trimmed.toLowerCase();
	if (lower === 'none') {
		// Page is hiding the cursor. We model this as an empty sprite so
		// `syncCursorOverlay` knows to clear the engine overlay. Visibility
		// flag is preserved so the cursor can still receive input events.
		cursor.sprite = { image: null, hotX: 0, hotY: 0, width: 0, height: 0, url: 'none' };
		cursor.pendingSpriteUrl = null;
		return;
	}
	if (lower === 'auto' || lower === 'default' || lower === 'pointer'
		|| lower === 'crosshair' || lower === 'text' || lower === 'wait'
		|| lower === 'help' || lower === 'progress' || lower === 'move'
		|| lower === 'inherit' || lower === 'initial' || lower === 'unset') {
		cursor.sprite = null;
		cursor.pendingSpriteUrl = null;
		return;
	}

	// `url(<URL>) [hotX hotY][, fallback]` — pull the first url(...) and
	// the two numbers immediately following.
	const urlM = /url\(\s*(['"]?)([^'")]+)\1\s*\)\s*([0-9]+)?\s*([0-9]+)?/i.exec(trimmed);
	if (!urlM) {
		cursor.sprite = null;
		cursor.pendingSpriteUrl = null;
		return;
	}
	const url = urlM[2].trim();
	const hotX = urlM[3] ? parseInt(urlM[3], 10) : 0;
	const hotY = urlM[4] ? parseInt(urlM[4], 10) : 0;
	console.debug('[page-mouse-fwd] parsed cursor url=' + url + ' hot=[' + hotX + ',' + hotY + ']');

	// Already loaded? Apply immediately.
	const cached = spriteCache.get(url);
	if (cached) {
		cursor.sprite = { ...cached, hotX, hotY };
		cursor.pendingSpriteUrl = null;
		console.debug('[page-mouse-fwd] applied cached sprite ' + cached.width + 'x' + cached.height);
		return;
	}
	// Already in-flight for this URL? Don't kick off a duplicate fetch.
	if (cursor.pendingSpriteUrl === url) {
		console.debug('[page-mouse-fwd] sprite load already in-flight for url');
		return;
	}
	cursor.pendingSpriteUrl = url;
	void loadCursorSprite(url, hotX, hotY);
}

async function loadCursorSprite(url: string, hotX: number, hotY: number): Promise<void> {
	try {
		console.debug('[page-mouse-fwd] loadCursorSprite START url=' + url);
		// Use globalThis.fetch — swb's page-script override already
		// handles `brewser://` (the scheme cursor URLs typically come
		// from). For `blob:` and `http(s):` the underlying nxjs fetch
		// covers it natively.
		const fetchFn = (globalThis as { fetch?: (u: string) => Promise<Response> }).fetch;
		if (!fetchFn) {
			console.debug('[page-mouse-fwd] FAIL: globalThis.fetch missing');
			return;
		}
		const resp = await fetchFn(url);
		console.debug('[page-mouse-fwd] fetch ok, status=' + resp.status);
		const blob = await resp.blob();
		console.debug('[page-mouse-fwd] blob size=' + blob.size + ' type=' + blob.type);
		const blobUrl = URL.createObjectURL(blob);
		const ImageCtor = (globalThis as unknown as { Image?: new () => unknown }).Image;
		if (typeof ImageCtor !== 'function') {
			console.debug('[page-mouse-fwd] FAIL: Image ctor missing');
			return;
		}
		const img = new ImageCtor() as { src: string; width: number; height: number; addEventListener: (t: string, fn: () => void) => void; naturalWidth?: number; naturalHeight?: number };
		await new Promise<void>((resolve, reject) => {
			img.addEventListener('load', () => resolve());
			img.addEventListener('error', () => reject(new Error('cursor image load failed: ' + url)));
			img.src = blobUrl;
		});
		const w = img.naturalWidth || img.width || 32;
		const h = img.naturalHeight || img.height || 32;
		const sprite: CursorSprite = { image: img, hotX, hotY, width: w, height: h, url };
		spriteCache.set(url, sprite);
		// Only apply if the page hasn't switched to a different URL while
		// we were loading.
		if (cursor.pendingSpriteUrl === url) {
			cursor.sprite = sprite;
			cursor.pendingSpriteUrl = null;
		}
		console.debug('[page-mouse-fwd] loaded cursor sprite ' + w + 'x' + h + ' from ' + url);
	} catch (e) {
		console.debug('[page-mouse-fwd] cursor sprite load failed: ' + String(e));
		if (cursor.pendingSpriteUrl === url) cursor.pendingSpriteUrl = null;
	}
}

// ---- Paint ----
//
// The cursor lives in a private OffscreenCanvas. Once rendered, its
// pixels are handed to the engine via `screen.setCursorOverlay(...)`;
// the engine composites them onto the display buffer at present time,
// so the cursor visual NEVER lands in the page's canvas->data. This
// replaces an earlier dirty-rect save/restore approach which corrupted
// page pixels in any region where the underlying cairo data was
// premultiplied-zero — producing the "cursor leaves a black trail"
// regression.
//
// Per cursor tick:
//  - position-only update: `screen.setCursorOverlayPosition(x, y)`.
//  - sprite change OR visibility toggle: re-render the offscreen,
//    grab ImageData, send the whole bitmap to the engine.
// Cheap path is the common case (every joycon-stick tick is just a
// position update).

/** Default arrow's drawn footprint, in device pixels. Sized to fit a
 * 1.5×-scaled 18-px arrow with 2px of slop for the stroke join. */
const DEFAULT_CURSOR_W = 32;
const DEFAULT_CURSOR_H = 32;

interface CursorBitmapSpec {
	kind: 'default' | 'sprite' | 'none';
	spriteUrl: string;
	w: number;
	h: number;
}

let cursorOffscreen: OffscreenCanvas | null = null;
let cursorOffscreenW = 0;
let cursorOffscreenH = 0;
let lastBitmapSpec: CursorBitmapSpec | null = null;
let overlayRegistered = false;
let lastOverlayX = -1;
let lastOverlayY = -1;

function specsEqual(a: CursorBitmapSpec, b: CursorBitmapSpec): boolean {
	return a.kind === b.kind
		&& a.spriteUrl === b.spriteUrl
		&& a.w === b.w
		&& a.h === b.h;
}

function ensureCursorOffscreen(w: number, h: number): OffscreenCanvas {
	if (!cursorOffscreen || cursorOffscreenW !== w || cursorOffscreenH !== h) {
		cursorOffscreen = new OffscreenCanvas(w, h);
		cursorOffscreenW = w;
		cursorOffscreenH = h;
	}
	return cursorOffscreen;
}

/**
 * Push the current cursor state to the engine overlay. Called every
 * cursor tick from `tickMouseInput`. Fast path is "no visual change
 * since last call" — sends only the (x, y) update.
 */
let syncDiagN = 0;
let screenIntrospectionLogged = false;
export function syncCursorOverlay(): void {
	const screen = nxScreen();
	syncDiagN++;
	const verbose = syncDiagN <= 6 || (syncDiagN % 240) === 0;
	if (!screenIntrospectionLogged) {
		screenIntrospectionLogged = true;
		const proto = Object.getPrototypeOf(screen);
		const protoName = proto?.constructor?.name ?? 'unknown';
		const ownKeys = Object.getOwnPropertyNames(screen).slice(0, 10).join(',');
		const protoKeys = proto ? Object.getOwnPropertyNames(proto).slice(0, 40).join(',') : 'no-proto';
		console.debug('[page-mouse-fwd] screen introspection'
			+ ' typeof=' + typeof screen
			+ ' protoCtor=' + protoName
			+ ' typeof.setCursorOverlay=' + typeof (screen as { setCursorOverlay?: unknown }).setCursorOverlay
			+ ' typeof.clearCursorOverlay=' + typeof (screen as { clearCursorOverlay?: unknown }).clearCursorOverlay
			+ ' typeof.getContext=' + typeof screen.getContext);
		console.debug('[page-mouse-fwd] screen ownKeys=[' + ownKeys + ']');
		console.debug('[page-mouse-fwd] screen protoKeys=[' + protoKeys + ']');
		// Also try the global directly in case nxScreen()'s closure has a
		// stale or shadowed binding.
		const g = globalThis as { screen?: { setCursorOverlay?: unknown } };
		console.debug('[page-mouse-fwd] globalThis.screen typeof.setCursorOverlay='
			+ typeof g.screen?.setCursorOverlay
			+ ' same-ref=' + (g.screen === screen));
	}
	// The cursor stays visible at all times the user is engaging it
	// (recent motion / A-press); the on-canvas keyboard is NOT a hide
	// trigger any more (user requested cursor stays interactive over the
	// keyboard panel). The sole hide trigger is `cursor.visible` flipping
	// to false, which `tickMouseInput` does after `cursorIdleMs` of no
	// motion.
	if (!cursor.visible) {
		if (verbose) console.debug('[page-mouse-fwd] sync n=' + syncDiagN
			+ ' invisible; overlayRegistered=' + overlayRegistered);
		if (overlayRegistered) {
			screen.clearCursorOverlay();
			overlayRegistered = false;
			lastBitmapSpec = null;
		}
		return;
	}

	const sprite = cursor.sprite;
	let spec: CursorBitmapSpec;
	let topLeftX: number;
	let topLeftY: number;
	const px = Math.round(cursor.x);
	const py = Math.round(cursor.y);
	lastDrawnPxX = px;
	lastDrawnPxY = py;

	if (sprite && sprite.url === 'none') {
		// Page-set `cursor: none`. Drop the overlay; cursor is logically
		// visible (events still fire) but renders nothing.
		if (overlayRegistered) {
			screen.clearCursorOverlay();
			overlayRegistered = false;
			lastBitmapSpec = null;
		}
		return;
	}

	if (sprite && sprite.image && sprite.width > 0 && sprite.url !== 'none') {
		spec = { kind: 'sprite', spriteUrl: sprite.url, w: sprite.width, h: sprite.height };
		topLeftX = px - sprite.hotX;
		topLeftY = py - sprite.hotY;
	} else {
		spec = { kind: 'default', spriteUrl: '', w: DEFAULT_CURSOR_W, h: DEFAULT_CURSOR_H };
		topLeftX = px;
		topLeftY = py;
	}

	const needsRender = !overlayRegistered
		|| !lastBitmapSpec
		|| !specsEqual(lastBitmapSpec, spec);

	if (needsRender) {
		if (verbose) console.debug('[page-mouse-fwd] sync n=' + syncDiagN
			+ ' RENDER spec=' + JSON.stringify(spec)
			+ ' topLeft=[' + topLeftX + ',' + topLeftY + ']');
		const oc = ensureCursorOffscreen(spec.w, spec.h);
		const octx = oc.getContext('2d');
		if (!octx) {
			console.debug('[page-mouse-fwd] sync NO octx');
			return;
		}
		// Clear to fully transparent so the engine's src-over composite
		// reveals the page underneath everywhere the cursor isn't drawn.
		octx.clearRect(0, 0, spec.w, spec.h);
		if (spec.kind === 'default') {
			try {
				drawDefaultArrow(octx as CanvasRenderingContext2D, 0, 0);
			} catch (e) {
				console.debug('[page-mouse-fwd] drawDefaultArrow threw: ' + String(e));
			}
		} else if (spec.kind === 'sprite' && sprite) {
			try {
				octx.drawImage(
					sprite.image as CanvasImageSource,
					0, 0, sprite.width, sprite.height,
				);
			} catch (_) {
				// Sprite draw failed (image not ready yet etc.) — fall back
				// to the default arrow so the user isn't left without a
				// cursor.
				octx.clearRect(0, 0, spec.w, spec.h);
				try { drawDefaultArrow(octx as CanvasRenderingContext2D, 0, 0); }
				catch (_) { /* swallow */ }
			}
		}
		let data: ImageData | null = null;
		try {
			data = octx.getImageData(0, 0, spec.w, spec.h);
		} catch (e) {
			console.debug('[page-mouse-fwd] getImageData threw: ' + String(e));
			return;
		}
		if (verbose) {
			// Sample a non-corner pixel so we can prove the offscreen
			// captured the arrow.
			const idx = 8 * spec.w * 4 + 5 * 4;
			const r = data.data[idx], g = data.data[idx + 1],
				b = data.data[idx + 2], a = data.data[idx + 3];
			console.debug('[page-mouse-fwd] sync n=' + syncDiagN
				+ ' bitmap[5,8] rgba=(' + r + ',' + g + ',' + b + ',' + a + ')'
				+ ' bytelen=' + data.data.byteLength);
		}
		try {
			screen.setCursorOverlay(topLeftX, topLeftY, data.data, spec.w, spec.h);
			overlayRegistered = true;
			lastBitmapSpec = spec;
			lastOverlayX = topLeftX;
			lastOverlayY = topLeftY;
			if (verbose) console.debug('[page-mouse-fwd] sync n=' + syncDiagN
				+ ' setCursorOverlay OK');
		} catch (e) {
			console.debug('[page-mouse-fwd] setCursorOverlay threw: ' + String(e));
		}
		return;
	}

	if (topLeftX !== lastOverlayX || topLeftY !== lastOverlayY) {
		try {
			screen.setCursorOverlayPosition(topLeftX, topLeftY);
			lastOverlayX = topLeftX;
			lastOverlayY = topLeftY;
		} catch (e) {
			console.debug('[page-mouse-fwd] setCursorOverlayPosition threw: ' + String(e));
		}
	}
}


function drawDefaultArrow(ctx: CanvasRenderingContext2D, x: number, y: number): void {
	ctx.save();
	// Scale up 1.5× from the 18-px coded path so the cursor is readable
	// at the 1280×720 framebuffer without a hi-res asset. Caller has
	// already rounded `x`/`y` so we don't round again here.
	const scale = 1.5;
	ctx.translate(x, y);
	ctx.scale(scale, scale);
	// White arrow with a black outline — readable against both dark
	// (pvzge dragon splash) and light (chrome strip) backdrops. No
	// inner fill — the previous round had a black inner fill that
	// dominated the cursor and made it look entirely black.
	ctx.beginPath();
	for (let i = 0; i < DEFAULT_CURSOR_PATH.length; i++) {
		const p = DEFAULT_CURSOR_PATH[i];
		if (i === 0) ctx.moveTo(p.x, p.y);
		else ctx.lineTo(p.x, p.y);
	}
	ctx.closePath();
	ctx.fillStyle = '#ffffff';
	ctx.fill();
	// Thicker black outline (in coded coords) so the cursor reads as
	// "white arrow with crisp border" rather than "almost-white blob."
	ctx.strokeStyle = '#000000';
	ctx.lineWidth = 1.5;
	ctx.lineJoin = 'round';
	ctx.stroke();
	ctx.restore();
}

export function getCursorPos(): { x: number; y: number } {
	return { x: cursor.x, y: cursor.y };
}

export function isCursorEngaged(): boolean {
	return cursor.visible && (performance.now() - cursor.lastMotionAt < cursorIdleMs || anyButtonDown());
}
