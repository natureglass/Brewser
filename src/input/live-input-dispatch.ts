// 2026-06-10: unified live-DOM press dispatch + chrome-tap router.
//
// Before this module, touch and engine-mouse each rebuilt the live-DOM
// dispatch path inline. Touch (controller-shortcuts.ts installCanvasTouch)
// did setPseudoActive + mousedown/touchstart on press and on touchend
// dispatched click + findTapIntent → pushInput + handleFormTap, then
// setPseudoActive(false). Engine-mouse (page-mouse-forwarder.ts
// tickMouseInput) only dispatched DOM mousedown/mouseup/click events and
// skipped everything else, so `<a href>` / `<button data-action>` /
// summary / form-widget taps under the engine cursor never reached the
// shell intent layer — the visible bug being "engine-mouse on content
// area does nothing."
//
// On top of that, a fast tap (touchstart + touchend in the same poll
// batch) flipped :active true then false before the shell's `onTick`
// ever painted, so no pressed visual was ever shown — the bug "no
// click feedback on touch."
//
// Two fixes, one module:
//
//   1. `beginLivePress(el, x, y, source)` + `endLivePress(handle, ...)`:
//      shared press lifecycle. Touch and engine-mouse both call these
//      so the intent path runs identically for both. Source-specific
//      event emission (touchstart vs mouseonly) lives in the helpers so
//      callers don't duplicate it.
//
//   2. The clear of `:active` is DEFERRED so the pressed state stays
//      visible for at least `MIN_PRESS_VISIBLE_MS` from beginPress. A
//      paint frame with `:active` applied is guaranteed because we
//      `requestFullRepaint()` at begin AND the shell's onTick consumes
//      it within one tick (~16 ms). At ~120 ms hold the user sees the
//      pressed visual on every tap.
//
//   3. `dispatchChromeTap(x, y)`: shared chrome-strip dispatcher used
//      by both touch (installCanvasTouch) and engine-mouse
//      (page-mouse-forwarder cursorInChromeZone path). Replaces the
//      mouse forwarder's earlier "synth touchstart/touchend on
//      nxScreen" round-trip that drove the chrome handler in
//      controller-shortcuts.
//
// pushInput / push-style intent emission is owned by controller-shortcuts;
// this module reaches it via a sink registered at boot.

import { CHROME_LAYOUT } from '../browser-config.js';
import { setPseudoActive } from '../scripts/live-css.js';
import { findTapIntent } from '../scripts/live-overlay.js';
import { handleFormTap, isFormWidget } from '../scripts/live-form.js';
import { requestFullRepaint } from '../scripts/live-paint-control.js';
import type { LiveElement } from '../scripts/live-dom.js';
import { playClick } from '../audio/click-sound.js';

/** Minimum time, in milliseconds, that a pressed element keeps its
 * `:active` state visible after `beginLivePress`. The clear on
 * `endLivePress` is deferred when the press was shorter than this.
 * 120ms ≈ 7 frames at 60Hz — enough for at least one paint cycle to
 * run with :active applied so the user reliably sees the press. */
const MIN_PRESS_VISIBLE_MS = 120;

export type PressSource = 'touch' | 'mouse';

export interface LivePressHandle {
	el: LiveElement;
	pressedSince: number;
	startX: number;
	startY: number;
	source: PressSource;
	cleared: boolean;
	/** Ancestor chain captured at press start (leaf first, root last).
	 * Real browsers apply `:active` to the leaf AND every ancestor —
	 * without this, a tap on an `<img>` inside `<a class="app-card">`
	 * would only set `:active` on the img, and a rule like
	 * `.app-card:active` would never match. We capture once at press
	 * time so the same set we set is the set we release, even if the
	 * page mutates its DOM mid-press. */
	chain: readonly LiveElement[];
}

// Pending clear-timer ids per element. When a press is re-issued before
// its previous clear timer fires (same element re-pressed inside the
// hold window), we cancel the stale timer so the element doesn't get
// wiped from :active mid-second-press.
const pendingClears = new WeakMap<LiveElement, ReturnType<typeof setTimeout>>();
// Pending handles per element — paired with `pendingClears` above. We
// need the HANDLE (not just the timer id) so re-press on the same leaf
// can release the previous press's ancestor-chain refcounts before
// starting fresh. Without this, the previous press's chain stays at
// refcount > 0 forever and `:active` never releases on its ancestors.
const pendingHandles = new WeakMap<LiveElement, LivePressHandle>();

