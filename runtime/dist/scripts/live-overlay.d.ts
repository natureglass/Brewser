/// <reference types="@nx.js/runtime" />
import { type LiveElement, type LiveViewport } from './live-dom.js';
import { type VideoControlHit } from './live-video.js';
/** Viewport rectangle for the live overlay. Re-exported from
 * `./live-dom.js` so existing consumers that imported it from this
 * module keep working without two duplicate-shape interface
 * declarations confusing TS. */
export type { LiveViewport };
export declare function getLiveContentBottom(): number;
/** Phase 1.6.1 (2026-05-25): partial cache repaint. Clears just `el`'s
 * border-box region in the live cache and re-paints its subtree at the
 * existing body-local layout box. Used by form-tap handlers (radio,
 * range, checkbox, color, label-for) to update the visual without
 * paying the ~80-150 ms full-rebuild cost.
 *
 * Assumes no LAYOUT change has happened — only the element's paint
 * output changed (e.g. `.checked` toggled, range value changed). The
 * caller should NOT use this for mutations that move siblings around
 * (e.g. `<details>` open/close, tree insertions). For those, let the
 * full-rebuild path run by NOT calling `syncLiveCacheVersion` afterward.
 *
 * Patches the box in body-local coords; the cache OffscreenCanvas is
 * already in body-local space so the blit on the next paint shows the
 * fresh widget at the right screen position. */
export declare function patchLiveCacheRegion(el: LiveElement): void;
/** Batched variant of {@link patchLiveCacheRegion}: patch ALL of `els`
 * in one pass. Collects paint ops once (`collectPaintOps` walks the
 * live tree, which is O(tree); doing it per-element scales O(N·tree)
 * and dominates the flush time on complex parents like Featured app
 * cards), then iterates the op list a single time, checking each op
 * against the union of all rects.
 *
 * Phase 4 (2026-06-02): the per-element `patchLiveCacheRegion` loop
 * in `flushPendingImageCompletions` measured 197 ms/patch on the home
 * page (vs. 3.6 ms/patch on a simple test page) because each call
 * re-walked the tree + re-painted the body gradient + re-painted
 * every intersecting ancestor's backdrop. Batching collapses that to
 * one tree walk per flush; per-flush cost drops from ~580 ms (6 cards
 * × 97 ms) to a single ~100 ms ops pass. Same JS-side correctness,
 * much smaller user-visible freeze. */
export declare function patchLiveCacheRegions(els: LiveElement[]): void;
/** Phase 4.2 lightweight image patch (2026-06-02): paint just each
 * element's own box on top of the existing cache. Skips the
 * `clearRect` + ancestor-backdrop repaint that {@link patchLiveCacheRegion}
 * / {@link patchLiveCacheRegions} do — those exist because clearing the
 * region requires re-painting the bg stack to avoid a transparent
 * element clearing to a hole.
 *
 * For image loads where the IMG's box doesn't change (explicit
 * dimensions), the cache pixels around the IMG (ancestor gradients,
 * shadows, borders) ARE ALREADY CORRECT from the initial build. We
 * only need to draw the IMG itself on top. Any transparency in the IMG
 * shows through to the underlying card bg pixels that the build wrote.
 *
 * Measured: per-element cost drops from ~193 ms (on Featured app
 * cards with gradient + box-shadow + border) to ~1-2 ms because
 * Cairo's gradient + gaussian-blur work is skipped. 6 home-page card
 * logos: ~1.2 s freeze → ~10 ms. */
export declare function patchLiveImagePixelsOnly(els: LiveElement[]): void;
/** Phase 1.6.1: mark the live cache as up-to-date with the current
 * `liveTreeVersion`. The next `paintLiveOverlay` will see a version
 * match and skip the full rebuild, blitting the cache as-is. Call this
 * AFTER `patchLiveCacheRegion` for every element you mutated, so the
 * patched cache content survives the next paint instead of being
 * overwritten by a full rebuild. */
export declare function syncLiveCacheVersion(): void;
/** Phase 2.6 (2026-05-28): targeted partial cache repaint for tap-driven
 * mutations. Drains the per-element dirty set (populated by
 * `markLiveDirty` from every paint-affecting mutation), re-lays-out, and
 * for each change finds the nearest ancestor whose box stayed put across
 * the re-layout ("stable container") — the region that bounds any reflow
 * the change caused. It then repaints just those regions instead of the
 * whole page. Returns true when it patched (caller can rely on the next
 * blit showing the change); false when it punted to the normal full
 * rebuild (the version is left ahead of `lastBodyVersion`, so the next
 * `paintLiveOverlay` rebuilds).
 *
 * Correctness for the live cache's LAYERED, semi-transparent backgrounds
 * (e.g. the audio player's body gradient → card → row, translucent
 * buttons): we don't just clear+repaint each element — we re-paint, in
 * tree order and CLIPPED to the changed regions, the body background plus
 * every paint op whose box intersects a changed region. That rebuilds the
 * full back-to-front stack inside those regions exactly as the full build
 * would, so there are no transparent holes or seams. Faithful because it
 * reuses the same `paintBoxedElement` / `paintOneInlineAtom` /
 * `collectPaintOps` the build uses; the only difference is the clip + the
 * intersection filter.
 *
 * Safe-by-construction: any uncertainty (no cache, build in flight, a
 * dirty element with no box, or a reflow that reached the root with no
 * stable container) returns false → the unchanged full-rebuild path runs. */
