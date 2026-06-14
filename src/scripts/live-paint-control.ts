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
	if (!el) return;
	// 2026-06-14 kb-input lag fix: mutations inside the keyboard's own
	// subtree shouldn't pollute the host page's dirty set. The keyboard
	// tree is a separate live-DOM root with its own offscreen cache; its
	// mutations route through `bumpKbTreeVersion` instead of bumping the
	// host's `liveTreeVersion`. Adding kb elements to `dirtyLiveElements`
	// would either (a) force the host's `patchLiveDirtyRegions` to try
	// to re-layout kb elements against the host's layout cache, or (b)
	// punt to a full host rebuild — both of which we're explicitly
	// avoiding by isolating kb mutations.
	if (kbMutationScopeDepth > 0) return;
	dirtyLiveElements.add(el);
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

/** Sticky flag: set true the first time the page calls a painting
 * method on a 2D canvas context (e.g. fillRect from a setTimeout-driven
 * render loop). The shell's fast-path skip otherwise gates the
 * per-frame canvas re-blit walk on `pageHasAnimationActivity()`, which
 * only fires for `requestAnimationFrame`-using pages — so a pure-2D
 * setTimeout-driven game (demo-breakout) had its canvas frozen at the
 * first paint. Cleared on navigation alongside the rAF flag. */
let pageHasCanvas2dActivityFlag = false;
export function markPageHasCanvas2dActivity(): void { pageHasCanvas2dActivityFlag = true; }
export function hasPageCanvas2dActivity(): boolean { return pageHasCanvas2dActivityFlag; }
export function clearPageHasCanvas2dActivity(): void { pageHasCanvas2dActivityFlag = false; }

export function setKeyboardOpen(v: boolean): void {
	keyboardOpen = !!v;
	if (!v) pendingFullRepaint = true;
}

export function isKeyboardOpen(): boolean { return keyboardOpen; }

// HTML-driven virtual keyboard root: a SECOND live-DOM root parsed
// once at shell startup from the file named by `config.json`'s
// `keyboard` field (a `keyboards/<file>.html` path relative to the
// app root, hoisted out of the per-profile dir 2026-06-11) and
// painted below `KEYBOARD_LAYOUT.topY` while the keyboard is visible.
// Kept separate from the host page's `getLiveRoot()` so the page's
// DOM stays untouched while the keyboard is up.
//
// `keyboardLiveRoot` is the populated root (or `null` if the html file
// failed to parse / wasn't seeded). `keyboardOverlayVisible` gates
// whether the engine paints it on top of the host page each frame.
// Checkpoint 1 drives the flag directly for parse + paint verification;
// checkpoint 2 onward, `KeyboardOverlay.open()` flips it on/off as
// part of the open/close lifecycle.
let keyboardLiveRoot: LiveElement | null = null;
let keyboardOverlayVisible = false;

export function setKeyboardLiveRoot(root: LiveElement | null): void {
	keyboardLiveRoot = root;
}
export function getKeyboardLiveRoot(): LiveElement | null { return keyboardLiveRoot; }

export function setKeyboardOverlayVisible(v: boolean): void {
	keyboardOverlayVisible = !!v;
	if (!v) pendingFullRepaint = true;
}
export function isKeyboardOverlayVisible(): boolean { return keyboardOverlayVisible; }

// Top edge of the keyboard panel in screen-space pixels. Computed at
// boot from `config.json keyboardHeight` (panel height in px) and the
// canvas height: topY = canvasH - keyboardHeight. Read by the engine
// in three places: the kb paint pass viewport, the touch-routing branch
// that decides above-vs-below-panel, and the gamepad A hit-test that
// only fires when the cursor is over the panel area.
//
// Falls back to `KEYBOARD_LAYOUT.topY` (browser-config) for the very
// first repaint before `setKeyboardTopY` lands, so the kb never
// vanishes during boot due to an unset value.
let keyboardTopY: number | null = null;
export function setKeyboardTopY(v: number): void {
	keyboardTopY = Number.isFinite(v) ? v : null;
}
export function getKeyboardTopY(): number {
	// Imported via require-style only at runtime so this module stays
	// import-cycle-free; the default lives in browser-config but we
	// can't import constants from there at module-eval without dragging
	// the whole config graph in.
	return keyboardTopY ?? DEFAULT_KEYBOARD_TOP_Y;
}
/** Match `KEYBOARD_LAYOUT.topY` in browser-config (kept in sync as a
 * loose default — the shell overrides via `setKeyboardTopY` once it
 * loads `config.json keyboardHeight`). */
const DEFAULT_KEYBOARD_TOP_Y = 320;

export function requestFullRepaint(): void {
	pendingFullRepaint = true;
}

// =========================================================================
// 2026-06-14 kb-input lag fix: keyboard mutation scope.
//
// The on-canvas keyboard is a separate live-DOM root with its own offscreen
// cache (`paintKeyboardOverlay`). Without scoping, every keypress causes:
//   - `setPseudoActive(key, true/false)` → bumps `liveTreeVersion`
//   - `setInputValue(urlInput, …)` → bumps `liveTreeVersion`
//   - `capsKey.classList.toggle('held', …)` / shiftKey ditto → bumps
//   - text-node case-rewrite (when shift consumed) → bumps per node
// The shared version counter invalidates BOTH the kb cache AND the host
// page's overlay cache — and since the dirty set contains kb elements
// that have no layout box in the host's cache, the host's
// `patchLiveDirtyRegions` typically punts to a full chunked rebuild on
// every keystroke. On heavy pages (settings.html etc.) that rebuild
// blocks the JS thread long enough that the next touchstart never gets
// polled — the second tap is silently dropped because Switch's HID layer
// only reports the latest snapshot per frame.
//
// Routing kb-internal mutations through a separate `kbTreeVersion`
// counter (and skipping `markLiveDirty` for them) keeps the host cache
// warm across keystrokes; only the kb cache invalidates, and that's a
// small ~80-element rebuild instead of a full host page paint.
//
// `pushKbMutationScope` / `popKbMutationScope` are wrapped around
// (a) the open()/finish() bookends in KeyboardOverlay (so initial
// `setInputValue(urlInput, initial)` + state sync don't dirty the host),
// (b) the `__brewserKeyboardHandleTap` body (every per-tap mutation), and
// (c) the deferred `setPseudoActive(key, false)` flash-clear timer.
let kbMutationScopeDepth = 0;
let kbTreeVersion = 0;

export function pushKbMutationScope(): void { kbMutationScopeDepth++; }
export function popKbMutationScope(): void {
	if (kbMutationScopeDepth > 0) kbMutationScopeDepth--;
}
export function inKbMutationScope(): boolean { return kbMutationScopeDepth > 0; }
export function bumpKbTreeVersion(): void { kbTreeVersion++; }
export function getKbTreeVersion(): number { return kbTreeVersion; }

/** One-shot consumer — returns true once, then resets. The shell
 * checks this each loop iteration before the cache-blit skip logic. */
export function consumeFullRepaintRequest(): boolean {
	if (pendingFullRepaint) { pendingFullRepaint = false; return true; }
	return false;
}
