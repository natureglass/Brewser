/**
 * In-memory cookie jar for the browser session.
 *
 * Captures `Set-Cookie` headers from responses and re-attaches matching
 * cookies to subsequent outgoing requests, following the subset of RFC
 * 6265 that matters for ordinary session round-trips:
 *
 *   - (name, domain, path) identity for replace-vs-add.
 *   - Domain match: exact host, or host is a subdomain of cookie.domain.
 *   - Path match: exact, or cookie.path is a directory prefix.
 *   - `Expires` / `Max-Age` honored; expired cookies are not sent
 *     (and a Set-Cookie with `Max-Age=0` deletes the existing entry).
 *   - `Secure` honored: those cookies only attach to `https://`.
 *   - `HttpOnly` parsed and stored for completeness (the engine has no
 *     JS-side `document.cookie` reading path right now, so it's not
 *     enforced anywhere — but it's recorded so we can enforce later
 *     without a re-ingest).
 *
 * Intentionally out of scope:
 *   - Disk persistence. Cookies live for the browser-session
 *     lifetime; closing the .nro clears them. A `<profile>/cookies.json`
 *     can be wired in later by adding `load()` / `save()` methods
 *     and calling them from BrowserShell startup / shutdown.
 *   - Public Suffix List enforcement. We accept any Domain= the server
 *     sets. A page setting `Domain=com` would be a real-browser bug
 *     too, just one we don't actively block.
 *   - `SameSite` enforcement. Single-user single-process browser has
 *     no cross-site context to defend against.
 *
 * Owned by `SwitchUaFetchLoader`; one jar per browser session.
 */

interface StoredCookie {
	name: string;
	value: string;
	/** Lowercased; no leading dot. */
	domain: string;
	/** Path scope; always starts with `/`. */
	path: string;
	/** Unix ms; `undefined` means session cookie (alive until clear()). */
	expires?: number;
	secure: boolean;
	httpOnly: boolean;
}

/** Identity key per RFC 6265 — a new Set-Cookie with the same
 * (domain, path, name) tuple replaces the prior entry. */
type CookieKey = string;

export class CookieJar {
	private readonly cookies = new Map<CookieKey, StoredCookie>();

	/**
	 * Parse the `Set-Cookie` headers from `response` and store any
	 * cookies that result. `requestUrl` is the URL the response came
	 * from — used as the default for `Domain=` / `Path=` when the
	 * server omits them.
	 */
	ingest(requestUrl: string, response: Response): void {
		let reqUrl: URL;
		try { reqUrl = new URL(requestUrl); } catch (_) { return; }

		for (const header of readSetCookieHeaders(response.headers)) {
			const cookie = parseSetCookie(header, reqUrl);
			if (!cookie) continue;
			const key = keyOf(cookie);
			if (cookie.expires !== undefined && cookie.expires <= Date.now()) {
				// Server is deleting the cookie (Max-Age=0 or past Expires=).
				this.cookies.delete(key);
			} else {
				this.cookies.set(key, cookie);
			}
		}
	}

	/**
	 * Compute the `Cookie` header value for a request to `requestUrl`,
	 * containing all matching, non-expired cookies in path-length order
	 * (longest first per RFC 6265 §5.4 step 2). Returns `undefined`
	 * when no cookies apply.
	 */
	cookieHeaderFor(requestUrl: string): string | undefined {
		let u: URL;
		try { u = new URL(requestUrl); } catch (_) { return undefined; }
		const host = u.hostname.toLowerCase();
		const path = u.pathname || '/';
		const isSecure = u.protocol === 'https:';
		const now = Date.now();

		const matched: StoredCookie[] = [];
		for (const cookie of this.cookies.values()) {
			if (cookie.expires !== undefined && cookie.expires <= now) continue;
			if (cookie.secure && !isSecure) continue;
			if (!domainMatches(host, cookie.domain)) continue;
			if (!pathMatches(path, cookie.path)) continue;
			matched.push(cookie);
		}
		if (matched.length === 0) return undefined;
		matched.sort((a, b) => b.path.length - a.path.length);
		return matched.map((c) => `${c.name}=${c.value}`).join('; ');
	}

	/** Return a copy of `init` with a `Cookie:` header added when any
	 * stored cookies apply to `requestUrl`. Original `init` is not
	 * mutated. If the caller already set a `Cookie:` header explicitly
	 * it wins — we don't overwrite. */
	applyTo(requestUrl: string, init: RequestInit | undefined): RequestInit {
		const cookieHeader = this.cookieHeaderFor(requestUrl);
		const merged: RequestInit = init ? { ...init } : {};
		if (!cookieHeader) return merged;
		const headers = new Headers(merged.headers as HeadersInit | undefined);
		if (!headers.has('cookie')) {
			headers.set('Cookie', cookieHeader);
			merged.headers = headers;
		} else {
			// Preserve caller header, but still surface our merged
			// `Headers` so downstream sees a consistent shape.
			merged.headers = headers;
		}
		return merged;
	}

