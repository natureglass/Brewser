// M2.4 / M2.5 follow-up: shared paint-gate flags for cross-module
// coordination that doesn't fit either live-overlay (per-frame paint)
// or live-form (async tap handler).
//
//   - `setKeyboardOpen(v)`: live-form sets this when it spawns the
//     on-canvas keyboard via `openKeyboardOpener`. While set, the
//     live-overlay's `paintLiveOverlay` returns early so widgets,
//     status canvases, etc. don't paint on top of the keyboard
//     panel.
//
//   - `requestFullRepaint()`: live-form calls this when the keyboard
//     closes so the next shell-loop iteration repaints the entire
//     page content (the cache-blit fast path normally skips on
//     animated-static frames; without this the keyboard's pixels
//     persist on screen).
//
// The shell wires both: it reads `isKeyboardOpen` before paint walks
// + checks `consumeFullRepaintRequest` to force the cache-blit.

let keyboardOpen = false;
let pendingFullRepaint = false;

export function setKeyboardOpen(v: boolean): void {
	keyboardOpen = !!v;
	if (!v) pendingFullRepaint = true;
}

export function isKeyboardOpen(): boolean { return keyboardOpen; }

export function requestFullRepaint(): void {
	pendingFullRepaint = true;
}

/** One-shot consumer — returns true once, then resets. The shell
 * checks this each loop iteration before the cache-blit skip logic. */
export function consumeFullRepaintRequest(): boolean {
	if (pendingFullRepaint) { pendingFullRepaint = false; return true; }
	return false;
}
