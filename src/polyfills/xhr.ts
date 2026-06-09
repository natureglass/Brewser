/**
 * Tier-1 `XMLHttpRequest` polyfill for brewser.
 *
 * Implements the subset of XHR that Cocos Creator / GameMaker / Construct 3
 * HTML5 exports / itch.io games typically rely on: open/send/abort,
 * setRequestHeader, readyState/status/statusText, response/responseText/
 * responseType (text/arraybuffer/blob/json), the standard event handlers
 * (onreadystatechange, onload, onerror, onabort, ontimeout, onloadstart,
 * onloadend, onprogress), and EventTarget-style addEventListener /
 * removeEventListener / dispatchEvent. Backed by `globalThis.fetch`.
 *
 * Tier-1 scope:
 * - GET / POST / PUT / DELETE / HEAD (any method fetch accepts)
 * - Request body: string, ArrayBuffer / ArrayBufferView, Blob, FormData,
 *   URLSearchParams — anything fetch's body init accepts
 * - Response readbacks: text (default), arraybuffer, blob, json
 * - Synchronous timeouts via the spec `timeout` property + AbortController
 * - `getResponseHeader(name)` + `getAllResponseHeaders()` from fetch
 *   Response.headers (case-insensitive name lookup, spec-shaped CRLF
 *   block for the all-headers form)
 * - `responseURL` from the fetch Response (post-redirect URL)
 *
 * Skipped (Tier-2):
 * - `responseType = 'document'` (no DOMParser surface)
 * - Real upload progress events (we fire load+loadend once, no streaming)
 * - `overrideMimeType()` actually changing the decode encoding
 * - `withCredentials` semantics (cookies aren't a thing on Switch homebrew)
 * - Synchronous mode (`async = false` in open(); we always run async)
 * - `responseXML`
 */

type ProgressEvent = {
	type: string;
	target: XMLHttpRequest;
	currentTarget: XMLHttpRequest;
	lengthComputable: boolean;
	loaded: number;
	total: number;
};

type XHRListener = (this: XMLHttpRequest, ev: ProgressEvent) => void;

const STATE_UNSENT = 0;
const STATE_OPENED = 1;
const STATE_HEADERS_RECEIVED = 2;
const STATE_LOADING = 3;
const STATE_DONE = 4;

class XMLHttpRequest {
	static readonly UNSENT = STATE_UNSENT;
	static readonly OPENED = STATE_OPENED;
	static readonly HEADERS_RECEIVED = STATE_HEADERS_RECEIVED;
	static readonly LOADING = STATE_LOADING;
	static readonly DONE = STATE_DONE;

	readonly UNSENT = STATE_UNSENT;
	readonly OPENED = STATE_OPENED;
	readonly HEADERS_RECEIVED = STATE_HEADERS_RECEIVED;
	readonly LOADING = STATE_LOADING;
	readonly DONE = STATE_DONE;

	readyState: number = STATE_UNSENT;
	status: number = 0;
	statusText: string = '';
	responseText: string = '';
	response: unknown = null;
	responseType: string = '';
	responseURL: string = '';
	timeout: number = 0;
	withCredentials: boolean = false;
	upload: { addEventListener: (...args: unknown[]) => void; removeEventListener: (...args: unknown[]) => void } = {
		// Stub — no streaming upload progress events. add/remove are no-ops
		// so `xhr.upload.onprogress = ...` and `addEventListener('progress', ...)`
		// don't throw when callers wire them up speculatively.
		addEventListener() {},
		removeEventListener() {},
	};

	onreadystatechange: XHRListener | null = null;
	onload: XHRListener | null = null;
	onerror: XHRListener | null = null;
	onabort: XHRListener | null = null;
	ontimeout: XHRListener | null = null;
	onloadstart: XHRListener | null = null;
	onloadend: XHRListener | null = null;
	onprogress: XHRListener | null = null;

	private _method: string = 'GET';
	private _url: string = '';
	private _requestHeaders: Array<[string, string]> = [];
	private _responseHeaders: Headers | null = null;
	private _aborted: boolean = false;
	private _sent: boolean = false;
	private _timedOut: boolean = false;
	private _abortCtrl: AbortController | null = null;
	private _timeoutHandle: number | null = null;
	private _listeners: Map<string, Set<XHRListener>> = new Map();

