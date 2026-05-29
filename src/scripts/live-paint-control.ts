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

import type { LiveElement } from './live-dom.js';

let keyboardOpen = false;
let pendingFullRepaint = false;

// Phase 2.6 (2026-05-28): per-element dirty registry for targeted cache
// patching. Every paint-affecting DOM mutation records the element here
// (via `invalidateLiveStyle` + the structural mutation methods). The
// live-overlay's `patchLiveDirtyRegions` drains this after a tap handler
// runs and repaints ONLY the changed elements' regions instead of doing a
// full-page cache rebuild — but only when no layout shift happened. A full
// rebuild clears the set (it repaints everything anyway). Kept here (a
// leaf module) so both live-dom (producer) and live-overlay (consumer) can
// reach it without an import cycle — the LiveElement import is type-only
// and erased at runtime.
const dirtyLiveElements = new Set<LiveElement>();

export function markLiveDirty(el: LiveElement | null | undefined): void {
	if (el) dirtyLiveElements.add(el);
}

/** Return + clear the set of elements mutated since the last drain/clear. */
export function drainLiveDirty(): LiveElement[] {
	const out = Array.from(dirtyLiveElements);
	dirtyLiveElements.clear();
	return out;
}

export function clearLiveDirty(): void {
	dirtyLiveElements.clear();
}

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
