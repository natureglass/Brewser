import { type LiveElement, type LiveViewport } from '../scripts/live-dom.js';
import { type MouseTickResult } from './page-mouse-forwarder.js';
export type ControllerInput = {
    kind: 'exit';
} | {
    kind: 'address-bar';
} | {
    kind: 'back';
} | {
    kind: 'forward';
} | {
    kind: 'home';
} | {
    kind: 'settings';
}
/** Tap on the toolbar avatar slot — opens the login dashboard
 * (brewser://login/) where the user can sign into a service or see
 * the current active session. The slot's image is updated each
 * `renderChrome` so the engine paints whichever provider's avatar
 * matches the current `auth/active.json`. */
 | {
    kind: 'avatar';
} | {
    kind: 'star';
} | {
    kind: 'reload';
}
/** Rising edge of the Minus button on its own (not part of the
 * L+R+Minus exit combo). The shell captures the current screen and
 * writes it as a PNG to `<profile>/screenshots/`. */
 | {
    kind: 'screenshot';
} | {
    kind: 'navigate';
    url: string;
}
/** Tap on an HTML `<button data-action="...">` rendered by the page.
 * The shell interprets the action string (e.g. `fullscreen-page`,
 * `fullscreen-canvas`); unknown actions are ignored. */
 | {
    kind: 'button-action';
    action: string;
}
/** Tap on a `<summary>` in the live-DOM tree. The shell toggles
 * `summary.parent.toggleAttribute('open')` and bumps the live tree
 * version so the cache rebuilds. */
 | {
    kind: 'summary-toggle';
    summary: LiveElement;
}
/** Tap on a `<video>` element in the live-DOM tree. The shell
 * enters video-fullscreen mode focused on this element; B button
 * (or L+R) exits back to normal mode. */
 | {
    kind: 'video-fullscreen-enter';
    video: LiveElement;
}
/** Tap on one of the inline controls-bar buttons on a `<video>`
 * element (no autoplay, 2026-05-27): play opens the decoder if
 * needed and starts playback; pause halts; stop seeks to 0 and
 * pauses. */
 | {
    kind: 'video-play';
    video: LiveElement;
} | {
    kind: 'video-pause';
    video: LiveElement;
} | {
    kind: 'video-stop';
    video: LiveElement;
}
/** Tap on the mute icon — toggles `decoder.muted` on the audio
 * voice. Distinct from the legacy `video-stop` so the shell can
 * skip a repaint when it knows mute doesn't change visible state. */
 | {
    kind: 'video-mute-toggle';
    video: LiveElement;
}
/** Tap on the progress strip — seeks to `ratio * duration`. */
 | {
    kind: 'video-seek';
    video: LiveElement;
    ratio: number;
}
/** Rising edge of L+R held *without* Minus. The shell interprets
 * this as "exit any fullscreen mode" and ignores it otherwise. */
 | {
    kind: 'lr-combo';
};
/** Browser-shell display mode. Owned by the shell; controller-shortcuts
 * mirrors it via {@link setBrowserMode} so the touch listener can suppress
 * chrome-strip dispatch when chrome isn't drawn. */
export type BrowserMode = 'normal' | 'fullscreen-page' | 'fullscreen-canvas' | 'video-fullscreen';
export declare function setBrowserMode(mode: BrowserMode): void;
export declare function getBrowserMode(): BrowserMode;
export declare function setFullscreenVideo(el: LiveElement | null): void;
export declare function setChromeRegion(y0: number, y1: number): void;
export declare function setStarEnabled(enabled: boolean): void;
/** Discard any queued input — kept for explicit reset cases (no longer called by `waitForControllerInput`). */
export declare function clearPendingInput(): void;
/** Non-consuming read of any input the touch listener has queued. */
export declare function peekPendingInput(): ControllerInput | null;
export declare function setNavigating(v: boolean): void;
export declare function setLiveViewport(v: LiveViewport, scrollY?: number): void;
export declare function setTouchScrollHandler(fn: ((delta: number) => void) | null): void;
export declare function installCanvasTouch(): void;
/** Gate the controller-shortcuts touch diag log. Flipped on by
 * `browser-shell.start()` from `config.json` -> `navDebug`. */
export declare function setTouchDebugEnabled(enabled: boolean): void;
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
     *
     * `info.mouseTick` carries the result of the per-iteration software-
     * cursor poll (see `page-mouse-forwarder.tickMouseInput`). The shell
     * uses `cursorChanged` to schedule a repaint when the cursor moved
     * or a button edge fired on an idle page.
     */
    onTick?: (info: {
        scrolledThisTick: boolean;
        mouseTick: MouseTickResult;
    }) => boolean;
}
export declare function waitForControllerInput(options?: ControllerInputOptions): Promise<ControllerInput>;
//# sourceMappingURL=controller-shortcuts.d.ts.map