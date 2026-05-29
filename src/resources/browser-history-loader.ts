import type { ResourceLoader, ResourceRequest } from '@switch-web/runtime';
import type { HistoryStore } from '../navigation/history-store.js';

const HISTORY_URL = 'browser://history/';

/**
 * Serves the current `HistoryStore` as JSON at `browser://history/`.
 *
 * Settings page's `<browser-history>` tag reads the store directly,
 * but this loader stays around as a clean JSON API surface for any
 * future page that wants the data via `fetch('browser://history/')`.
 * Registered ahead of `BrowserResourceLoader` so the static-page loader
 * doesn't intercept the request first.
 */
export class BrowserHistoryLoader implements ResourceLoader {
	constructor(private readonly historyStore: HistoryStore) {}

	canLoad(request: ResourceRequest): boolean {
		return request.url === HISTORY_URL;
	}

	async load(_request: ResourceRequest): Promise<Response> {
		const entries = this.historyStore.recent(50);
		return new Response(JSON.stringify(entries), {
			status: 200,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'x-browser-page': HISTORY_URL,
			},
		});
	}
}
