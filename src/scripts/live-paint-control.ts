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
	// Same logic for the HTML-driven toolbar root (a separate live tree
	// with its own offscreen cache + version counter). Per-nav address-
	// bar updates + per-tap :active flashes route through
	// `toolbarTreeVersion` so the host page cache stays warm across
	// chrome state pushes. See `pushToolbarMutationScope` below.
	if (toolbarMutationScopeDepth > 0) return;
	// 2026-06-14 modal layer: elements inside a `<browser-modal>` subtree
	// (carrying the `inModalLayer` flag set by `propagateAttached`) skip
	// the host dirty set for the same reason the kb/toolbar do — the
	// modal has its own offscreen cache and own version counter
	// (`modalTreeVersion`). Polluting the host dirty set would force a
	// host-cache rebuild on every modal mutation (and bake screen-coord
	// modal pixels into the body cache, the original logo-ghost bug).
	if (modalMutationScopeDepth > 0) return;
	if (el.inModalLayer) return;
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

// =========================================================================
// 2026-06-14 HTML-driven toolbar (rip-replace of the engine-drawn chrome).
//
// Parallel shape to the on-canvas keyboard above: a SECOND live-DOM root
// parsed once at shell startup from the file named by `config.json`'s
// `toolbar` field (e.g. `themes/toolbars/light.html`), painted into the
// chrome strip slice every frame (top or bottom per `toolbarPosition`).
//
// Why a separate counter from the kb? Different mutation cadences and
// invalidation triggers — the kb mutates per-keypress while open, the
// toolbar mutates per-navigation (URL change, back/forward enable, star
// toggle) and per-tap (:active flash on chrome buttons). Keeping the
// counters separate means the kb cache doesn't invalidate when the
// address bar updates, and vice versa.
//
// `toolbarLiveRoot` is the populated root (or `null` if the toolbar HTML
// failed to parse / wasn't seeded). `toolbarOverlayVisible` is a kill
// switch the shell uses to suppress paint in fullscreen modes (where
// the chrome strip isn't drawn).
// =========================================================================
let toolbarLiveRoot: LiveElement | null = null;
let toolbarOverlayVisible = false;

export function setToolbarLiveRoot(root: LiveElement | null): void {
	toolbarLiveRoot = root;
}
export function getToolbarLiveRoot(): LiveElement | null { return toolbarLiveRoot; }

export function setToolbarOverlayVisible(v: boolean): void {
	toolbarOverlayVisible = !!v;
	if (!v) pendingFullRepaint = true;
}
export function isToolbarOverlayVisible(): boolean { return toolbarOverlayVisible; }

// Mutation scope: same shape as `pushKbMutationScope` above. Wrap any
// state-push that touches the toolbar tree (address-bar value sync,
// back/forward disabled toggle, star icon swap, :active flash on a
// chrome button) in push/pop so the bumps route to `toolbarTreeVersion`
// instead of the shared `liveTreeVersion`. Without scoping, a
// renderChrome call on every navigation invalidates the host page
// cache (forcing a full chunked rebuild of the page that just
// finished loading), and a chrome-button :active flash invalidates
// the page cache on every chrome tap.
let toolbarMutationScopeDepth = 0;
let toolbarTreeVersion = 0;

export function pushToolbarMutationScope(): void { toolbarMutationScopeDepth++; }
export function popToolbarMutationScope(): void {
	if (toolbarMutationScopeDepth > 0) toolbarMutationScopeDepth--;
}
export function inToolbarMutationScope(): boolean { return toolbarMutationScopeDepth > 0; }
export function bumpToolbarTreeVersion(): void { toolbarTreeVersion++; }
export function getToolbarTreeVersion(): number { return toolbarTreeVersion; }

// =========================================================================
// 2026-06-14 modal layer — engine-blessed `<browser-modal>` quarantine.
//
// Parallel shape to the kb + toolbar above: each modal root has its own
// offscreen cache + version counter so per-modal mutations (title text,
// logo src, body innerHTML, --open class flip) don't dirty the host page's
// `liveTreeVersion` or `dirtyLiveElements`. The host's `liveCacheOffscreen`
// stays warm across opens/closes — no full chunked rebuild fires when a
// modal opens, no logo-ghost leak when an async image load races a close.
//
// Modal roots live IN the host body subtree (so page-side
// `document.getElementById('app-modal-overlay')` still resolves), but
// `paintModalOverlay` paints them from their own caches and `collectPaintOps`
// / the fixed-element pass both skip the subtree (a `data-engine-modal="true"`
// attribute is the engine hint, stamped by the resource loader's
// `<browser-modal>` expansion).
//
// Auto-routing: when a LiveElement attached anywhere inside a modal subtree
// is mutated, `markLiveDirty` skips it and `bumpLiveTreeVersion` reroutes to
// `bumpModalTreeVersion` — same shape as the kb/toolbar scopes but driven
// by per-element `inModalLayer` flag (set on attach) rather than an explicit
// push/pop around mutations, since page-side scripts don't (and shouldn't)
// know about engine scopes.
//
// The explicit `pushModalMutationScope` exists for engine-side internal
// mutations on modal elements (none today, but kept for symmetry — same
// reason the kb has it).
// =========================================================================
let modalMutationScopeDepth = 0;
let modalTreeVersion = 0;
const modalRoots = new Set<LiveElement>();

