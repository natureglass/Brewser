/**
 * Tier-1 IndexedDB polyfill for switch-web-browser.
 *
 * Pure-JS, file-backed (one JSON file per database) at
 * `sdmc:/switch/brewser/indexedDB/<dbName>.json`.
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

declare const Switch: {
	readFileSync(path: string): ArrayBuffer | null;
	writeFileSync(path: string, data: ArrayBuffer | Uint8Array | string): void;
	mkdirSync(path: string): void;
};

const DB_DIR = 'sdmc:/switch/brewser/indexedDB/';
function dbPath(name: string): string {
	const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
	return DB_DIR + safe + '.json';
}

function ensureDbDir(): void {
	try { Switch.mkdirSync(DB_DIR); } catch { /* exists */ }
}

type StoreSchema = { keyPath: string | null };
type StoreRecords = Record<string, unknown>;
type DbFile = {
	name: string;
	version: number;
	stores: Record<string, { schema: StoreSchema; records: StoreRecords }>;
};

function loadDbFile(name: string): DbFile | null {
	try {
		const ab = Switch.readFileSync(dbPath(name));
		if (!ab) return null;
		const text = new TextDecoder().decode(ab);
		if (!text) return null;
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number') {
			return parsed as DbFile;
		}
		return null;
	} catch {
		return null;
	}
}

function writeDbFile(file: DbFile): void {
	try {
		ensureDbDir();
		Switch.writeFileSync(dbPath(file.name), JSON.stringify(file));
	} catch {
		// Disk write failed — keep in-memory state consistent, log only.
	}
}

function keyToString(key: unknown): string {
	if (key === undefined || key === null) throw new Error('IndexedDB key must not be null/undefined');
	if (typeof key === 'string') return 's:' + key;
	if (typeof key === 'number') return 'n:' + key;
	if (typeof key === 'boolean') return 'b:' + (key ? '1' : '0');
	// Spec disallows objects as keys except arrays + Date — Tier-1 stringifies.
	return 'j:' + JSON.stringify(key);
}

function extractKey(value: unknown, keyPath: string | null, explicitKey?: unknown): unknown {
	if (explicitKey !== undefined) return explicitKey;
	if (keyPath === null) {
		throw new Error('IndexedDB: store has no keyPath; explicit key required');
	}
	if (value === null || typeof value !== 'object') {
		throw new Error('IndexedDB: keyPath set but value is not an object');
	}
	return (value as Record<string, unknown>)[keyPath];
}

// Microtask scheduling. queueMicrotask is the cleanest; fall back to
// Promise.resolve().then() for older runtimes (nxjs has both).
function schedule(fn: () => void): void {
	if (typeof queueMicrotask === 'function') queueMicrotask(fn);
	else Promise.resolve().then(fn);
}

// --- Event base ----------------------------------------------------------

type Listener = (ev: { type: string; target: unknown; [k: string]: unknown }) => void;

class EventLike {
	#listeners: Record<string, Listener[]> = Object.create(null);
	addEventListener(type: string, listener: Listener): void {
		(this.#listeners[type] ??= []).push(listener);
	}
	removeEventListener(type: string, listener: Listener): void {
		const arr = this.#listeners[type];
		if (!arr) return;
		const i = arr.indexOf(listener);
		if (i >= 0) arr.splice(i, 1);
	}
	dispatchEvent(ev: { type: string; target: unknown; [k: string]: unknown }): boolean {
		const arr = this.#listeners[ev.type];
		if (arr) for (const l of arr.slice()) { try { l(ev); } catch { /* ignore */ } }
		// Fire on{type} handler too (real EventTarget does both).
		const handler = (this as unknown as Record<string, Listener | undefined>)['on' + ev.type];
		if (typeof handler === 'function') { try { handler.call(this, ev); } catch { /* ignore */ } }
		return true;
	}
}

// --- IDBRequest -----------------------------------------------------------

export class IDBRequest extends EventLike {
	result: unknown = undefined;
	error: Error | null = null;
	readyState: 'pending' | 'done' = 'pending';
	source: unknown = null;
	transaction: IDBTransaction | null = null;
	onsuccess: ((ev: { type: 'success'; target: IDBRequest }) => void) | null = null;
	onerror: ((ev: { type: 'error'; target: IDBRequest }) => void) | null = null;

