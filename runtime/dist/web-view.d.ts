/** Toggle the WebView's navigation-flow diag log
 * (`sdmc:/switch/brewser/logs/shell-nav-diag.log`). Off by default. The
 * brewser shell flips this on at startup when `config.json`'s
 * `navDebug` key is `true`. Pair with `setShellInputDebugEnabled` /
 * `setTouchDebugEnabled` on the shell side so all three writers share
 * one gate. */
export declare function setNavDebugEnabled(enabled: boolean): void;
import type { WebViewConfig, WebViewDelegate, WebViewLoadRequest } from './runtime-config.js';
export type { WebViewConfig, WebViewDelegate, WebViewLoadRequest } from './runtime-config.js';
/**
 * Lifecycle wrapper around the nx.js full-screen canvas.
 *
 * A WebView owns one app session at a time. `initialize()` installs the
 * browser/gamepad/touch shims once and configures runtime fetch.
 * `loadBundle()` or `load()` then executes the JS bundle inside that session.
 * `destroy()` ends the session, which restores fetch and clears tracked
 * listeners/timers.
 */
export declare class WebView {
    private readonly config;
    private readonly delegate;
    private readonly canvas;
    private readonly nativeFetch;
    private initialized;
    private sessionActive;
    private url;
    constructor(config: WebViewConfig, delegate?: WebViewDelegate);
    get currentURL(): string | null;
    initialize(): void;
    load(request: WebViewLoadRequest): Promise<void>;
    loadBundle(entryPath: string): Promise<void>;
    reload(): Promise<void>;
    stop(): void;
    destroy(): void;
    private runSession;
    private beginSession;
    private endSession;
    private executeBundle;
    private fetchAndExecute;
}
//# sourceMappingURL=web-view.d.ts.map