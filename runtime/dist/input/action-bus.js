// Action event bus — the freestanding singleton the input cluster uses
// to fan out button-action events to runtime *and* shell subscribers.
//
// Design (Phase 3):
//   - `RuntimeButtonAction` is the closed set of actions the runtime
//     itself knows how to handle (mouse, scroll, page-level submit /
//     dismiss / back / forward).
//   - The bus accepts any string for `name`, so the shell can extend it
//     with chrome actions (`bookmark`, `settings`, …) and the routing
//     stays string-keyed.
//   - Whether the runtime or the shell handles an action is a function
//     of WHO registered a handler — there is no central allow-list. The
//     button-router fires `emitAction(name, ctx)` once per rising edge;
//     each registered handler runs in registration order.
//
// Scope note: the action bus is a freestanding singleton today. Phase 5
// (WebPageSession extraction) may scope per-session if multi-page
// concurrent sessions ever land; the API surface here is small enough
// that promoting it to a per-instance bus is straightforward.
const subscribers = new Map();
/**
 * Register a handler for the named action. Returns an unsubscribe
 * function so callers don't have to thread the same handler reference
 * around to remove it later.
 */
export function subscribeAction(name, handler) {
    let set = subscribers.get(name);
    if (!set) {
        set = new Set();
        subscribers.set(name, set);
    }
    set.add(handler);
    return () => {
        const s = subscribers.get(name);
        if (s) {
            s.delete(handler);
            if (s.size === 0)
                subscribers.delete(name);
        }
    };
}
/**
 * Fire all handlers registered for the action. Handlers run in
 * registration order. Exceptions inside a handler are logged but
 * don't stop the rest of the chain — one bad subscriber shouldn't
 * swallow the event for the rest.
 */
export function emitAction(name, ctx = {}) {
    const set = subscribers.get(name);
    if (!set || set.size === 0)
        return;
    for (const handler of set) {
        try {
            handler(name, ctx);
        }
        catch (err) {
            console.debug('[action-bus] handler for "' + name + '" threw:', err);
        }
    }
}
/** Has anyone registered a handler for this action? Useful for
 * short-circuiting expensive emit paths when nothing is listening. */
export function hasActionHandler(name) {
    const set = subscribers.get(name);
    return !!(set && set.size > 0);
}
/** Test-only / shutdown helper. Drops every subscriber. */
export function clearActionHandlers() {
    subscribers.clear();
}
//# sourceMappingURL=action-bus.js.map