import { nxScreen } from './graphics/screen.js';
import { DefaultPermissionPolicy } from './permissions/default-permission-policy.js';
import { LocalResourceLoader } from './resources/local-resource-loader.js';
import { NativeFetchLoader } from './resources/native-fetch-loader.js';
import { captureNativeFetch, installRuntimeFetch, } from './resources/runtime-fetch.js';
import { beginAppSession, endAppSession } from './session/app-session.js';
// Navigation diagnostic — writes each step of session-transition + page-load
// to a separate SDMC file so we can debug hangs when console output isn't
// accessible. Best-effort: appendFileSync may not exist on older nxjs.nro;
// fall back to no-op silently. Single file path means tail it after a hang
// to see exactly where the navigation flow got stuck.
const _NAV_DIAG_PATH = 'sdmc:/switch/brewser/logs/shell-nav-diag.log';
const _navDiagStart = Date.now();
let _navDebugEnabled = false;
/** Toggle the WebView's navigation-flow diag log
 * (`sdmc:/switch/brewser/logs/shell-nav-diag.log`). Off by default. The
 * brewser shell flips this on at startup when `config.json`'s
 * `navDebug` key is `true`. Pair with `setShellInputDebugEnabled` /
 * `setTouchDebugEnabled` on the shell side so all three writers share
 * one gate. */
export function setNavDebugEnabled(enabled) {
    _navDebugEnabled = enabled;
}
function _navDiag(label) {
    if (!_navDebugEnabled)
        return;
    try {
        const sw = globalThis.Switch;
        if (!sw)
            return;
        const line = (Date.now() - _navDiagStart) + 'ms\t' + label + '\n';
        if (typeof sw.appendFileSync === 'function')
            sw.appendFileSync(_NAV_DIAG_PATH, line);
        else if (typeof sw.writeFileSync === 'function')
            sw.writeFileSync(_NAV_DIAG_PATH, line);
    }
    catch { /* swallow */ }
}
import { installBrowserShim } from './shims/browser-shim.js';
import { installGamepadShim } from './shims/gamepad-shim.js';
import { installTouchShim } from './shims/touch-shim.js';
const decoder = new TextDecoder();
const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
function normalizeConfig(config) {
    return {
        width: config.width,
        height: config.height,
        origin: config.origin,
        appRoot: config.appRoot,
        enableWebGL: config.enableWebGL ?? true,
        enableGamepad: config.enableGamepad ?? true,
        enableTouch: config.enableTouch ?? true,
        enableLocalFetch: config.enableLocalFetch ?? true,
        enableNetworkFetch: config.enableNetworkFetch ?? false,
        resourceLoaders: config.resourceLoaders,
        permissionPolicy: config.permissionPolicy ?? new DefaultPermissionPolicy(),
    };
}
function buildLoaders(config, nativeFetch) {
    // Explicit loaders run first so embedders can claim URLs (e.g. `brewser://`)
    // before the auto-built defaults see them. The auto-built Local/Native
    // loaders are still appended afterward based on enableLocalFetch /
    // enableNetworkFetch so embedders don't have to re-register them.
    const loaders = [];
    if (config.resourceLoaders) {
        loaders.push(...config.resourceLoaders);
    }
    if (config.enableLocalFetch && config.appRoot) {
        loaders.push(new LocalResourceLoader({
            appRoot: config.appRoot,
            permissionPolicy: config.permissionPolicy,
        }));
    }
    if (config.enableNetworkFetch) {
        loaders.push(new NativeFetchLoader({
            nativeFetch,
            permissionPolicy: config.permissionPolicy,
        }));
    }
    return loaders;
}
/**
 * Lifecycle wrapper around the nx.js full-screen canvas.
 *
 * A WebView owns one app session at a time. `initialize()` installs the
 * browser/gamepad/touch shims once and configures runtime fetch.
 * `loadBundle()` or `load()` then executes the JS bundle inside that session.
 * `destroy()` ends the session, which restores fetch and clears tracked
 * listeners/timers.
 */
