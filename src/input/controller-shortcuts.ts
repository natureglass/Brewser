import { nxScreen } from '@switch-web/runtime';
import {
	CHROME_LAYOUT,
	COMBO_BUTTONS,
	EXIT_COMBO_HOLD_MS,
} from '../browser-config.js';
import {
	dispatchPageKeyEvent,
	getLiveRoot, getLiveWindow, hitTestLive,
	pageHasListenerFor,
	setInternalLiveScrollY, setInternalLiveViewport,
	type LiveElement, type LiveViewport,
} from '../scripts/live-dom.js';
import { getComputedLiveStyle, setPseudoActive } from '../scripts/live-css.js';
import { handleFormTap, isFormWidget } from '../scripts/live-form.js';
import { getLayoutBox } from '../scripts/live-layout.js';
import { findTapIntent, patchLiveDirtyRegions } from '../scripts/live-overlay.js';
import { isKeyboardOpen } from '../scripts/live-paint-control.js';
import { hitTestVideoControls, videoIsPaused } from '../scripts/live-video.js';

const nativeSetTimeout = setTimeout.bind(globalThis);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => nativeSetTimeout(resolve, ms));
}

function activePad(): Gamepad | null {
	return navigator.getGamepads().find((gamepad) => gamepad && gamepad.connected) ?? null;
}

function isPressed(pad: Gamepad | null, index: number): boolean {
	return Boolean(pad?.buttons[index]?.pressed);
}

interface ShellButtonSnapshot {
	zr: boolean;
	b: boolean;
	x: boolean;
	y: boolean;
	l: boolean;
	r: boolean;
	dpadUp: boolean;
	dpadDown: boolean;
	minus: boolean;
}

function snapshot(): ShellButtonSnapshot {
	const pad = activePad();
	return {
		zr: isPressed(pad, COMBO_BUTTONS.zr),
		b: isPressed(pad, COMBO_BUTTONS.b),
		x: isPressed(pad, COMBO_BUTTONS.x),
		y: isPressed(pad, COMBO_BUTTONS.y),
		l: isPressed(pad, COMBO_BUTTONS.l),
		r: isPressed(pad, COMBO_BUTTONS.r),
		dpadUp: isPressed(pad, COMBO_BUTTONS.dpadUp),
		dpadDown: isPressed(pad, COMBO_BUTTONS.dpadDown),
		minus: isPressed(pad, COMBO_BUTTONS.minus),
	};
}

function rising(prev: ShellButtonSnapshot, next: ShellButtonSnapshot, name: keyof ShellButtonSnapshot): boolean {
	return next[name] && !prev[name];
}

const RIGHT_STICK_Y_AXIS = 3;
const STICK_DEADZONE = 0.15;
// The GPU compositor caps per-scroll-tick cadence at ~30 Hz on
// Switch hardware because each `present()` blocks ~15 ms on the
// nx.js bridge readback (`glReadPixels` 1280×720 + glFinish +
// memcpy back to cairo). Each tick spans 1-2 vsync frames, so we
// can't drive the visual position smoothly enough at small per-
// tick steps — the eye sees discrete jumps when cadence drops
// below ~30 Hz.
//
// Tuning knobs:
//   - `IDLE_POLL_INTERVAL_MS`: poll delay when no scroll input is
//     active. Keeps the loop responsive to buttons without burning
//     cycles.
//   - `ACTIVE_POLL_INTERVAL_MS`: poll delay while the stick is
//     deflected. Set to 0 so we re-run on the very next main-loop
//     tick (vsync-paced), maximizing scroll cadence.
//   - `MAX_SCROLL_PER_TICK`: pixels moved at full stick deflection
//     per tick. Smaller = smoother per-frame motion, lower top
//     speed. Larger = faster scroll but bigger visible jumps.
//
// With the CPU cache-blit content path (browser-shell.ts), scroll
// cadence is pegged at ~60 Hz (17 ms p50 tick interval, of which
// ~5 ms is `handleScroll` and the rest is loop yield). At full
// deflection: `MAX_SCROLL_PER_TICK * ~58 Hz` = px/s.
//   - 5 px  → ~290 px/s  (very smooth, slow traversal)
//   - 10 px → ~580 px/s  (smooth, comfortable reading pace)
//   - 20 px → ~1170 px/s (matches the prior 40 Hz × 30 px = 1200 px/s)
//   - 30 px → ~1750 px/s (sprint)
const IDLE_POLL_INTERVAL_MS = 16;
const ACTIVE_POLL_INTERVAL_MS = 0;
const MAX_SCROLL_PER_TICK = 10;
const DPAD_SCROLL_STEP = 30;
/** Hold time before D-pad up/down starts auto-repeating. A single
 * press always fires one `DPAD_SCROLL_STEP` step; holding past this
 * threshold turns the D-pad into a continuous scroller throttled by
 * `DPAD_HOLD_REPEAT_MS`. */
const DPAD_HOLD_DELAY_MS = 500;
/** Repeat interval once auto-repeat engages. At 30 px/step the
 * resulting speed is `1000 / DPAD_HOLD_REPEAT_MS * 30` px/s — at
 * 50 ms that's 600 px/s, comparable to the stick's full-deflection
 * speed (10 px × ~58 Hz = 580 px/s). */
const DPAD_HOLD_REPEAT_MS = 50;

function readStickScroll(pad: Gamepad | null): number {
	const axis = pad?.axes[RIGHT_STICK_Y_AXIS] ?? 0;
	const abs = Math.abs(axis);
	if (abs < STICK_DEADZONE) return 0;
	const normalized = (abs - STICK_DEADZONE) / (1 - STICK_DEADZONE);
	return Math.sign(axis) * Math.round(normalized * normalized * MAX_SCROLL_PER_TICK);
}

