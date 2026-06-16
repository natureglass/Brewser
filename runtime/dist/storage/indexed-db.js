/**
 * Tier-1 IndexedDB polyfill for brewser.
 *
 * Pure-JS, file-backed (one JSON file per database) under
 * `<profile.storageRoot>indexedDB/<dbName>.json` for the `default`
 * namespace, `<profile.storageRoot><ns>/indexedDB/<dbName>.json` for
 * any other namespace (e.g. `dev`). The active namespace is picked by
 * `profile.pickStorageNamespace(currentUrl)` on every access — the
 * shell typically routes `brewser://dev/...` to the `dev` namespace
 * to keep test artifacts out of real user storage, but the runtime
 * stays agnostic.
 *
 * Covers the subset that the api-probe test + typical itch.io games
 * exercise: open with versioning, createObjectStore, put/add/get/delete/
 * clear/count/getAll, microtask-dispatched onsuccess.
 *
 * Tier-1 limitations (worth knowing):
 *
 * - SINGLE shared namespace across all pages (same caveat as
 *   [[project-swb-local-storage-tier1]]). Two games using the same
 *   database name will collide.
 * - No `IDBIndex` / `IDBCursor` / `IDBKeyRange` — only direct key lookup.
 * - No `autoIncrement`, no composite key paths (`['a','b']`).
 * - No real structured clone — values round-trip through `JSON.stringify`
 *   so Date/Map/Set/typed-arrays/Blob get lost.
 * - No "transaction inactive" enforcement; ops are queued and committed
 *   on the next microtask boundary.
 * - `deleteDatabase`, `databases()`, `onblocked` not implemented.
 */
import { DEFAULT_STORAGE_PROFILE, } from '../profile/storage-profile.js';
/** Active profile — supplies the on-disk root + namespace picker. The
 * default profile resolves everything to a single 'default' namespace
 * under `DEFAULT_PROFILE_ROOT` so embedding consumers without a shell
 * still get working storage. */
let activeProfile = DEFAULT_STORAGE_PROFILE;
/** Source of the current page URL, set at install time. Returns '' when
 * no shell wired it up (test harness, early boot) — picker falls through
 * to `'default'` so production state is the safe default. */