export class WebView {
    config;
    delegate;
    canvas;
    nativeFetch;
    initialized = false;
    sessionActive = false;
    url = null;
    constructor(config, delegate) {
        this.config = normalizeConfig(config);
        this.delegate = delegate;
        this.canvas = nxScreen();
        this.nativeFetch = captureNativeFetch();
    }
    get currentURL() {
        return this.url;
    }
    initialize() {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        if (this.config.enableGamepad && this.config.permissionPolicy.allowGamepad()) {
            installGamepadShim();
        }
        installBrowserShim({
            canvas: this.canvas,
            width: this.config.width,
            height: this.config.height,
        });
        if (this.config.enableTouch && this.config.permissionPolicy.allowTouch()) {
            installTouchShim(this.canvas);
        }
    }
    async load(request) {
        _navDiag('load(' + request.url + ') ENTER');
        this.initialize();
        this.url = request.url;
        try {
            await this.runSession(request.url, async () => {
                if (request.entryPath) {
                    _navDiag('load: about to executeBundle(' + request.entryPath + ')');
                    await this.executeBundle(request.entryPath);
                    _navDiag('load: executeBundle returned');
                }
                else {
                    _navDiag('load: about to fetchAndExecute(' + request.url + ')');
                    await this.fetchAndExecute(request.url);
                    _navDiag('load: fetchAndExecute returned');
                }
            });
            _navDiag('load: runSession returned');
        }
        catch (e) {
            _navDiag('load: runSession THREW: ' + (e instanceof Error ? e.message : String(e)));
            throw e;
        }
    }
    async loadBundle(entryPath) {
        await this.load({ url: entryPath, entryPath });
    }
    async reload() {
        if (this.url) {
            await this.load({ url: this.url });
        }
    }
    stop() {
        this.endSession();
    }
    destroy() {
        this.endSession();
        this.initialized = false;
        this.url = null;
    }
    async runSession(url, runner) {
        this.beginSession();
        this.delegate?.onPageStarted?.(url);
        try {
            await runner();
            this.delegate?.onPageFinished?.(url);
        }
        catch (error) {
            this.delegate?.onPageError?.(url, error);
            throw error;
        }
    }
    beginSession() {
        this.endSession();
        beginAppSession();
        this.sessionActive = true;
        const loaders = buildLoaders(this.config, this.nativeFetch);
        if (loaders.length > 0) {
            installRuntimeFetch({
                loaders,
                origin: this.config.origin,
                allowNativeFetchFallback: this.config.enableNetworkFetch,
            });
        }
    }
    endSession() {
        if (!this.sessionActive) {
            return;
        }
        _navDiag('endSession: dispatching beforeunload');
        // Give page scripts a chance to tear down their own state
        // (timers, intervals, custom rAF/setTimeout overrides) before
        // `endAppSession` removes their event listeners. The browser
        // shim's `globalThis.addEventListener` automatically registers
        // each listener for cleanup on session end — without this
        // dispatch, listeners would be silently removed before any
        // beforeunload-style notification could reach them.
        try {
            globalThis.dispatchEvent(new Event('beforeunload'));
            _navDiag('endSession: beforeunload dispatch returned');
        }
        catch (e) {
            _navDiag('endSession: beforeunload dispatch THREW: ' + (e instanceof Error ? e.message : String(e)));
        }
        this.sessionActive = false;
        _navDiag('endSession: about to endAppSession');
        endAppSession();
        _navDiag('endSession: endAppSession returned');
    }
    async executeBundle(entryUrl) {
        const buffer = Switch.readFileSync(entryUrl);
        if (buffer === null) {
            throw new Error(`JS entry file is missing: ${entryUrl}`);
        }
        const source = decoder.decode(buffer);
        const run = new AsyncFunction(`${source}\n//# sourceURL=${entryUrl}`);
        await run.call(globalThis);
    }
    async fetchAndExecute(url) {
        _navDiag('fetchAndExecute(' + url + ') ENTER, about to fetch');
        // At this point beginSession() has already installed the runtime fetch
        // wrapper, so globalThis.fetch routes through the registered loaders.
        const response = await globalThis.fetch(url);
        _navDiag('fetchAndExecute: fetch returned status=' + response.status);
        if (!response.ok) {
            throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
        }
        const mediaType = parseMediaType(response.headers.get('content-type'));
        if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
            if (!this.delegate?.onHtmlResponse) {
                throw new Error(`HTML response for ${url} but no onHtmlResponse delegate is registered`);
            }
            const html = await response.text();
            _navDiag('fetchAndExecute: about to call onHtmlResponse, html bytes=' + html.length);
            await this.delegate.onHtmlResponse(url, html);
            _navDiag('fetchAndExecute: onHtmlResponse returned');
            return;
        }
        const source = await response.text();
        const run = new AsyncFunction(`${source}\n//# sourceURL=${url}`);
        await run.call(globalThis);
    }
}
function parseMediaType(header) {
    if (!header)
        return null;
    const semicolon = header.indexOf(';');
    const type = semicolon === -1 ? header : header.slice(0, semicolon);
    return type.trim().toLowerCase() || null;
}
//# sourceMappingURL=web-view.js.map