/**
 * Per-origin `localStorage` backing store.
 *
 * Placeholder. The eventual implementation persists each origin's key/value
 * map to `<profileRoot>/<origin>/local-storage.json`.
 */
export class LocalStorageStore {
	private maps = new Map<string, Map<string, string>>();

	for(origin: string): Map<string, string> {
		let map = this.maps.get(origin);
		if (!map) {
			map = new Map();
			this.maps.set(origin, map);
		}
		return map;
	}

	clear(origin?: string): void {
		if (origin === undefined) {
			this.maps.clear();
		} else {
			this.maps.delete(origin);
		}
	}
}