// ----- Intent + chrome sinks -------------------------------------------------

/** Subset of `ControllerInput` that this dispatcher emits. `pushInput`
 * is owned by controller-shortcuts.ts; we keep the shape structural so
 * we don't pull in its full union (which would cycle: controller →
 * dispatch → controller). */
export type LiveTapIntent =
	| { kind: 'navigate'; url: string }
	| { kind: 'button-action'; action: string }
	| { kind: 'summary-toggle'; summary: LiveElement }
	| { kind: 'video-play'; video: LiveElement }
	| { kind: 'video-pause'; video: LiveElement }
	| { kind: 'video-mute-toggle'; video: LiveElement }
	| { kind: 'video-fullscreen-enter'; video: LiveElement }
	| { kind: 'video-seek'; video: LiveElement; ratio: number };

export type ChromeIntent =
	| { kind: 'back' }
	| { kind: 'forward' }
	| { kind: 'reload' }
	| { kind: 'home' }
	| { kind: 'star' }
	| { kind: 'settings' }
	| { kind: 'address-bar' };

type IntentSink = (intent: LiveTapIntent | ChromeIntent) => void;
let intentSink: IntentSink | null = null;

/** Registered once by the shell boot path (controller-shortcuts.ts). */
export function setLiveInputIntentSink(fn: IntentSink): void {
	intentSink = fn;
}

// Chrome y-range mirrored from controller-shortcuts via setChromeRegion.
// Kept duplicated here (not imported) so callers can dispatch into this
// module without re-fetching the range; both controller-shortcuts and
// page-mouse-forwarder write through `setChromeTapRegion`.
let chromeY0 = 0;
let chromeY1 = 56;
/** True when the star button is shown. The address-bar slot reclaims the
 * star's x-range when this is false (matches the visible UI). */
let starEnabled = true;

export function setChromeTapRegion(y0: number, y1: number): void {
	chromeY0 = y0;
	chromeY1 = y1;
}
export function setChromeTapStarEnabled(enabled: boolean): void {
	starEnabled = enabled;
}

/** True iff (x, y) lands inside the chrome strip. Used by both touch and
 * engine-mouse to gate input ahead of the live-DOM hit-test. */
export function pointInChromeStrip(_x: number, y: number): boolean {
	return y >= chromeY0 && y < chromeY1;
}

/** Hit-test (x, y) against the chrome strip's button slots and dispatch
 * the matching shell intent. Plays the chrome click sound. Returns true
 * if the point was inside the chrome strip (handled), false otherwise.
 *
 * Activates on press (touchstart for touch, A-rising for engine-mouse)
 * — matches the prior behaviour where back/forward fire immediately
 * when the finger lands, not on release. */
export function dispatchChromeTap(x: number, y: number): boolean {
	if (!pointInChromeStrip(x, y)) return false;
	playClick();
	const backEnd = CHROME_LAYOUT.backX + CHROME_LAYOUT.backWidth;
	const forwardEnd = CHROME_LAYOUT.forwardX + CHROME_LAYOUT.forwardWidth;
	const refreshEnd = CHROME_LAYOUT.refreshX + CHROME_LAYOUT.refreshWidth;
	const homeEnd = CHROME_LAYOUT.homeX + CHROME_LAYOUT.homeWidth;
	const starEnd = CHROME_LAYOUT.starX + CHROME_LAYOUT.starWidth;
	const settingsEnd = CHROME_LAYOUT.settingsX + CHROME_LAYOUT.settingsWidth;
	if (!intentSink) return true;
	if (x >= CHROME_LAYOUT.backX && x < backEnd) {
		intentSink({ kind: 'back' });
	} else if (x >= CHROME_LAYOUT.forwardX && x < forwardEnd) {
		intentSink({ kind: 'forward' });
	} else if (x >= CHROME_LAYOUT.refreshX && x < refreshEnd) {
		intentSink({ kind: 'reload' });
	} else if (x >= CHROME_LAYOUT.homeX && x < homeEnd) {
		intentSink({ kind: 'home' });
	} else if (starEnabled && x >= CHROME_LAYOUT.starX && x < starEnd) {
		intentSink({ kind: 'star' });
	} else if (x >= CHROME_LAYOUT.settingsX && x < settingsEnd) {
		intentSink({ kind: 'settings' });
	} else {
		intentSink({ kind: 'address-bar' });
	}
	return true;
}