	open(method: string, url: string, _async?: boolean, _user?: string, _password?: string): void {
		// Spec: open() resets a bunch of state.
		this._method = String(method || 'GET').toUpperCase();
		this._url = String(url || '');
		this._requestHeaders = [];
		this._responseHeaders = null;
		this._aborted = false;
		this._sent = false;
		this._timedOut = false;
		this.status = 0;
		this.statusText = '';
		this.responseText = '';
		this.response = null;
		this.responseURL = '';
		this._setReadyState(STATE_OPENED);
	}

	setRequestHeader(name: string, value: string): void {
		if (typeof name !== 'string') return;
		this._requestHeaders.push([name, String(value)]);
	}

	overrideMimeType(_mime: string): void {
		// Tier-1: accept but no-op. Tier-2 would re-decode arraybuffer body
		// to text using the overridden charset.
	}

	getResponseHeader(name: string): string | null {
		if (!this._responseHeaders || typeof name !== 'string') return null;
		return this._responseHeaders.get(name);
	}

	getAllResponseHeaders(): string {
		if (!this._responseHeaders) return '';
		const out: string[] = [];
		this._responseHeaders.forEach((value, key) => {
			out.push(key + ': ' + value);
		});
		return out.join('\r\n');
	}

	send(body?: BodyInit | null): void {
		if (this.readyState !== STATE_OPENED || this._sent) return;
		this._sent = true;
		this._abortCtrl = (typeof AbortController === 'function') ? new AbortController() : null;

		const headers: Record<string, string> = {};
		for (const [k, v] of this._requestHeaders) {
			// Last write wins — same as the WHATWG spec append-then-combine.
			headers[k] = v;
		}

		// Resolve relative URLs against the document's base URL — the
		// engine's fetch doesn't auto-resolve (it routes via the brewser://
		// loader which expects absolute scheme-prefixed URLs). Spec says
		// XHR.open() resolves against the document base immediately; we
		// defer to send() so the URL captured in `_url` stays as the
		// caller gave it (some callers inspect `_url` between open and send).
		let resolvedUrl = this._url;
		if (resolvedUrl && !/^[a-z][a-z0-9+.-]*:/i.test(resolvedUrl)) {
			const base = (typeof document !== 'undefined' && document.baseURI)
				|| (typeof location !== 'undefined' && location.href)
				|| '';
			if (base) {
				try { resolvedUrl = new URL(this._url, base).href; }
				catch (_) { /* fall through with the original URL */ }
			}
		}

		const init: RequestInit = {
			method: this._method,
			headers,
			body: body == null ? undefined : body,
			signal: this._abortCtrl ? this._abortCtrl.signal : undefined,
		};

		// Spec: loadstart fires once at send-time.
		this._fire('loadstart');

		// Optional timeout — abort the underlying fetch if the timer fires
		// before completion.
		if (this.timeout > 0) {
			this._timeoutHandle = setTimeout(() => {
				if (this.readyState >= STATE_DONE) return;
				this._timedOut = true;
				if (this._abortCtrl) this._abortCtrl.abort();
			}, this.timeout) as unknown as number;
		}

		const self = this;

		fetch(resolvedUrl, init).then(
			async (response) => {
				if (self._aborted) return;
				self.status = response.status;
				self.statusText = response.statusText;
				self.responseURL = response.url;
				self._responseHeaders = response.headers;
				self._setReadyState(STATE_HEADERS_RECEIVED);

				const rtype = self.responseType || '';
				try {
					if (rtype === 'arraybuffer') {
						self.response = await response.arrayBuffer();
					} else if (rtype === 'blob') {
						self.response = await response.blob();
					} else if (rtype === 'json') {
						const text = await response.text();
						self.responseText = text;
						try { self.response = JSON.parse(text); }
						catch (_) { self.response = null; }
					} else {
						// '' / 'text' — default
						self.responseText = await response.text();
						self.response = self.responseText;
					}
				} catch (bodyErr) {
					if (!self._aborted) self._failWith(bodyErr);
					return;
				}

				if (self._aborted) return;
				self._setReadyState(STATE_LOADING);
				self._setReadyState(STATE_DONE);
				self._fire('load');
				self._fire('loadend');
				self._clearTimeout();
			},
			(err) => {
				self._clearTimeout();
				if (self._aborted) {
					self._setReadyState(STATE_DONE);
					self._fire('abort');
					self._fire('loadend');
				} else if (self._timedOut) {
					self._setReadyState(STATE_DONE);
					self._fire('timeout');
					self._fire('loadend');
				} else {
					self._failWith(err);
				}
			},
		);
	}