export type ControllerInput =
	| { kind: 'exit' }
	| { kind: 'address-bar' }
	| { kind: 'back' }
	| { kind: 'forward' }
	| { kind: 'home' }
	| { kind: 'settings' }
	| { kind: 'star' }
	| { kind: 'reload' }
	/** Rising edge of the Minus button on its own (not part of the
	 * L+R+Minus exit combo). The shell captures the current screen and
	 * writes it as a PNG to `<profile>/screenshots/`. */
	| { kind: 'screenshot' }
	| { kind: 'navigate'; url: string }
	/** Tap on an HTML `<button data-action="...">` rendered by the page.
	 * The shell interprets the action string (e.g. `fullscreen-page`,
	 * `fullscreen-canvas`); unknown actions are ignored. */
	| { kind: 'button-action'; action: string }
	/** Tap on a `<summary>` in the live-DOM tree. The shell toggles
	 * `summary.parent.toggleAttribute('open')` and bumps the live tree
	 * version so the cache rebuilds. */
	| { kind: 'summary-toggle'; summary: LiveElement }
	/** Tap on a `<video>` element in the live-DOM tree. The shell
	 * enters video-fullscreen mode focused on this element; B button
	 * (or L+R) exits back to normal mode. */
	| { kind: 'video-fullscreen-enter'; video: LiveElement }
	/** Tap on one of the inline controls-bar buttons on a `<video>`
	 * element (no autoplay, 2026-05-27): play opens the decoder if
	 * needed and starts playback; pause halts; stop seeks to 0 and
	 * pauses. */
	| { kind: 'video-play'; video: LiveElement }
	| { kind: 'video-pause'; video: LiveElement }
	| { kind: 'video-stop'; video: LiveElement }
	/** Tap on the mute icon — toggles `decoder.muted` on the audio
	 * voice. Distinct from the legacy `video-stop` so the shell can
	 * skip a repaint when it knows mute doesn't change visible state. */
	| { kind: 'video-mute-toggle'; video: LiveElement }
	/** Tap on the progress strip — seeks to `ratio * duration`. */
	| { kind: 'video-seek'; video: LiveElement; ratio: number }
	/** Rising edge of L+R held *without* Minus. The shell interprets
	 * this as "exit any fullscreen mode" and ignores it otherwise. */
	| { kind: 'lr-combo' };

/** Browser-shell display mode. Owned by the shell; controller-shortcuts
 * mirrors it via {@link setBrowserMode} so the touch listener can suppress
 * chrome-strip dispatch when chrome isn't drawn. */
export type BrowserMode = 'normal' | 'fullscreen-page' | 'fullscreen-canvas' | 'video-fullscreen';

let browserMode: BrowserMode = 'normal';
export function setBrowserMode(mode: BrowserMode): void {
	browserMode = mode;
}
export function getBrowserMode(): BrowserMode {
	return browserMode;
}

/** Currently focused video element while {@link BrowserMode} is
 * `'video-fullscreen'`. The touch handler reads this so taps on the
 * full-canvas controls bar route to the right element. Cleared on
 * exit. */
let fullscreenVideoEl: LiveElement | null = null;
export function setFullscreenVideo(el: LiveElement | null): void {
	fullscreenVideoEl = el;
}

/** Chrome-strip y-range in screen coordinates. Updated by the shell
 * whenever the template is loaded so taps in either toolbar position
 * (top OR bottom) route to the same chrome-button branches. */
let chromeY0 = 0;
let chromeY1 = 56;
export function setChromeRegion(y0: number, y1: number): void {
	chromeY0 = y0;
	chromeY1 = y1;
}

/** Whether the star (bookmark) button is currently shown + tappable.
 * The shell sets this false on non-bookmarkable pages (local
 * `browser://`); a tap in the star's x-slot then falls through to the
 * address-bar branch, matching the UI where the URL reclaims that slot. */
let starEnabled = true;
export function setStarEnabled(enabled: boolean): void {
	starEnabled = enabled;
}

/**
 * External nudges into the controller-input loop. Lets touch input (chrome
 * strip tap, content-area link tap) push events without restructuring the
 * polling.
 *
 * Pending input persists across `waitForControllerInput` calls so a tap
 * that happens during an unrelated sync action (e.g. while the on-canvas
 * keyboard is open) propagates to the next iteration instead of being
 * silently dropped.
 */
let pendingInput: ControllerInput | null = null;

function pushInput(input: ControllerInput): void {
	pendingInput = input;
}

/** Discard any queued input — kept for explicit reset cases (no longer called by `waitForControllerInput`). */
export function clearPendingInput(): void {
	pendingInput = null;
}

/** Non-consuming read of any input the touch listener has queued. */
export function peekPendingInput(): ControllerInput | null {
	return pendingInput;
}

// Double-tap discrimination for taps that land on a video frame
// (outside the controls bar). Single tap → toggle play/pause; double
// tap → toggle fullscreen. We always wait DOUBLE_TAP_MS before firing
// the single-tap action so we don't have to "undo" play/pause when a
// second tap arrives. The wait is short enough not to feel sluggish.
const VIDEO_DOUBLE_TAP_MS = 280;
let pendingFrameTap: {
	el: LiveElement;
	timeoutId: ReturnType<typeof setTimeout>;
	lastTapAt: number;
} | null = null;

function handleVideoFrameTap(el: LiveElement): void {
	const now = performance.now();
	if (pendingFrameTap &&
	    pendingFrameTap.el === el &&
	    (now - pendingFrameTap.lastTapAt) < VIDEO_DOUBLE_TAP_MS) {
		// Second tap on the same video within the window — double-tap.
		// Cancel the scheduled play/pause and toggle fullscreen.
		clearTimeout(pendingFrameTap.timeoutId);
		pendingFrameTap = null;
		if (browserMode === 'video-fullscreen') {
			// Reuse the existing fullscreen-exit path (B button / L+R).
			pushInput({ kind: 'lr-combo' });
		} else {
			pushInput({ kind: 'video-fullscreen-enter', video: el });
		}
		return;
	}
	if (pendingFrameTap) clearTimeout(pendingFrameTap.timeoutId);
	const tapEl = el;
	const tid = setTimeout(() => {
		pendingFrameTap = null;
		// Resolve play vs pause at fire time so the action matches the
		// state the user sees at the moment we act.
		if (videoIsPaused(tapEl)) {
			pushInput({ kind: 'video-play', video: tapEl });
		} else {
			pushInput({ kind: 'video-pause', video: tapEl });
		}
	}, VIDEO_DOUBLE_TAP_MS);
	pendingFrameTap = { el: tapEl, timeoutId: tid, lastTapAt: now };
}

// Generic double-tap → shell action for elements carrying
// `data-dbltap-action`. Unlike the video frame tap there's no single-tap
// action, so we just compare timestamps: a second tap on the SAME element
// with the SAME action inside the window fires the action; a lone tap is a
// no-op. Used by the audio player's visualizer canvas to enter
// fullscreen-canvas on a double-tap (exit is handled by the
// fullscreen-canvas touchstart gate + the B button).
const DBLTAP_ACTION_MS = 320;
let pendingActionTap: { el: LiveElement; action: string; lastTapAt: number } | null = null;
function handleDoubleTapAction(el: LiveElement, action: string): void {
	const now = performance.now();
	if (pendingActionTap &&
	    pendingActionTap.el === el &&
	    pendingActionTap.action === action &&
	    (now - pendingActionTap.lastTapAt) < DBLTAP_ACTION_MS) {
		pendingActionTap = null;
		pushInput({ kind: 'button-action', action });
		return;
	}
	pendingActionTap = { el, action, lastTapAt: now };
}

