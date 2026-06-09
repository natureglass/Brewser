import { NavigationController, type WebView } from '@switch-web/runtime';
import type { HistoryStore } from './history-store.js';

const ERROR_URL = 'brewser://error/';
const HOME_URL = 'brewser://home/';

/** URLs that should never be persisted to the visit history. */
const EXCLUDED_FROM_HISTORY = new Set<string>([HOME_URL, ERROR_URL]);

/**
 * Ties navigation requests to a `WebView` and the runtime's
 * `NavigationController`. The controller records the *requested* URL even
 * when the load falls back to the error page so back/forward and the address
 * bar reflect what the user tried to visit.
 *
 * If a `HistoryStore` is supplied, successful **user-initiated** navigations
 * (i.e. `navigate()` calls, not back/forward/reload) are persisted to the
 * profile's history journal. The home page and error page are excluded so
 * they never clutter "Recent".
 */
export class BrowserNavigation {
	readonly controller: NavigationController;
	private readonly webView: WebView;
	private readonly historyStore: HistoryStore | undefined;
	/** Title extracted from the loaded page's `<title>`. Reset on every
	 * new navigation so a slow/failed load can't carry the previous
	 * page's label into the new URL's history entry. */
	private currentTitleValue: string | null = null;

	constructor(webView: WebView, historyStore?: HistoryStore) {
		this.webView = webView;
		this.historyStore = historyStore;
		this.controller = new NavigationController();
	}

	get currentURL(): string | null {
		return this.controller.currentURL;
	}

	get currentTitle(): string | null {
		return this.currentTitleValue;
	}

	setCurrentTitle(title: string | null): void {
		this.currentTitleValue = title;
	}

	async navigate(url: string): Promise<void> {
		this.controller.navigate(url);
		await this.loadOrError(url, { record: true });
	}

	async reload(): Promise<void> {
		const url = this.controller.reload();
		if (url) {
			await this.loadOrError(url, { record: false });
		}
	}

	async goBack(): Promise<void> {
		const url = this.controller.goBack();
		if (url) {
			await this.loadOrError(url, { record: false });
		}
	}

	async goForward(): Promise<void> {
		const url = this.controller.goForward();
		if (url) {
			await this.loadOrError(url, { record: false });
		}
	}

	private async loadOrError(url: string, opts: { record: boolean }): Promise<void> {
		try {
			await this.webView.load({ url });
			if (opts.record) {
				this.recordVisit(url);
			}
		} catch (error) {
			const detail = describeError(error);
			console.debug(`[brewser] load failed for ${url}: ${detail.message}`);
			if (url !== ERROR_URL) {
				(globalThis as { __browserLastError?: LastErrorDetail }).__browserLastError = {
					url,
					...detail,
				};
				try {
					await this.webView.load({ url: ERROR_URL });
				} catch (innerError) {
					console.debug(`[brewser] error page also failed: ${describeError(innerError).message}`);
				}
			}
		}
	}

	private recordVisit(url: string): void {
		if (!this.historyStore) return;
		if (EXCLUDED_FROM_HISTORY.has(url)) return;
		this.historyStore.record({
			url,
			title: this.currentTitleValue || url,
			visitedAt: Date.now(),
		});
	}
}

interface ErrorDetail {
	message: string;
	errorName: string;
	errorType: string;
	errorStack?: string;
	errorJson?: string;
}

interface LastErrorDetail extends ErrorDetail {
	url: string;
}

function describeError(error: unknown): ErrorDetail {
	const errorType =
		error === null
			? 'null'
			: error === undefined
				? 'undefined'
				: typeof error;
	if (error instanceof Error) {
		let errorJson: string | undefined;
		try {
			const own: Record<string, unknown> = {};
			for (const key of Object.getOwnPropertyNames(error)) {
				if (key === 'stack') continue;
				own[key] = (error as unknown as Record<string, unknown>)[key];
			}
			const text = JSON.stringify(own);
			if (text && text !== '{}') errorJson = text;
		} catch (_) {
			// JSON.stringify can throw on cyclic graphs; just omit.
		}
		const message =
			error.message || error.name || error.toString() || 'Error (empty)';
		return {
			message,
			errorName: error.name || 'Error',
			errorType,
			errorStack: error.stack,
			errorJson,
		};
	}
	let message: string;
	try {
		message = String(error);
	} catch (_) {
		message = '(unprintable error value)';
	}
	if (!message) message = `(${errorType} thrown with no message)`;
	return {
		message,
		errorName: '(non-Error throw)',
		errorType,
	};
}