	abort(): void {
		this._aborted = true;
		this._clearTimeout();
		if (this._abortCtrl) {
			try { this._abortCtrl.abort(); } catch (_) {}
		}
		if (this.readyState >= STATE_OPENED && this.readyState < STATE_DONE) {
			this._setReadyState(STATE_DONE);
			this._fire('abort');
			this._fire('loadend');
		}
	}

	addEventListener(type: string, listener: XHRListener, _opts?: unknown): void {
		if (typeof type !== 'string' || typeof listener !== 'function') return;
		const lower = type.toLowerCase();
		let set = this._listeners.get(lower);
		if (!set) { set = new Set(); this._listeners.set(lower, set); }
		set.add(listener);
	}

	removeEventListener(type: string, listener: XHRListener, _opts?: unknown): void {
		if (typeof type !== 'string') return;
		this._listeners.get(type.toLowerCase())?.delete(listener);
	}

	dispatchEvent(event: { type: string }): boolean {
		if (!event || typeof event.type !== 'string') return true;
		this._fire(event.type);
		return true;
	}

	// --- internals ---------------------------------------------------

	private _setReadyState(state: number): void {
		this.readyState = state;
		this._fire('readystatechange');
	}

	private _fire(type: string): void {
		const lower = type.toLowerCase();
		const ev: ProgressEvent = {
			type: lower,
			target: this,
			currentTarget: this,
			lengthComputable: false,
			loaded: 0,
			total: 0,
		};
		// Built-in on<type> handler (spec order: fired before addEventListener
		// listeners on most implementations, but for our purposes both
		// firing is fine).
		const handler = (this as unknown as Record<string, XHRListener | null>)['on' + lower];
		if (typeof handler === 'function') {
			try { handler.call(this, ev); } catch (e) {
				// IMPORTANT: don't silently swallow. Cocos's onload /
				// onreadystatechange callbacks call deep into asset-pipeline
				// code; a TypeError there must surface so we can diagnose.
				// We still don't rethrow (the spec says event dispatch
				// continues even if a listener throws), but the engine's
				// debug log captures the throw with name + message + stack.
				const err = e as Error | undefined;
				console.debug('[xhr] on' + lower + ' handler THREW:',
					err && err.name, err && err.message,
					err && err.stack ? err.stack.substring(0, 400) : '');
			}
		}
		const set = this._listeners.get(lower);
		if (set) {
			for (const fn of set) {
				try { fn.call(this, ev); } catch (e) {
					const err = e as Error | undefined;
					console.debug('[xhr] ' + lower + ' listener THREW:',
						err && err.name, err && err.message,
						err && err.stack ? err.stack.substring(0, 400) : '');
				}
			}
		}
	}

	private _failWith(_err: unknown): void {
		this._clearTimeout();
		this.status = 0;
		this.statusText = '';
		this._setReadyState(STATE_DONE);
		this._fire('error');
		this._fire('loadend');
	}

	private _clearTimeout(): void {
		if (this._timeoutHandle !== null) {
			clearTimeout(this._timeoutHandle as unknown as ReturnType<typeof setTimeout>);
			this._timeoutHandle = null;
		}
	}
}

let installed = false;

export function installXMLHttpRequest(): void {
	if (installed) return;
	installed = true;
	Object.defineProperty(globalThis, 'XMLHttpRequest', {
		value: XMLHttpRequest, writable: true, configurable: true,
	});
}
