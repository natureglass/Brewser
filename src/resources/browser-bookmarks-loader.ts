import type { ResourceLoader, ResourceRequest } from '@switch-web/runtime';
import type { BookmarksStore } from '../navigation/bookmarks-store.js';

const BOOKMARKS_URL = 'browser://bookmarks/';

/**
 * Serves the current `BookmarksStore` as JSON at `browser://bookmarks/`.
 *
 * Consumed by the library page bundle to populate its "Bookmarks"
 * section. Registered ahead of `BrowserResourceLoader` so the
 * static-page loader doesn't intercept the request first.
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
