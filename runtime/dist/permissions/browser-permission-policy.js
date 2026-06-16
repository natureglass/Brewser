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
export class BrowserPermissionPolicy {
    gamepad;
    touch;
    webgl;
    network;
    constructor(options = {}) {
        this.gamepad = options.allowGamepad ?? true;
        this.touch = options.allowTouch ?? true;
        this.webgl = options.allowWebGL ?? true;
        this.network = options.allowNetwork ?? true;
    }
    /** Public read of the network gate so the shell can mirror it into `WebView.enableNetworkFetch`. */
    get networkEnabled() {
        return this.network;
    }
    allowLocalFile(_path) {
        return false;
    }
    allowNetworkURL(url) {
        // REVERTED 2026-06-03: the romfs:/sdmc: short-circuit (added
        // to silence the boot-probe's `network fetch denied: romfs:/main.js`
        // log noise) appears to have broken mediaplayer audio + video
        // playback by changing which loader claims sdmc:/ URLs. The cost
        // (silent regression) is dramatically worse than the log noise.
        //
        // blob:/data: are always allowed regardless of the `network`
        // toggle — they don't touch the network. blob: references an
        // in-memory Blob created by URL.createObjectURL; data: is an
        // inline data URI. Both are safe to resolve. Pvzge needs blob:
        // because our Image.src brewser:// translation hooks at
        // pvzge/index.html mint blob: URLs and Cocos's createImageBitmap
        // shim re-fetches via page-script fetch — without this branch,
        // Cocos's texture pipeline returns 403 on every loaded image.
        if (url.startsWith('blob:') || url.startsWith('data:')) {
            return true;
        }
        if (!this.network) {
            return false;
        }
        return url.startsWith('http://') || url.startsWith('https://');
    }
    allowGamepad() {
        return this.gamepad;
    }
    allowTouch() {
        return this.touch;
    }
    allowWebGL() {
        return this.webgl;
    }
    allowPersistentStorage(_origin) {
        return true;
    }
}
//# sourceMappingURL=browser-permission-policy.js.map