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
/** Call from `buildDocumentShim` for each new page-script context to
 * add `exitPointerLock` + `pointerLockElement` to the per-page document
 * shim. The Tier-1 implementation hard-binds to ONE active shim at a
 * time (matches the single-page-active model of swb). */
export declare function installPointerLockOnDocumentShim(shim: Record<string, unknown>): void;
/**
 * Bootstrap — call once at app startup. Expose `Element` (= LiveElement)
 * as a global with `requestPointerLock` on its prototype. Page scripts'
 * `typeof Element` then resolves to `'function'` and
 * `Element.prototype.requestPointerLock` is callable.
 */
export declare function installPointerLock(LiveElementCtor: {
    prototype: Record<string, unknown>;
}): void;
//# sourceMappingURL=pointer-lock.d.ts.map