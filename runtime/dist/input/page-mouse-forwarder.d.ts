export declare function setCursorIdleMs(ms: number): void;
declare let chromeMode: 'normal' | 'fullscreen-page' | 'fullscreen-canvas' | 'video-fullscreen';
export declare function setMouseChromeRegion(y0: number, y1: number): void;
export declare function setMouseChromeMode(mode: typeof chromeMode): void;
export declare function installPageMouseForwarder(): void;
/** Snap the cursor to (x, y) and re-engage it. Used by the touch
 * listener so a tap visibly moves the cursor to the touch point, and
 * usable by future modal owners that want to anchor the cursor before
 * showing UI. Clamped to the framebuffer; ignored if coords are NaN. */
export declare function setCursorPos(x: number, y: number): void;
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
export declare function syncMouseButtonsToCurrent(): void;
export declare function tickCursorMovementOnly(): boolean;
export declare function tickMouseInput(): MouseTickResult;
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
export declare function setCursorFromCss(value: string | null | undefined): void;
export declare function syncCursorOverlay(): void;
export declare function getCursorPos(): {
    x: number;
    y: number;
};
export declare function isCursorEngaged(): boolean;
export {};
//# sourceMappingURL=page-mouse-forwarder.d.ts.map