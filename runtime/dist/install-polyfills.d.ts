import type { StorageProfileLike } from './profile/storage-profile.js';
/**
 * Options accepted by {@link installPolyfills}.
 */
export interface InstallPolyfillsOptions {
    /** Profile passed through to {@link installLocalStorage} and
     * {@link installIndexedDB}. When omitted, both storage drivers
     * fall back to a single-namespace default at
     * `DEFAULT_PROFILE_ROOT`. */
    profile?: StorageProfileLike;
    /** Source of the active page URL, called on every storage access
     * so the {@link StorageProfileLike.pickStorageNamespace} dispatcher
     * sees up-to-date input. The brewser shell passes
     * `() => shell.getCurrentPageUrl()`. Optional — when omitted, the
     * picker receives `''`. */
    getCurrentUrl?: () => string;
    /** Skip {@link installSafeConsoleRedirect}. The shipping brewser
     * shell never needs this, but a test harness that captures
     * `console.log` output may want to disable the redirect. Default
     * `false`. */
    skipSafeConsole?: boolean;
}
/**
 * Install every Web Platform polyfill the runtime ships, in the order
 * the brewser shell expects. Centralizes the install sequence so
 * embedded NRO apps don't have to replicate `main.ts`'s install block.
 *
 * Order is load-bearing:
 *  - `installSafeConsoleRedirect` runs FIRST — before any other code
 *    can trigger a global `console.log`, which nx.js would route to
 *    `$.print` and flip the runtime from canvas-render mode into
 *    text-render mode (see the safe-console memory). Subsequent
 *    installs are write-once; their order among each other is mostly
 *    cosmetic.
 *  - Storage installs (`installLocalStorage` / `installIndexedDB`)
 *    receive the {@link StorageProfileLike} + URL getter so namespace
 *    dispatch works on first access.
 *  - `installPointerLock(LiveElement)` mounts the spec method on the
 *    LiveElement prototype that page scripts see as `Element`.
 *
 * Each installer is idempotent — calling `installPolyfills` twice is
 * harmless (subsequent calls are no-ops). The shell still inlines its
 * install block to keep the comments visible for archaeology; new
 * embedders should call this helper instead.
 */
export declare function installPolyfills(opts?: InstallPolyfillsOptions): void;
//# sourceMappingURL=install-polyfills.d.ts.map