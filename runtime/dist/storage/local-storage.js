/**
 * Tier-1 Web Storage API (`localStorage`) for brewser.
 *
 * The nx.js runtime ships its own `localStorage` lazy getter at
 * `globalThis.localStorage`, but it (a) returns `undefined` when the
 * app's NACP `userAccountSaveDataSize` is 0 (swb's is), and (b) ties
 * persistence to Switch per-user save data — wrong granularity for a
 * web browser that needs per-page-origin storage.
 *
 * This module redefines `globalThis.localStorage` BEFORE any page
 * script runs, backed by a single JSON file under
 * `<profile.storageRoot>localStorage/default.json` for the `default`
 * namespace, `<profile.storageRoot><ns>/localStorage/default.json`
 * for any other namespace (e.g. `dev`). The active namespace is picked
 * by `profile.pickStorageNamespace(currentUrl)` on every access — the
 * shell typically routes `brewser://dev/...` to the `dev` namespace
 * to keep test artifacts out of real user storage, but the runtime
 * stays agnostic. Reloads on namespace change so reads always see the
 * file for the active page's namespace.
 *
 * Tier-1 limitation: ALL pages share one namespace per profile. itch.io
 * games can collide with each other's save data. Tier-2 work would
 * partition by page origin (extract from current URL on each access)
 * and write to `localStorage/<origin-slug>.json`. Adequate for verifying
 * the api-probe + unblocking simple game persistence today.
 */
import { DEFAULT_STORAGE_PROFILE, } from '../profile/storage-profile.js';
/** Active profile — supplies the on-disk root + namespace picker. The
 * default profile resolves everything to a single 'default' namespace
 * under `DEFAULT_PROFILE_ROOT` so embedding consumers without a shell
 * still get working storage. */
let activeProfile = DEFAULT_STORAGE_PROFILE;
/** Source of the current page URL, set at install time. Returns '' when
 * no shell wired it up (e.g. test harness) — picker falls through to
 * `'default'`. */