	/** Diagnostic — number of stored cookies (including expired ones
	 * not yet swept). Used by tests / a future settings UI. */
	size(): number { return this.cookies.size; }

	/** Drop every stored cookie. */
	clear(): void { this.cookies.clear(); }
}

// =========================================================================
// Set-Cookie parsing + matching helpers (RFC 6265 §5)
// =========================================================================

/** Per Fetch spec, `Headers.getSetCookie()` returns each `Set-Cookie`
 * response header as a separate string — the only API that doesn't
 * fold multiple values with `, ` (which would corrupt `Expires=` date
 * values containing commas). We fall back to `forEach` when the
 * runtime is too old to expose it; the folded value is usually
 * salvageable for simple cookies but unreliable for date strings. */
function readSetCookieHeaders(headers: Headers): string[] {
	const h = headers as Headers & { getSetCookie?: () => string[] };
	if (typeof h.getSetCookie === 'function') return h.getSetCookie();
	const folded: string[] = [];
	h.forEach((value, name) => {
		if (name.toLowerCase() === 'set-cookie') folded.push(value);
	});
	return folded;
}

function parseSetCookie(header: string, requestUrl: URL): StoredCookie | null {
	const parts = header.split(';').map((s) => s.trim());
	if (parts.length === 0) return null;
	const first = parts[0];
	const eq = first.indexOf('=');
	if (eq <= 0) return null;
	const name = first.slice(0, eq).trim();
	const value = first.slice(eq + 1).trim();
	if (!name) return null;

	let domain = requestUrl.hostname.toLowerCase();
	let path = defaultPathFor(requestUrl);
	let expires: number | undefined;
	let secure = false;
	let httpOnly = false;

	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		const e = part.indexOf('=');
		const attr = (e >= 0 ? part.slice(0, e) : part).trim().toLowerCase();
		const val = e >= 0 ? part.slice(e + 1).trim() : '';
		switch (attr) {
			case 'domain':
				// RFC 6265 §5.2.3 — leading '.' historically allowed; strip.
				if (val) domain = val.toLowerCase().replace(/^\./, '');
				break;
			case 'path':
				if (val.startsWith('/')) path = val;
				break;
			case 'expires': {
				const ts = Date.parse(val);
				if (Number.isFinite(ts)) expires = ts;
				break;
			}
			case 'max-age': {
				// Max-Age wins over Expires per spec — set unconditionally
				// after Expires has been parsed (we iterate in order).
				const secs = parseInt(val, 10);
				if (Number.isFinite(secs)) expires = Date.now() + secs * 1000;
				break;
			}
			case 'secure':
				secure = true;
				break;
			case 'httponly':
				httpOnly = true;
				break;
			// SameSite / Priority / Partitioned ignored — not enforced.
		}
	}

	return { name, value, domain, path, expires, secure, httpOnly };
}

function keyOf(cookie: StoredCookie): CookieKey {
	return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

/** RFC 6265 §5.1.4 default-path: directory portion of the request URL's
 * path, or `'/'` when the path is empty, root, or doesn't start with
 * `'/'`. */
function defaultPathFor(u: URL): string {
	const p = u.pathname || '/';
	if (!p.startsWith('/') || p === '/') return '/';
	const lastSlash = p.lastIndexOf('/');
	return lastSlash <= 0 ? '/' : p.slice(0, lastSlash);
}

/** RFC 6265 §5.1.3 domain match — exact host equality, or host is a
 * proper subdomain of cookieDomain (i.e. host ends with
 * `'.' + cookieDomain`). Public-suffix enforcement is intentionally
 * skipped. */
function domainMatches(host: string, cookieDomain: string): boolean {
	if (!cookieDomain) return false;
	if (host === cookieDomain) return true;
	return host.endsWith('.' + cookieDomain);
}

/** RFC 6265 §5.1.4 path match — exact equality, OR cookiePath is a
 * proper prefix of reqPath with a boundary on `/`. */
function pathMatches(reqPath: string, cookiePath: string): boolean {
	if (reqPath === cookiePath) return true;
	if (!reqPath.startsWith(cookiePath)) return false;
	if (cookiePath.endsWith('/')) return true;
	return reqPath[cookiePath.length] === '/';
}
