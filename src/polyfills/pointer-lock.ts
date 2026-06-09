/**
 * Tier-1 Pointer Lock API polyfill for brewser.
 *
 * The Switch has no mouse cursor in handheld mode, so this is a
 * **compatibility stub** — games that call `requestPointerLock()` keep
 * running instead of crashing. The synthetic lock state is tracked +
 * the standard `pointerlockchange` event fires.
 *
 * Page scripts run in a sandboxed context: they see the per-page
 * documentShim (built in canvas-runner.ts buildDocumentShim), not the
 * shell-side `globalThis.document`. So Pointer Lock has TWO install
 * surfaces:
 *
 * 1. **`globalThis.Element`** = `LiveElement` class + `requestPointerLock`
 *    on its prototype, so `typeof Element !== 'undefined'` is true and
 *    `Element.prototype.requestPointerLock` works from page scripts.
 *
 * 2. **The documentShim** gets `exitPointerLock` + `pointerLockElement`
 *    properties via `installPointerLockOnDocumentShim` (called from
 *    `buildDocumentShim` each time a page boots).
 *
 * What's NOT done in Tier-1:
 * - No actual cursor confinement (no cursor exists)
 * - No right-stick → mousemove deltas synthesis (deferred until a
 *   target game actually needs it)
 * - No B-button-release escape from lock (trivial when stick mapping lands)
 */

// Track which element (if any) "owns" the synthetic lock. Real browsers
// track this per-document; we have one document per page session so a
// single module-level var suffices.
let lockedElement: unknown = null;

// Each page's documentShim registers its own "fire pointerlockchange"
// callback here so requestPointerLock (which lives on the Element
// prototype, not on a per-shim instance) can dispatch into the right
// document.
let activeShimDispatcher: ((ev: { type: string; target: unknown }) => void) | null = null;
let activeShim: unknown = null;

function dispatchPointerLockChange(): void {
	if (!activeShimDispatcher || !activeShim) return;
	try { activeShimDispatcher({ type: 'pointerlockchange', target: activeShim }); }
	catch { /* ignore */ }
}

function scheduleDispatch(): void {
	if (typeof queueMicrotask === 'function') queueMicrotask(dispatchPointerLockChange);
	else Promise.resolve().then(dispatchPointerLockChange);
}

/** Install `requestPointerLock` on a class prototype (typically
 * `LiveElement.prototype`). Idempotent. */
function installRequestPointerLockOn(proto: Record<string, unknown>): void {
	if (typeof proto.requestPointerLock === 'function') return;
	Object.defineProperty(proto, 'requestPointerLock', {
		value: function (this: unknown): Promise<void> {
			lockedElement = this;
			scheduleDispatch();
			return Promise.resolve();
		},
		writable: true,
		configurable: true,
	});
}

/** Call from `buildDocumentShim` for each new page-script context to
 * add `exitPointerLock` + `pointerLockElement` to the per-page document
 * shim. The Tier-1 implementation hard-binds to ONE active shim at a
 * time (matches the single-page-active model of swb). */
export function installPointerLockOnDocumentShim(shim: Record<string, unknown>): void {
	if (typeof shim.exitPointerLock !== 'function') {
		Object.defineProperty(shim, 'exitPointerLock', {
			value: function (): void {
				if (lockedElement === null) return;
				lockedElement = null;
				scheduleDispatch();
			},
			writable: true,
			configurable: true,
		});
	}
	if (!('pointerLockElement' in shim)) {
		Object.defineProperty(shim, 'pointerLockElement', {
			get(): unknown { return lockedElement; },
			configurable: true,
		});
	}
	// Capture the shim's dispatchEvent so requestPointerLock (which is
	// on Element.prototype, not the shim) can fire pointerlockchange
	// into the right document.
	const disp = shim.dispatchEvent;
	if (typeof disp === 'function') {
		activeShim = shim;
		activeShimDispatcher = (ev) => (disp as (ev: unknown) => void).call(shim, ev);
	}
}

let installed = false;

/**
 * Bootstrap — call once at app startup. Expose `Element` (= LiveElement)
 * as a global with `requestPointerLock` on its prototype. Page scripts'
 * `typeof Element` then resolves to `'function'` and
 * `Element.prototype.requestPointerLock` is callable.
 */
export function installPointerLock(LiveElementCtor: { prototype: Record<string, unknown> }): void {
	if (installed) return;
	installed = true;
	installRequestPointerLockOn(LiveElementCtor.prototype);
	Object.defineProperty(globalThis, 'Element', {
		value: LiveElementCtor,
		writable: true,
		configurable: true,
	});
}
