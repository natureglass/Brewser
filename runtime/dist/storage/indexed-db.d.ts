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
import { type StorageInstallOptions } from '../profile/storage-profile.js';
type StoreSchema = {
    keyPath: string | null;
};
type StoreRecords = Record<string, unknown>;
type DbFile = {
    name: string;
    version: number;
    stores: Record<string, {
        schema: StoreSchema;
        records: StoreRecords;
    }>;
};
type Listener = (ev: {
    type: string;
    target: unknown;
    [k: string]: unknown;
}) => void;
declare class EventLike {
    #private;
    addEventListener(type: string, listener: Listener): void;
    removeEventListener(type: string, listener: Listener): void;
    dispatchEvent(ev: {
        type: string;
        target: unknown;
        [k: string]: unknown;
    }): boolean;
}
export declare class IDBRequest extends EventLike {
    result: unknown;
    error: Error | null;
    readyState: 'pending' | 'done';
    source: unknown;
    transaction: IDBTransaction | null;
    onsuccess: ((ev: {
        type: 'success';
        target: IDBRequest;
    }) => void) | null;
    onerror: ((ev: {
        type: 'error';
        target: IDBRequest;
    }) => void) | null;
    _succeed(result: unknown): void;
    _fail(error: Error): void;
}
export declare class IDBOpenDBRequest extends IDBRequest {
    onupgradeneeded: ((ev: {
        type: 'upgradeneeded';
        target: IDBOpenDBRequest;
        oldVersion: number;
        newVersion: number;
    }) => void) | null;
    onblocked: ((ev: {
        type: 'blocked';
        target: IDBOpenDBRequest;
    }) => void) | null;
}
declare class StringList {
    #private;
    constructor(items: string[]);
    get length(): number;
    contains(name: string): boolean;
    item(index: number): string | null;
    [Symbol.iterator](): Iterator<string>;
}
export declare class IDBObjectStore {
    #private;
    readonly name: string;
    readonly keyPath: string | null;
    readonly autoIncrement: boolean;
    readonly transaction: IDBTransaction;
    _records: StoreRecords;
    constructor(name: string, schema: StoreSchema, records: StoreRecords, tx: IDBTransaction);
    put(value: unknown, key?: unknown): IDBRequest;
    add(value: unknown, key?: unknown): IDBRequest;
    get(key: unknown): IDBRequest;
    delete(key: unknown): IDBRequest;
    clear(): IDBRequest;
    count(_query?: unknown): IDBRequest;
    getAll(_query?: unknown, count?: number): IDBRequest;
    getAllKeys(_query?: unknown, count?: number): IDBRequest;
}
export declare class IDBTransaction extends EventLike {
    #private;
    readonly db: IDBDatabase;
    readonly mode: 'readonly' | 'readwrite' | 'versionchange';
    readonly objectStoreNames: StringList;
    error: Error | null;
    oncomplete: ((ev: {
        type: 'complete';
        target: IDBTransaction;
    }) => void) | null;
    onerror: ((ev: {
        type: 'error';
        target: IDBTransaction;
    }) => void) | null;
    onabort: ((ev: {
        type: 'abort';
        target: IDBTransaction;
    }) => void) | null;
    constructor(db: IDBDatabase, scope: string[], mode: 'readonly' | 'readwrite' | 'versionchange');
    objectStore(name: string): IDBObjectStore;
    abort(): void;
    _markDirty(): void;
    _commit(): void;
}
export declare class IDBDatabase extends EventLike {
    #private;
    readonly name: string;
    readonly version: number;
    readonly objectStoreNames: StringList;
    _file: DbFile;
    onversionchange: ((ev: {
        type: 'versionchange';
        target: IDBDatabase;
    }) => void) | null;
    onclose: ((ev: {
        type: 'close';
        target: IDBDatabase;
    }) => void) | null;
    constructor(file: DbFile);
    createObjectStore(name: string, options?: {
        keyPath?: string | null;
        autoIncrement?: boolean;
    }): IDBObjectStore;
    deleteObjectStore(name: string): void;
    transaction(scope: string | string[], mode?: 'readonly' | 'readwrite'): IDBTransaction;
    close(): void;
}
export declare class IDBFactory {
    open(name: string, version?: number): IDBOpenDBRequest;
    cmp(a: unknown, b: unknown): number;
}
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
export declare function installIndexedDB(opts?: StorageInstallOptions): void;
export {};
//# sourceMappingURL=indexed-db.d.ts.map