// Double-tap-to-exit while already in fullscreen-canvas mode. Tracked by
// screen coordinates (not the live hit-test) so the gesture works anywhere
// on screen even though the source canvas's layout box is only card-sized
// in fullscreen. A lone tap returns false and falls through to the normal
// hit-test so fixed overlays (e.g. lil-gui panels) still receive single
// taps — same contract as the video-fullscreen double-tap.
const FS_CANVAS_DBLTAP_MS = 320;
const FS_CANVAS_DBLTAP_DIST = 90;
let lastFsCanvasTap: { x: number; y: number; at: number } | null = null;
function fullscreenCanvasDoubleTap(x: number, y: number): boolean {
	const now = performance.now();
	if (lastFsCanvasTap &&
	    (now - lastFsCanvasTap.at) < FS_CANVAS_DBLTAP_MS &&
	    Math.hypot(x - lastFsCanvasTap.x, y - lastFsCanvasTap.y) < FS_CANVAS_DBLTAP_DIST) {
		lastFsCanvasTap = null;
		return true;
	}
	lastFsCanvasTap = { x, y, at: now };
	return false;
}

let touchListenerInstalled = false;

/**
 * `true` while a navigation is in flight. The touch handler drops new
 * tap-driven nav inputs (link taps + chrome buttons that trigger a
 * load) while this is set so rapid taps don't enqueue a second
 * `webView.load()` to fire the instant the first returns — on real
 * hardware that pattern surfaced random crashes back to hbmenu,
 * probably from native resource churn (offscreens, image decoders).
 * Sticky module-local so the touch listener can see it without an
 * extra closure.
 */
let isNavigating = false;
export function setNavigating(v: boolean): void {
	isNavigating = v;
	if (v) pendingInput = null;
}


/**
 * Tell the touch handler the current live-DOM viewport rect (in screen
 * coords). Mirrors what `paintLiveOverlay` uses so a tap inside a
 * `position:fixed top:N left:M` element resolves to the same on-screen
 * bbox as the painter draws. Set by the shell from each render path.
 */
let liveViewport: LiveViewport = { x: 0, y: 0, width: 0, height: 0 };
let liveScrollY = 0;
export function setLiveViewport(v: LiveViewport, scrollY: number = 0): void {
	liveViewport = v;
	liveScrollY = scrollY;
	// Push into live-dom so getBoundingClientRect() lands on the same
	// math the painter + hit-tester use (M2.0). Phase 1.5: also pushes
	// scrollY so hit-test can translate body-local boxes to screen.
	setInternalLiveViewport(v);
	setInternalLiveScrollY(scrollY);
}

/**
 * Install a single canvas touchstart listener that handles both the
 * chrome-strip taps (back / forward / home / star / settings / URL bar)
 * and content-area link taps. The chrome's screen y-range is supplied
 * by `setChromeRegion`, so the same listener works whether the toolbar
 * sits at the top or the bottom of the screen.
 */
/**
 * Tracks whether the last `touchstart` landed on a live-DOM element so
 * subsequent `touchmove` / `touchend` events get forwarded to the live
 * window's listener registry. Cleared on touchend / on missed taps.
 *
 * Needed for lil-gui's slider/number drag pattern: `mousedown` on the
 * `$slider` → `window.addEventListener('mousemove', ...)` →
 * release fires `window` `mouseup`. We translate touch events to the
 * mouse equivalents since lil-gui's mouse path runs first; the touch
 * path is also forwarded for libraries that prefer it.
 */
interface LiveDragSession {
	element: LiveElement;
	startX: number;
	startY: number;
}
let liveDragSession: LiveDragSession | null = null;
/** Vertical-scroll drag session — set if the touchstart landed inside
 * a scrollable live element. tracks the start touch y + the element's
 * scrollTop at session start so each touchmove computes the delta. */
let liveScrollSession: {
	element: LiveElement;
	startY: number;
	startScrollTop: number;
	maxScroll: number;
	moved: boolean;
} | null = null;
/** Touch-swipe page-scroll session — opened on `touchstart` when the
 * hit is on a live-DOM element with no inner scrollable ancestor and
 * the element isn't a form widget. `touchmove` translates the finger
 * delta into shell `handleScroll` calls (via {@link touchScrollHandler})
 * so a swipe-up / swipe-down on body content scrolls the page. */
let pageScrollSession: {
	startY: number;
	lastY: number;
	moved: boolean;
} | null = null;
/** Video-swipe session — opened on `touchstart` when the touch lands on
 * (or inside) a `<video>` element WITHOUT the `controls` attribute.
 * Swallows touchmove (no page scroll), and on touchend past
 * `VIDEO_SWIPE_THRESHOLD` dispatches a synthetic `keydown` to the page:
 * swipe up → `ArrowDown` (next), swipe down → `ArrowUp` (prev). The
 * TikTok app uses this for finger-swipe navigation; a chromed `<video>`
 * (native controls bar visible) falls back to the normal page-scroll
 * behavior so tappable seek bars / play buttons still work as expected. */
let videoSwipeSession: {
	videoEl: LiveElement;
	startY: number;
	moved: boolean;
} | null = null;
const VIDEO_SWIPE_THRESHOLD = 40;
/** Move-threshold (px) before a touch is treated as a swipe instead of
 * a tap. Matches the `liveScrollSession.moved` threshold so both
 * page-level and element-level scrolls use the same gesture cutoff —
 * past this distance the trailing `touchend` skips the click+intent
 * dispatch so a swipe doesn't activate a button under the finger. */
const SWIPE_MOVE_THRESHOLD = 6;
/** Shell-supplied scroll handler. Set once at boot via
 * {@link setTouchScrollHandler}; called from `touchmove` while a
 * `pageScrollSession` is open. Positive delta scrolls content down
 * (matches the right-stick / D-pad convention in `onScroll`). */
let touchScrollHandler: ((delta: number) => void) | null = null;
export function setTouchScrollHandler(fn: ((delta: number) => void) | null): void {
	touchScrollHandler = fn;
}

/** Walk up `el` until we find an element whose computed overflow makes
 * its M2.3 layout box scrollable (intrinsicContentH > contentH). Uses
 * the cascaded style so class-based overflow rules win. */
function findScrollableAncestor(el: LiveElement): LiveElement | null {
	for (let n: LiveElement | null = el; n; n = n.parent) {
		const lb = getLayoutBox(n);
		if (!lb || lb.intrinsicContentH <= lb.contentH) continue;
		const cs = getComputedLiveStyle(n);
		const oy = cs.overflowY ?? 'visible';
		if (oy === 'auto' || oy === 'scroll') return n;
	}
	return null;
}