export declare function patchLiveDirtyRegions(): boolean;
/** Set the idle/continuation build budget (ms per chunk). Wired to
 * `config.json`'s `wwwRenderChunkMs` (for external pages) or the internal
 * one-shot sentinel (for `brewser://`). Guarded so a non-positive /
 * non-finite value can't stall or busy-loop the build (it would just keep
 * the default). The caller already clamps WWW values to [1, 1000]. */
export declare function setLiveBuildChunkMs(ms: number): void;
/** Set the scroll-driven build budget (ms per chunk). Wired to
 * `config.json`'s `scrollChunkMs`. Same guard/clamp story as
 * `setLiveBuildChunkMs`. */
export declare function setLiveScrollChunkMs(ms: number): void;
/** True iff a cache build is in progress (chunked). Image / form-tap
 * handlers consult this so they don't try to patch a region that the
 * build is about to over-paint. */
export declare function isLiveCacheBuilding(): boolean;
/** True only when the live-DOM cache OffscreenCanvas exists AND its
 * chunked build is fully complete (every paint op consumed). The shell's
 * video-only fast path uses this to decide whether it can skip the
 * per-tick fillRect+cache-blit on a stable page: if the cache hasn't
 * been built yet (or is still chunking), we still need to run
 * `paintLiveOverlay` so the build advances. */
export declare function isLiveCacheReady(): boolean;
/** Phase 3b (2026-05-26): force-invalidate all live-overlay module
 * state so the next `paintLiveOverlay` call performs a full layout +
 * cascade + cache rebuild. Required after `resetLiveRoot()` because
 * the per-frame cache is keyed by LiveElement identity (WeakMap),
 * AND `paintLiveOverlay`'s dirty check uses `liveTreeVersion` which
 * `resetLiveRoot()` resets to 0 — meaning a freshly-populated new
 * tree could COINCIDENTALLY have the same version as the last paint
 * of the previous page, fooling the dirty check into thinking the
 * cache is valid when it's actually structurally stale.
 *
 * Symptom of NOT calling this: the second navigation to the same
 * page after a mutation (e.g. Settings template select → reload)
 * appears visually correct (cache pixels happen to match), but
 * `hitTestLive` returns null because the layout WeakMap has no
 * entries for the freshly-populated LiveElements. */
export declare function resetLiveOverlayCache(): void;
/** Walk the live root and paint visible fixed elements onto `ctx`,
 * with `position:fixed` interpreted relative to `viewport`. M2.3
 * runs a layout pass per fixed subtree first so children get real
 * boxes; the paint pass then reads the layout cache and draws each
 * element at its computed bbox.
 *
 * Phase 1 (2026-05-25): also paints the body root's non-fixed children
 * as a normal-flow scrollable region. `scrollY` is the page scroll
 * offset (from browser-shell) applied to the body's origin so content
 * scrolls with the rest of the page. The viewport rect is the clip
 * area — content outside it (chrome strip, off-screen) is masked. */
export interface PaintLiveOverlayOptions {
    /** Skip the body-flow render (cache build + blit). The fixed-element
     * pass still runs so lil-gui style overlays stay visible. Used by
     * fullscreen-canvas mode where the WebGL canvas should fill the
     * screen instead of the page content. */
    skipFlow?: boolean;
    /** Vestigial — the old canvas keyboard used this to bypass the
     * `isKeyboardOpen()` early-return. The HTML keyboard paints AFTER
     * `paintLiveOverlay`, so the gate is gone and this flag is a no-op.
     * Retained on the option type so the scroll-behind-keyboard call
     * site in `repaintBehindKeyboard` keeps compiling without a churn
     * pass; remove next cleanup cycle if no new caller emerges. */
    paintBehindKeyboard?: boolean;
}
export declare function paintLiveOverlay(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, root: LiveElement, viewport?: LiveViewport, scrollY?: number, options?: PaintLiveOverlayOptions): void;
/** Painter for the HTML-driven keyboard. The shell calls this AFTER
 * `paintLiveOverlay` (so the host page's pixels are already on the
 * screen ctx) when `isKeyboardOverlayVisible()` is true. `viewport`
 * is the target rect on the screen — typically `{x:0, y:topY,
 * width:canvasW, height:canvasH-topY}`. */
export declare function paintKeyboardOverlay(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, root: LiveElement, viewport: LiveViewport): void;
/** Discard the keyboard cache. Called when the html source changes
 * (template-switch reload, future hot-reload). Not normally needed —
 * the version-keyed invalidation in `paintKeyboardOverlay` covers the
 * routine cases. */
