import {
	deniedResponse,
	type PermissionPolicy,
	type ResourceLoader,
	type ResourceRequest,
} from '@switch-web/runtime';
import { CookieJar } from './cookie-jar.js';

/**
 * Switch-UA-injecting external-fetch loader.
 *
 * Many sites (notably google.com) sniff the `User-Agent` header and
 * serve a smaller, simpler HTML variant when they see the Nintendo
 * Switch system-browser UA. Without it, libcurl's default
 * `curl/<ver>` UA gets served the full desktop homepage — hundreds of
 * KB of JavaScript that the engine can't execute, which is why pages
 * "load but look broken" on real hardware.
 *
 * This loader claims every `http(s)://` request and injects the
 * Switch system-browser UA before delegating to the captured native
 * fetch. Registered ahead of @switch-web/runtime's `NativeFetchLoader`
 * so it sees external requests first; non-http(s) protocols fall
 * through unchanged. The caller can still override the UA per-request
 * by setting `init.headers['User-Agent']` explicitly.
 */

// The exact Switch UA that google.com's tier3 detector accepts (verified
// against `https://www.google.com/` via curl 2026-05-31). The
// `NintendoBrowser/` token is the part Google keys on; the rest mirrors
// what the Switch system browser actually sends from
// `WifiWebAuthApplet`.
const SWITCH_USER_AGENT =
	'Mozilla/5.0 (Nintendo Switch; WifiWebAuthApplet) AppleWebKit/606.4 (KHTML, like Gecko) NF/6.0.2.20.5 NintendoBrowser/5.1.0.21002';

export type ColorSchemeTheme = 'light' | 'dark';

export interface SwitchUaFetchLoaderOptions {
	nativeFetch: typeof fetch;
	permissionPolicy?: PermissionPolicy;
	/** User-preferred colour scheme. Surfaced to servers as the
	 * `Sec-CH-Prefers-Color-Scheme` client hint so they can serve a
	 * matching theme without a client-side flash. */
	colorScheme?: ColorSchemeTheme;
}

export class SwitchUaFetchLoader implements ResourceLoader {
	private readonly nativeFetch: typeof fetch;
	private readonly permissionPolicy: PermissionPolicy | undefined;
	private colorScheme: ColorSchemeTheme;
	private readonly cookieJar: CookieJar;

	constructor(options: SwitchUaFetchLoaderOptions) {
		this.nativeFetch = options.nativeFetch;
		this.permissionPolicy = options.permissionPolicy;
		this.colorScheme = options.colorScheme ?? 'light';
		this.cookieJar = new CookieJar();
	}

	/** Update the colour-scheme hint sent on subsequent requests. Lets
	 * the shell flip themes at runtime without rebuilding the loader. */
	setColorScheme(scheme: ColorSchemeTheme): void {
		this.colorScheme = scheme;
	}

	/** Drop every cookie collected so far. Wire to a future "clear
	 * browsing data" / private-browsing toggle. */
	clearCookies(): void {
		this.cookieJar.clear();
	}

	canLoad(request: ResourceRequest): boolean {
		const url = request.url;
		return url.startsWith('http://') || url.startsWith('https://');
	}

	async load(request: ResourceRequest): Promise<Response> {
		if (this.permissionPolicy && !this.permissionPolicy.allowNetworkURL(request.url)) {
			console.debug('[switch-web-browser] network fetch denied: ' + request.url);
			return deniedResponse(request.url, 'Network access denied');
		}

		// Pipeline: caller's init → Switch UA + Sec-CH-Prefers-Color-Scheme
		// → matching cookies from the jar → native fetch. After the
		// response lands, harvest any Set-Cookie headers so the next
		// request to a matching origin carries the resulting session.
		const baseInit = withSwitchHeaders(request.init, this.colorScheme);
		const initWithCookies = this.cookieJar.applyTo(request.url, baseInit);
		_cookieDiag('REQ ' + request.url
			+ ' cookieHeader=' + describeCookieHeader(initWithCookies));
		const response = await this.nativeFetch(request.url, initWithCookies);
		// Sniff the raw Set-Cookie surface BEFORE the jar ingests it so
		// we can tell apart "Google sent nothing" vs "jar parser
		// rejected it" vs "Headers API doesn't surface Set-Cookie".
		_cookieDiag('RESP ' + request.url
			+ ' status=' + response.status
			+ ' setCookieCount=' + countSetCookieHeaders(response.headers)
			+ ' setCookieSample=' + sampleSetCookieHeader(response.headers));
		this.cookieJar.ingest(request.url, response);
		_cookieDiag('JAR size=' + this.cookieJar.size());
		return response;
	}
}

