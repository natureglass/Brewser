/**
 * HTTP cache scoped to one `BrowserProfile`.
 *
 * Placeholder. The eventual implementation honors `Cache-Control`, applies
 * eviction by total size, and persists entries to disk.
 */
export interface CacheEntry {
	url: string;
	body: Uint8Array;
	headers: Record<string, string>;
	storedAt: number;
}

export class CacheStore {
	private entries = new Map<string, CacheEntry>();

	get(url: string): CacheEntry | undefined {
		return this.entries.get(url);
	}

	put(entry: CacheEntry): void {
		this.entries.set(entry.url, entry);
	}

	clear(): void {
		this.entries.clear();
	}
}