	_succeed(result: unknown): void {
		this.result = result;
		this.readyState = 'done';
		schedule(() => this.dispatchEvent({ type: 'success', target: this }));
	}
	_fail(error: Error): void {
		this.error = error;
		this.readyState = 'done';
		schedule(() => this.dispatchEvent({ type: 'error', target: this }));
	}
}

export class IDBOpenDBRequest extends IDBRequest {
	onupgradeneeded: ((ev: { type: 'upgradeneeded'; target: IDBOpenDBRequest; oldVersion: number; newVersion: number }) => void) | null = null;
	onblocked: ((ev: { type: 'blocked'; target: IDBOpenDBRequest }) => void) | null = null;
}

// --- IDBVersionChangeEvent (passed to onupgradeneeded) --------------------

class IDBVersionChangeEventImpl {
	type: string;
	target: unknown;
	oldVersion: number;
	newVersion: number;
	constructor(target: unknown, oldVersion: number, newVersion: number) {
		this.type = 'upgradeneeded';
		this.target = target;
		this.oldVersion = oldVersion;
		this.newVersion = newVersion;
	}
}

// --- DOMStringList-like for objectStoreNames -----------------------------

class StringList {
	#items: string[];
	constructor(items: string[]) { this.#items = items.slice().sort(); }
	get length(): number { return this.#items.length; }
	contains(name: string): boolean { return this.#items.indexOf(name) >= 0; }
	item(index: number): string | null {
		if (index < 0 || index >= this.#items.length) return null;
		return this.#items[index];
	}
	[Symbol.iterator](): Iterator<string> { return this.#items[Symbol.iterator](); }
}

// --- IDBObjectStore -------------------------------------------------------

export class IDBObjectStore {
	readonly name: string;
	readonly keyPath: string | null;
	readonly autoIncrement: boolean = false;
	readonly transaction: IDBTransaction;
	_records: StoreRecords;

	constructor(name: string, schema: StoreSchema, records: StoreRecords, tx: IDBTransaction) {
		this.name = name;
		this.keyPath = schema.keyPath;
		this.transaction = tx;
		this._records = records;
	}

	#assertWrite(): void {
		if (this.transaction.mode === 'readonly') {
			throw new Error('IndexedDB: write op on readonly transaction');
		}
	}

	put(value: unknown, key?: unknown): IDBRequest {
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
		} catch (e) {
			req._fail(e instanceof Error ? e : new Error(String(e)));
		}
		return req;
	}

	add(value: unknown, key?: unknown): IDBRequest {
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
		} catch (e) {
			req._fail(e instanceof Error ? e : new Error(String(e)));
		}
		return req;
	}

	get(key: unknown): IDBRequest {
		const req = new IDBRequest();
		req.source = this;
		req.transaction = this.transaction;
		try {
			const ks = keyToString(key);
			const v = Object.prototype.hasOwnProperty.call(this._records, ks)
				? this._records[ks] : undefined;
			req._succeed(v);
		} catch (e) {
			req._fail(e instanceof Error ? e : new Error(String(e)));
		}
		return req;
	}

	delete(key: unknown): IDBRequest {
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
		} catch (e) {
			req._fail(e instanceof Error ? e : new Error(String(e)));
		}
		return req;
	}

	clear(): IDBRequest {
		this.#assertWrite();
		const req = new IDBRequest();
		req.source = this;
		req.transaction = this.transaction;
		try {
			for (const k of Object.keys(this._records)) delete this._records[k];
			this.transaction._markDirty();
			req._succeed(undefined);
		} catch (e) {
			req._fail(e instanceof Error ? e : new Error(String(e)));
		}
		return req;
	}

	count(_query?: unknown): IDBRequest {
		const req = new IDBRequest();
		req.source = this;
		req.transaction = this.transaction;
		req._succeed(Object.keys(this._records).length);
		return req;
	}

	getAll(_query?: unknown, count?: number): IDBRequest {
		const req = new IDBRequest();
		req.source = this;
		req.transaction = this.transaction;
		const values = Object.values(this._records);
		const out = typeof count === 'number' ? values.slice(0, count) : values;
		req._succeed(out);
		return req;
	}

	getAllKeys(_query?: unknown, count?: number): IDBRequest {
		const req = new IDBRequest();
		req.source = this;
		req.transaction = this.transaction;
		const keys = Object.keys(this._records).map((ks) => decodeKey(ks));
		const out = typeof count === 'number' ? keys.slice(0, count) : keys;
		req._succeed(out);
		return req;
	}
}

function decodeKey(ks: string): unknown {
	if (ks.startsWith('s:')) return ks.slice(2);
	if (ks.startsWith('n:')) return Number(ks.slice(2));
	if (ks.startsWith('b:')) return ks.slice(2) === '1';
	if (ks.startsWith('j:')) { try { return JSON.parse(ks.slice(2)); } catch { return null; } }
	return ks;
}

// --- IDBTransaction -------------------------------------------------------

export class IDBTransaction extends EventLike {
	readonly db: IDBDatabase;
	readonly mode: 'readonly' | 'readwrite' | 'versionchange';
	readonly objectStoreNames: StringList;
	error: Error | null = null;
	#stores: Record<string, IDBObjectStore> = Object.create(null);
	#dirty = false;
	#committed = false;
	oncomplete: ((ev: { type: 'complete'; target: IDBTransaction }) => void) | null = null;
	onerror: ((ev: { type: 'error'; target: IDBTransaction }) => void) | null = null;
	onabort: ((ev: { type: 'abort'; target: IDBTransaction }) => void) | null = null;

