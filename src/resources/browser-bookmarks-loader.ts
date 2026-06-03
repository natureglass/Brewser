import type { ResourceLoader, ResourceRequest } from '@switch-web/runtime';
import type { BookmarksStore } from '../navigation/bookmarks-store.js';

const BOOKMARKS_URL = 'brewser://bookmarks.json';

/**
 * Serves the current `BookmarksStore` as JSON at `brewser://bookmarks.json`.
 *
 * Mirrors `BrowserHistoryLoader`: the HTML bookmarks page at
 * `brewser://bookmarks/` (pages/bookmarks.html) uses the static-page
 * route via `BrowserResourceLoader` — its `<browser-bookmarks>` tag
 * reads the store directly. This loader stays around as a clean JSON
 * API for any future page that wants the data via
 * `fetch('brewser://bookmarks.json')`. The `.json` suffix is what
 * keeps the two routes from colliding (same trick as the history
 * loader).
 */
export class BrowserBookmarksLoader implements ResourceLoader {
	constructor(private readonly bookmarksStore: BookmarksStore) {}

	canLoad(request: ResourceRequest): boolean {
		return request.url === BOOKMARKS_URL;
	}

	async load(_request: ResourceRequest): Promise<Response> {
		const entries = this.bookmarksStore.list();
		return new Response(JSON.stringify(entries), {
			status: 200,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'x-browser-page': BOOKMARKS_URL,
			},
		});
	}
}