export function pushModalMutationScope(): void { modalMutationScopeDepth++; }
export function popModalMutationScope(): void {
	if (modalMutationScopeDepth > 0) modalMutationScopeDepth--;
}
export function inModalMutationScope(): boolean { return modalMutationScopeDepth > 0; }
export function bumpModalTreeVersion(): void { modalTreeVersion++; }
export function getModalTreeVersion(): number { return modalTreeVersion; }

/** Register a `<div data-engine-modal="true">` LiveElement as a modal
 * root. Called by `propagateAttached` in live-dom.ts the first time the
 * element + the attribute land in the live tree. The paint pass walks
 * this registry each frame instead of re-scanning the host tree. */
export function registerModalRoot(el: LiveElement): void {
	modalRoots.add(el);
	// A modal newly attached (or freshly hot-swapped via innerHTML) needs
	// at least one paint to pick up its visibility. Bump the version so
	// the cache invalidates + repaint kicks in. Cheap.
	modalTreeVersion++;
	pendingFullRepaint = true;
}
export function unregisterModalRoot(el: LiveElement): void {
	if (modalRoots.delete(el)) {
		// Removed from the live tree → painted output should disappear.
		// Bump version so the modal paint pass skips it on the next paint
		// (the cache for this root is GC'd via the WeakMap in live-overlay).
		modalTreeVersion++;
		pendingFullRepaint = true;
	}
	// Also drop modal-mode tracking if the dialog was detached while
	// open (e.g. innerHTML hot-swap or navigation). Without this the
	// stale entry would keep the backdrop + scroll/tap block active
	// for an element that's no longer painted.
	modalModeDialogs.delete(el);
}
export function getModalRoots(): readonly LiveElement[] {
	// Snapshot — callers iterate without holding a Set reference.
	return Array.from(modalRoots);
}
/** Cheap "does any modal exist at all?" gate for the paint-pass fast-path
 * skip when the page has no modals. */
export function hasAnyModalRoot(): boolean { return modalRoots.size > 0; }

// =========================================================================
// 2026-06-15 modal-mode tracking — `<dialog>.showModal()` vs `<dialog>.show()`.
//
// Spec semantics: `showModal()` puts the dialog in the "top layer" and makes
// the rest of the page inert (no user interaction outside the modal),
// renders a `::backdrop` pseudo, and traps focus. `show()` is non-modal —
// the dialog renders but the page stays interactive. Engine-side we mirror
// just the user-visible parts: showModal-tagged dialogs get a backdrop
// painted underneath, block scroll on the host, and intercept hit-test so
// taps outside the modal are dropped. show()-tagged dialogs do none of
// those things (modal renders, page stays interactive — same shape as
// `<browser-modal>` without `.--open` would behave, but visible).
//
// The flag is per-element (a separate Set rather than a field on
// LiveElement) so it doesn't pollute every LiveElement instance with a
// rarely-used field. Cleared automatically on detach via
// `unregisterModalRoot` and on close via `LiveElement.close()`.
// =========================================================================
const modalModeDialogs = new Set<LiveElement>();
export function markDialogModalMode(el: LiveElement): void { modalModeDialogs.add(el); }
export function unmarkDialogModalMode(el: LiveElement): void { modalModeDialogs.delete(el); }
export function isDialogModalMode(el: LiveElement): boolean { return modalModeDialogs.has(el); }
/** Iterates currently-attached modal-mode dialogs. Callers should filter
 * by `cs.display !== 'none'` to skip those that were closed via attribute
 * manipulation (rare — `LiveElement.close()` unmarks, but page scripts
 * that `removeAttribute('open')` directly leave the flag stale). */
export function getModalModeDialogs(): readonly LiveElement[] {
	return Array.from(modalModeDialogs);
}

/** Find the topmost OPEN modal-mode dialog (the one the user sees on
 * top) and close it via `LiveElement.close()`. Returns true iff a
 * dialog was found and closed. Used by the shell to intercept B-button
 * / Escape / exit so the user can dismiss a modal without it
 * bypassing the page's own close handlers. Last-inserted Set member
 * wins — matches the visual "most recently opened is on top" stack
 * order (the spec's top-layer ordering, approximated). */
export function closeTopmostModalModeDialog(): boolean {
	if (modalModeDialogs.size === 0) return false;
	// Iterate in REVERSE insertion order to find the topmost open one.
	const arr = Array.from(modalModeDialogs);
	for (let i = arr.length - 1; i >= 0; i--) {
		const d = arr[i];
		if (d.getAttribute('open') === null) continue;
		// LiveElement has a typed `close(returnValue?)` — call it via
		// a structural cast so this control module doesn't depend on
		// the full LiveElement shape (`live-dom.ts` already imports
		// from us, importing it back would loop).
		const closer = d as unknown as { close?: () => void };
		if (typeof closer.close === 'function') {
			closer.close();
			return true;
		}
	}
	return false;
}