/** Walk up `el` looking for a `<video>` element that has no `controls`
 * attribute. The TikTok app's chromeless `<video>` opts into
 * finger-swipe navigation this way: touchstart on the video (or any
 * descendant — overlays / caption / sidebar buttons all live inside
 * the same .stage subtree but the engine hit-tests the deepest hit
 * first) opens a `videoSwipeSession`. A chromed `<video>` (controls
 * attribute present) returns null here so the existing tap-to-play /
 * seek-bar UX keeps working. */
function findChromelessVideoAncestor(el: LiveElement): LiveElement | null {
	for (let n: LiveElement | null = el; n; n = n.parent) {
		if (n.tagName === 'VIDEO' && !n.hasAttribute('controls')) return n;
	}
	return null;
}

export function installCanvasTouch(): void {
	if (touchListenerInstalled) return;
	touchListenerInstalled = true;

	const canvas = nxScreen();
	canvas.addEventListener('touchstart', (event) => {
		_touchDiag('touchstart event received');
		const touch = event.touches[0] ?? event.changedTouches[0];
		if (!touch) { _touchDiag('  → no touch object, returning'); return; }
		const x = touch.clientX;
		const y = touch.clientY;
		_touchDiag('  → coords x=' + x + ' y=' + y + ' isNavigating=' + isNavigating);

		// Drop every tap while a navigation is in flight. Without this
		// guard, the touch listener queues the second tap while the
		// main loop is awaiting webView.load(); when the first load
		// returns, the queued tap fires a fresh navigation back-to-back.
		// On real hardware that rapid pattern was crashing the app to
		// hbmenu (suspected native resource churn — offscreens, image
		// decoders, etc.). The user already sees the loading state in
		// the chrome, so the right UX is to ignore taps until the load
		// completes.
		if (isNavigating) return;
		// In fullscreen-canvas, a double-tap anywhere exits (mirrors the
		// video-fullscreen exit gesture + the B button). A single tap
		// falls through to the normal hit-test so fixed overlays still
		// get it. Entering fullscreen-canvas is the page's job via a
		// `data-dbltap-action` element (see handleDoubleTapAction).
		if (browserMode === 'fullscreen-canvas') {
			if (fullscreenCanvasDoubleTap(x, y)) {
				pushInput({ kind: 'lr-combo' });
				return;
			}
		}
		// In video-fullscreen the page is hidden behind the focused
		// video, so we can't fall through to the normal hit-test (a
		// tap might land on an invisible <a href> at the same coords).
		// Only the fullscreen controls bar (always at the bottom of the
		// canvas) is tappable; everything else is a no-op so the user
		// uses the B button to exit.
		if (browserMode === 'video-fullscreen') {
			const fv = fullscreenVideoEl;
			if (fv) {
				const canvas = nxScreen();
				const ctrl = hitTestVideoControls(
					0, 0, canvas.width, canvas.height, x, y, fv,
				);
				if (ctrl) {
					if (ctrl.kind === 'play') {
						pushInput({ kind: 'video-play', video: fv });
					} else if (ctrl.kind === 'pause') {
						pushInput({ kind: 'video-pause', video: fv });
					} else if (ctrl.kind === 'mute-toggle' || ctrl.kind === 'unmute-toggle') {
						pushInput({ kind: 'video-mute-toggle', video: fv });
					} else if (ctrl.kind === 'fullscreen-enter') {
						// Already in fullscreen — treat the bar's
						// fullscreen icon as an exit affordance.
						pushInput({ kind: 'lr-combo' });
					} else if (ctrl.kind === 'seek') {
						pushInput({ kind: 'video-seek', video: fv, ratio: ctrl.ratio });
					}
				} else {
					// Tap outside the bar in fullscreen: same single/
					// double-tap discrimination as inline mode. Single
					// → play/pause toggle on the focused video. Double
					// → exit fullscreen.
					handleVideoFrameTap(fv);
				}
			}
			return;
		}

		// Live-DOM hit-test runs FIRST (before mode gates / chrome /
		// content checks). position:fixed overlay elements sit on top
		// of everything visually, so they should get the tap first.
		// Works in all browser modes since the live overlay is painted
		// in all modes (including fullscreen-canvas). Handles Stats's
		// tap-to-cycle and any future tappable overlay.
		//
		// M2.0 expansion: dispatch the full press-edge event chain to
		// the hit element AND to the live window. lil-gui's slider
		// drag pattern is mousedown-on-element →
		// window.addEventListener('mousemove'+'mouseup'). The
		// touchmove/touchend handlers installed below complete the
		// chain. `click` is also fired for back-compat with Stats's
		// tap-to-cycle (it listens for `click`, not `mousedown`).
		//
		// Gated off when the on-canvas keyboard is up: outside-panel
		// taps are meant purely as cancel gestures and shouldn't also
		// fire a `click` on whatever sits under the finger. The welcome
		// page's bookmark cards extend down through the area visually
		// occupied by the keyboard panel — without this gate a tap on
		// the visible-sliver of a card (or seemingly empty space just
		// above the panel) would queue a navigate to that bookmark.
		// Chrome strip taps still fire via the static dispatch path
		// below, which doesn't use the live-DOM hit-test.
		try {
			const liveHit = isKeyboardOpen()
				? null
				: hitTestLive(getLiveRoot(), x, y, liveViewport);
			if (liveHit) {
				_touchDiag('  → live-DOM hit on <' + liveHit.tagName + '>');
				// M2.5: open a scroll session if the hit is inside a
				// scrollable ancestor. The touchmove handler drives it;
				// if the cumulative move exceeds the click threshold we
				// suppress the trailing click + form-tap so a swipe to
				// scroll doesn't accidentally activate a button under
				// the finger.
				const scrollHost = findScrollableAncestor(liveHit);
				const chromelessVideo = scrollHost ? null
					: findChromelessVideoAncestor(liveHit);
				if (scrollHost) {
					const lb = getLayoutBox(scrollHost)!;
					liveScrollSession = {
						element: scrollHost,
						startY: y,
						startScrollTop: scrollHost.scrollTop,
						maxScroll: Math.max(0, lb.intrinsicContentH - lb.contentH),
						moved: false,
					};
				} else if (chromelessVideo
					&& browserMode === 'normal' && !isKeyboardOpen()) {
					// Touch landed on a chromeless `<video>` (or inside its
					// overlays). Open a video-swipe session — touchmove
					// won't drive page scroll, and touchend past threshold
					// dispatches ArrowUp / ArrowDown on the page so the
					// app's keydown handler treats finger swipes the same
					// as D-pad presses.
					videoSwipeSession = { videoEl: chromelessVideo, startY: y, moved: false };
				} else if (browserMode === 'normal' && !isFormWidget(liveHit) && !isKeyboardOpen()) {
					// No inner overflow:auto/scroll ancestor + the hit isn't
					// a form widget (sliders own their own drag) → open a
					// page-level scroll session. `touchmove` will translate
					// finger dy into shell scrollY deltas via
					// `touchScrollHandler`.
					//
					// Gated off when the on-canvas keyboard is up: the
					// keyboard owns the page-scroll route in that mode (its
					// own touchmove emits onScroll) so we don't get
					// double-fired deltas.
					pageScrollSession = { startY: y, lastY: y, moved: false };
				}
				const baseEvent = {
					clientX: x, clientY: y,
					pageX: x, pageY: y,
					screenX: x, screenY: y,
					button: 0, buttons: 1,
					preventDefault: () => { /* no-op — already consumed */ },
					stopPropagation: () => { /* no-op */ },
				};
				const touchObj = {
					clientX: x, clientY: y,
					pageX: x, pageY: y,
					screenX: x, screenY: y,
					identifier: 0,
				};
				liveDragSession = { element: liveHit, startX: x, startY: y };
				// M2.2: set :active state on the pressed element.
				setPseudoActive(liveHit, true);
				liveHit.dispatchEvent({ type: 'mousedown', ...baseEvent });
				liveHit.dispatchEvent({
					type: 'touchstart',
					touches: [touchObj], changedTouches: [touchObj], targetTouches: [touchObj],
					preventDefault: baseEvent.preventDefault,
					stopPropagation: baseEvent.stopPropagation,
				});
				// M2.5: click + form-tap dispatch is DEFERRED to touchend
				// so a scroll-drag swipe suppresses the trailing click.
				// The touchend handler reads liveDragSession + liveScrollSession.moved
				// to decide whether to fire click / handleFormTap.
				return;
			}
		} catch (e) {
			_touchDiag('  → live-DOM hit-test threw: ' +
				(e instanceof Error ? e.message : String(e)));
		}

		// In fullscreen modes the chrome strip isn't drawn — there's no
		// way to leave fullscreen by tap, so just don't dispatch any
		// other touch input. (Fullscreen exit is the L+R combo.) Content
		// taps in fullscreen-page mode also fall under this: the
		// experiment treats fullscreen as view-only. Note this runs
		// AFTER the live-DOM hit-test so Stats etc. still work in
		// fullscreen-canvas mode.
		if (browserMode !== 'normal') return;

		if (y >= chromeY0 && y < chromeY1) {
			const backEnd = CHROME_LAYOUT.backX + CHROME_LAYOUT.backWidth;
			const forwardEnd = CHROME_LAYOUT.forwardX + CHROME_LAYOUT.forwardWidth;
			const refreshEnd = CHROME_LAYOUT.refreshX + CHROME_LAYOUT.refreshWidth;
			const homeEnd = CHROME_LAYOUT.homeX + CHROME_LAYOUT.homeWidth;
			const starEnd = CHROME_LAYOUT.starX + CHROME_LAYOUT.starWidth;
			const settingsEnd = CHROME_LAYOUT.settingsX + CHROME_LAYOUT.settingsWidth;
			if (x >= CHROME_LAYOUT.backX && x < backEnd) {
				pushInput({ kind: 'back' });
			} else if (x >= CHROME_LAYOUT.forwardX && x < forwardEnd) {
				pushInput({ kind: 'forward' });
			} else if (x >= CHROME_LAYOUT.refreshX && x < refreshEnd) {
				// Refresh slot — reuses the existing `reload` input kind that
				// the Y button rising-edge handler also fires.
				pushInput({ kind: 'reload' });
			} else if (x >= CHROME_LAYOUT.homeX && x < homeEnd) {
				pushInput({ kind: 'home' });
			} else if (starEnabled && x >= CHROME_LAYOUT.starX && x < starEnd) {
				// Star tap only when the button is shown (bookmarkable
				// http/https page). On local browser:// pages the star is
				// hidden and the URL occupies its slot, so the tap falls
				// through to the address-bar branch below.
				pushInput({ kind: 'star' });
			} else if (x >= CHROME_LAYOUT.settingsX && x < settingsEnd) {
				pushInput({ kind: 'settings' });
			} else {
				pushInput({ kind: 'address-bar' });
			}
			return;
		}

		// Below the chrome strip: no static-layout tap targets remain.
		// Live-DOM hit-test above already handled any content tap that
		// landed on an interactive element; missed taps are a no-op.
		_touchDiag('  → no live-DOM hit at y=' + y);
	});

	// M2.0 drag-event bridge: forward touchmove/touchend to the live
	// window's listener registry (and translate to mousemove/mouseup
	// since lil-gui registers the mouse forms first). Only active
	// while `liveDragSession` is set — i.e., the touchstart that
	// opened the drag landed on a live-DOM element. Without this gate
	// every page swipe would wake up listeners that don't apply.
	canvas.addEventListener('touchmove', (event: TouchEvent) => {
		if (!liveDragSession) return;
		const touch = event.touches[0] ?? event.changedTouches[0];
		if (!touch) return;
		const x = touch.clientX;
		const y = touch.clientY;
		// M2.5: drive the scroll-drag session if open. Move > threshold
		// flags the session as "moved" so the trailing touchend skips
		// the click/form-tap dispatch.
		if (liveScrollSession) {
			const dy = y - liveScrollSession.startY;
			const target = Math.max(0, Math.min(
				liveScrollSession.maxScroll,
				liveScrollSession.startScrollTop - dy,
			));
			liveScrollSession.element.scrollTop = target;
			if (Math.abs(dy) > SWIPE_MOVE_THRESHOLD) liveScrollSession.moved = true;
		} else if (videoSwipeSession) {
			// Just track the move — page scroll is suppressed for chromeless
			// videos. Flip `moved` once we've crossed the click-suppression
			// threshold so the trailing touchend skips dispatching `click` /
			// `video-frame-tap` (otherwise a swipe would also toggle
			// play/pause or enter fullscreen).
			if (Math.abs(y - videoSwipeSession.startY) > SWIPE_MOVE_THRESHOLD) {
				videoSwipeSession.moved = true;
			}
		} else if (pageScrollSession) {
			// Page-level swipe. Use the INCREMENTAL delta (since last
			// touchmove) rather than the cumulative dy because
			// `touchScrollHandler` mutates `currentScrollY` directly and
			// would double-count if we sent the full distance each tick.
			// Sign: finger DOWN (positive dy) reveals content above →
			// scrollY decreases → handleScroll wants negative delta. So
			// dispatch `-incDy`.
			const incDy = y - pageScrollSession.lastY;
			pageScrollSession.lastY = y;
			if (Math.abs(y - pageScrollSession.startY) > SWIPE_MOVE_THRESHOLD) {
				pageScrollSession.moved = true;
			}
			if (incDy !== 0 && touchScrollHandler) {
				touchScrollHandler(-incDy);
			}
		}
		// Batch B follow-up (2026-05-25): drag the range slider thumb
		// continuously as the finger moves. Fires `input` events per
		// move; `change` lands on touchend via handleFormTap. Replays
		// through the same handler that drives tap-to-position so the
		// step / clamp / value math stays in one place.
		const dragEl = liveDragSession.element;
		if (dragEl.tagName === 'INPUT'
			&& (dragEl.getAttribute('type') ?? '').toLowerCase() === 'range'
		) {
			void handleFormTap(dragEl, x);
		}
		const win = getLiveWindow();
		const baseEvent = {
			clientX: x, clientY: y,
			pageX: x, pageY: y,
			screenX: x, screenY: y,
			button: 0, buttons: 1,
			preventDefault: () => { /* no-op */ },
			stopPropagation: () => { /* no-op */ },
		};
		const touchObj = {
			clientX: x, clientY: y,
			pageX: x, pageY: y,
			screenX: x, screenY: y,
			identifier: 0,
		};
		win.dispatchEvent({ type: 'mousemove', ...baseEvent });
		win.dispatchEvent({
			type: 'touchmove',
			touches: [touchObj], changedTouches: [touchObj], targetTouches: [touchObj],
			preventDefault: baseEvent.preventDefault,
			stopPropagation: baseEvent.stopPropagation,
		});
	});

	canvas.addEventListener('touchend', (event: TouchEvent) => {
		if (!liveDragSession) return;
		const touch = event.changedTouches[0] ?? event.touches[0];
		const x = touch?.clientX ?? 0;
		const y = touch?.clientY ?? 0;
		const win = getLiveWindow();
		const baseEvent = {
			clientX: x, clientY: y,
			pageX: x, pageY: y,
			screenX: x, screenY: y,
			button: 0, buttons: 0,
			preventDefault: () => { /* no-op */ },
			stopPropagation: () => { /* no-op */ },
		};
		const touchObj = {
			clientX: x, clientY: y,
			pageX: x, pageY: y,
			screenX: x, screenY: y,
			identifier: 0,
		};
		win.dispatchEvent({ type: 'mouseup', ...baseEvent });
		win.dispatchEvent({
			type: 'touchend',
			touches: [], changedTouches: [touchObj], targetTouches: [],
			preventDefault: baseEvent.preventDefault,
			stopPropagation: baseEvent.stopPropagation,
		});

		// Video-swipe commit: if the touch crossed VIDEO_SWIPE_THRESHOLD
		// on a chromeless video, dispatch the matching keydown to the
		// page and suppress the trailing click. Mapping matches the
		// keyboard handler in the TikTok app: swipe UP (finger up,
		// dy < 0) → next → ArrowDown. Swipe DOWN → prev → ArrowUp. We
		// dispatch regardless of whether anyone is currently listening
		// because the page may register/unregister the handler
		// dynamically; `dispatchPageKeyEvent` is a no-op when no listener
		// is attached.
		if (videoSwipeSession) {
			const dy = y - videoSwipeSession.startY;
			if (Math.abs(dy) >= VIDEO_SWIPE_THRESHOLD) {
				const key = dy < 0 ? 'ArrowDown' : 'ArrowUp';
				dispatchPageKeyEvent('keydown', key, key);
			}
		}

		// M2.5: dispatch the deferred click + form-tap UNLESS the
		// session was actually a scroll-drag (moved > threshold). For
		// scroll-drags we skip click so finger-swipe doesn't activate
		// a button under the finger. Both element-level (overflow:auto
		// inner container) and page-level (body swipe) sessions count.
		// The video-swipe session also suppresses click — a sub-threshold
		// touch on the video still falls through (so tap-to-fullscreen /
		// tap-to-play keeps working).
		const wasDrag = (liveScrollSession?.moved === true)
			|| (pageScrollSession?.moved === true)
			|| (videoSwipeSession?.moved === true);
		if (!wasDrag) {
			const target = liveDragSession.element;
			target.dispatchEvent({ type: 'click', ...baseEvent });
			// Walk up the live tree from the tapped element looking for
			// navigation / button / summary intents. This is how
			// <a href> / <button data-action> / <summary> taps reach
			// the shell's navigation handlers.
			const intent = findTapIntent(
				target, x, y,
				liveViewport.x, liveViewport.y, liveScrollY,
			);
			// Form widgets normally open the keyboard / cycle on tap. But
			// a widget that opts into a shell action via `data-action`
			// (e.g. the search `<input data-action="search">`) should
			// fire that action instead of the default widget behaviour —
			// otherwise both the keyboard AND the action would trigger.
			const widgetHasAction = intent?.kind === 'button-action';
			if (isFormWidget(target) && !widgetHasAction) {
				// Pass the tap's screen-x so range sliders can compute
				// the new value from the position; other widgets ignore it.
				_touchDiag('  → route: handleFormTap <' + target.tagName + '>');
				// `true`: we already dispatched `click` on `target` above, so
				// handleFormTap must NOT re-fire it (avoids double-firing a
				// <button>'s handler — which made Stop instantly re-Play).
				void handleFormTap(target, x, true);
			} else if (!widgetHasAction) {
				_touchDiag('  → route: generic-click patchLiveDirtyRegions <' + target.tagName + '>');
				// Generic click target (e.g. a <button> tapped on its <svg>/
				// <span> child, so `target` isn't the form widget itself — the
				// click bubbled to the button's handler above). Repaint just
				// the regions the handler mutated instead of rebuilding the
				// whole page cache; patchLiveDirtyRegions falls back to the
				// full rebuild (and still schedules the repaint) when it can't
				// safely patch.
				patchLiveDirtyRegions();
			}
			_touchDiag('  → touchend on <' + target.tagName + '> intent=' +
				(intent ? intent.kind : 'none'));
			if (intent) {
				if (intent.kind === 'navigate') {
					_touchDiag('    → pushInput(navigate ' + intent.href + ')');
					pushInput({ kind: 'navigate', url: intent.href });
				} else if (intent.kind === 'button-action') {
					_touchDiag('    → pushInput(button-action ' + intent.action + ')');
					pushInput({ kind: 'button-action', action: intent.action });
				} else if (intent.kind === 'dbltap-action') {
					_touchDiag('    → handleDoubleTapAction ' + intent.action);
					handleDoubleTapAction(intent.el, intent.action);
				} else if (intent.kind === 'summary') {
					_touchDiag('    → pushInput(summary-toggle)');
					pushInput({ kind: 'summary-toggle', summary: intent.summary });
				} else if (intent.kind === 'video-control') {
					const c = intent.control;
					_touchDiag('    → pushInput(video-' + c.kind + ')');
					if (c.kind === 'play') {
						pushInput({ kind: 'video-play', video: intent.video });
					} else if (c.kind === 'pause') {
						pushInput({ kind: 'video-pause', video: intent.video });
					} else if (c.kind === 'mute-toggle' || c.kind === 'unmute-toggle') {
						pushInput({ kind: 'video-mute-toggle', video: intent.video });
					} else if (c.kind === 'fullscreen-enter') {
						pushInput({ kind: 'video-fullscreen-enter', video: intent.video });
					} else if (c.kind === 'seek') {
						pushInput({ kind: 'video-seek', video: intent.video, ratio: c.ratio });
					}
				} else if (intent.kind === 'video-frame-tap') {
					handleVideoFrameTap(intent.video);
				}
			}
		}

		// M2.2: clear :active on the element the drag opened on.
		setPseudoActive(liveDragSession.element, false);
		liveDragSession = null;
		// M2.5: close the scroll-drag session.
		liveScrollSession = null;
		pageScrollSession = null;
		videoSwipeSession = null;
	});
}

