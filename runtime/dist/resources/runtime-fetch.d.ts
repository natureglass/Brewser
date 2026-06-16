/// <reference types="@nx.js/runtime" />
import { type ResourceLoader } from './resource-loader.js';
export interface RuntimeFetchOptions {
    /** Ordered list of resource loaders to try for each request. */
    loaders: ResourceLoader[];
    /** Logical origin of the running app, surfaced to loaders via `ResourceRequest.origin`. */
    origin: string;
    /**
     * When true, requests not handled by any loader fall through to the
     * captured native fetch. When false, unhandled requests return 403.
     *
     * Defaults to `false` so local apps cannot quietly reach the network.
     */
    allowNativeFetchFallback?: boolean;
    /**
     * Restore the previous `globalThis.fetch` on app-session end. Defaults to true.
     * Setting this to false is mainly useful for tests or hosts that manage
     * the global fetch lifecycle themselves.
     */
    restoreOnSessionEnd?: boolean;
}
interface InstalledRuntimeFetch {
    /** Manually restore the original `globalThis.fetch` (idempotent). */
    uninstall: () => void;
}
/**
 * Replace `globalThis.fetch` with a runtime-managed wrapper that tries each
 * registered `ResourceLoader` in order. The previously-installed fetch is
 * captured and restored on `uninstall()` or at app-session end, so successive
 * apps never inherit each other's fetch overrides.
 */
export declare function installRuntimeFetch(options: RuntimeFetchOptions): InstalledRuntimeFetch;
/** Capture the original `globalThis.fetch` before any runtime override is installed. */
export declare function captureNativeFetch(): typeof fetch;
export {};
//# sourceMappingURL=runtime-fetch.d.ts.map