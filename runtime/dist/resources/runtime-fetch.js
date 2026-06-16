import { trackAppCleanup } from '../session/app-session.js';
import { getRequestUrl } from './path-utils.js';
import { deniedResponse, notFoundResponse, } from './resource-loader.js';
let activeRuntimeFetch = null;
/**
 * Replace `globalThis.fetch` with a runtime-managed wrapper that tries each
 * registered `ResourceLoader` in order. The previously-installed fetch is
 * captured and restored on `uninstall()` or at app-session end, so successive
 * apps never inherit each other's fetch overrides.
 */
export function installRuntimeFetch(options) {
    // Always tear down any prior runtime fetch override before installing a
    // new one. This prevents an exited app's wrapper from sitting under a new
    // app's wrapper and leaking root paths or permissions across sessions.
    if (activeRuntimeFetch) {
        activeRuntimeFetch.uninstall();
    }
    const previousFetch = globalThis.fetch.bind(globalThis);
    const { loaders, origin } = options;
    const allowNativeFetchFallback = options.allowNativeFetchFallback ?? false;
    const restoreOnSessionEnd = options.restoreOnSessionEnd ?? true;
    let uninstalled = false;
    async function runtimeFetch(input, init) {
        const url = getRequestUrl(input);
        const request = { url, init, origin };
        for (const loader of loaders) {
            if (loader.canLoad(request)) {
                return loader.load(request);
            }
        }
        if (allowNativeFetchFallback) {
            return previousFetch(input, init);
        }
        console.debug(`[switch-web/runtime] no loader accepted: ${url}`);
        // Distinguish "couldn't find anywhere to load this" from "explicit deny"
        // when the URL clearly has a network scheme.
        if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url) && !url.startsWith('/')) {
            return deniedResponse(url, 'Network access denied');
        }
        return notFoundResponse(url);
    }
    globalThis.fetch = runtimeFetch;
    const installed = {
        uninstall() {
            if (uninstalled) {
                return;
            }
            uninstalled = true;
            if (activeRuntimeFetch === installed) {
                activeRuntimeFetch = null;
            }
            globalThis.fetch = previousFetch;
        },
    };
    activeRuntimeFetch = installed;
    if (restoreOnSessionEnd) {
        trackAppCleanup(() => installed.uninstall());
    }
    return installed;
}
/** Capture the original `globalThis.fetch` before any runtime override is installed. */
export function captureNativeFetch() {
    return globalThis.fetch.bind(globalThis);
}
//# sourceMappingURL=runtime-fetch.js.map