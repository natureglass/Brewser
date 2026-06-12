import {
	type ResourceLoader,
	type ResourceRequest,
} from '@switch-web/runtime';

/**
 * Delegates `sdmc:`, `romfs:`, and `file:` URLs to the captured nxjs
 * native fetch.
 *
 * Why this exists: once `WebView` starts its first app session, the
 * runtime installs `runtimeFetch` over `globalThis.fetch` and appends
 * a `NativeFetchLoader` to the end of the loader chain. That loader
 * claims every URL with a protocol and then denies anything
 * `BrowserPermissionPolicy.allowNetworkURL` doesn't accept — and the
 * policy only allows `http(s):`, `blob:`, `data:`. So an
 * `Image.src = 'sdmc:/…/home.png'` (e.g. a chrome icon refresh after
 * the user changes templates in Settings) goes through the wrapper,
 * gets a 403 deniedResponse, and `loadImage` resolves null, leaving the
 * chrome painting fallback glyphs in place of the toolbar PNGs.
 *
 * Registering this loader BEFORE the runtime's NativeFetchLoader sees
 * local-scheme URLs short-circuits them through the captured nxjs fetch
 * (the one we snapshot BEFORE the wrapper installs itself), which reads
 * straight off the SD card / romfs partition via `fetchFile`. The
 * permission policy is intentionally NOT consulted — local file reads
 * happen all over the shell (icons, click.wav, page-script asset URLs)
 * and have nothing to do with the network gate.
 *
 * The captured fetch is passed in (not re-captured here) so the caller
 * controls timing — re-capturing during a session would just hand back
 * the wrapper itself and create an infinite loop on local URLs.
 */
export class LocalSchemeFetchLoader implements ResourceLoader {
	private readonly nativeFetch: typeof fetch;

	constructor(nativeFetch: typeof fetch) {
		this.nativeFetch = nativeFetch;
	}

	canLoad(request: ResourceRequest): boolean {
		const url = request.url;
		return url.startsWith('sdmc:') || url.startsWith('romfs:') || url.startsWith('file:');
	}

	load(request: ResourceRequest): Promise<Response> {
		return this.nativeFetch(request.url, request.init);
	}
}
