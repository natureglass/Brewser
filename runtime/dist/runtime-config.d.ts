import type { ResourceLoader } from './resources/resource-loader.js';
import type { PermissionPolicy } from './permissions/permission-policy.js';
export interface WebViewConfig {
    /** Logical canvas width in CSS pixels. */
    width: number;
    /** Logical canvas height in CSS pixels. */
    height: number;
    /** Run the canvas in fullscreen mode. Currently the only supported value is `true`. */
    fullscreen?: boolean;
    /** Logical origin used for permission checks and resource attribution. */
    origin: string;
    /** Optional per-origin storage path on the SD card. */
    storagePath?: string;
    /**
     * Filesystem-style app root used by the local resource loader when one is
     * not explicitly supplied via `resourceLoaders`. Optional for embedders
     * that build their own loaders.
     */
    appRoot?: string;
    enableWebGL?: boolean;
    enableGamepad?: boolean;
    enableTouch?: boolean;
    enableLocalFetch?: boolean;
    enableNetworkFetch?: boolean;
    /**
     * Resource loaders to register. These run **before** the auto-built
     * defaults so embedders can claim URLs (e.g. `brewser://`) ahead of the
     * local-fetch / native-fetch fallbacks. The `LocalResourceLoader` is
     * still synthesized from `appRoot` when `enableLocalFetch` is true, and
     * `NativeFetchLoader` when `enableNetworkFetch` is true.
     */
    resourceLoaders?: ResourceLoader[];
    /** Permission policy. Falls back to DefaultPermissionPolicy when omitted. */
    permissionPolicy?: PermissionPolicy;
}
export interface WebViewLoadRequest {
    /** Fully-qualified URL, or a logical entry like `app://example/`. */
    url: string;
    /** Optional resolved entry path for bundle-style loading (overrides URL-derived defaults). */
    entryPath?: string;
}
export interface WebViewDelegate {
    onPageStarted?(url: string): void;
    onPageFinished?(url: string): void;
    onPageError?(url: string, error: unknown): void;
    onConsoleMessage?(message: string): void;
    /**
     * Called when `WebView.load()` fetches a response whose `Content-Type` is
     * `text/html` or `application/xhtml+xml`. The runtime never tries to
     * `new AsyncFunction`-evaluate HTML bodies; embedders that want to render
     * HTML supply this hook. If the hook is omitted, an HTML response throws
     * and propagates as a load failure.
     */
    onHtmlResponse?(url: string, html: string): void | Promise<void>;
}
//# sourceMappingURL=runtime-config.d.ts.map