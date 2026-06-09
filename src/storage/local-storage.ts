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
 * script runs, backed by a single JSON file at
 * `sdmc:/switch/brewser/localStorage/default.json` for production pages,
 * `sdmc:/switch/brewser/dev/localStorage/default.json` when the active
 * page is under `brewser://dev/` (keeps test artifacts out of real
 * user storage). Reloads on namespace change so reads always see the
 * file for the active page's namespace.
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

/** Storage namespaces. `default` is the production root used by real
 * pages; `dev` quarantines test-fixture writes under a `dev/` subdir so
 * the brewser root path stays clean. Selected at access time from the
 * current page URL — pages under `brewser://dev/` get `dev`, everything
 * else gets `default`. Adding a new namespace is just a new branch
 * here + in `pickNamespace`. */
type Namespace = 'default' | 'dev';

const ROOT = 'sdmc:/switch/brewser/';
const STORAGE_DIRS: Record<Namespace, string> = {
	default: ROOT + 'localStorage/',
	dev: ROOT + 'dev/localStorage/',
};

/** Source of the current page URL, set at install time. Returns '' when
 * no shell wired it up (e.g. test harness) — falls through to `default`. */
let getCurrentPageUrl: () => string = () => '';

function pickNamespace(): Namespace {
	const url = getCurrentPageUrl();
	return url.startsWith('brewser://dev/') ? 'dev' : 'default';
}

function storageDir(ns: Namespace): string { return STORAGE_DIRS[ns]; }
function storageFile(ns: Namespace): string { return storageDir(ns) + 'default.json'; }

function ensureStorageDir(ns: Namespace): void {
	try { Switch.mkdirSync(storageDir(ns)); } catch { /* exists */ }
}

function loadFromDisk(ns: Namespace): Record<string, string> {
	try {
		const ab = Switch.readFileSync(storageFile(ns));
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

function writeToDisk(ns: Namespace, map: Record<string, string>): void {
	try {
		ensureStorageDir(ns);
		const text = JSON.stringify(map);
		Switch.writeFileSync(storageFile(ns), text);
	} catch {
		// Disk write failed — keep in-memory state consistent so the
		// session continues, but the data won't survive a reload. A
		// future Tier-2 enhancement can surface a StorageEvent or
		// throw QuotaExceededError per spec.
	}
}

class WebStorage {
	#data: Record<string, string>;
	#loadedNs: Namespace;

	constructor() {
		this.#loadedNs = pickNamespace();
		this.#data = loadFromDisk(this.#loadedNs);
	}

	/** Before each access, check whether the active namespace changed
	 * since we last loaded (i.e. the user navigated to/from a dev page).
	 * If so, drop the in-memory cache and reload from the new namespace's
	 * file so reads return its data, not the prior namespace's. */
	#syncNs(): void {
		const ns = pickNamespace();
		if (ns === this.#loadedNs) return;
		this.#loadedNs = ns;
		this.#data = loadFromDisk(ns);
	}

	get length(): number {
		this.#syncNs();
		return Object.keys(this.#data).length;
	}

	key(index: number): string | null {
		this.#syncNs();
		if (!Number.isInteger(index) || index < 0) return null;
		const keys = Object.keys(this.#data);
		return keys[index] ?? null;
	}

	getItem(key: string): string | null {
		this.#syncNs();
		const k = String(key);
		return Object.prototype.hasOwnProperty.call(this.#data, k) ? this.#data[k] : null;
	}

	setItem(key: string, value: string): void {
		this.#syncNs();
		const k = String(key);
		const v = String(value);
		if (this.#data[k] === v) return; // no-op write, skip disk
		this.#data[k] = v;
		writeToDisk(this.#loadedNs, this.#data);
	}

	removeItem(key: string): void {
		this.#syncNs();
		const k = String(key);
		if (!Object.prototype.hasOwnProperty.call(this.#data, k)) return;
		delete this.#data[k];
		writeToDisk(this.#loadedNs, this.#data);
	}

	clear(): void {
		this.#syncNs();
		if (Object.keys(this.#data).length === 0) return;
		this.#data = {};
		writeToDisk(this.#loadedNs, this.#data);
	}

	/** Used by the Proxy's `ownKeys` / `has` / `getOwnPropertyDescriptor`. */
	_keys(): string[] {
		this.#syncNs();
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
 *
 * `getCurrentUrl` (optional) lets the storage namespace switch between
 * `default` and `dev` based on the active page URL — see the namespace
 * dispatcher above. Pass `BrowserShell.getCurrentPageUrl.bind(shell)`
 * (or an arrow wrapping it) so the closure reads the up-to-date URL on
 * each storage access. Without it, all writes go to `default`.
 */
export function installLocalStorage(getCurrentUrl?: () => string): void {
	if (installed) return;
	installed = true;
	if (getCurrentUrl) getCurrentPageUrl = getCurrentUrl;
	const storage = wrapWithProxy(new WebStorage());
	Object.defineProperty(globalThis, 'localStorage', {
		value: storage,
		writable: false,
		configurable: true,
		enumerable: true,
	});
}