export declare function resetKeyboardOverlayCache(): void;
/** Painter for the HTML-driven toolbar. The shell calls this each
 * frame (in `normal` mode only — fullscreen modes hide the chrome
 * strip entirely) as part of the repaint sequence. `viewport` is the
 * target rect on the screen, typically
 * `{x:0, y:0, width:canvasW, height:chromeHeight}` for a top toolbar
 * or `{x:0, y:canvasH-chromeHeight, ...}` for a bottom toolbar. */
export declare function paintToolbarOverlay(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, root: LiveElement, viewport: LiveViewport): void;
/** Discard the toolbar cache. Called when the html source changes
 * (theme switch via the Settings page). Not normally needed — the
 * version-keyed invalidation in `paintToolbarOverlay` covers the
 * routine cases. */
export declare function resetToolbarOverlayCache(): void;
/** Painter for `<browser-modal>` roots. The shell calls this after the
 * body / canvas / CSS-loading overlays paint and before the chrome
 * toolbar. `viewport` is the host's content viewport (the rect outside
 * the chrome strip) — modal roots were laid out by the host's
 * fixed-element pass at viewport-origin screen coords (so the engine's
 * touch hit-test against the host layout cache can route taps inside
 * a modal correctly). This paint pass reuses those boxes verbatim and
 * paints them into a per-modal offscreen cache, translating the ctx by
 * `-viewport.{x,y}` so screen-coord boxes land at modal-local coords
 * inside the cache. The cache is then blitted at the viewport origin.
 *
 * Walks the modal-roots registry maintained by `live-paint-control.ts`
 * (populated by `propagateAttached` on attach of each
 * `data-engine-modal="true"` element). For each visible modal, builds /
 * blits its own offscreen cache. Hidden modals (CSS display:none — the
 * default before the page-script flips the `--open` class) emit no
 * paint work. */
export declare function paintModalOverlay(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, viewport: LiveViewport): void;
/** Discard all modal caches. Called by `resetLiveOverlayCache` on
 * navigation. The WeakMap GC's per-root entries when their root
 * detaches, but on a navigation reset the host root itself is
 * recreated, and modal roots from the prior page would still hold
 * WeakMap entries until their refs are released — clearing here is
 * the safe explicit drop. */
export declare function resetModalOverlayCache(): void;
/** Per-frame walk of the live tree to overlay animated `<canvas>`
 * content on top of the cached body paint.
 *
 * For each visible CANVAS LiveElement in body-flow:
 *   - WebGL-backed → `copyBridgeToScreen(...)` (fast direct path).
 *   - 2D-backed → `drawImage(offscreen, ...)`.
 *
 * `copyBridgeToScreen` is dependency-injected to avoid coupling
 * live-overlay.ts to canvas-runner.ts (the canvas-runner imports
 * live-overlay for the cache patch APIs, so the reverse would create
 * a cycle). The shell hands in its closure-bound helper.
 *
 * Clips to the viewport rect; honors `scrollY`. Skips fixed-position
 * canvases (they're painted at viewport-origin via the fixed-element
 * pass, which already handles canvas via `paintBoxedElement`'s normal
 * drawImage branch — WebGL fixed canvases would need separate work). */
export declare function overlayLiveAnimatedCanvases(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, root: LiveElement, viewport: LiveViewport, scrollY: number, copyBridgeToScreen: (srcX: number, srcY: number, srcW: number, srcH: number, dstX: number, dstY: number) => boolean): void;
/** Walk the live tree extracting `<a href>` / `<button data-action>` /
 * `<summary>` tap targets so the touch dispatcher can fire navigation,
 * button-action, and summary-toggle inputs without re-implementing
 * tree-walking in controller-shortcuts. Returns the closest matching
 * ancestor of `target`, or null. */
export declare function findTapIntent(target: LiveElement, tapX?: number, tapY?: number, viewportX?: number, viewportY?: number, scrollY?: number): {
    kind: 'navigate';
    href: string;
} | {
    kind: 'button-action';
    action: string;
} | {
    kind: 'dbltap-action';
    action: string;
    el: LiveElement;
} | {
    kind: 'summary';
    summary: LiveElement;
} | {
    kind: 'video-control';
    control: VideoControlHit;
    video: LiveElement;
} | {
    kind: 'video-frame-tap';
    video: LiveElement;
} | null;
/** Scroll the nearest scrollable ancestor of `el` so `el` is fully visible
 * (vertical only). Backs `LiveElement.scrollIntoView()`. Uses raw layout
 * boxes (which are scroll-independent — `scrollTop` is applied at paint),
 * so the math is just "where does this element sit within the unscrolled
 * content." Setting `scrollTop` triggers a cheap re-blit (no re-layout). */
export declare function scrollElementIntoView(el: LiveElement): void;
/** True iff there's at least one paintable element in the tree (fixed
 * OR a normal-flow direct child of body). Lets the shell skip the
 * entire overlay path on idle frames.
 *
 * Phase 1 widened the check: a script that creates `<div>` children
 * under document.body without setting position:fixed now produces
 * paintable normal-flow content, so the overlay path must run. */
export declare function hasLiveOverlay(root: LiveElement): boolean;
//# sourceMappingURL=live-overlay.d.ts.map