// =========================================================================
// Cookie-jar diagnostic — appends one line per outgoing request, one
// per incoming response, and the post-ingest jar size to
// `sdmc:/swb_cookie_diag.log`. Capped at 1000 entries per session.
// Flip `COOKIE_DIAG` to `false` to silence.
// =========================================================================

const COOKIE_DIAG = false;
const COOKIE_DIAG_PATH = 'sdmc:/swb_cookie_diag.log';
const COOKIE_DIAG_CAP = 1000;
let _cookieDiagCount = 0;
function _cookieDiag(msg: string): void {
	if (!COOKIE_DIAG || _cookieDiagCount >= COOKIE_DIAG_CAP) return;
	_cookieDiagCount++;
	try {
		const sw = (globalThis as { Switch?: { appendFileSync?: (p: string, d: string) => void } }).Switch;
		sw?.appendFileSync?.(COOKIE_DIAG_PATH, '[' + new Date().toISOString() + '] ' + msg + '\n');
	} catch (_) { /* ignore */ }
}

function describeCookieHeader(init: RequestInit | undefined): string {
	if (!init || !init.headers) return '(none)';
	const headers = init.headers instanceof Headers
		? init.headers
		: new Headers(init.headers as HeadersInit);
	const c = headers.get('cookie');
	if (!c) return '(none)';
	// Truncate value bodies — names are what matter for diagnostics.
	const names = c.split(';').map((p) => p.trim().split('=')[0]).join(',');
	return '[' + names + ']';
}

function countSetCookieHeaders(headers: Headers): number {
	const h = headers as Headers & { getSetCookie?: () => string[] };
	if (typeof h.getSetCookie === 'function') return h.getSetCookie().length;
	let n = 0;
	h.forEach((_value, name) => { if (name.toLowerCase() === 'set-cookie') n++; });
	return n;
}

function sampleSetCookieHeader(headers: Headers): string {
	const h = headers as Headers & { getSetCookie?: () => string[] };
	let first: string | undefined;
	if (typeof h.getSetCookie === 'function') {
		first = h.getSetCookie()[0];
	} else {
		h.forEach((value, name) => {
			if (first === undefined && name.toLowerCase() === 'set-cookie') first = value;
		});
	}
	if (!first) return '(none)';
	// Just the name=value portion to keep the log readable.
	const semiIdx = first.indexOf(';');
	const head = semiIdx > 0 ? first.slice(0, semiIdx) : first;
	const eqIdx = head.indexOf('=');
	if (eqIdx <= 0) return '(unparseable)';
	const name = head.slice(0, eqIdx);
	const value = head.slice(eqIdx + 1);
	const truncVal = value.length > 16 ? value.slice(0, 16) + '...' : value;
	return name + '=' + truncVal;
}

/** Merge `User-Agent: <Switch>` and `Sec-CH-Prefers-Color-Scheme:
 * "<scheme>"` into a `RequestInit`'s headers, preserving any value the
 * caller already set (so page scripts can opt out per-request). The
 * colour-scheme hint follows the structured-fields syntax (RFC 8941):
 * a quoted token. */
function withSwitchHeaders(
	init: RequestInit | undefined,
	colorScheme: ColorSchemeTheme,
): RequestInit {
	const merged: RequestInit = init ? { ...init } : {};
	const headers = new Headers(merged.headers as HeadersInit | undefined);
	if (!headers.has('user-agent')) {
		headers.set('User-Agent', SWITCH_USER_AGENT);
	}
	if (!headers.has('sec-ch-prefers-color-scheme')) {
		headers.set('Sec-CH-Prefers-Color-Scheme', '"' + colorScheme + '"');
	}
	merged.headers = headers;
	return merged;
}
