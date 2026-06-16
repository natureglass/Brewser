import { type LiveElement } from '../scripts/live-dom.js';
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
/** Subset of `ControllerInput` that this dispatcher emits. `pushInput`
 * is owned by controller-shortcuts.ts; we keep the shape structural so
 * we don't pull in its full union (which would cycle: controller →
 * dispatch → controller). */
export type LiveTapIntent = {
    kind: 'navigate';
    url: string;
} | {
    kind: 'button-action';
    action: string;
} | {
    kind: 'summary-toggle';
    summary: LiveElement;
} | {
    kind: 'video-play';
    video: LiveElement;
} | {
    kind: 'video-pause';
    video: LiveElement;
} | {
    kind: 'video-mute-toggle';
    video: LiveElement;
} | {
    kind: 'video-fullscreen-enter';
    video: LiveElement;
} | {
    kind: 'video-seek';
    video: LiveElement;
    ratio: number;
};
export type ChromeIntent = {
    kind: 'back';
} | {
    kind: 'forward';
} | {
    kind: 'reload';
} | {
    kind: 'home';
} | {
    kind: 'star';
} | {
    kind: 'settings';
} | {
    kind: 'avatar';
} | {
    kind: 'address-bar';
};
type IntentSink = (intent: LiveTapIntent | ChromeIntent) => void;
/** Registered once by the shell boot path (controller-shortcuts.ts). */
export declare function setLiveInputIntentSink(fn: IntentSink): void;
export declare function setChromeTapRegion(y0: number, y1: number): void;
export declare function setChromeTapStarEnabled(enabled: boolean): void;
/** True iff (x, y) lands inside the chrome strip. Used by both touch and
 * engine-mouse to gate input ahead of the live-DOM hit-test. */
export declare function pointInChromeStrip(_x: number, y: number): boolean;
/** Hit-test (x, y) against the HTML-driven toolbar live root and
 * dispatch the matching shell intent. Plays the chrome click sound.
 * Returns true if the point was inside the chrome strip (handled),
 * false otherwise.
 *
 * Activates on press (touchstart for touch, A-rising for engine-mouse)
 * — matches the prior engine-drawn behaviour where back/forward fired
 * immediately when the finger lands, not on release.
 *
 * Press visual: the matched action element gets a 120 ms `:active`
 * flash (same shape as the keyboard's `flashKey`). Wrapped in
 * `pushToolbarMutationScope` so the bump routes to
 * `toolbarTreeVersion` and the host page cache stays warm.
 *
 * Fallbacks for robustness:
 *   - Toolbar live root not yet built (boot race) → still treat as
 *     address-bar so taps don't disappear.
 *   - Tap hit-tests into the strip but lands on bare panel area (no
 *     `data-action` ancestor) → address-bar.
 *   - Tap lands on the URL `<input data-action="address-bar">` →
 *     address-bar (no `:active` flash on the input — it's text, not
 *     a button). `starEnabled` still gates the star-button branch:
 *     local `brewser://` pages disable bookmarking and the toolbar
 *     HTML hides `#bookmarkButton` via the same flag so the tap
 *     falls through to the URL bar visually. */
export declare function dispatchChromeTap(x: number, y: number): boolean;
/** Begin a live-DOM press on `el`. Sets `:active`, dispatches the press
 * event sequence (mousedown + touchstart for touch source; mousedown
 * only for mouse source), and requests a full repaint so the next
 * onTick paints with the pressed style applied. */
export declare function beginLivePress(el: LiveElement, x: number, y: number, source: PressSource): LivePressHandle;
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
export type UnhandledTapIntent = {
    kind: 'video-frame-tap';
    video: LiveElement;
} | {
    kind: 'dbltap-action';
    action: string;
    el: LiveElement;
};
export declare function endLivePress(handle: LivePressHandle, x: number, y: number, opts?: EndPressOpts): UnhandledTapIntent | null;
/** Force-clear an in-flight press WITHOUT dispatching click/intent.
 * Used by the touch handler when the gesture turns into a scroll-drag
 * mid-press — the press visual should clear (no point holding :active
 * on an element the user isn't activating) and no intent should fire.
 * Distinct from `endLivePress({suppressClick:true})` only in that the
 * mouseup/touchend dispatch is also skipped. */
export declare function abortLivePress(handle: LivePressHandle): void;
export {};
//# sourceMappingURL=live-input-dispatch.d.ts.map