let getCurrentPageUrl = () => '';
function pickNamespace() {
    const url = getCurrentPageUrl();
    const ns = activeProfile.pickStorageNamespace(url);
    return ns || 'default';
}
function dbDir() {
    const ns = pickNamespace();
    const root = activeProfile.storageRoot;
    return ns === 'default' ? `${root}indexedDB/` : `${root}${ns}/indexedDB/`;
}
function dbPath(name) {
    const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return dbDir() + safe + '.json';
}
function ensureDbDir() {
    try {
        Switch.mkdirSync(dbDir());
    }
    catch { /* exists */ }
}
function loadDbFile(name) {
    try {
        const ab = Switch.readFileSync(dbPath(name));
        if (!ab)
            return null;
        const text = new TextDecoder().decode(ab);
        if (!text)
            return null;
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number') {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
function writeDbFile(file) {
    try {
        ensureDbDir();
        Switch.writeFileSync(dbPath(file.name), JSON.stringify(file));
    }
    catch {
        // Disk write failed — keep in-memory state consistent, log only.
    }
}
function keyToString(key) {
    if (key === undefined || key === null)
        throw new Error('IndexedDB key must not be null/undefined');
    if (typeof key === 'string')
        return 's:' + key;
    if (typeof key === 'number')
        return 'n:' + key;
    if (typeof key === 'boolean')
        return 'b:' + (key ? '1' : '0');
    // Spec disallows objects as keys except arrays + Date — Tier-1 stringifies.
    return 'j:' + JSON.stringify(key);
}
function extractKey(value, keyPath, explicitKey) {
    if (explicitKey !== undefined)
        return explicitKey;
    if (keyPath === null) {
        throw new Error('IndexedDB: store has no keyPath; explicit key required');
    }
    if (value === null || typeof value !== 'object') {
        throw new Error('IndexedDB: keyPath set but value is not an object');
    }
    return value[keyPath];
}
// Microtask scheduling. queueMicrotask is the cleanest; fall back to
// Promise.resolve().then() for older runtimes (nxjs has both).
function schedule(fn) {
    if (typeof queueMicrotask === 'function')
        queueMicrotask(fn);
    else
        Promise.resolve().then(fn);
}
class EventLike {
    #listeners = Object.create(null);
    addEventListener(type, listener) {
        (this.#listeners[type] ??= []).push(listener);
    }
    removeEventListener(type, listener) {
        const arr = this.#listeners[type];
        if (!arr)
            return;
        const i = arr.indexOf(listener);
        if (i >= 0)
            arr.splice(i, 1);
    }
    dispatchEvent(ev) {
        const arr = this.#listeners[ev.type];
        if (arr)
            for (const l of arr.slice()) {
                try {
                    l(ev);
                }
                catch { /* ignore */ }
            }
        // Fire on{type} handler too (real EventTarget does both).
        const handler = this['on' + ev.type];
        if (typeof handler === 'function') {
            try {
                handler.call(this, ev);
            }
            catch { /* ignore */ }
        }
        return true;
    }
}
// --- IDBRequest -----------------------------------------------------------
export class IDBRequest extends EventLike {
    result = undefined;
    error = null;
    readyState = 'pending';
    source = null;
    transaction = null;
    onsuccess = null;
    onerror = null;
    _succeed(result) {
        this.result = result;
        this.readyState = 'done';
        schedule(() => this.dispatchEvent({ type: 'success', target: this }));
    }
    _fail(error) {
        this.error = error;
        this.readyState = 'done';
        schedule(() => this.dispatchEvent({ type: 'error', target: this }));
    }
}
export class IDBOpenDBRequest extends IDBRequest {
    onupgradeneeded = null;
    onblocked = null;
}
// --- IDBVersionChangeEvent (passed to onupgradeneeded) --------------------
class IDBVersionChangeEventImpl {
    type;
    target;
    oldVersion;
    newVersion;
    constructor(target, oldVersion, newVersion) {
        this.type = 'upgradeneeded';
        this.target = target;
        this.oldVersion = oldVersion;
        this.newVersion = newVersion;
    }
}
// --- DOMStringList-like for objectStoreNames -----------------------------
class StringList {
    #items;
    constructor(items) { this.#items = items.slice().sort(); }
    get length() { return this.#items.length; }
    contains(name) { return this.#items.indexOf(name) >= 0; }
    item(index) {
        if (index < 0 || index >= this.#items.length)
            return null;
        return this.#items[index];
    }
    [Symbol.iterator]() { return this.#items[Symbol.iterator](); }
}
// --- IDBObjectStore -------------------------------------------------------
export class IDBObjectStore {
    name;
    keyPath;
    autoIncrement = false;
    transaction;
    _records;
    constructor(name, schema, records, tx) {
        this.name = name;
        this.keyPath = schema.keyPath;
        this.transaction = tx;
        this._records = records;
    }
    #assertWrite() {
        if (this.transaction.mode === 'readonly') {
            throw new Error('IndexedDB: write op on readonly transaction');
        }
    }
    put(value, key) {
        this.#assertWrite();
        const req = new IDBRequest();
        req.source = this;
        req.transaction = this.transaction;
        try {
            const k = extractKey(value, this.keyPath, key);
            const ks = keyToString(k);
            this._records[ks] = JSON.parse(JSON.stringify(value));
            this.transaction._markDirty();
            req._succeed(k);
        }
        catch (e) {
            req._fail(e instanceof Error ? e : new Error(String(e)));
        }
        return req;
    }
    add(value, key) {
        this.#assertWrite();
        const req = new IDBRequest();
        req.source = this;
        req.transaction = this.transaction;
        try {
            const k = extractKey(value, this.keyPath, key);
            const ks = keyToString(k);
            if (Object.prototype.hasOwnProperty.call(this._records, ks)) {
                throw new Error('IndexedDB: key already exists (add called for existing key)');
            }
            this._records[ks] = JSON.parse(JSON.stringify(value));
            this.transaction._markDirty();
            req._succeed(k);
        }
        catch (e) {
            req._fail(e instanceof Error ? e : new Error(String(e)));
        }
        return req;
    }
    get(key) {
        const req = new IDBRequest();
        req.source = this;
        req.transaction = this.transaction;
        try {
            const ks = keyToString(key);
            const v = Object.prototype.hasOwnProperty.call(this._records, ks)
                ? this._records[ks] : undefined;
            req._succeed(v);
        }
        catch (e) {
            req._fail(e instanceof Error ? e : new Error(String(e)));
        }
        return req;
    }
    delete(key) {
        this.#assertWrite();
        const req = new IDBRequest();
        req.source = this;
        req.transaction = this.transaction;
        try {
            const ks = keyToString(key);
            if (Object.prototype.hasOwnProperty.call(this._records, ks)) {
                delete this._records[ks];
                this.transaction._markDirty();
            }
            req._succeed(undefined);
        }
        catch (e) {
            req._fail(e instanceof Error ? e : new Error(String(e)));
        }
        return req;
    }
    clear() {
        this.#assertWrite();
        const req = new IDBRequest();
        req.source = this;
        req.transaction = this.transaction;
        try {
            for (const k of Object.keys(this._records))
                delete this._records[k];
            this.transaction._markDirty();
            req._succeed(undefined);
        }
        catch (e) {
            req._fail(e instanceof Error ? e : new Error(String(e)));
        }
        return req;
    }
    count(_query) {
        const req = new IDBRequest();
        req.source = this;
        req.transaction = this.transaction;
        req._succeed(Object.keys(this._records).length);
        return req;
    }
    getAll(_query, count) {
        const req = new IDBRequest();
        req.source = this;
        req.transaction = this.transaction;
        const values = Object.values(this._records);
        const out = typeof count === 'number' ? values.slice(0, count) : values;
        req._succeed(out);
        return req;
    }
    getAllKeys(_query, count) {
        const req = new IDBRequest();
        req.source = this;
        req.transaction = this.transaction;
        const keys = Object.keys(this._records).map((ks) => decodeKey(ks));
        const out = typeof count === 'number' ? keys.slice(0, count) : keys;
        req._succeed(out);
        return req;
    }
}
function decodeKey(ks) {
    if (ks.startsWith('s:'))
        return ks.slice(2);
    if (ks.startsWith('n:'))
        return Number(ks.slice(2));
    if (ks.startsWith('b:'))
        return ks.slice(2) === '1';
    if (ks.startsWith('j:')) {
        try {
            return JSON.parse(ks.slice(2));
        }
        catch {
            return null;
        }
    }
    return ks;
}
// --- IDBTransaction -------------------------------------------------------
export class IDBTransaction extends EventLike {
    db;
    mode;
    objectStoreNames;
    error = null;
    #stores = Object.create(null);
    #dirty = false;
    #committed = false;
    oncomplete = null;
    onerror = null;
    onabort = null;
    constructor(db, scope, mode) {
        super();
        this.db = db;
        this.mode = mode;
        this.objectStoreNames = new StringList(scope);
        for (const name of scope) {
            const meta = db._file.stores[name];
            if (!meta)
                throw new Error(`IndexedDB: no such object store "${name}"`);
            this.#stores[name] = new IDBObjectStore(name, meta.schema, meta.records, this);
        }
        // Auto-commit on next microtask drain. Game code typically queues
        // all ops synchronously on the tx; the microtask boundary catches
        // "everything done, time to write to disk".
        schedule(() => this._commit());
    }
    objectStore(name) {
        const s = this.#stores[name];
        if (!s)
            throw new Error(`IndexedDB: transaction has no scope on "${name}"`);
        return s;
    }
    abort() {
        this.#committed = true; // skip commit
        this.#dirty = false;
        schedule(() => this.dispatchEvent({ type: 'abort', target: this }));
    }
    _markDirty() { this.#dirty = true; }
    _commit() {
        if (this.#committed)
            return;
        this.#committed = true;
        try {
            if (this.#dirty && this.mode !== 'readonly')
                writeDbFile(this.db._file);
            this.dispatchEvent({ type: 'complete', target: this });
        }
        catch (e) {
            this.error = e instanceof Error ? e : new Error(String(e));
            this.dispatchEvent({ type: 'error', target: this });
        }
    }
}
// --- IDBDatabase ----------------------------------------------------------
export class IDBDatabase extends EventLike {
    name;
    version;
    objectStoreNames;
    _file;
    #closed = false;
    onversionchange = null;
    onclose = null;
    constructor(file) {
        super();
        this._file = file;
        this.name = file.name;
        this.version = file.version;
        this.objectStoreNames = new StringList(Object.keys(file.stores));
    }
    createObjectStore(name, options) {
        if (this._file.stores[name]) {
            throw new Error(`IndexedDB: object store "${name}" already exists`);
        }
        const schema = { keyPath: options?.keyPath ?? null };
        this._file.stores[name] = { schema, records: {} };
        this.objectStoreNames = new StringList(Object.keys(this._file.stores));
        // Synthetic tx so the store can carry one; ops on it during the
        // upgrade go through the versionchange tx (see _runUpgrade).
        const tx = new IDBTransaction(this, [name], 'versionchange');
        return tx.objectStore(name);
    }
    deleteObjectStore(name) {
        if (!this._file.stores[name])
            throw new Error(`IndexedDB: no such object store "${name}"`);
        delete this._file.stores[name];
        this.objectStoreNames = new StringList(Object.keys(this._file.stores));
    }
    transaction(scope, mode = 'readonly') {
        if (this.#closed)
            throw new Error('IndexedDB: database is closed');
        const list = typeof scope === 'string' ? [scope] : scope;
        return new IDBTransaction(this, list, mode);
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        schedule(() => this.dispatchEvent({ type: 'close', target: this }));
    }
}
// --- IDBFactory -----------------------------------------------------------
export class IDBFactory {
    open(name, version = 1) {
        const req = new IDBOpenDBRequest();
        schedule(() => {
            try {
                let file = loadDbFile(name);
                const oldVersion = file ? file.version : 0;
                const needsUpgrade = !file || file.version < version;
                if (!file) {
                    file = { name, version, stores: {} };
                }
                const dbFile = file;
                const db = new IDBDatabase(dbFile);
                req.result = db;
                if (needsUpgrade) {
                    dbFile.version = version;
                    // Upgrade transaction is the synthetic versionchange tx
                    // that createObjectStore/deleteObjectStore writes through.
                    const ev = new IDBVersionChangeEventImpl(req, oldVersion, version);
                    // onupgradeneeded fires BEFORE onsuccess; both via microtask.
                    schedule(() => {
                        req.dispatchEvent(ev);
                        // After upgrade callback returns, persist + fire success.
                        schedule(() => {
                            writeDbFile(dbFile);
                            req._succeed(db);
                        });
                    });
                }
                else {
                    req._succeed(db);
                }
            }
            catch (e) {
                req._fail(e instanceof Error ? e : new Error(String(e)));
            }
        });
        return req;
    }
    cmp(a, b) {
        // Real IDB has a deep key-comparison algorithm. Tier-1: stringify.
        const sa = keyToString(a), sb = keyToString(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
}
let installed = false;
/**
 * Define `globalThis.indexedDB` as an IDBFactory instance. Call once at
 * app startup BEFORE any page script reads `indexedDB`.
 *
 * `opts.profile` injects the on-disk root + namespace picker — pass
 * the shell's `BrowserProfile` (which implements
 * {@link StorageProfileLike}) to route `brewser://dev/...` writes into
 * a sandboxed `dev/` subdir. Omitting the profile keeps everything on
 * the single-namespace {@link DEFAULT_STORAGE_PROFILE}.
 *
 * `opts.getCurrentUrl` reads the active page URL on each storage
 * access so the namespace can change across navigations. Pass an
 * arrow wrapping `shell.getCurrentPageUrl()`. Without it the picker
 * receives `''` — the default picker maps that to `'default'`.
 */
export function installIndexedDB(opts = {}) {
    if (installed)
        return;
    installed = true;
    if (opts.profile)
        activeProfile = opts.profile;
    if (opts.getCurrentUrl)
        getCurrentPageUrl = opts.getCurrentUrl;
    const factory = new IDBFactory();
    Object.defineProperty(globalThis, 'indexedDB', {
        value: factory,
        writable: false,
        configurable: true,
        enumerable: true,
    });
    // Spec exposes the constructors as globals too — useful for `instanceof`.
    Object.defineProperty(globalThis, 'IDBFactory', { value: IDBFactory, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'IDBRequest', { value: IDBRequest, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'IDBOpenDBRequest', { value: IDBOpenDBRequest, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'IDBDatabase', { value: IDBDatabase, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'IDBTransaction', { value: IDBTransaction, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'IDBObjectStore', { value: IDBObjectStore, writable: true, configurable: true });
}
//# sourceMappingURL=indexed-db.js.map