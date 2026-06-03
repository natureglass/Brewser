/**
 * Tier-1 Web Storage API (`localStorage`) for switch-web-browser.
 *
 * The nx.js runtime ships its own `localStorage` lazy getter at
 * `globalThis.localStorage`, but it (a) returns `undefined` when the
 * app's NACP `userAccountSaveDataSize` is 0 (swb's is), and (b) ties
 * persistence to Switch per-user save data — wrong granularity for a
 * web browser that needs per-page-origin storage.
 *
 * This module redefines `globalThis.localStorage` BEFORE any page
 * script runs, backed by a single JSON file at
 * `sdmc:/switch/brewser/localStorage/default.json`.
 *
 * Tier-1 limitation: ALL pages share one namespace. itch.io games can
 * collide with each other's save data. Tier-2 work would partition by
 * page origin (extract from current URL on each access) and write to
 * `localStorage/<origin-slug>.json`. Adequate for verifying the api-
 * probe + unblocking simple game persistence today.
 */

declare const Switch: {
	readFileSync(path: string): ArrayBuffer | null;
	writeFileSync(path: string, data: ArrayBuffer | Uint8Array | string): void;
	mkdirSync(path: string): void;
	statSync?(path: string): { size: number } | null;
};

const STORAGE_DIR = 'sdmc:/switch/brewser/localStorage/';
const STORAGE_FILE = STORAGE_DIR + 'default.json';

function ensureStorageDir(): void {
	try { Switch.mkdirSync(STORAGE_DIR); } catch { /* exists */ }
}

function loadFromDisk(): Record<string, string> {
	try {
		const ab = Switch.readFileSync(STORAGE_FILE);
		if (!ab) return {};
		const text = new TextDecoder().decode(ab);
		if (!text) return {};
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const out: Record<string, string> = {};
			for (const k of Object.keys(parsed)) out[k] = String((parsed as Record<string, unknown>)[k]);
			return out;
		}
		return {};
	} catch {
		return {};
	}
}

function writeToDisk(map: Record<string, string>): void {
	try {
		ensureStorageDir();
		const text = JSON.stringify(map);
		Switch.writeFileSync(STORAGE_FILE, text);
	} catch {
		// Disk write failed — keep in-memory state consistent so the
		// session continues, but the data won't survive a reload. A
		// future Tier-2 enhancement can surface a StorageEvent or
		// throw QuotaExceededError per spec.
	}
}

class WebStorage {
	#data: Record<string, string>;

	constructor() {
		this.#data = loadFromDisk();
	}

	get length(): number {
		return Object.keys(this.#data).length;
	}

	key(index: number): string | null {
		if (!Number.isInteger(index) || index < 0) return null;
		const keys = Object.keys(this.#data);
		return keys[index] ?? null;
	}

	getItem(key: string): string | null {
		const k = String(key);
		return Object.prototype.hasOwnProperty.call(this.#data, k) ? this.#data[k] : null;
	}

	setItem(key: string, value: string): void {
		const k = String(key);
		const v = String(value);
		if (this.#data[k] === v) return; // no-op write, skip disk
		this.#data[k] = v;
		writeToDisk(this.#data);
	}

	removeItem(key: string): void {
		const k = String(key);
		if (!Object.prototype.hasOwnProperty.call(this.#data, k)) return;
		delete this.#data[k];
		writeToDisk(this.#data);
	}

	clear(): void {
		if (Object.keys(this.#data).length === 0) return;
		this.#data = {};
		writeToDisk(this.#data);
	}

	/** Used by the Proxy's `ownKeys` / `has` / `getOwnPropertyDescriptor`. */
	_keys(): string[] {
		return Object.keys(this.#data);
	}
}

function wrapWithProxy(storage: WebStorage): WebStorage {
	return new Proxy(storage, {
		has(target, p) {
			if (typeof p !== 'string') return Reflect.has(target, p);
			if (p in target) return true;
			return target.getItem(p) !== null;
		},
		get(target, p, _receiver) {
			if (typeof p !== 'string') return Reflect.get(target, p, target);
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
			if (typeof p !== 'string') return Reflect.set(target, p, value, target);
			// Don't overwrite real methods (`getItem`, `length`, etc).
			if (p in target && typeof (target as unknown as Record<string, unknown>)[p] === 'function') {
				return Reflect.set(target, p, value, target);
			}
			target.setItem(p, String(value));
			return true;
		},
		deleteProperty(target, p) {
			if (typeof p !== 'string') return Reflect.deleteProperty(target, p);
			target.removeItem(p);
			return true;
		},
		ownKeys(target) {
			return target._keys();
		},
		getOwnPropertyDescriptor(target, p) {
			if (typeof p !== 'string') return Reflect.getOwnPropertyDescriptor(target, p);
			const v = target.getItem(p);
			if (v === null) return undefined;
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
 */
export function installLocalStorage(): void {
	if (installed) return;
	installed = true;
	const storage = wrapWithProxy(new WebStorage());
	Object.defineProperty(globalThis, 'localStorage', {
		value: storage,
		writable: false,
		configurable: true,
		enumerable: true,
	});
}
