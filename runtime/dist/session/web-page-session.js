import { getLiveRoot, resetLiveRoot, setLivePageBase, } from '../scripts/live-dom.js';
import { setCssViewport } from '../scripts/inline-css.js';
import { loadHeadLinkStylesheetsWithFlag, populateLiveRoot, } from '../scripts/html-to-live.js';
import { installPageFetchAndWorker, isWebGLBackedCanvas, runPageScripts, } from '../scripts/canvas-runner.js';
import { scanForAutoplayVideos } from '../scripts/live-video.js';
import { resetLiveOverlayCache } from '../scripts/live-overlay.js';
import { requestFullRepaint } from '../scripts/live-paint-control.js';
/**
 * Owns the per-navigation page state inside the runtime. One session ⇒
 * one currently-loaded page; the host shell creates one session and
 * calls {@link load} on every navigation.
 *
 * Owned state:
 *  - {@link scriptCtx}: result of the most recent `runPageScripts` call.
 *    Pages can re-execute scripts via `scriptCtx.rerun(...)` (used by
 *    fullscreen-canvas resize).
 *  - {@link currentPageUrl}: the URL of the most recent successful
 *    `load`. Empty string before the first load.
 *
 * NOT owned (kept on the host shell):
 *  - Chrome / toolbar state
 *  - Navigation stack / back-forward history
 *  - Scroll offset (host UI concern — the shell calls into runtime
 *    paint with whatever scroll value its input pipeline produced)
 *  - Fullscreen mode flags (host UI concern)
 *
 * Phase 5 of the brewser → brewser-runtime migration extracted this
 * class from the brewser shell so headless app NROs can render a page
 * without bringing in the toolbar / address-bar / OAuth-routing
 * surface area of the brewser shell. See the migration plan for the
 * boundary rationale.
 */
export class WebPageSession {
    screen;
    scriptCtx = null;
    currentPageUrl = '';
    _chromeHeight;
    constructor(opts) {
        this.screen = opts.screen;
        this._chromeHeight = opts.chromeHeight ?? 0;
    }
    /** Chrome-strip height the host shell currently reserves. Used to
     * derive the CSS viewport on every load. */
    get chromeHeight() { return this._chromeHeight; }
    setChromeHeight(h) { this._chromeHeight = Math.max(0, h); }
    /**
     * Wipe the prior navigation's state — live tree + paint cache only.
     * `resetLiveRoot` already handles modal registry, image cache, CSS
     * cascade, pending image completions, and live-tree-version bump.
     *
     * Split out from {@link populateAndRunScripts} so the host shell can
     * rebuild its chrome roots (toolbar / keyboard) BETWEEN this reset
     * and the page populate, ensuring fresh chrome `<style>` blocks
     * re-register with the now-cleared cascade.
     */
    reset() {
        resetLiveOverlayCache();
        resetLiveRoot();
    }
    /**
     * Populate the live tree from the parsed HTML, kick off external
     * stylesheet fetches, run inline scripts, wire canvas outputs, and
     * record the new `currentPageUrl`. Call AFTER {@link reset} and the
     * host shell's chrome rebuilds.
     *
     * Steps:
     *  1. Wire the page base so relative `<img src="./x.png">` etc.
     *     resolves like a real browser.
     *  2. Install the fetch + Worker wrappers on `globalThis` (idempotent,
     *     once-per-runtime) so scripts running during populate see them.
     *  3. Sync the CSS viewport to the chrome-aware screen dims so a
     *     page's `height: 100vh` lands inside the visible content rect.
     *  4. Populate the live tree from the parsed HTML.
     *  5. Scan for `<video autoplay>` so playback starts on attach.
     *  6. Fire async external `<link rel=stylesheet>` fetches (the page
     *     paints immediately with inline styles + UA defaults; sheets
     *     arrive opportunistically).
     *  7. Run inline scripts; capture the resulting `PageScriptContext`.
     *  8. Attach each canvas-runner offscreen to its corresponding
     *     LiveElement so the painter can find it.
     *  9. Stamp the new `currentPageUrl`.
     *
     * Errors during script execution are swallowed by `runPageScripts`
     * (logged via `console.debug` to avoid the nx.js render-mode switch),
     * so this method's promise resolves even when individual scripts
     * throw.
     */
    async populateAndRunScripts(url, tree, opts) {
        setLivePageBase(opts.pageBase);
        installPageFetchAndWorker();
        setCssViewport(this.screen.width, Math.max(1, this.screen.height - this._chromeHeight));
        const byParsed = populateLiveRoot(tree);
        scanForAutoplayVideos(getLiveRoot());
        if (opts.loadExternalStylesheets ?? true) {
            loadHeadLinkStylesheetsWithFlag(tree, url).then(() => {
                requestFullRepaint();
            }).catch(() => { });
        }
        // Clear scriptCtx BEFORE running the new page's scripts. The
        // previous context's `firstCanvas()` etc. must not be reachable
        // while the new page initializes — e.g. a queued
        // `__swbRequestFullscreenCanvas` would otherwise resolve against
        // the prior page's canvas.
        this.scriptCtx = null;
        this.scriptCtx = await runPageScripts(tree, {
            allowScripts: opts.allowScripts ?? false,
            pageUrl: url,
            preserveLiveRoot: true,
        });
        for (const [parsedCanvas, offscreen] of this.scriptCtx.outputs) {
            const liveCanvas = byParsed.get(parsedCanvas);
            if (liveCanvas) {
                liveCanvas.attachOffscreen(offscreen, isWebGLBackedCanvas(offscreen));
            }
        }
        this.currentPageUrl = url;
        return { byParsed };
    }
    /**
     * Convenience: {@link reset} followed by {@link populateAndRunScripts}.
     * Intended for headless app NROs that don't have chrome to rebuild
     * between the two steps. The brewser shell drives the steps
     * separately so it can rebuild its toolbar / keyboard between the
     * cascade clear and the page populate.
     */
    async load(url, tree, opts) {
        this.reset();
        return this.populateAndRunScripts(url, tree, opts);
    }
    /** Tear down the active page without loading a replacement. Used by
     * the shell when entering a chrome-only state (e.g. a settings page
     * whose body is built purely via chrome rendering — not the typical
     * brewser path). Idempotent: a no-op when no page is loaded. */
    unload() {
        if (!this.scriptCtx && !this.currentPageUrl)
            return;
        resetLiveRoot();
        resetLiveOverlayCache();
        this.scriptCtx = null;
        this.currentPageUrl = '';
    }
}
//# sourceMappingURL=web-page-session.js.map