// ----- Press dispatch --------------------------------------------------------

function buildBaseEvent(x: number, y: number, buttons: number): Record<string, unknown> {
	return {
		clientX: x, clientY: y,
		pageX: x, pageY: y,
		screenX: x, screenY: y,
		button: 0, buttons,
		preventDefault: () => { /* no-op */ },
		stopPropagation: () => { /* no-op */ },
	};
}

function buildTouchObj(x: number, y: number): Record<string, unknown> {
	return {
		clientX: x, clientY: y,
		pageX: x, pageY: y,
		screenX: x, screenY: y,
		identifier: 0,
	};
}

/** Begin a live-DOM press on `el`. Sets `:active`, dispatches the press
 * event sequence (mousedown + touchstart for touch source; mousedown
 * only for mouse source), and requests a full repaint so the next
 * onTick paints with the pressed style applied. */
export function beginLivePress(
	el: LiveElement,
	x: number, y: number,
	source: PressSource,
): LivePressHandle {
	// A pending clear from a previous press on this element would wipe
	// :active mid-second-press. Cancel it AND release the previous
	// press's chain refcounts (otherwise the new beginLivePress adds a
	// second +1 layer on every ancestor and they stay stuck `:active`
	// after this press releases). performClear is idempotent via
	// handle.cleared so the WeakMap entry is the source of truth.
	const pending = pendingClears.get(el);
	if (pending !== undefined) {
		clearTimeout(pending);
		pendingClears.delete(el);
		const prevHandle = pendingHandles.get(el);
		if (prevHandle) performClear(prevHandle);
	}
	// Apply `:active` to the leaf AND every ancestor so CSS rules like
	// `.app-card:active` match when the user taps a child element
	// (e.g. an `<img>` inside `<a class="app-card">`). Matches the
	// real-browser propagation semantics; the leaf-only convention this
	// file used previously meant ancestor `:active` rules silently
	// failed for any tap that landed on a child. The per-element
	// invalidation gate inside `setPseudoActive` ensures ancestors with
	// no matching `:active` rules don't pay any cascade-rebuild cost.
	const chain: LiveElement[] = [];
	for (let n: LiveElement | null = el; n; n = n.parent) chain.push(n);
	for (const n of chain) setPseudoActive(n, true);
	// setPseudoActive only bumps the live-tree version when the page
	// actually has an :active rule for this element. Pages without such
	// rules wouldn't repaint otherwise; force a repaint here so the
	// dispatched mousedown handler (which might mutate the DOM) is
	// still picked up by the shell's onTick.
	requestFullRepaint();

	const baseDown = buildBaseEvent(x, y, 1);
	if (source === 'touch') {
		const touchObj = buildTouchObj(x, y);
		el.dispatchEvent({ type: 'mousedown', ...baseDown });
		el.dispatchEvent({
			type: 'touchstart',
			touches: [touchObj], changedTouches: [touchObj], targetTouches: [touchObj],
			preventDefault: baseDown.preventDefault,
			stopPropagation: baseDown.stopPropagation,
		});
	} else {
		el.dispatchEvent({ type: 'mousedown', ...baseDown });
	}

	return {
		el,
		pressedSince: performance.now(),
		startX: x,
		startY: y,
		source,
		cleared: false,
		chain,
	};
}

export interface EndPressOpts {
	/** Suppress the click event + intent dispatch (e.g. the press
	 * resolved into a scroll-drag or video swipe). The deferred
	 * `:active` clear still runs so the element doesn't stay stuck. */
	suppressClick?: boolean;
	/** When set, the caller already dispatched `click` on `el` before
	 * calling endLivePress and wants the intent path without a
	 * second click event. Used by the touch handler which has
	 * legacy ordering (touchend dispatch then click) it doesn't
	 * want to change. */
	clickAlreadyDispatched?: boolean;
}

