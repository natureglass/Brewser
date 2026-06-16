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
/// <reference types="@nx.js/runtime" />
export declare class CookieJar {
    private readonly cookies;
    /**
     * Parse the `Set-Cookie` headers from `response` and store any
     * cookies that result. `requestUrl` is the URL the response came
     * from — used as the default for `Domain=` / `Path=` when the
     * server omits them.
     */
    ingest(requestUrl: string, response: Response): void;
    /**
     * Compute the `Cookie` header value for a request to `requestUrl`,
     * containing all matching, non-expired cookies in path-length order
     * (longest first per RFC 6265 §5.4 step 2). Returns `undefined`
     * when no cookies apply.
     */
    cookieHeaderFor(requestUrl: string): string | undefined;
    /** Return a copy of `init` with a `Cookie:` header added when any
     * stored cookies apply to `requestUrl`. Original `init` is not
     * mutated. If the caller already set a `Cookie:` header explicitly
     * it wins — we don't overwrite. */
    applyTo(requestUrl: string, init: RequestInit | undefined): RequestInit;
    /** Diagnostic — number of stored cookies (including expired ones
     * not yet swept). Used by tests / a future settings UI. */
    size(): number;
    /** Drop every stored cookie. */
    clear(): void;
}
//# sourceMappingURL=cookie-jar.d.ts.map