	constructor(db: IDBDatabase, scope: string[], mode: 'readonly' | 'readwrite' | 'versionchange') {
		super();
		this.db = db;
		this.mode = mode;
		this.objectStoreNames = new StringList(scope);
		for (const name of scope) {
			const meta = db._file.stores[name];
			if (!meta) throw new Error(`IndexedDB: no such object store "${name}"`);
			this.#stores[name] = new IDBObjectStore(name, meta.schema, meta.records, this);
		}
		// Auto-commit on next microtask drain. Game code typically queues
		// all ops synchronously on the tx; the microtask boundary catches
		// "everything done, time to write to disk".
		schedule(() => this._commit());
	}

	objectStore(name: string): IDBObjectStore {
		const s = this.#stores[name];
		if (!s) throw new Error(`IndexedDB: transaction has no scope on "${name}"`);
		return s;
	}

	abort(): void {
		this.#committed = true; // skip commit
		this.#dirty = false;
		schedule(() => this.dispatchEvent({ type: 'abort', target: this }));
	}

	_markDirty(): void { this.#dirty = true; }

	_commit(): void {
		if (this.#committed) return;
		this.#committed = true;
		try {
			if (this.#dirty && this.mode !== 'readonly') writeDbFile(this.db._file);
			this.dispatchEvent({ type: 'complete', target: this });
		} catch (e) {
			this.error = e instanceof Error ? e : new Error(String(e));
			this.dispatchEvent({ type: 'error', target: this });
		}
	}
}

// --- IDBDatabase ----------------------------------------------------------

export class IDBDatabase extends EventLike {
	readonly name: string;
	readonly version: number;
	readonly objectStoreNames: StringList;
	_file: DbFile;
	#closed = false;
	onversionchange: ((ev: { type: 'versionchange'; target: IDBDatabase }) => void) | null = null;
	onclose: ((ev: { type: 'close'; target: IDBDatabase }) => void) | null = null;

	constructor(file: DbFile) {
		super();
		this._file = file;
		this.name = file.name;
		this.version = file.version;
		this.objectStoreNames = new StringList(Object.keys(file.stores));
	}

	createObjectStore(name: string, options?: { keyPath?: string | null; autoIncrement?: boolean }): IDBObjectStore {
		if (this._file.stores[name]) {
			throw new Error(`IndexedDB: object store "${name}" already exists`);
		}
		const schema: StoreSchema = { keyPath: options?.keyPath ?? null };
		this._file.stores[name] = { schema, records: {} };
		(this as { objectStoreNames: StringList }).objectStoreNames = new StringList(Object.keys(this._file.stores));
		// Synthetic tx so the store can carry one; ops on it during the
		// upgrade go through the versionchange tx (see _runUpgrade).
		const tx = new IDBTransaction(this, [name], 'versionchange');
		return tx.objectStore(name);
	}

	deleteObjectStore(name: string): void {
		if (!this._file.stores[name]) throw new Error(`IndexedDB: no such object store "${name}"`);
		delete this._file.stores[name];
		(this as { objectStoreNames: StringList }).objectStoreNames = new StringList(Object.keys(this._file.stores));
	}

	transaction(scope: string | string[], mode: 'readonly' | 'readwrite' = 'readonly'): IDBTransaction {
		if (this.#closed) throw new Error('IndexedDB: database is closed');
		const list = typeof scope === 'string' ? [scope] : scope;
		return new IDBTransaction(this, list, mode);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		schedule(() => this.dispatchEvent({ type: 'close', target: this }));
	}
}

// --- IDBFactory -----------------------------------------------------------

export class IDBFactory {
	open(name: string, version: number = 1): IDBOpenDBRequest {
		const req = new IDBOpenDBRequest();
		schedule(() => {
			try {
				let file = loadDbFile(name);
				const oldVersion = file ? file.version : 0;
				const needsUpgrade = !file || file.version < version;
				if (!file) {
					file = { name, version, stores: {} };
				}
				const db = new IDBDatabase(file);
				req.result = db;
				if (needsUpgrade) {
					file.version = version;
					// Upgrade transaction is the synthetic versionchange tx
					// that createObjectStore/deleteObjectStore writes through.
					const ev = new IDBVersionChangeEventImpl(req, oldVersion, version);
					// onupgradeneeded fires BEFORE onsuccess; both via microtask.
					schedule(() => {
						req.dispatchEvent(ev as unknown as { type: string; target: unknown });
						// After upgrade callback returns, persist + fire success.
						schedule(() => {
							writeDbFile(file);
							req._succeed(db);
						});
					});
				} else {
					req._succeed(db);
				}
			} catch (e) {
				req._fail(e instanceof Error ? e : new Error(String(e)));
			}
		});
		return req;
	}

	cmp(a: unknown, b: unknown): number {
		// Real IDB has a deep key-comparison algorithm. Tier-1: stringify.
		const sa = keyToString(a), sb = keyToString(b);
		return sa < sb ? -1 : sa > sb ? 1 : 0;
	}
}

let installed = false;

/**
 * Define `globalThis.indexedDB` as an IDBFactory instance. Call once at
 * app startup BEFORE any page script reads `indexedDB`. Per-app singleton;
 * all databases stored under `sdmc:/switch/brewser/indexedDB/`.
 */
export function installIndexedDB(): void {
	if (installed) return;
	installed = true;
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