let getCurrentPageUrl = () => '';
function pickNamespace() {
    const url = getCurrentPageUrl();
    const ns = activeProfile.pickStorageNamespace(url);
    return ns || 'default';
}
function storageDir(ns) {
    const root = activeProfile.storageRoot;
    return ns === 'default' ? `${root}localStorage/` : `${root}${ns}/localStorage/`;
}
function storageFile(ns) { return storageDir(ns) + 'default.json'; }
function ensureStorageDir(ns) {
    try {
        Switch.mkdirSync(storageDir(ns));
    }
    catch { /* exists */ }
}
function loadFromDisk(ns) {
    try {
        const ab = Switch.readFileSync(storageFile(ns));
        if (!ab)
            return {};
        const text = new TextDecoder().decode(ab);
        if (!text)
            return {};
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const out = {};
            for (const k of Object.keys(parsed))
                out[k] = String(parsed[k]);
            return out;
        }
        return {};
    }
    catch {
        return {};
    }
}
function writeToDisk(ns, map) {
    try {
        ensureStorageDir(ns);
        const text = JSON.stringify(map);
        Switch.writeFileSync(storageFile(ns), text);
    }
    catch {
        // Disk write failed — keep in-memory state consistent so the
        // session continues, but the data won't survive a reload. A
        // future Tier-2 enhancement can surface a StorageEvent or
        // throw QuotaExceededError per spec.
    }
}
class WebStorage {
    #data;
    #loadedNs;
    constructor() {
        this.#loadedNs = pickNamespace();
        this.#data = loadFromDisk(this.#loadedNs);
    }
    /** Before each access, check whether the active namespace changed
     * since we last loaded (i.e. the user navigated to/from a dev page).
     * If so, drop the in-memory cache and reload from the new namespace's
     * file so reads return its data, not the prior namespace's. */
    #syncNs() {
        const ns = pickNamespace();
        if (ns === this.#loadedNs)
            return;
        this.#loadedNs = ns;
        this.#data = loadFromDisk(ns);
    }
    get length() {
        this.#syncNs();
        return Object.keys(this.#data).length;
    }
    key(index) {
        this.#syncNs();
        if (!Number.isInteger(index) || index < 0)
            return null;
        const keys = Object.keys(this.#data);
        return keys[index] ?? null;
    }
    getItem(key) {
        this.#syncNs();
        const k = String(key);
        return Object.prototype.hasOwnProperty.call(this.#data, k) ? this.#data[k] : null;
    }
    setItem(key, value) {
        this.#syncNs();
        const k = String(key);
        const v = String(value);
        if (this.#data[k] === v)
            return; // no-op write, skip disk
        this.#data[k] = v;
        writeToDisk(this.#loadedNs, this.#data);
    }
    removeItem(key) {
        this.#syncNs();
        const k = String(key);
        if (!Object.prototype.hasOwnProperty.call(this.#data, k))
            return;
        delete this.#data[k];
        writeToDisk(this.#loadedNs, this.#data);
    }
    clear() {
        this.#syncNs();
        if (Object.keys(this.#data).length === 0)
            return;
        this.#data = {};
        writeToDisk(this.#loadedNs, this.#data);
    }
    /** Used by the Proxy's `ownKeys` / `has` / `getOwnPropertyDescriptor`. */
    _keys() {
        this.#syncNs();
        return Object.keys(this.#data);
    }
}
function wrapWithProxy(storage) {
    return new Proxy(storage, {
        has(target, p) {
            if (typeof p !== 'string')
                return Reflect.has(target, p);
            if (p in target)
                return true;
            return target.getItem(p) !== null;
        },
        get(target, p, _receiver) {
            if (typeof p !== 'string')
                return Reflect.get(target, p, target);
            // Real property / method on the WebStorage instance.
            if (p in target) {
                // IMPORTANT: pass `target` (not the proxy) as the receiver
                // so getters like `length` run against the real instance.
                // And bind methods so user calls like `localStorage.getItem('x')`
                // don't end up with `this === proxy`, which would break the
                // private `#data` field access (private fields are bound to
                // the original instance, not the proxy).
                const val = Reflect.get(target, p, target);
                return typeof val === 'function' ? val.bind(target) : val;
            }
            // Otherwise treat as a stored key access.
            return target.getItem(p) ?? undefined;
        },
        set(target, p, value, _receiver) {
            if (typeof p !== 'string')
                return Reflect.set(target, p, value, target);
            // Don't overwrite real methods (`getItem`, `length`, etc).
            if (p in target && typeof target[p] === 'function') {
                return Reflect.set(target, p, value, target);
            }
            target.setItem(p, String(value));
            return true;
        },
        deleteProperty(target, p) {
            if (typeof p !== 'string')
                return Reflect.deleteProperty(target, p);
            target.removeItem(p);
            return true;
        },
        ownKeys(target) {
            return target._keys();
        },
        getOwnPropertyDescriptor(target, p) {
            if (typeof p !== 'string')
                return Reflect.getOwnPropertyDescriptor(target, p);
            const v = target.getItem(p);
            if (v === null)
                return undefined;
            return { enumerable: true, configurable: true, writable: true, value: v };
        },
    });
}
let installed = false;
/**
 * Define `globalThis.localStorage` as a Proxy-wrapped file-backed
 * Storage. Call once at app startup BEFORE any page script reads
 * `localStorage`. The runtime's own lazy getter is `configurable:true`,
 * so this override replaces it cleanly.
 *
 * `opts.profile` injects the on-disk root + namespace picker. Pass the
 * shell's `BrowserProfile` (which implements {@link StorageProfileLike})
 * to get `brewser://dev/...` writes sandboxed to a `dev/` subdir.
 * Omitting the profile leaves storage on the single-namespace
 * {@link DEFAULT_STORAGE_PROFILE}.
 *
 * `opts.getCurrentUrl` reads the active page URL on each storage
 * access so the namespace can change when navigation crosses
 * production / dev pages. Pass `BrowserShell.getCurrentPageUrl.bind(shell)`
 * (or an arrow wrapping it). Without it, the picker receives `''` —
 * which the default picker maps to `'default'`.
 */
export function installLocalStorage(opts = {}) {
    if (installed)
        return;
    installed = true;
    if (opts.profile)
        activeProfile = opts.profile;
    if (opts.getCurrentUrl)
        getCurrentPageUrl = opts.getCurrentUrl;
    const storage = wrapWithProxy(new WebStorage());
    Object.defineProperty(globalThis, 'localStorage', {
        value: storage,
        writable: false,
        configurable: true,
        enumerable: true,
    });
}
//# sourceMappingURL=local-storage.js.map