const _TOUCH_DIAG_PATH = 'sdmc:/switch/webprofiles/default/logs/shell-nav-diag.log';
const _touchDiagStart = Date.now();
function _touchDiag(label: string): void {
	try {
		const sw = (globalThis as { Switch?: { appendFileSync?: (p: string, d: string) => void } }).Switch;
		if (sw?.appendFileSync) {
			sw.appendFileSync(_TOUCH_DIAG_PATH,
				(Date.now() - _touchDiagStart) + 'ms\tTOUCH: ' + label + '\n');
		}
	} catch { /* swallow */ }
}

export interface ControllerInputOptions {
	/**
	 * Called when the user requests vertical scrolling via the right stick
	 * or D-pad up/down. Positive delta scrolls down (content moves up).
	 * The shell can clamp and repaint inside the callback; the poll loop
	 * does not return on scroll, so scrolling is continuous.
	 */
	onScroll?: (delta: number) => void;
	/**
	 * Called once per poll iteration after gamepad state is sampled.
	 * Used by the browser shell to drive page-script animation frames
	 * (`tickAnimationFrames` in canvas-runner) so Three.js-style
	 * `requestAnimationFrame` loops get a steady tick aligned with the
	 * input poll cadence. Returning `true` tells the loop the tick did
	 * useful work — currently advisory only (the active-poll cadence
	 * is already at-vsync when scrolling, so an active animation just
	 * piggybacks on that), but the signal lets us drop to the active
	 * poll interval even when no scroll input is happening.
	 *
	 * `info.scrolledThisTick` is true when `onScroll` already fired in
	 * this iteration. The shell uses this to skip double-repaints during
	 * a chunked cache build — scroll input already triggered a repaint,
	 * so the build-continuation flag waits until the next idle tick to
	 * advance. Keeps scroll responsive during build.
	 */
	onTick?: (info: { scrolledThisTick: boolean }) => boolean;
}

