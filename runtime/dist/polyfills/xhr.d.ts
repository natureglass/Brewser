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
export declare function installXMLHttpRequest(): void;
//# sourceMappingURL=xhr.d.ts.map