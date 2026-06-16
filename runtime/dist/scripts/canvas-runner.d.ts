/// <reference types="@nx.js/runtime" />
import type { HtmlElement } from '../html/html-parser.js';
/**
 * Per-element offscreen drawn into by an inline `<script>`. The layout
 * looks an element up here and, if present, emits an `ImageBox` whose
 * `image` is the offscreen so the painter draws it at the canvas slot.
 *
 * Absent from the map ⇒ no script populated this canvas; the layout
 * falls back to the empty placeholder rectangle.
 */
export type CanvasOutputs = Map<HtmlElement, OffscreenCanvas>;
/**
 * Output of `runPageScripts`. The shell holds onto this so it can
 * resize a target canvas and re-execute the same scripts when entering
 * (or leaving) fullscreen-canvas mode — a responsive script that reads
 * `canvas.width` / `canvas.height` then redraws to fit the new size.
 */
export interface PageScriptContext {
    outputs: CanvasOutputs;
    /** True iff any inline `<script>` body was found. Used by the shell
     * to decide whether fullscreen-canvas mode is meaningful. */
    hasScripts: boolean;
    /** Re-run every inline script. If `resizes` is given, each named
     * offscreen is resized first (setting `width`/`height` clears the
     * canvas per the spec) so the script's redraw lands on a clean
     * surface at the new dimensions. Returns the same `outputs` map
     * (offscreen instances are reused). Promise resolves once every
     * script's async body has settled. */
    rerun(resizes?: Map<HtmlElement, {
        width: number;
        height: number;
    }>): Promise<CanvasOutputs>;
    /** First `<canvas>` in document order, or `null` if the page has
     * none. The fullscreen-canvas mode targets this element. */
    firstCanvas(): HtmlElement | null;
}
export interface RunPageScriptsOptions {
    /**
     * When `false`, `<script>` elements in the tree are ignored entirely:
     * no collection, no execution. `<canvas>` elements are still
     * registered so the painter can still draw their (empty) placeholders.
     *
     * The shell gates this on the page URL — only `brewser://` pages
     * are trusted to run inline scripts. Fetched external pages can ship
     * arbitrary JavaScript that calls DOM APIs we don't implement
     * (e.g. `document.createElement`, `addEventListener`); if such a
     * script ALSO sets a `setTimeout`, the eventual callback's
     * `TypeError: not a function` escapes our try/catch (we only catch
     * the immediate script body) and lands in nx.js's unhandled-error
     * path, which flips the canvas into text-render mode. Defaults to
     * `true` for backward compatibility with the existing callers.
     */
    allowScripts?: boolean;
    /**
     * Page URL of the document being parsed. Used to resolve relative
     * `<script src="...">` URLs (e.g. `assets/main.js` →
     * `brewser://X/Y/assets/main.js`). When omitted, external scripts
     * with relative srcs are skipped with a debug log.
     */
    pageUrl?: string;
    /**
     * Phase 3b (2026-05-26): when `true`, skip the `resetLiveRoot()`
     * call that normally fires inside `buildDocumentShim`. The caller is
     * expected to have already populated the live root with the page
     * content (via `populateLiveRoot`) so scripts see `document.body`
     * pre-filled with the parsed DOM rather than starting empty.
     *
     * When `false` (default), behavior is unchanged: live root is reset
     * for each navigation and scripts start with an empty document.body.
     */
    preserveLiveRoot?: boolean;
}
export declare function runPageScripts(root: HtmlElement, options?: RunPageScriptsOptions): Promise<PageScriptContext>;
export declare function isWebGLBackedCanvas(c: OffscreenCanvas): boolean;
export declare function copyBridgeToScreen(srcX: number, srcY: number, srcW: number, srcH: number, dstX: number, dstY: number): boolean;
/**
 * Fire every callback queued since the last tick. Returns `true` if
 * at least one callback ran (lets the caller skip a screen present
 * when nothing happened). The queue is swapped before firing so
 * callbacks that re-register themselves run on the NEXT tick rather
 * than spinning forever inside one tick.
 */
export declare function tickAnimationFrames(): boolean;
/** Drop any queued animation-frame callbacks. Called on navigation so
 * a leaving page's callbacks don't keep firing under the next page.
 * Also clears the per-page readback hook + animation-active flag. */
export declare function clearAnimationFrames(): void;
/** Wipe the shared screen GL bridge FBO so pixels from the previous
 * page don't bleed onto the next page's canvas slot before its first
 * rAF tick fires. The shared GL contexts (v1 + v2) are acquired once
 * each per process and each owns its OWN native EGL backend with its
 * own bridge FBO — so we have to clear BOTH if both are acquired.
 * Otherwise an A→B→A pattern that touches both kinds (e.g. WebGL1 →
 * WebGL2 → WebGL1) leaves the un-cleared backend holding stale content
 * that `copyBridgeToScreen` would show on the next paint. No-op when
 * no shared context has been acquired yet. */
export declare function clearSharedScreenGLBridge(): void;
/** True iff at least one callback is queued. Lets the shell choose a
 * shorter poll interval when an animation is active. */
export declare function hasPendingAnimationFrames(): boolean;
/** True iff the current page has called `requestAnimationFrame` at
 * least once (sticky until navigation). The shell uses this to skip
 * the cached-layout fast path on animated pages so updated canvas
 * frames make it to the screen. */
export declare function pageHasAnimationActivity(): boolean;
export declare function installPageFetchAndWorker(): void;
//# sourceMappingURL=canvas-runner.d.ts.map