/**
 * Poll the gamepad and check for pushed touch input until one of the shell
 * shortcuts fires.
 *
 * Right stick Y and D-pad up/down don't return — they trigger `onScroll`
 * and keep polling. Everything else returns the discrete `ControllerInput`.
 *
 * Buttons that are already held when this function is entered don't fire
 * until released and re-pressed (the initial snapshot seeds "wasPressed").
 */
/**
 * D-pad hold-repeat state — module-level so it survives across calls
 * to `waitForControllerInput`. If the function returns mid-hold (e.g.,
 * a touch tap arrives in `pendingInput`), local state would reset and
 * the next call's `prev = snapshot()` would capture the already-held
 * D-pad, so the `rising` check would never fire again and the hold
 * branch couldn't engage either (heldSince==0). Keeping the state
 * module-level lets the hold timer continue from the original press
 * across re-entries. The `!next.dpadUp` release branch is the only
 * resetter.
 */
let dpadUpHeldSince = 0;
let dpadUpLastFire = 0;
let dpadUpRepeatFires = 0;
let dpadDownHeldSince = 0;
let dpadDownLastFire = 0;
let dpadDownRepeatFires = 0;

/** Right-stick Y rising-edge tracker for video-fullscreen keydown
 * dispatch. We treat a stick deflection that crosses the deadzone as a
 * single virtual D-pad press: one keydown immediately, then auto-repeat
 * at DPAD_HOLD_REPEAT_MS while the stick stays deflected past the same
 * threshold. Resets when the stick returns through the deadzone, so a
 * release+re-deflect re-fires the initial keydown. Direction is encoded
 * as -1 (up) / +1 (down) / 0 (neutral). Module-level so the state
 * survives between input-loop iterations (matches the dpad pattern). */