/** End a live-DOM press. Dispatches release events (mouseup + touchend
 * + click), runs the shell intent dispatch (navigate / button-action /
 * summary / video-control / form), and schedules deferred `:active`
 * clear so the user sees the pressed visual for at least
 * `MIN_PRESS_VISIBLE_MS`.
 *
 * Click sounds: played on intent fire AND on form-widget tap, matching
 * the pre-refactor touch behaviour. Engine-mouse no longer plays a
 * separate press-time click sound — release-time matches the touch UX
 * so the two input sources sound identical.
 *
 * Returns the `findTapIntent` result so the caller can apply
 * single-vs-double tap discrimination to `video-frame-tap` and
 * `dbltap-action` — the dispatcher itself only forwards the simple
 * subset (navigate / button-action / summary / video-control) that
 * maps directly to a shell intent. Returns `null` when `suppressClick`
 * was set (no intent fires in that case) or when the hit had no
 * matching ancestor with an intent. */
export type UnhandledTapIntent =
	| { kind: 'video-frame-tap'; video: LiveElement }
	| { kind: 'dbltap-action'; action: string; el: LiveElement };

export function endLivePress(
	handle: LivePressHandle,
	x: number, y: number,
	opts: EndPressOpts = {},
): UnhandledTapIntent | null {
	const el = handle.el;
	const baseUp = buildBaseEvent(x, y, 0);

	// Synchronous DOM release dispatch — page-script handlers run NOW.
	// Deferring these would make the page feel laggy (e.g., a button's
	// own `onmouseup` would fire 120ms late).
	if (handle.source === 'touch') {
		const touchObj = buildTouchObj(x, y);
		el.dispatchEvent({
			type: 'touchend',
			touches: [], changedTouches: [touchObj], targetTouches: [],
			preventDefault: baseUp.preventDefault,
			stopPropagation: baseUp.stopPropagation,
		});
		el.dispatchEvent({ type: 'mouseup', ...baseUp });
	} else {
		el.dispatchEvent({ type: 'mouseup', ...baseUp });
	}

	let unhandled: UnhandledTapIntent | null = null;
	if (opts.suppressClick) {
		// Drag-suppressed release. No click, no intent — just clear the
		// pressed visual after the standard hold.
		scheduleClear(handle);
		return null;
	}

	if (!opts.clickAlreadyDispatched) {
		el.dispatchEvent({ type: 'click', ...baseUp });
	}

	// Resolve the intent + form-widget target synchronously. The
	// audible click + form-widget DOM mutation (handleFormTap)
	// also fire NOW so the user gets the immediate feedback they
	// expect. Only the shell-side `pushInput` is deferred (see
	// below) because pushing an intent makes the shell exit
	// `waitForControllerInput` and process the input — typically
	// a `navigate` that swallows the next ~120 ms of paint frames.
	// Without the defer the press visual is never seen because the
	// shell jumps straight from press-touchstart into navigation
	// without ever rendering :active.
	const resolved = resolveIntentAndFormTap(el, x, y);
	unhandled = resolved.unhandled;

	const elapsed = performance.now() - handle.pressedSince;
	const intentDelay = Math.max(0, MIN_PRESS_VISIBLE_MS - elapsed);

	if (intentDelay <= 0) {
		// Slow tap — the press has already been on screen long enough
		// (the shell's onTick has run several times since touchstart).
		// Clear + dispatch immediately. No hold-window timer to set up.
		performClear(handle);
		runResolvedIntent(resolved);
		return unhandled;
	}

	// Fast tap. Hold :active visible for `intentDelay` ms so the
	// shell's poll loop gets at least one onTick iteration where
	// the press is painted. Order inside the timer: clear :active
	// FIRST so the released visual paints, then fire the intent
	// (the shell will exit the loop after pushInput and stop
	// painting until the new page is ready). For non-pushInput
	// intents (no intentSink kind matched) the clear still fires
	// to release the element.
	const id = setTimeout(() => {
		performClear(handle);
		runResolvedIntent(resolved);
	}, intentDelay);
	pendingClears.set(el, id);
	pendingHandles.set(el, handle);
	return unhandled;
}

/** The intent + form-tap synchronous resolution side of release. Runs
 * findTapIntent, decides which form widget (if any) owns the tap, runs
 * `handleFormTap` immediately (DOM mutation can't be deferred without
 * a perceived UI lag), and plays the audible click. Returns a packaged
 * descriptor that `runResolvedIntent` consumes later — split so the
 * shell-side `pushInput` can be held until the press visual has had a
 * chance to paint. */
