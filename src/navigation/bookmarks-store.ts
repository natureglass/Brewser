/**
 * Bookmarks list, scoped to a `BrowserProfile`. Persisted as a single
 * JSON array at `<profileRoot>bookmarks.json`. Loaded in the
 * constructor and rewritten synchronously on every mutating call —
 * matches the `HistoryStore` shape so the resource loader can hand
 * either out as a `[{ url, title, ... }]` list.
 */
export interface Bookmark {
	url: string;
	title: string;
	addedAt: number;
	/** Optional one-line description shown under the title in the
	 * settings list. Hand-authored bookmarks may include it. */
	description?: string;
}

const decoder = new TextDecoder();

export interface BookmarksStoreOptions {
	/** Absolute SD-card path to the bookmarks JSON file. */
	path: string;
}

export class BookmarksStore {
	private readonly path: string;
	private bookmarks: Bookmark[] = [];

	constructor(options: BookmarksStoreOptions) {
		this.path = options.path;
		this.load();
	}

	/** Most-recently added first. */
	list(): Bookmark[] {
		return this.bookmarks.slice().reverse();
	}

	has(url: string): boolean {
		return this.bookmarks.some((b) => b.url === url);
	}

	add(bookmark: Bookmark): void {
		if (this.has(bookmark.url)) return;
		this.bookmarks.push(bookmark);
		this.persist();
	}

	remove(url: string): void {
		const next = this.bookmarks.filter((b) => b.url !== url);
		if (next.length === this.bookmarks.length) return;
		this.bookmarks = next;
		this.persist();
	}

	/** Wipe every bookmark. Used by the bookmarks page's
	 * `Clear Bookmarks` button (`data-action="clear-bookmarks"`).
	 * No-op when the list is already empty so we don't rewrite the
	 * file for nothing. */
	clear(): void {
		if (this.bookmarks.length === 0) return;
		this.bookmarks = [];
		this.persist();
	}

	/**
	 * Toggle the given URL. Returns the new "is bookmarked" state — so
	 * the caller can update the star indicator without a second `has()`
	 * check.
	 */
	toggle(bookmark: Bookmark): boolean {
		if (this.has(bookmark.url)) {
			this.remove(bookmark.url);
			return false;
		}
		this.add(bookmark);
		return true;
	}

	private load(): void {
		try {
			const buffer = Switch.readFileSync(this.path);
			if (!buffer) return;
			const text = decoder.decode(buffer);
			const parsed = JSON.parse(text);
			if (!Array.isArray(parsed)) return;
			for (const entry of parsed) {
				// Only `url` is required. Everything else is coerced
				// leniently so hand-edited bookmarks.json files load:
				//   - `addedAt` accepts a number OR a numeric string
				//     (`"1778919520150"`) — the strict `typeof === 'number'`
				//     check used to silently drop every quoted entry.
				//   - title / description accept either casing
				//     (`title`/`Title`, `description`/`Description`).
				if (!entry || typeof entry.url !== 'string') continue;
				const rawAdded = entry.addedAt;
				const addedAt =
					typeof rawAdded === 'number' && Number.isFinite(rawAdded)
						? rawAdded
						: typeof rawAdded === 'string' && rawAdded.trim() !== '' && Number.isFinite(Number(rawAdded))
							? Number(rawAdded)
							: 0;
				const title =
					typeof entry.title === 'string' ? entry.title
						: typeof entry.Title === 'string' ? entry.Title
							: entry.url;
				const description =
					typeof entry.description === 'string' ? entry.description
						: typeof entry.Description === 'string' ? entry.Description
							: undefined;
				const bookmark: Bookmark = { url: entry.url, title, addedAt };
				if (description) bookmark.description = description;
				this.bookmarks.push(bookmark);
			}
		} catch (error) {
			// File missing on first run is normal; any other read failure
			// just leaves the list empty for this session.
			console.debug(`[brewser] bookmarks load failed: ${error}`);
		}
	}

	private persist(): void {
		try {
			Switch.writeFileSync(this.path, JSON.stringify(this.bookmarks, null, 2));
		} catch (error) {
			console.debug(`[brewser] bookmarks persist failed: ${error}`);
		}
	}
}