let rightStickDir = 0;
let rightStickHeldSince = 0;
let rightStickLastFire = 0;
const RIGHT_STICK_EDGE = 0.55;
const RIGHT_STICK_RELEASE = 0.30;

/** Diagnostic snapshot of the D-pad hold state, exposed for the
 * benchmark page to read so we can verify auto-repeat is engaging. */
interface DpadHoldDebug {
	upHeldSince: number;
	upLastFire: number;
	upRepeatFires: number;
	upPressedNow: boolean;
	downHeldSince: number;
	downLastFire: number;
	downRepeatFires: number;
	downPressedNow: boolean;
	now: number;
}

function publishDpadDebug(snap: ShellButtonSnapshot, nowMs: number): void {
	const dbg: DpadHoldDebug = {
		upHeldSince: dpadUpHeldSince,
		upLastFire: dpadUpLastFire,
		upRepeatFires: dpadUpRepeatFires,
		upPressedNow: snap.dpadUp,
		downHeldSince: dpadDownHeldSince,
		downLastFire: dpadDownLastFire,
		downRepeatFires: dpadDownRepeatFires,
		downPressedNow: snap.dpadDown,
		now: nowMs,
	};
	(globalThis as { __dpadDebug?: DpadHoldDebug }).__dpadDebug = dbg;
}

