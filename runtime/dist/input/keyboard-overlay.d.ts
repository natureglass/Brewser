/** Callbacks the shell passes to `KeyboardOverlay.open()` so the page
 * behind the keyboard can be scrolled while it's up, and (for
 * `<input type=number>` etc.) so the keyboard can gate Submit behind
 * a validator. Same shape as the old canvas-keyboard's callbacks — the
 * three URL-bar / search / live-form call sites pass through unchanged. */
export interface KeyboardScrollCallbacks {
    onScroll?: (delta: number) => void;
    validate?: (value: string) => boolean;
}
export declare function setKeyboardRepaintDriver(cb: (() => void) | null): void;
/**
 * HTML-driven virtual keyboard. Replaces the on-canvas keyboard that
 * lived in this file pre-2026-06-11. The keyboard's visible markup
 * lives in the file named by `config.json`'s `keyboard` field
 * (`keyboards/<file>.html` relative to the app root) and is parsed into a
 * SECOND live-DOM root at shell startup (see
 * `BrowserShell.loadHtmlKeyboard` / `paintKeyboardOverlay`).
 *
 * Open/close lifecycle:
 *   - `open()` flips `setKeyboardOpen(true)` (input-dispatch gate) +
 *     `setKeyboardOverlayVisible(true)` (paint gate), seeds the
 *     `<input>` with `initial`, registers the global submit/cancel/tap
 *     hooks, and starts an internal repaint tick.
 *   - Touch lands inside the kb panel area → controller-shortcuts
 *     calls `globalThis.__brewserKeyboardHandleTap(el)`. The handler
 *     processes the key (insert / backspace / nav / shift / caps /
 *     submit / etc.) and updates the visible `<input>` text via
 *     `setInputValue`.
 *   - Submit (tap `#submitBtn`, or external `__brewserKeyboardSubmit`)
 *     resolves with the typed value. Cancel (tap above panel, or
 *     external `__brewserKeyboardCancel`) resolves with `null`.
 */
export declare class KeyboardOverlay {
    open(initial?: string, callbacks?: KeyboardScrollCallbacks): Promise<string | null>;
}
//# sourceMappingURL=keyboard-overlay.d.ts.map