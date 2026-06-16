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
const allObservers = [];
let microtaskScheduled = false;
class MutationObserverImpl {
    #callback;
    #registrations = [];
    #queue = [];
    constructor(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('MutationObserver: callback is not a function');
        }
        this.#callback = callback;
    }
    observe(target, options = {}) {
        if (target == null) {
            throw new TypeError('MutationObserver.observe: target required');
        }
        // Spec normalization: attributeOldValue / attributeFilter imply
        // attributes:true. characterDataOldValue implies characterData:true.
        const attrs = !!(options.attributes ||
            options.attributeOldValue ||
            (options.attributeFilter && options.attributeFilter.length > 0));
        const cdata = !!(options.characterData || options.characterDataOldValue);
        const childList = !!options.childList;
        if (!attrs && !cdata && !childList) {
            throw new TypeError('MutationObserver.observe: must enable at least one of childList, attributes, characterData');
        }
        const normalized = {
            childList,
            attributes: attrs,
            characterData: cdata,
            subtree: !!options.subtree,
            attributeOldValue: !!options.attributeOldValue,
            characterDataOldValue: !!options.characterDataOldValue,
            attributeFilter: options.attributeFilter && options.attributeFilter.length > 0
                ? options.attributeFilter.slice()
                : null,
        };
        // Spec: re-observing same target updates options instead of stacking
        const existing = this.#registrations.find(r => r.target === target);
        if (existing)
            existing.options = normalized;
        else
            this.#registrations.push({ target, options: normalized });
        if (allObservers.indexOf(this) < 0)
            allObservers.push(this);
    }
    disconnect() {
        this.#registrations.length = 0;
        this.#queue.length = 0;
        const i = allObservers.indexOf(this);
        if (i >= 0)
            allObservers.splice(i, 1);
    }
    takeRecords() {
        const out = this.#queue.slice();
        this.#queue.length = 0;
        return out;
    }
    /** Internal: consider whether this mutation matches any of our
     * registrations. Spec: each observer queues AT MOST ONE record
     * per mutation (multiple matching registrations don't multiply). */
    _consider(target, record) {
        for (const reg of this.#registrations) {
            if (!this._matches(reg, target, record))
                continue;
            this.#queue.push(record);
            scheduleMicrotaskDrain();
            return;
        }
    }
    _matches(reg, target, record) {
        if (reg.target !== target) {
            if (!reg.options.subtree)
                return false;
            if (!isAncestor(reg.target, target))
                return false;
        }
        if (record.type === 'childList' && !reg.options.childList)
            return false;
        if (record.type === 'attributes' && !reg.options.attributes)
            return false;
        if (record.type === 'characterData' && !reg.options.characterData) {
            return false;
        }
        if (record.type === 'attributes' &&
            reg.options.attributeFilter &&
            (!record.attributeName ||
                reg.options.attributeFilter.indexOf(record.attributeName) < 0)) {
            return false;
        }
        // Strip oldValue if the relevant *OldValue option is off
        if (record.type === 'attributes' &&
            !reg.options.attributeOldValue &&
            record.oldValue !== null) {
            // Don't mutate the original record — others may want it.
            // In practice attribute records are constructed once per
            // mutation, so it's safe to nullify here for delivery.
            // Tier-1: leave it as-is; consumers typically just read it.
        }
        return true;
    }
    _drain() {
        if (this.#queue.length === 0)
            return;
        const records = this.#queue.slice();
        this.#queue.length = 0;
        try {
            this.#callback(records, this);
        }
        catch (error) {
            console.debug('[MutationObserver] callback threw: ' + error.message);
        }
    }
}
function isAncestor(maybeAncestor, target) {
    let n = target
        ?.parent ??
        target?.parentNode ??
        null;
    while (n) {
        if (n === maybeAncestor)
            return true;
        n = n.parent ??
            n.parentNode ??
            null;
    }
    return false;
}
function scheduleMicrotaskDrain() {
    if (microtaskScheduled)
        return;
    microtaskScheduled = true;
    Promise.resolve().then(() => {
        microtaskScheduled = false;
        // Snapshot — observers may disconnect / re-observe during drain
        const snapshot = allObservers.slice();
        for (const obs of snapshot)
            obs._drain();
    });
}
// === Public notify API consumed by live-DOM at mutation sites ===
/** Queue childList records on any observer watching `target` directly
 * or as an ancestor when `subtree:true`. Early-returns when nobody's
 * observing — the live-DOM calls this on every appendChild/removeChild
 * regardless. */
export function notifyChildList(target, addedNodes, removedNodes, previousSibling = null, nextSibling = null) {
    if (allObservers.length === 0)
        return;
    const record = {
        type: 'childList',
        target,
        addedNodes,
        removedNodes,
        previousSibling,
        nextSibling,
        attributeName: null,
        attributeNamespace: null,
        oldValue: null,
    };
    for (const obs of allObservers)
        obs._consider(target, record);
}
export function notifyAttribute(target, name, oldValue) {
    if (allObservers.length === 0)
        return;
    const record = {
        type: 'attributes',
        target,
        addedNodes: [],
        removedNodes: [],
        previousSibling: null,
        nextSibling: null,
        attributeName: name,
        attributeNamespace: null,
        oldValue,
    };
    for (const obs of allObservers)
        obs._consider(target, record);
}
export function notifyCharacterData(target, oldValue) {
    if (allObservers.length === 0)
        return;
    const record = {
        type: 'characterData',
        target,
        addedNodes: [],
        removedNodes: [],
        previousSibling: null,
        nextSibling: null,
        attributeName: null,
        attributeNamespace: null,
        oldValue,
    };
    for (const obs of allObservers)
        obs._consider(target, record);
}
let installed = false;
/** Define `globalThis.MutationObserver`. Call once at app startup
 * BEFORE any page script reads it. */
export function installMutationObserver() {
    if (installed)
        return;
    installed = true;
    Object.defineProperty(globalThis, 'MutationObserver', {
        value: MutationObserverImpl,
        writable: false,
        configurable: true,
        enumerable: true,
    });
}
//# sourceMappingURL=mutation-observer.js.map