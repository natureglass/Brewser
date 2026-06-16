import type { LiveElement } from './live-dom.js';
export declare function markLiveDirty(el: LiveElement | null | undefined): void;
/** Return + clear the set of elements mutated since the last drain/clear. */
export declare function drainLiveDirty(): LiveElement[];
export declare function clearLiveDirty(): void;
export declare function markPageHasCanvas2dActivity(): void;
export declare function hasPageCanvas2dActivity(): boolean;
export declare function clearPageHasCanvas2dActivity(): void;
export declare function setKeyboardOpen(v: boolean): void;
export declare function isKeyboardOpen(): boolean;
export declare function setKeyboardLiveRoot(root: LiveElement | null): void;
export declare function getKeyboardLiveRoot(): LiveElement | null;
export declare function setKeyboardOverlayVisible(v: boolean): void;
export declare function isKeyboardOverlayVisible(): boolean;
export declare function setKeyboardTopY(v: number): void;
export declare function getKeyboardTopY(): number;
export declare function requestFullRepaint(): void;
export declare function pushKbMutationScope(): void;
export declare function popKbMutationScope(): void;
export declare function inKbMutationScope(): boolean;
export declare function bumpKbTreeVersion(): void;
export declare function getKbTreeVersion(): number;
/** One-shot consumer — returns true once, then resets. The shell
 * checks this each loop iteration before the cache-blit skip logic. */
export declare function consumeFullRepaintRequest(): boolean;
export declare function setToolbarLiveRoot(root: LiveElement | null): void;
export declare function getToolbarLiveRoot(): LiveElement | null;
export declare function setToolbarOverlayVisible(v: boolean): void;
export declare function isToolbarOverlayVisible(): boolean;
export declare function pushToolbarMutationScope(): void;
export declare function popToolbarMutationScope(): void;
export declare function inToolbarMutationScope(): boolean;
export declare function bumpToolbarTreeVersion(): void;
export declare function getToolbarTreeVersion(): number;
export declare function pushModalMutationScope(): void;
export declare function popModalMutationScope(): void;
export declare function inModalMutationScope(): boolean;
export declare function bumpModalTreeVersion(): void;
export declare function getModalTreeVersion(): number;
/** Register a `<div data-engine-modal="true">` LiveElement as a modal
 * root. Called by `propagateAttached` in live-dom.ts the first time the
 * element + the attribute land in the live tree. The paint pass walks
 * this registry each frame instead of re-scanning the host tree. */
export declare function registerModalRoot(el: LiveElement): void;
export declare function unregisterModalRoot(el: LiveElement): void;
export declare function getModalRoots(): readonly LiveElement[];
/** Cheap "does any modal exist at all?" gate for the paint-pass fast-path
 * skip when the page has no modals. */
export declare function hasAnyModalRoot(): boolean;
/** Drop every registered modal root + dialog-modal-mode entry. Called by
 * `resetLiveRoot` on navigation so modal LiveElements from the previous
 * page don't keep painting on top of the new page's load frame. Without
 * this, `paintModalOverlay` walks the Set on every frame and renders the
 * old page's now-detached modal subtrees over the new page's content
 * (see prior-page Permission / Missing-App / Updates leak-through). */
export declare function clearModalRoots(): void;
export declare function markDialogModalMode(el: LiveElement): void;
export declare function unmarkDialogModalMode(el: LiveElement): void;
export declare function isDialogModalMode(el: LiveElement): boolean;
/** Iterates currently-attached modal-mode dialogs. Callers should filter
 * by `cs.display !== 'none'` to skip those that were closed via attribute
 * manipulation (rare — `LiveElement.close()` unmarks, but page scripts
 * that `removeAttribute('open')` directly leave the flag stale). */
export declare function getModalModeDialogs(): readonly LiveElement[];
/** Find the topmost OPEN modal-mode dialog (the one the user sees on
 * top) and close it via `LiveElement.close()`. Returns true iff a
 * dialog was found and closed. Used by the shell to intercept B-button
 * / Escape / exit so the user can dismiss a modal without it
 * bypassing the page's own close handlers. Last-inserted Set member
 * wins — matches the visual "most recently opened is on top" stack
 * order (the spec's top-layer ordering, approximated). */
export declare function closeTopmostModalModeDialog(): boolean;
//# sourceMappingURL=live-paint-control.d.ts.map