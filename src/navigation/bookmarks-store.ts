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
				if (
					entry &&
					typeof entry.url === 'string' &&
					typeof entry.addedAt === 'number'
				) {
					this.bookmarks.push({
						url: entry.url,
						title: typeof entry.title === 'string' ? entry.title : entry.url,
						addedAt: entry.addedAt,
					});
				}
			}
		} catch (error) {
			// File missing on first run is normal; any other read failure
			// just leaves the list empty for this session.
			console.debug(`[switch-web-browser] bookmarks load failed: ${error}`);
		}
	}

	private persist(): void {
		try {
			Switch.writeFileSync(this.path, JSON.stringify(this.bookmarks, null, 2));
		} catch (error) {
			console.debug(`[switch-web-browser] bookmarks persist failed: ${error}`);
		}
	}
}
