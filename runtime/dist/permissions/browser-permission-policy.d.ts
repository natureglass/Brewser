import type { PermissionPolicy } from './permission-policy.js';
export interface BrowserPermissionPolicyOptions {
    /** Whether to allow gamepad/controller input. Defaults to true. */
    allowGamepad?: boolean;
    /** Whether to allow touch input. Defaults to true. */
    allowTouch?: boolean;
    /** Whether to allow WebGL. Defaults to true. */
    allowWebGL?: boolean;
    /**
     * Whether to allow `http(s)://` fetches via `NativeFetchLoader`.
     *
     * Defaults to `true` as of milestone C1: the `WebView` now routes
     * `text/html` responses to `WebViewDelegate.onHtmlResponse` (currently a
     * stub painter) instead of evaluating them as JS, so network HTML no
     * longer crashes the page session. Set to `false` to gate network access
     * back off — unknown URLs then short-circuit to a 403 inside the runtime
     * fetch wrapper, which falls back to `brewser://error/`.
     */
    allowNetwork?: boolean;
}
/**
 * Browser-side permission policy.
 *
 * Defaults (per `docs/security-model.md`):
 *  - local file access: denied for http(s) pages; the browser must register
 *    its own loader for `brewser://` / `nx-internal://` pages.
 *  - network access: **enabled by default** as of milestone C1. HTML
 *    responses are diverted to the browser's `onHtmlResponse` delegate
 *    instead of being eval'd as JS, so `http(s)://` URLs no longer crash
 *    the page session. Set `allowNetwork: false` to gate it back off.
 *  - gamepad / touch / WebGL: enabled.
 *  - persistent storage: allowed per origin (a profile/storage driver
 *    will be wired later).
 */
export declare class BrowserPermissionPolicy implements PermissionPolicy {
    private readonly gamepad;
    private readonly touch;
    private readonly webgl;
    private readonly network;
    constructor(options?: BrowserPermissionPolicyOptions);
    /** Public read of the network gate so the shell can mirror it into `WebView.enableNetworkFetch`. */
    get networkEnabled(): boolean;
    allowLocalFile(_path: string): boolean;
    allowNetworkURL(url: string): boolean;
    allowGamepad(): boolean;
    allowTouch(): boolean;
    allowWebGL(): boolean;
    allowPersistentStorage(_origin: string): boolean;
}
//# sourceMappingURL=browser-permission-policy.d.ts.map