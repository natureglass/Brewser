/**
 * Tier-1 MutationObserver polyfill for the swb live-DOM.
 *
 * Modern JS frameworks (React/Vue/Lit/Svelte hydration), jQuery's
 * modern attachments, and many Construct 3 / Phaser plugins depend
 * on `MutationObserver`. Without it, pages SILENTLY misbehave —
 * animations stall, lifecycle hooks don't fire, lazy-load patterns
 * skip. itch.io compat roadmap A2.
 *
 * Architecture:
 *   - Live-DOM's mutation sites (appendChild / removeChild /
 *     insertBefore / replaceChild / setAttribute / removeAttribute /
 *     `data` setter on text nodes, `nodeValue` setter) call into the
 *     three `notify*` helpers exported below at the end of each
 *     mutation.
 *   - This module keeps a global registry of active observers. Each
 *     notification walks the registry, filters by options + target
 *     identity (or ancestry when `subtree:true`), queues a record
 *     on every matching observer, and schedules a microtask to fire
 *     callbacks in batches.
 *   - `notify*` early-returns when no observers exist — cost when
 *     nothing is watching is one array length check.
 *
 * Tier-1 limits:
 *   - Records report `previousSibling` / `nextSibling` for childList
 *     but only the SINGLE-CHILD case (most real mutations). Bulk
 *     mutations fire one record per child movement, matching spec.
 *   - `attributeNamespace` always null (no XML namespaces in our DOM).
 *   - Callback errors are swallowed + logged (spec says they're
 *     reported per HTML "report exception" — we just keep going).
 */
/** Queue childList records on any observer watching `target` directly
 * or as an ancestor when `subtree:true`. Early-returns when nobody's
 * observing — the live-DOM calls this on every appendChild/removeChild
 * regardless. */
export declare function notifyChildList(target: unknown, addedNodes: unknown[], removedNodes: unknown[], previousSibling?: unknown, nextSibling?: unknown): void;
export declare function notifyAttribute(target: unknown, name: string, oldValue: string | null): void;
export declare function notifyCharacterData(target: unknown, oldValue: string): void;
/** Define `globalThis.MutationObserver`. Call once at app startup
 * BEFORE any page script reads it. */
export declare function installMutationObserver(): void;
//# sourceMappingURL=mutation-observer.d.ts.map