interface ResolvedIntent {
	unhandled: UnhandledTapIntent | null;
	shellIntent: LiveTapIntent | null;
}
function resolveIntentAndFormTap(el: LiveElement, x: number, y: number): ResolvedIntent {
	const intent = findTapIntent(el, x, y, 0, 0, 0);
	let widgetTarget: LiveElement | null = null;
	for (let n: LiveElement | null = el; n; n = n.parent) {
		if (isFormWidget(n)) { widgetTarget = n; break; }
	}
	const widgetHasAction = intent?.kind === 'button-action';
	if (widgetTarget && !widgetHasAction) {
		playClick();
		// `true` arg: click was already dispatched on the leaf in
		// endLivePress. handleFormTap takes that as "don't re-fire
		// click on widget" so we don't double-fire button onClick.
		void handleFormTap(widgetTarget, x, widgetTarget === el);
	}
	if (!intent) return { unhandled: null, shellIntent: null };
	if (intent.kind === 'navigate') {
		playClick();
		return { unhandled: null, shellIntent: { kind: 'navigate', url: intent.href } };
	}
	if (intent.kind === 'button-action') {
		playClick();
		return { unhandled: null, shellIntent: { kind: 'button-action', action: intent.action } };
	}
	if (intent.kind === 'summary') {
		playClick();
		return { unhandled: null, shellIntent: { kind: 'summary-toggle', summary: intent.summary } };
	}
	if (intent.kind === 'video-control') {
		playClick();
		const c = intent.control;
		if (c.kind === 'play') return { unhandled: null, shellIntent: { kind: 'video-play', video: intent.video } };
		if (c.kind === 'pause') return { unhandled: null, shellIntent: { kind: 'video-pause', video: intent.video } };
		if (c.kind === 'mute-toggle' || c.kind === 'unmute-toggle')
			return { unhandled: null, shellIntent: { kind: 'video-mute-toggle', video: intent.video } };
		if (c.kind === 'fullscreen-enter')
			return { unhandled: null, shellIntent: { kind: 'video-fullscreen-enter', video: intent.video } };
		if (c.kind === 'seek')
			return { unhandled: null, shellIntent: { kind: 'video-seek', video: intent.video, ratio: c.ratio } };
		return { unhandled: null, shellIntent: null };
	}
	if (intent.kind === 'video-frame-tap') {
		// Single-vs-double tap discrimination is the touch controller's
		// job; surface unchanged so the caller can run its own timer.
		return { unhandled: intent, shellIntent: null };
	}
	if (intent.kind === 'dbltap-action') {
		return { unhandled: intent, shellIntent: null };
	}
	return { unhandled: null, shellIntent: null };
}

/** Fire the resolved shell intent (deferred half of release). Called
 * either immediately (slow tap, press already visible) or from the
 * hold-window setTimeout. Safe to call when `shellIntent` is null —
 * a no-op in that case. */
function runResolvedIntent(resolved: ResolvedIntent): void {
	if (!resolved.shellIntent) return;
	if (!intentSink) return;
	intentSink(resolved.shellIntent);
}

function scheduleClear(handle: LivePressHandle): void {
	if (handle.cleared) return;
	const elapsed = performance.now() - handle.pressedSince;
	const remaining = MIN_PRESS_VISIBLE_MS - elapsed;
	if (remaining <= 0) {
		performClear(handle);
		return;
	}
	const id = setTimeout(() => performClear(handle), remaining);
	pendingClears.set(handle.el, id);
	pendingHandles.set(handle.el, handle);
}

function performClear(handle: LivePressHandle): void {
	if (handle.cleared) return;
	handle.cleared = true;
	pendingClears.delete(handle.el);
	pendingHandles.delete(handle.el);
	// Release `:active` from the leaf AND every ancestor that
	// beginLivePress propagated to. Using the chain captured at press
	// start (not a fresh walk) keeps the released set identical to the
	// set we set, even if the DOM was restructured during the press.
	for (const n of handle.chain) setPseudoActive(n, false);
	// Force a repaint so the cleared pressed-state visual lands on
	// screen even if the page has no other animation tick driving the
	// shell loop.
	requestFullRepaint();
}

/** Force-clear an in-flight press WITHOUT dispatching click/intent.
 * Used by the touch handler when the gesture turns into a scroll-drag
 * mid-press — the press visual should clear (no point holding :active
 * on an element the user isn't activating) and no intent should fire.
 * Distinct from `endLivePress({suppressClick:true})` only in that the
 * mouseup/touchend dispatch is also skipped. */
export function abortLivePress(handle: LivePressHandle): void {
	performClear(handle);
}