export async function waitForControllerInput(options: ControllerInputOptions = {}): Promise<ControllerInput> {
	let exitHeldSince = 0;
	let prev = snapshot();

	while (true) {
		if (pendingInput) {
			const input = pendingInput;
			pendingInput = null;
			return input;
		}

		const pad = activePad();
		const l = isPressed(pad, COMBO_BUTTONS.l);
		const r = isPressed(pad, COMBO_BUTTONS.r);
		const minus = isPressed(pad, COMBO_BUTTONS.minus);

		if (l && r && minus) {
			exitHeldSince ||= performance.now();
			if (performance.now() - exitHeldSince >= EXIT_COMBO_HOLD_MS) {
				return { kind: 'exit' };
			}
			prev = snapshot();
			await delay(IDLE_POLL_INTERVAL_MS);
			continue;
		}
		exitHeldSince = 0;

		const next = snapshot();

		// Rising edge of L+R (without Minus) — used to exit fullscreen.
		// The shell ignores this in normal mode, so pressing L+R there is
		// a no-op. Adding Minus continues the exit-shell combo path above.
		const lrNow = next.l && next.r;
		const lrPrev = prev.l && prev.r;
		if (lrNow && !lrPrev && !minus) {
			prev = next;
			return { kind: 'lr-combo' };
		}

		if (rising(prev, next, 'zr')) return { kind: 'address-bar' };
		if (rising(prev, next, 'b')) return { kind: 'back' };
		if (rising(prev, next, 'x')) return { kind: 'forward' };
		if (rising(prev, next, 'y')) return { kind: 'reload' };
		// Minus alone (no L/R) → screenshot. The L+R+Minus exit combo is
		// caught above and continues without falling through to the
		// rising-edge checks, so a held Minus en route to the exit combo
		// never reaches this branch.
		if (rising(prev, next, 'minus')) return { kind: 'screenshot' };

		let scrolledThisTick = false;
		if (options.onScroll) {
			// D-pad up/down + right-stick Y are forwarded to the page as
			// synthetic `keydown` events (ArrowUp / ArrowDown) ANY time a
			// page handler is registered — not just in video-fullscreen
			// mode. If the page handler calls `preventDefault()`, the
			// engine skips the scroll for that input on that tick;
			// otherwise the normal scroll runs. Standard web semantics.
			// Pages with no keydown listener (most welcome / settings
			// pages) pay zero extra cost and scroll exactly as before.
			const pageWantsKeys = pageHasListenerFor('keydown');
			function fireKey(direction: 'up' | 'down'): boolean {
				if (!pageWantsKeys) return false;
				const key = direction === 'up' ? 'ArrowUp' : 'ArrowDown';
				return dispatchPageKeyEvent('keydown', key, key);
			}

			const stickDelta = readStickScroll(pad);
			if (stickDelta !== 0) {
				options.onScroll(stickDelta);
				scrolledThisTick = true;
			}
			const nowMs = performance.now();

			// --- Right-stick Y → virtual D-pad for video-fullscreen pages ---
			if (pageWantsKeys) {
				const axis = pad?.axes[RIGHT_STICK_Y_AXIS] ?? 0;
				const absAxis = Math.abs(axis);
				if (rightStickDir === 0) {
					if (absAxis >= RIGHT_STICK_EDGE) {
						rightStickDir = axis < 0 ? -1 : 1;
						rightStickHeldSince = nowMs;
						rightStickLastFire = nowMs;
						fireKey(rightStickDir === -1 ? 'up' : 'down');
					}
				} else if (absAxis < RIGHT_STICK_RELEASE
				           || (rightStickDir === -1 && axis > 0)
				           || (rightStickDir === 1 && axis < 0)) {
					rightStickDir = 0;
					rightStickHeldSince = 0;
				} else if (
					nowMs - rightStickHeldSince >= DPAD_HOLD_DELAY_MS &&
					nowMs - rightStickLastFire >= DPAD_HOLD_REPEAT_MS
				) {
					fireKey(rightStickDir === -1 ? 'up' : 'down');
					rightStickLastFire = nowMs;
				}
			} else {
				rightStickDir = 0;
				rightStickHeldSince = 0;
			}

			// D-pad up: single step on rising edge; once the button has
			// been held continuously for `DPAD_HOLD_DELAY_MS`, repeat
			// every `DPAD_HOLD_REPEAT_MS` until release. Hold state is
			// module-level so a brief return from this function (e.g.,
			// a touch event) doesn't reset the timer.
			if (rising(prev, next, 'dpadUp')) {
				const handled = fireKey('up');
				if (!handled) {
					options.onScroll(-DPAD_SCROLL_STEP);
					scrolledThisTick = true;
				}
				dpadUpHeldSince = nowMs;
				dpadUpLastFire = nowMs;
			} else if (next.dpadUp) {
				if (dpadUpHeldSince === 0) {
					// We re-entered with D-pad already held — no rising
					// edge captured. Start the hold timer NOW so the
					// auto-repeat can still engage after the delay.
					dpadUpHeldSince = nowMs;
					dpadUpLastFire = nowMs;
				} else if (
					nowMs - dpadUpHeldSince >= DPAD_HOLD_DELAY_MS &&
					nowMs - dpadUpLastFire >= DPAD_HOLD_REPEAT_MS
				) {
					const handled = fireKey('up');
					if (!handled) {
						options.onScroll(-DPAD_SCROLL_STEP);
						scrolledThisTick = true;
					}
					dpadUpLastFire = nowMs;
					dpadUpRepeatFires++;
				}
			} else {
				dpadUpHeldSince = 0;
			}
			// D-pad down: same logic, opposite direction.
			if (rising(prev, next, 'dpadDown')) {
				const handled = fireKey('down');
				if (!handled) {
					options.onScroll(DPAD_SCROLL_STEP);
					scrolledThisTick = true;
				}
				dpadDownHeldSince = nowMs;
				dpadDownLastFire = nowMs;
			} else if (next.dpadDown) {
				if (dpadDownHeldSince === 0) {
					dpadDownHeldSince = nowMs;
					dpadDownLastFire = nowMs;
				} else if (
					nowMs - dpadDownHeldSince >= DPAD_HOLD_DELAY_MS &&
					nowMs - dpadDownLastFire >= DPAD_HOLD_REPEAT_MS
				) {
					const handled = fireKey('down');
					if (!handled) {
						options.onScroll(DPAD_SCROLL_STEP);
						scrolledThisTick = true;
					}
					dpadDownLastFire = nowMs;
					dpadDownRepeatFires++;
				}
			} else {
				dpadDownHeldSince = 0;
			}
			publishDpadDebug(next, nowMs);
		}

		// Drive page-script animation frames. The shell wires this to
		// `tickAnimationFrames` in canvas-runner so Three.js-style
		// `requestAnimationFrame` callbacks fire at the input-poll
		// cadence. When the tick reports it did real work we drop to
		// the active-poll interval so the next frame fires at vsync
		// rather than after the full idle delay.
		const tickedThisIter = options.onTick ? options.onTick({ scrolledThisTick }) : false;

		prev = next;

		// Drop the poll delay to ~0 while the user is actively
		// scrolling OR a page animation is in flight so we run on every
		// main-loop iteration (one per vsync). When idle, sleep for the
		// full poll interval to keep the loop cheap. On Switch each
		// `await delay(0)` still goes through `setTimeout(0)` → next
		// main-loop tick → vsync-paced render, so this doesn't busy-spin.
		const active = scrolledThisTick || tickedThisIter;
		await delay(active ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
	}
}
