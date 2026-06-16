import type { NxScreenCanvas } from '../graphics/screen.js';
import type { HtmlElement } from '../html/html-parser.js';
import { type LiveElement } from '../scripts/live-dom.js';
import { type PageScriptContext } from '../scripts/canvas-runner.js';
/**
 * Construction-time options for a {@link WebPageSession}.
 */
export interface WebPageSessionOptions {
    /** Output surface the session paints into. The session itself doesn't
     * trigger paints — the host shell drives the per-frame loop — but it
     * uses the screen dimensions to derive the CSS viewport. */
    screen: NxScreenCanvas;
    /** Chrome-strip height, in CSS pixels, the host shell reserves
     * outside the page area. Subtracted from the screen height to derive
     * the effective viewport that `vh`/`vw` resolve against. Defaults to
     * `0` (page fills the whole screen) — appropriate for headless app
     * NRO use. The brewser shell calls {@link setChromeHeight} to keep
     * this in sync with its toolbar height. */
    chromeHeight?: number;
}
/**
 * Per-call options for {@link WebPageSession.load}.
 */
export interface PageLoadOptions {
    /** Allow inline `<script>` evaluation. Default `false` for safety:
     * external content (http(s)://) should not execute scripts on a
     * shell that doesn't sandbox them. The brewser shell enables this
     * only for trusted `brewser://` URLs. */
    allowScripts?: boolean;
    /** Page-relative URL base used by `<img>` / `<audio>` / `<video>` /
     * `fetch()` / `new Worker()` to resolve relative paths. The shell
     * computes this from the URL — for `brewser://` URLs it's the
     * page's SD-card directory; for `http(s)://` it's the URL up to
     * the last `/`. Passed verbatim to {@link setLivePageBase}. */
    pageBase: string;
    /** Whether to fire external `<link rel=stylesheet>` fetches after
     * populate. The shell enables this for `http(s)://` and `brewser://`
     * pages so a shared `main.css` actually loads, but disables it for
     * data URLs / synthetic pages with no external sheets. Default
     * `true` since pages with zero external sheets get an early-return
     * from {@link loadHeadLinkStylesheetsWithFlag}. */
    loadExternalStylesheets?: boolean;
}
/**
 * Result returned from {@link WebPageSession.load}. The host shell uses
 * it to attach canvas-runner outputs to live elements and to drain any
 * queued top-level fullscreen request.
 */
export interface PageLoadResult {
    /** Parsed `HtmlElement` → `LiveElement` map produced by
     * {@link populateLiveRoot}. The shell uses this to wire each
     * `<canvas>` from the parsed tree to its runner-allocated offscreen
     * (already done internally for offscreens the scripts created — this
     * map is exposed for shell-specific post-processing like attaching
     * a shell-owned animation root). */
    byParsed: Map<HtmlElement, LiveElement>;
}
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
export declare class WebPageSession {
    readonly screen: NxScreenCanvas;
    scriptCtx: PageScriptContext | null;
    currentPageUrl: string;
    private _chromeHeight;
    constructor(opts: WebPageSessionOptions);
    /** Chrome-strip height the host shell currently reserves. Used to
     * derive the CSS viewport on every load. */
    get chromeHeight(): number;
    setChromeHeight(h: number): void;
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
    reset(): void;
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
    populateAndRunScripts(url: string, tree: HtmlElement, opts: PageLoadOptions): Promise<PageLoadResult>;
    /**
     * Convenience: {@link reset} followed by {@link populateAndRunScripts}.
     * Intended for headless app NROs that don't have chrome to rebuild
     * between the two steps. The brewser shell drives the steps
     * separately so it can rebuild its toolbar / keyboard between the
     * cascade clear and the page populate.
     */
    load(url: string, tree: HtmlElement, opts: PageLoadOptions): Promise<PageLoadResult>;
    /** Tear down the active page without loading a replacement. Used by
     * the shell when entering a chrome-only state (e.g. a settings page
     * whose body is built purely via chrome rendering — not the typical
     * brewser path). Idempotent: a no-op when no page is loaded. */
    unload(): void;
}
//# sourceMappingURL=web-page-session.d.ts.map