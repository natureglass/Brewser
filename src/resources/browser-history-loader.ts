import type { ResourceLoader, ResourceRequest } from '@switch-web/runtime';
import type { HistoryStore } from '../navigation/history-store.js';

const HISTORY_URL = 'brewser://history.json';

/**
 * Serves the current `HistoryStore` as JSON at `brewser://history.json`.
 *
 * Settings page's `<browser-history>` tag reads the store directly,
 * but this loader stays around as a clean JSON API surface for any
 * future page that wants the data via `fetch('brewser://history.json')`.
 * The HTML history page at `brewser://history/` (pages/history.html)
 * uses the static-page route via `BrowserResourceLoader`; this loader's
 * URL was moved to a `.json` suffix so the two routes don't collide.
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
