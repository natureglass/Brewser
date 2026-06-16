// Live-DOM for brewser. Originally Phase 1 (Stats slice);
// expanded in Phase 2.0 to a generic element surface that future
// milestones build text rendering / CSS / flex layout / form widgets
// on top of. lil-gui is the eventual phase-2.6 target.
//
// Phase 1 scope (Stats addon — FPS-counter overlay): position:fixed
// element with a visible 80×48 canvas; per-frame canvas-2d ops; tap
// cycles panels via the touch hit-tester.
//
// Phase 2.0 additions (this file): `classList` DOMTokenList shim;
// `parentElement` getter; `insertBefore` / `replaceChild`;
// `toggleAttribute`; `textContent` / `innerHTML` getter+setter (text
// stored on the element — painting in 2.1); `getBoundingClientRect`
// (viewport-relative, uses the same fixed-positioning math as the
// painter); `nextSibling` / `previousSibling` / `firstChild` /
// `lastChild`; `ownerDocument` stub; window-level event-target bridge
// so future drag handlers (`window.addEventListener('mousemove', ...)`)
// can be plumbed from the canvas touch listener.
//
// Layout / rendering is STILL Phase 1 — only position:fixed paints,
// children stack at the parent's origin, no text in non-canvas
// elements. Those land in 2.1+ atop the M2.0 surface.
import { parseHtml } from '../html/html-parser.js';
import { applyDecl, parseCssText, parseLength, serializeStyle } from './inline-css.js';
import { paintSvgSubtree } from './svg-painter.js';
// Probe counters (2026-06-07 pvzge text+touch investigation). Rate-limited
// loggers so the device console doesn't explode under 60fps repaints.
let _diagBboxCanvas = 0;
let _diagGetContextCanvas = 0;
let _diagGetContextNonCanvas = 0;
let _diagCanvasDispatchEntry = 0;
let _diagCanvasDispatchThrow = 0;
/** Coerce a value written to `style.{width,height,...}` into a
 * `CssLength | undefined`. Accepts numbers (raw px), CssLength objects,
 * percent/px strings, and undefined. Anything unparseable lands as
 * undefined so layout code sees a missing value rather than NaN math. */
function coerceLength(v) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v === 'number')
        return v;
    if (typeof v === 'string') {
        const s = v.trim();
        if (s === '' || s === 'auto')
            return undefined;
        return parseLength(s);
    }
    // Already a CssLength object.
    return v;
}
import { getComputedLiveStyle, invalidateLiveStyle, registerStyleSheet, resetLiveCss, unregisterStyleSheet, } from './live-css.js';
// Runtime-only import (used inside the innerHTML setter). html-to-live
// imports LiveElement back from this module — the cycle is safe because
// neither side touches the other's exports at module-eval time.
import { loadIframeContents, parseFragmentInto } from './html-to-live.js';
import { getInputChecked, getInputValue, setInputChecked, setInputValue, } from './live-form.js';
import { videoCurrentTime, videoDuration, videoErrorMessage, videoIsEnded, videoIsPaused, videoPause, videoPlay, videoResetSource, videoSeek, videoGetVolume, videoSetVolume, videoIsMuted, videoSetMuted, videoGetAudioLevels, videoGetFrequencyData, videoGetWaveform, } from './live-video.js';
import { getInlineLayout, getLayoutBox } from './live-layout.js';
import { isLiveCacheBuilding, patchLiveCacheRegion, patchLiveImagePixelsOnly, scrollElementIntoView, syncLiveCacheVersion, } from './live-overlay.js';
import { bumpKbTreeVersion, bumpModalTreeVersion, bumpToolbarTreeVersion, clearModalRoots, getModalModeDialogs, inKbMutationScope, inModalMutationScope, inToolbarMutationScope, markDialogModalMode, markLiveDirty, markPageHasCanvas2dActivity, registerModalRoot, requestFullRepaint, unmarkDialogModalMode, unregisterModalRoot } from './live-paint-control.js';
import { notifyAttribute, notifyCharacterData, notifyChildList, } from '../polyfills/mutation-observer.js';
const LIVE_ELEMENT_BRAND = Symbol('LiveElement');
// =========================================================================
// `<script src=...>` runtime injection (appendChild side-effect)
// =========================================================================
// A real browser, when a <script> element with a `src` attribute is inserted
// into the DOM, fetches that URL, evaluates the script, then dispatches a
// `load` event on the element (or `error` on failure). Cocos Creator's
// bundle loader (`ES` function in cocos-js/cc.js) relies on this exact flow
// to load each bundle's `index.js` — without it, the `load` event never
// fires and `loadBundle`'s natural callback hangs forever (today the
// pvzge force-stub fires after 5s per bundle to work around this). The
// natural flow ALSO removes the need for pvzge's `System.instantiate`
// shim, since SystemJS itself injects `<script src>` when no instantiate
// override is registered.
//
// Tracked on the element via a private flag so re-attaching the same node
// doesn't double-load. Errors fire `error`; loads fire `load`. Both
// dispatch as bubble:false (script-load events don't bubble in HTML spec).
function maybeLoadScriptElement(el) {
    if (el.tagName !== 'SCRIPT')
        return;
    const raw = el.src;
    if (typeof raw !== 'string' || !raw)
        return;
    const marked = el;
    if (marked.__scriptLoadStarted)
        return;
    marked.__scriptLoadStarted = true;
    const g = globalThis;
    if (typeof g.fetch !== 'function' || typeof g.eval !== 'function')
        return;
    // Real-browser semantics: `<script src="foo.js">` resolves the
    // relative URL against document.baseURI. Cocos's bundle loader (ES
    // function in cc.js) sets `n.src = "assets/internal/index.js"`
    // (relative) and expects the engine to honor that. Without
    // resolution, the fetch hits a bare relative path that page-fetch
    // can't handle and 404s.
    let resolved = raw;
    const base = g.document?.baseURI;
    if (base) {
        try {
            resolved = new URL(raw, base).href;
        }
        catch { /* fall through to raw */ }
    }
    const indirectEval = g.eval;
    g.fetch(resolved).then((r) => {
        if (!r.ok)
            throw new Error('<script src> fetch ' + resolved + ' returned ' + r.status);
        return r.text();
    }).then((scriptText) => {
        // Indirect eval — runs in global scope so System.register etc. land
        // on the page-global System, not the swb-runtime closure.
        // Indirect eval — runs in global scope so System.register etc. land
        // on the page-global System, not the swb-runtime closure.
        // The classic `(0, eval)(...)` syntax breaks TS strict, so call
        // through a typed alias instead — the spec treats any non-syntactic
        // eval reference as indirect.
        indirectEval(scriptText + '\n//# sourceURL=' + resolved);
        el.dispatchEvent({ type: 'load', bubbles: false });
    }).catch((err) => {
        console.debug('[swb] <script src> load failed:', resolved, String(err));
        el.dispatchEvent({ type: 'error', bubbles: false, message: String(err) });
    });
}
// =========================================================================
// `<img>` src resolution
// =========================================================================
// nx.js's `Image` fetch resolves a relative URL against the runtime base
// (`romfs:/`), NOT the page — so a page-authored relative path read the
// BUNDLED romfs copy instead of the editable profile copy (and required a
// full .nro rebuild + redeploy to update).
//
// 2026-06-10: `brewser://` URLs now flow through unchanged. Previously
// resolveLiveResourceUrl rewrote them to `sdmc:/...` because the old
// nxjs Image fetched via its internal `./fetch/fetch` (which knows
// sdmc:/ natively but not brewser://). After
// `[[reference-nxjs-image-audio-page-url-base]]` (image.ts uses
// globalThis.fetch), the runtime-fetch wrapper routes brewser:// through
// BrowserResourceLoader, which serves the same on-disk file. So the
// rewrite was both unnecessary AND broken — it produced an `sdmc:/` URL
// that no loader in the runtime-fetch chain accepts → 403. The
// `liveAppRoot` / `liveProfileRoot` vars + setters are gone; the brewser://
// branch in resolveLiveResourceUrl now just returns the URL as-is.
let livePageBase = '';
/** Hard floor on per-frame delay. GIF spec allows 0 ("as fast as
 * possible"), which would peg the timer at native frame rate and burn
 * CPU painting the same image; real browsers clamp similarly. */
const GIF_MIN_FRAME_DELAY_MS = 20;
function clampGifDelay(ms) {
    if (!Number.isFinite(ms) || ms < GIF_MIN_FRAME_DELAY_MS)
        return GIF_MIN_FRAME_DELAY_MS;
    return ms;
}
/** Every active GIF frame-ticker. The shell calls `clearGifAnimations`
 * on page-change so previously-scheduled `setFrame` + repaint calls
 * don't fire on detached elements (and clobber the new page's cache). */
const activeGifAnimations = new Set();
export function clearGifAnimations() {
    for (const t of activeGifAnimations)
        t.cancel();
    activeGifAnimations.clear();
}
/** Sister registry for CSS-animation tickers (one per element running a
 * `@keyframes` animation). Shell calls `clearCssAnimations` on page-
 * change, same lifecycle as the GIF set. */
const activeCssAnimations = new Set();
const cssAnimTickerByEl = new WeakMap();
const cssAnimStateByEl = new WeakMap();
export function clearCssAnimations() {
    for (const t of activeCssAnimations)
        t.cancel();
    activeCssAnimations.clear();
}
/** Painter-side lookup: current interpolated values for `el`, or
 * undefined if no animation is running. */
export function getCssAnimState(el) {
    return cssAnimStateByEl.get(el);
}
/** Start a CSS-animation ticker for `el` if its computed style carries
 * an `animation: <name> <duration> …` shorthand AND the named
 * `@keyframes` rule has been registered. Idempotent. */
export function ensureCssAnimation(el, spec, keyframesLookup) {
    if (cssAnimTickerByEl.has(el))
        return;
    const stops = keyframesLookup(spec.name);
    if (!stops || stops.length === 0)
        return;
    if (!(spec.durationMs > 0))
        return;
    const start = performance.now();
    let cancelled = false;
    let tid = null;
    // Gate the per-tick paint cost on whether the element is actually
    // being rendered. Infinite animations on elements that later get
    // hidden (e.g. updates-modal's loading-bar pulse, the parent
    // `.updates-modal-loading` flips to `display:none` once the
    // fetch settles) would otherwise force a full-repaint every 33 ms
    // FOREVER — `requestFullRepaint()` flips the consume-once flag
    // the shell reads each frame to bypass the fast cache-blit path.
    // One stuck infinite ticker pegs the paint pump at ~30 Hz and
    // drags the engine mouse from 60 FPS to ~10 FPS until the page
    // navigates away (which calls `clearCssAnimations`). The setTimeout
    // keeps firing so the animation state stays correct for when the
    // element becomes visible again, but we skip the patch + repaint
    // when there's nothing on screen to update.
    const elementHasPaintedBox = () => {
        const box = getLayoutBox(el);
        return !!box && box.w > 0 && box.h > 0;
    };
    // 2026-06-14: modal-layer elements (`.updates-modal-loading-bar`
    // pulse is the in-tree case) don't patch the HOST cache —
    // `patchLiveCacheRegion` uses the element's layout box (screen-coord
    // for fixed-anchored modal descendants) and would bake the animated
    // pixels into the body cache, which was the previous bug. Instead
    // the tick bumps the modal-only counter so the next modal paint
    // rebuilds the modal cache with the new animation state. Cheap;
    // modal subtree is small.
    const tick = () => {
        if (cancelled)
            return;
        const elapsed = performance.now() - start;
        let t = elapsed / spec.durationMs;
        if (spec.iterationCount !== 'infinite') {
            if (t >= spec.iterationCount) {
                cssAnimStateByEl.set(el, sampleStops(stops, 1));
                if (elementHasPaintedBox()) {
                    if (el.inModalLayer)
                        bumpModalTreeVersion();
                    else
                        patchLiveCacheRegion(el);
                    requestFullRepaint();
                }
                activeCssAnimations.delete(ticker);
                cssAnimTickerByEl.delete(el);
                return;
            }
        }
        t = t - Math.floor(t);
        cssAnimStateByEl.set(el, sampleStops(stops, t));
        if (elementHasPaintedBox()) {
            if (el.inModalLayer)
                bumpModalTreeVersion();
            else
                patchLiveCacheRegion(el);
            requestFullRepaint();
        }
        tid = setTimeout(tick, 33);
    };
    const ticker = {
        cancel: () => {
            cancelled = true;
            if (tid !== null)
                clearTimeout(tid);
        },
    };
    cssAnimTickerByEl.set(el, ticker);
    activeCssAnimations.add(ticker);
    tick();
}
/** Linear interpolation between the two flanking keyframe stops. */
function sampleStops(stops, t) {
    if (stops.length === 1) {
        return { rotateRad: stops[0].rotateRad, scaleX: stops[0].scaleX, scaleY: stops[0].scaleY, opacity: stops[0].opacity };
    }
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i].offset && t <= stops[i + 1].offset) {
            lo = stops[i];
            hi = stops[i + 1];
            break;
        }
    }
    const span = (hi.offset - lo.offset) || 1;
    const u = (t - lo.offset) / span;
    const lerp = (a, b) => {
        if (a === undefined && b === undefined)
            return undefined;
        if (a === undefined)
            return b;
        if (b === undefined)
            return a;
        return a + (b - a) * u;
    };
    return {
        rotateRad: lerp(lo.rotateRad, hi.rotateRad),
        scaleX: lerp(lo.scaleX, hi.scaleX),
        scaleY: lerp(lo.scaleY, hi.scaleY),
        opacity: lerp(lo.opacity, hi.opacity),
    };
}
const bgImageCache = new Map();
/** Lookup-or-load a background-image URL. Returns the loaded image, or
 * `null` while still loading / on permanent failure. Triggers a fresh
 * load + tree-version bump on first call per URL. */
export function getBackgroundImage(url) {
    if (!url)
        return null;
    const existing = bgImageCache.get(url);
    if (existing)
        return existing.failed ? null : existing.img;
    const entry = { img: null, failed: false };
    bgImageCache.set(url, entry);
    const resolved = resolveLiveResourceUrl(url);
    _imgDiag('[' + new Date().toISOString() + '] BG-START url=' + url + ' resolved=' + resolved);
    // SVG is now handled by the native decoder (nanosvg in image.c) so
    // .svg URLs flow through the same `new Image()` path as raster
    // formats. `rasterizeSvgBackground` stays defined below as a
    // defensive fallback path but is no longer wired in.
    try {
        const img = new globalThis.Image();
        img.onload = () => {
            _imgDiag('[' + new Date().toISOString() + '] BG-LOAD ok url=' + url
                + ' w=' + img.naturalWidth + ' h=' + img.naturalHeight);
            entry.img = img;
            bumpLiveTreeVersion();
            // `bumpLiveTreeVersion` alone only invalidates the cache —
            // it doesn't wake the paint loop. On idle pages (DDG result
            // list after layout settles) the loop was sleeping, so the
            // duck logo only appeared after the user scrolled twice
            // (first scroll = stale cache blit, second = full rebuild).
            // Active repaint matches what `<img>` element loadImage does.
            requestFullRepaint();
        };
        img.onerror = () => {
            _imgDiag('[' + new Date().toISOString() + '] BG-LOAD fail url=' + url);
            entry.failed = true;
        };
        img.src = resolved;
    }
    catch (err) {
        entry.failed = true;
        _imgDiag('[' + new Date().toISOString() + '] BG-LOAD threw url=' + url + ' err=' + String(err));
    }
    return null;
}
/** Fetch + rasterize an SVG URL into an OffscreenCanvas, store on
 * `entry.img` when done. Uses html-parser's permissive HTML5 mode —
 * good enough for the simple-shapes SVGs sites actually serve
 * (favicons, logos, icon glyphs). Sizing comes from `viewBox` first,
 * then `width`/`height` attrs, then a 24×24 fallback. Failures (404,
 * unparseable, no shapes) are silent — entry.failed flips so we don't
 * re-attempt. */
async function rasterizeSvgBackground(url, resolved, entry) {
    try {
        const res = await fetch(resolved);
        if (!res.ok) {
            _imgDiag('[' + new Date().toISOString() + '] BG-LOAD fail (svg http ' + res.status + ') url=' + url);
            entry.failed = true;
            return;
        }
        const svgText = await res.text();
        const tree = parseHtml(svgText);
        // The parser wraps top-level elements under a synthetic root.
        // Real SVG documents have <svg> at the top; if the parser
        // HTML-wrapped them (under <html><body>), defensively unwrap.
        const svgEl = findSvgRoot(tree);
        if (!svgEl) {
            _imgDiag('[' + new Date().toISOString() + '] BG-LOAD fail (svg no root) url=' + url);
            entry.failed = true;
            return;
        }
        const { width, height, vbX, vbY, vbW, vbH } = readSvgViewport(svgEl);
        if (width <= 0 || height <= 0) {
            entry.failed = true;
            return;
        }
        // Rasterize at up to 2x the natural size so we have headroom when
        // the background is scaled up (most CSS-sized SVGs end up larger
        // than their viewBox). Capped to keep memory reasonable for big
        // logos.
        const scale = Math.min(2, Math.max(1, 64 / Math.max(width, height)));
        const cw = Math.max(1, Math.round(width * scale));
        const ch = Math.max(1, Math.round(height * scale));
        const oc = new OffscreenCanvas(cw, ch);
        const octx = oc.getContext('2d');
        if (!octx) {
            entry.failed = true;
            return;
        }
        // Map viewBox → canvas so SVG user-space coordinates land in
        // [0, cw] × [0, ch] regardless of viewBox origin or aspect.
        octx.scale(cw / vbW, ch / vbH);
        octx.translate(-vbX, -vbY);
        paintSvgSubtree(octx, svgEl, BG_SVG_ADAPTER);
        _imgDiag('[' + new Date().toISOString() + '] BG-LOAD ok (svg) url=' + url
            + ' w=' + cw + ' h=' + ch);
        entry.img = oc;
        bumpLiveTreeVersion();
    }
    catch (err) {
        _imgDiag('[' + new Date().toISOString() + '] BG-LOAD threw (svg) url=' + url + ' err=' + String(err));
        entry.failed = true;
    }
}
/** Locate the `<svg>` element inside an html-parser tree. */
function findSvgRoot(node) {
    if (node.tag === 'svg')
        return node;
    for (const child of node.children) {
        if (child.type !== 'element')
            continue;
        const found = findSvgRoot(child);
        if (found)
            return found;
    }
    return null;
}
/** Resolve an `<svg>` element's intrinsic dimensions + viewBox. Width /
 * height attrs override viewBox-derived sizing per SVG spec; if both
 * are missing we fall back to the viewBox extent, then a 24×24 default
 * so a malformed SVG still rasterizes to *something*. */
function readSvgViewport(svgEl) {
    const attrs = svgEl.attrs ?? {};
    const wAttr = parseFloat(attrs['width'] ?? '');
    const hAttr = parseFloat(attrs['height'] ?? '');
    // html-parser lowercases attr names — viewBox → viewbox.
    const vbRaw = attrs['viewbox'];
    let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
    if (vbRaw) {
        const parts = vbRaw.trim().split(/[\s,]+/).map(parseFloat);
        if (parts.length === 4 && parts.every((p) => Number.isFinite(p))) {
            vbX = parts[0];
            vbY = parts[1];
            vbW = parts[2];
            vbH = parts[3];
        }
    }
    const width = Number.isFinite(wAttr) && wAttr > 0 ? wAttr : (vbW > 0 ? vbW : 24);
    const height = Number.isFinite(hAttr) && hAttr > 0 ? hAttr : (vbH > 0 ? vbH : 24);
    if (vbW <= 0)
        vbW = width;
    if (vbH <= 0)
        vbH = height;
    return { width, height, vbX, vbY, vbW, vbH };
}
/** SVG-painter adapter over html-parser's HtmlElement shape — same
 * fields as live-overlay's LIVE_SVG_ADAPTER but reading the parsed
 * primitives directly so we don't construct LiveElements just to
 * rasterize an icon. */
const BG_SVG_ADAPTER = {
    tag(n) { return n.tag; },
    attr(n, name) {
        return n.attrs ? n.attrs[name.toLowerCase()] : undefined;
    },
    children(n) {
        const kids = n.children ?? [];
        return kids.filter((c) => c.type === 'element');
    },
};
/** Wipe the background-image cache on page navigation so loads from
 * the previous page don't leak into the new one. */
export function clearBackgroundImageCache() {
    bgImageCache.clear();
}
// =========================================================================
// Image-load diagnostic — appends every `<img>` load attempt + result to
// `sdmc:/switch/brewser/logs/swb_img_diag.log` so we can
// diagnose missing-image bugs on real hardware (where stdout/stderr aren't
// easy to see). Capped so a broken page can't fill the SD card. Gated by
// `config.json` -> `swbImgDebug`; flipped on at shell startup via
// `setSwbImgDebugEnabled`. The cap stays in place even when enabled so
// a runaway page can't write 100k entries.
// =========================================================================
const IMG_DIAG_PATH = 'sdmc:/switch/brewser/logs/swb_img_diag.log';
const IMG_DIAG_CAP = 500;
let _imgDiagEnabled = false;
let _imgDiagCount = 0;
/** Toggle the swb image-load diag log. Off by default; the shell flips
 * it on at startup when `config.json`'s `swbImgDebug` key is `true`. */
export function setSwbImgDebugEnabled(enabled) {
    _imgDiagEnabled = enabled;
}
function _imgDiag(msg) {
    if (!_imgDiagEnabled || _imgDiagCount >= IMG_DIAG_CAP)
        return;
    _imgDiagCount++;
    try {
        const sw = globalThis.Switch;
        sw?.appendFileSync?.(IMG_DIAG_PATH, msg + '\n');
    }
    catch (_) { /* ignore */ }
}
// =========================================================================
// Phase 4 — image-completion coalescing (2026-06-02; see
// [[project-swb-parallel-processing-milestone]])
// =========================================================================
//
// Each <img> load that completes used to fire bumpLiveTreeVersion +
// markLiveDirty + requestFullRepaint immediately. For a page with N images
// landing in close succession (typical home/apps pages with 6+ logos,
// or Phase 0 stress at N=30), the in-progress chunked cache rebuild
// restarted on every bump — never finishing while images kept landing
// (see [[reference-swb-live-dom-partial-repaint]] — the dirty-check
// at the top of paintLiveOverlay forces a restart when buildVersion
// changes mid-build). Symptom: paint cadence collapsed to ~14 fps
// during the onload window, which the user perceived as "images load
// slow during navigation".
//
// Coalescing: each completion adds itself to one of two pending sets
// (explicit-dimensions images need a region patch only; auto-
// dimensions images need a layout-affecting invalidation) and
// schedules a setTimeout(0) flush. The flush drains both sets in one
// batch — ONE bumpLiveTreeVersion + ONE requestFullRepaint regardless
// of how many images landed. The chunked rebuild gets to run
// uninterrupted.
//
// Trade-off: a single isolated image load is delayed by one macrotask
// (~ms) vs. firing immediately. Imperceptible. A batch of N images
// triggers one rebuild instead of N restarts, which is the user-
// visible win the milestone targets.
const pendingExplicitImageCompletions = new Set();
const pendingAutoImageCompletions = new Set();
let imageCompletionFlushScheduled = false;
function queueImageCompletion(el, explicit) {
    // An element can't be in both sets — clear the other first so a
    // rapid src reassignment that flips between explicit-dimensions
    // and auto doesn't double-flush. (Edge case; mostly just hygiene.)
    if (explicit) {
        pendingAutoImageCompletions.delete(el);
        pendingExplicitImageCompletions.add(el);
    }
    else {
        pendingExplicitImageCompletions.delete(el);
        pendingAutoImageCompletions.add(el);
    }
    if (imageCompletionFlushScheduled)
        return;
    imageCompletionFlushScheduled = true;
    setTimeout(flushPendingImageCompletions, 0);
}
function flushPendingImageCompletions() {
    imageCompletionFlushScheduled = false;
    if (pendingExplicitImageCompletions.size === 0
        && pendingAutoImageCompletions.size === 0)
        return;
    // Snapshot + clear before applying, so an onload that fires
    // re-entrantly (shouldn't happen, but defensive) doesn't get
    // double-applied.
    const explicit = Array.from(pendingExplicitImageCompletions);
    const auto = Array.from(pendingAutoImageCompletions);
    pendingExplicitImageCompletions.clear();
    pendingAutoImageCompletions.clear();
    // 2026-06-14: partition by which live tree owns each image. Images
    // inside the HTML-driven toolbar / keyboard roots have their own
    // offscreen caches keyed on `toolbarTreeVersion` / `kbTreeVersion`;
    // painting them into the host's `liveCacheOffscreen` would bake the
    // toolbar's icons into the host page cache, where they would (a)
    // appear as visible duplicates below the chrome strip and (b) scroll
    // with the page — exactly the bug this guard closes. The alt-tree
    // imgs route to their own version-bump invalidation so the next
    // paintToolbarOverlay / paintKeyboardOverlay rebuilds with the
    // loaded pixels.
    const explicitHost = [];
    const autoHost = [];
    let anyAlt = false;
    let anyModal = false;
    for (const el of explicit) {
        if (!isInHostLiveTree(el)) {
            anyAlt = true;
            continue;
        }
        // 2026-06-14: modal-layer images skip the host's
        // `patchLiveImagePixelsOnly` path entirely. That helper paints
        // into the host's `liveCacheOffscreen` using the IMG's layout
        // box (screen-coords for fixed-anchored modal IMGs) — exactly
        // the leak that ghosted the modal logo into the host cache when
        // an image load raced a modal close. Modal IMGs now invalidate
        // the modal cache via `bumpModalTreeVersion` and the modal
        // paint pass re-renders the small modal subtree from scratch.
        if (el.inModalLayer) {
            anyModal = true;
            continue;
        }
        explicitHost.push(el);
    }
    for (const el of auto) {
        if (!isInHostLiveTree(el)) {
            anyAlt = true;
            continue;
        }
        if (el.inModalLayer) {
            anyModal = true;
            continue;
        }
        autoHost.push(el);
    }
    // Explicit-dimensions images: LIGHTWEIGHT patch. Paint just each
    // IMG's own box on top of the existing cache; the bg stack behind
    // each IMG (card gradient + shadow + border) was painted into the
    // cache during the initial build and DOES NOT NEED TO BE
    // REPAINTED. Measured: ~193 ms/img → ~0-2 ms/img on Featured app
    // cards (Cairo gradient + box-shadow skipped).
    if (explicitHost.length > 0)
        patchLiveImagePixelsOnly(explicitHost);
    // Auto-dimensions images: layout depends on the decoded size, so
    // route through the dirty-set path — patchLiveDirtyRegions on the
    // next paint will re-layout each subtree with the now-known
    // natural width/height and repaint the changed region.
    for (const el of autoHost)
        markLiveDirty(el);
    // Batched invalidation — one bump + one repaint for the whole batch.
    if (autoHost.length > 0)
        bumpLiveTreeVersion();
    if (explicitHost.length > 0 && !isLiveCacheBuilding())
        syncLiveCacheVersion();
    if (anyAlt) {
        // Bump both alt-tree counters so whichever cache (toolbar or
        // keyboard) contains the loaded image invalidates and rebuilds
        // on the next paint pass. Cheap — two integer bumps regardless
        // of how many images landed in this flush.
        bumpToolbarTreeVersion();
        bumpKbTreeVersion();
    }
    // Modal-layer images: bump the modal-only counter so the per-modal
    // cache invalidates on the next `paintModalOverlay`. Modal subtrees
    // are small (~30 nodes) so a full rebuild is cheap and avoids the
    // host-cache leak class of bug.
    if (anyModal)
        bumpModalTreeVersion();
    requestFullRepaint();
}
/** True iff `el` is a descendant of the host page's live root (the
 * `getLiveRoot()` singleton). Used to gate host-cache-affecting work
 * so it doesn't fire for elements in a separate live tree (the HTML-
 * driven toolbar root or the on-canvas keyboard root, both of which
 * are owned by the shell and have their own version-keyed offscreen
 * caches). Walks the parent chain — toolbar / kb trees are tiny
 * (~30 nodes max), so this is cheap. */
function isInHostLiveTree(el) {
    const hostRoot = getLiveRoot();
    for (let n = el; n; n = n.parent) {
        if (n === hostRoot)
            return true;
    }
    return false;
}
/** Drop any pending image-completion work on navigation. Called by
 * `resetLiveRoot` so a deferred flush from the previous page doesn't
 * fire against detached elements after the new page has loaded. */
function clearPendingImageCompletions() {
    pendingExplicitImageCompletions.clear();
    pendingAutoImageCompletions.clear();
    // Leave `imageCompletionFlushScheduled = true` if it already is —
    // the scheduled timer will fire harmlessly on an empty set and
    // reset the flag.
}
/** SD-card directory of the page currently loaded (e.g.
 * `sdmc:/switch/brewser/apps/mediaplayer/` for app pages, or `sdmc:/switch/brewser/shell/<rest>/` for per-profile pages). Set by
 * the shell per navigation; used to resolve PAGE-relative `<img>` srcs
 * (`./assets/x.png`) so `index.html` acts as the base, like a real browser. */
export function setLivePageBase(dir) { livePageBase = dir; }
/** Resolve a relative path against an absolute `scheme:/a/b/` base,
 * honoring `.` / `..` segments. */
function resolveAgainstBase(baseDir, rel) {
    const m = /^([a-z][a-z0-9+.-]*:\/)(.*)$/i.exec(baseDir);
    if (!m)
        return baseDir + rel;
    const parts = m[2].split('/').filter(Boolean);
    for (const seg of rel.split('/')) {
        if (seg === '' || seg === '.')
            continue;
        if (seg === '..') {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return m[1] + parts.join('/');
}
/** Resolve a live-DOM resource URL (`<img>` src, `<audio>`/`<video>` src)
 * to a fetchable absolute URL using the page-relative architecture. Shared
 * so every resource reference resolves the same way. */
export function resolveLiveResourceUrl(src) {
    const s = src.trim();
    if (!s)
        return s;
    // Already a fetchable absolute scheme → use as-is. `brewser://` is
    // included here because nxjs Image + Audio now fetch via
    // globalThis.fetch (per [[reference-nxjs-image-audio-page-url-base]]),
    // which the brewser runtime wraps so BrowserResourceLoader serves
    // brewser:// URLs from disk. No need to pre-rewrite to sdmc:/ — the
    // runtime-fetch chain rejects bare sdmc:/ URLs with 403 (no loader
    // claims them) and would silently break every catalog logo.
    if (/^(?:sdmc|romfs|file|data|blob|brewser|https?):/i.test(s))
        return s;
    // Everything else is PAGE-relative — resolved against the page's own
    // directory (`index.html` as the base), like a real browser. This is
    // uniform across all pages; `./assets/x.png`, `assets/x.png` and
    // `../sibling/x.png` all resolve relative to the current page.
    if (livePageBase) {
        // External http(s) pages: defer to the standard `URL` parser,
        // which handles root-relative (`/x`), directory-relative
        // (`./x`, `../x`), protocol-relative (`//host/x`), and
        // absolute (`scheme://...`) hrefs against the page URL in one
        // step. Required for tier3-style pages whose assets are root-
        // relative — see `BrowserShell.computeLivePageBase`. Falls
        // back to the original src on a malformed input so a bad
        // attribute doesn't throw out of the load path.
        if (/^https?:\/\//i.test(livePageBase)) {
            try {
                return new URL(s, livePageBase).toString();
            }
            catch (_) {
                return s;
            }
        }
        return resolveAgainstBase(livePageBase, s);
    }
    return s;
}
// =========================================================================
// Live tree version counter (Phase 1.5, 2026-05-25)
// =========================================================================
//
// Bumped every time the live-DOM tree mutates in a way that could change
// the rendered output: appendChild/removeChild/insertBefore/replaceChild,
// setAttribute/removeAttribute/toggleAttribute, textContent / innerHTML /
// value / checked writes, classList mutations, AND inline-style writes
// (via the LiveStyle Proxy on LiveElement construction).
//
// `paintLiveOverlay` reads this and skips re-cascade + re-layout when the
// version matches the last paint — collapses scroll-only paints from
// "walk the entire cascade for ~150 elements" to "re-blit body subtree
// via cached layout boxes." That's the FPS difference between Phase 1
// (re-layout every frame) and Phase 1.5 (re-layout only on mutation).
//
// Side effect for callers: page scripts that mutate state DON'T need to
// call any "invalidate" API; mutation hooks bump the counter automatically.
let liveTreeVersion = 0;
/** Bump the live tree version, routing to the appropriate counter
 * based on (a) an active mutation scope (kb / toolbar / modal) or (b)
 * the optional `el`'s `inModalLayer` flag — set on attach when the
 * element or an ancestor carries `data-engine-modal="true"` (the
 * `<browser-modal>` tag's expansion). The element parameter lets
 * per-mutation callers (LiveTokenList.notify, LiveElement.setAttribute,
 * etc.) auto-route to `modalTreeVersion` without the page script
 * having to push an explicit scope. */
export function bumpLiveTreeVersion(el) {
    // 2026-06-14 kb-input lag fix: while a keyboard mutation scope is
    // active (`pushKbMutationScope` / `popKbMutationScope` around
    // per-tap mutations in keyboard-overlay.ts), route the bump to the
    // kb-only counter so the host page's `liveCacheOffscreen` stays
    // warm across keystrokes. See `live-paint-control.ts` for the full
    // rationale.
    if (inKbMutationScope()) {
        bumpKbTreeVersion();
        return;
    }
    // Same shape for the HTML-driven toolbar root (rip-replace of the
    // engine-drawn chrome, 2026-06-14). Address-bar value sync, back/
    // forward enable toggles, star-icon swap, and :active flashes on
    // chrome buttons route here so the host page cache doesn't dirty
    // on every chrome state push.
    if (inToolbarMutationScope()) {
        bumpToolbarTreeVersion();
        return;
    }
    // 2026-06-14 modal layer: per-modal mutations (page-script open/close
    // class flips, async logo onload from setAttribute('src'), title
    // textContent updates) route through `modalTreeVersion` so the host's
    // `liveCacheOffscreen` stays warm across modal opens — and the logo
    // no longer ghosts into the host cache when an image load races a
    // close. Driven by `el.inModalLayer`, set on attach in
    // `propagateAttached` whenever an ancestor (or self) carries
    // `data-engine-modal="true"` (the `<browser-modal>` tag's expansion).
    // `inModalMutationScope()` covers any engine-side scoped mutations
    // (currently none, kept for symmetry with kb/toolbar).
    if (inModalMutationScope() || el?.inModalLayer) {
        bumpModalTreeVersion();
        return;
    }
    liveTreeVersion++;
}
export function getLiveTreeVersion() { return liveTreeVersion; }
/** Runtime predicate that answers "is this offscreen currently
 * WebGL-backed?" by consulting the canvas-runner's `webGLBackedCanvases`
 * set at call time. Installed once by `canvas-runner` at module-init.
 * Lets `LiveElement.isWebGLBacked()` reflect lazy `getContext('webgl2')`
 * calls that happen AFTER `attachOffscreen` committed `_webglBacked =
 * false`. See `isWebGLBacked()` for the full rationale. */
let webGLBackedPredicate = null;
export function setWebGLBackedPredicate(fn) {
    webGLBackedPredicate = fn;
}
function resetLiveTreeVersion() { liveTreeVersion = 0; }
/**
 * Minimal `DOMTokenList` shim returned by `el.classList`. Stores tokens
 * in insertion order with set semantics (duplicates ignored). Backed by
 * a plain `Set<string>` for O(1) contains.
 *
 * lil-gui calls .add / .toggle / .contains heavily ("controller", "name",
 * "widget", "number", "hasSlider", "active" etc.). The painter's CSS
 * cascade (M2.2) will read this list via `.contains` and `forEach`.
 */
export class LiveTokenList {
    tokens = new Set();
    /** Owning element — set by LiveElement's constructor. Mutations
     * notify the element's invalidation hook so the M2.2 CSS cascade
     * recomputes on the next paint. Optional so tests can construct a
     * standalone token list. */
    owner = null;
    notify() {
        // Bump tree version FIRST so paintLiveOverlay can detect the
        // mutation. invalidateLiveStyle would also bump (see live-css.ts),
        // but the chained call ensures both the style cache and the
        // live-overlay cache see a consistent dirty signal.
        // 2026-06-14: pass owner so classList ops on a `<browser-modal>`
        // descendant (the page-script `--open` flip) auto-route to
        // `modalTreeVersion` instead of dirtying the host cache.
        bumpLiveTreeVersion(this.owner ?? undefined);
        if (this.owner)
            invalidateLiveStyle(this.owner);
    }
    get length() { return this.tokens.size; }
    add(...names) {
        for (const n of names) {
            const trimmed = n.trim();
            if (trimmed)
                this.tokens.add(trimmed);
        }
        this.notify();
    }
    remove(...names) {
        for (const n of names)
            this.tokens.delete(n.trim());
        this.notify();
    }
    contains(name) {
        return this.tokens.has(name);
    }
    toggle(name, force) {
        const trimmed = name.trim();
        if (!trimmed)
            return false;
        const present = this.tokens.has(trimmed);
        const target = force === undefined ? !present : !!force;
        if (target)
            this.tokens.add(trimmed);
        else
            this.tokens.delete(trimmed);
        this.notify();
        return target;
    }
    replace(oldName, newName) {
        if (!this.tokens.has(oldName))
            return false;
        this.tokens.delete(oldName);
        if (newName.trim())
            this.tokens.add(newName.trim());
        this.notify();
        return true;
    }
    forEach(fn) {
        this.tokens.forEach(fn);
    }
    values() {
        return this.tokens.values();
    }
    get value() {
        return Array.from(this.tokens).join(' ');
    }
    set value(v) {
        this.tokens.clear();
        if (v) {
            for (const tok of v.split(/\s+/)) {
                if (tok)
                    this.tokens.add(tok);
            }
        }
        this.notify();
    }
    toString() { return this.value; }
}
/** Detect a LiveElement without `instanceof` (works across class-
 * identity issues if the module ever gets re-evaluated). */
export function isLiveElement(v) {
    return !!v && typeof v === 'object' && v[LIVE_ELEMENT_BRAND] === true;
}
/**
 * Make page-script 2D-canvas drawing visible. Native ctx mutation methods
 * (fillRect, drawImage, etc.) write directly to the OffscreenCanvas and
 * never touch live-tree state — the engine's paint loop has no signal
 * that the canvas region needs re-blitting and silently sleeps. Pages
 * that animate a 2D canvas via setTimeout/rAF (e.g. demo-breakout) end
 * up with the render loop firing but the framebuffer never updating
 * past the initial paint.
 *
 * The fix: replace the painter methods on the returned context with
 * versions that delegate to the original then `bumpLiveTreeVersion()` +
 * `requestFullRepaint()`. Done once per context instance via instance
 * shadowing (own-property overrides the prototype) so the originals
 * stay reachable through the captured `orig` closure. Sibling family
 * to the appendChild / textContent / bg-image-onload repaint hooks.
 *
 * Only true pixel-writing methods are wrapped — beginPath / moveTo /
 * arc / save / clip etc. don't paint, so they stay native.
 */
const CANVAS_PAINTER_METHODS = [
    'fillRect', 'clearRect', 'strokeRect',
    'fill', 'stroke',
    'fillText', 'strokeText',
    'drawImage', 'putImageData',
];
const CTX_WRAPPED_FLAG = Symbol('liveCtx2dWrapped');
export function wrapCanvasCtx2dForRepaint(ctx) {
    // Idempotent — page-script flows that re-call getContext on the
    // same canvas (canvas-runner shim does this every time) must not
    // re-wrap, or each call would double-shadow and the closure stack
    // would multiply repaint signals per draw. Flag the instance.
    const tagged = ctx;
    if (tagged[CTX_WRAPPED_FLAG])
        return;
    tagged[CTX_WRAPPED_FLAG] = true;
    for (const name of CANVAS_PAINTER_METHODS) {
        const orig = ctx[name];
        if (typeof orig !== 'function')
            continue;
        ctx[name] = function (...args) {
            const result = orig.apply(this, args);
            bumpLiveTreeVersion();
            requestFullRepaint();
            // Tells the shell to run overlayLiveAnimatedCanvases each
            // frame — without this the cached-layout fast path skips
            // the canvas re-blit and the framebuffer freezes at the
            // initial paint. rAF use sets a parallel flag in
            // canvas-runner; 2D canvas drawing sets this one. Both ORed
            // in the shell's gate.
            markPageHasCanvas2dActivity();
            return result;
        };
    }
}
let inputFocusHandler = null;
export function setInputFocusHandler(fn) {
    inputFocusHandler = fn;
}
export class LiveElement {
    [LIVE_ELEMENT_BRAND] = true;
    tagName;
    style;
    attrs = {};
    classList;
    parent = null;
    children = [];
    listeners = null;
    /** For `<canvas>`: lazy-allocated OffscreenCanvas backing the 2D
     * context. `null` for non-canvas tags. Also re-pointed by Phase 3b
     * `attachOffscreen` to share a canvas-runner-owned offscreen. */
    offscreen = null;
    canvasCtx2d = null;
    /** Phase 3b: true iff the attached offscreen is fed by the shared
     * screen GL bridge (live painter skips drawImage, shell's per-frame
     * overlay does copyBridgeToScreen instead). Always false for
     * canvases obtained by `getContext('2d')` from this LiveElement. */
    _webglBacked = false;
    /** For `<img>`: the loaded Image instance (or null while loading
     * or on failure). Set asynchronously from `loadImage()` on first
     * `src` attribute assignment. Painter reads via `getLoadedImage()`. */
    loadedImage = null;
    /** True once an `<img>` src fails to load. The painter shows the
     * `alt` placeholder ONLY in this state; a still-loading image renders
     * nothing (just reserves its box). Reset on each new `loadImage`. */
    imageLoadFailed = false;
    /** Animated-GIF frame ticker. Null for static images and for
     * elements whose load hasn't completed (or whose decoded image has
     * `frameCount <= 1`). Cancelled by `loadImage` on re-load, and by
     * `clearGifAnimations()` from the shell on page navigation. */
    gifAnimation = null;
    /** Per-element width/height, used both as canvas-pixel dims (when
     * tag is `canvas`) and as fallback paint-size for fixed div
     * backgrounds. Defaults match HTMLCanvasElement (300×150). */
    _width = 300;
    _height = 150;
    /** Tracks whether this element (or an ancestor) is currently
     * attached to the live root. Maintained by appendChild/removeChild
     * so the registry-driven painter can shortcut traversal. */
    attached = false;
    /** 2026-06-14: true when this element OR any ancestor in its current
     * attachment chain carries `data-engine-modal="true"` (the
     * `<browser-modal>` tag's expansion stamp). Set by
     * `propagateAttached` on every attach + cleared on detach. Mutations
     * on flagged elements route through `modalTreeVersion` instead of
     * the host's `liveTreeVersion`, so per-modal opens / closes / image
     * loads don't dirty the host page cache (and don't leak modal pixels
     * into it — the class of bug closed by this rewrite). See
     * `live-paint-control.ts` for the modal-layer rationale. */
    inModalLayer = false;
    /** Plain text content (set via `.textContent =` / `.innerHTML =`).
     * Stored in M2.0; rendered by the painter in M2.1. innerHTML strips
     * tags rather than parsing (lil-gui only assigns text strings, not
     * markup, so this is fine). */
    _text = '';
    constructor(tag) {
        // `#text` text nodes keep their tagName lowercase (DOM spec uses
        // `#text` literally for Text.nodeName / .tagName). Element tags
        // uppercase per the spec. Tests use `tagName === '#text'` to
        // branch into inline-text paint, so the case sensitivity matters.
        this.tagName = tag === '#text' ? '#text' : tag.toUpperCase();
        // Phase 1.5 + 1.5.1 (2026-05-25): wrap inline style in a Proxy
        // so per-property writes (`el.style.width = '83.5%'`, lil-gui's
        // slider pattern) invalidate THIS element's subtree only.
        // `invalidateLiveStyle(self)` walks self+descendants in the
        // computed-style cache and bumps liveTreeVersion. Other elements'
        // cached cascades are preserved — saves ~80-150 ms per tap on
        // 150-element pages (the rebuild was previously re-cascading
        // every element).
        const rawStyle = new LiveStyle();
        const self = this;
        this.style = new Proxy(rawStyle, {
            set(target, prop, value) {
                target[prop] = value;
                invalidateLiveStyle(self);
                return true;
            },
        });
        this.classList = new LiveTokenList();
        this.classList.owner = this;
        // Canvas defaults to 300×150 per HTMLCanvasElement spec.
        if (this.tagName === 'CANVAS') {
            this._width = 300;
            this._height = 150;
        }
    }
    get nodeName() { return this.tagName; }
    /** DOM spec: ELEMENT_NODE = 1, TEXT_NODE = 3. */
    get nodeType() { return this.tagName === '#text' ? 3 : 1; }
    /** Text nodes only. `el.data` mirrors `el.textContent` for `#text`
     * elements — that's the inline-flow content payload. For non-text
     * elements this is a no-op getter returning ''. Real DOM puts this
     * on CharacterData; here we expose it on LiveElement for simplicity. */
    get data() { return this.tagName === '#text' ? this._text : ''; }
    set data(v) {
        if (this.tagName !== '#text')
            return;
        const oldValue = this._text;
        this._text = v == null ? '' : String(v);
        invalidateLiveStyle(this);
        notifyCharacterData(this, oldValue);
    }
    /** Spec alias for `data` on text nodes. Modern code uses
     * `node.nodeValue` interchangeably. Same MutationObserver fire. */
    get nodeValue() { return this.tagName === '#text' ? this._text : ''; }
    set nodeValue(v) {
        if (this.tagName !== '#text')
            return;
        const oldValue = this._text;
        this._text = v == null ? '' : String(v);
        invalidateLiveStyle(this);
        notifyCharacterData(this, oldValue);
    }
    /** DOM-spec `parentElement` getter. Real DOM distinguishes it from
     * `parentNode` (returns `null` for non-element parents); here our
     * tree only has elements, so both alias `parent`. */
    get parentElement() { return this.parent; }
    get parentNode() { return this.parent; }
    get ownerDocument() { return getOwnerDocument(); }
    get firstChild() { return this.children[0] ?? null; }
    get lastChild() {
        return this.children.length ? this.children[this.children.length - 1] : null;
    }
    get nextSibling() {
        if (!this.parent)
            return null;
        const siblings = this.parent.children;
        const i = siblings.indexOf(this);
        return i >= 0 && i + 1 < siblings.length ? siblings[i + 1] : null;
    }
    get previousSibling() {
        if (!this.parent)
            return null;
        const siblings = this.parent.children;
        const i = siblings.indexOf(this);
        return i > 0 ? siblings[i - 1] : null;
    }
    get childNodes() { return this.children; }
    /** Spec `className` accessor — round-trips via classList so both
     * forms (`el.className = 'a b'` and `el.classList.add('a')`) stay in
     * sync. lil-gui's stylesheet selectors lean on this. */
    get className() { return this.classList.value; }
    set className(v) { this.classList.value = v; }
    /** Spec `id` accessor — round-trips via `setAttribute('id', …)` so
     * the cascade matcher (which reads `el.attrs.id`) sees the change.
     * Without this, `box.id = 'slice1'` was setting a plain JS property
     * that the matcher never consulted — ID-selector rules silently
     * skipped freshly-created elements. */
    get id() { return this.attrs.id ?? ''; }
    set id(v) { this.setAttribute('id', v == null ? '' : String(v)); }
    /** `textContent` — concatenates all child text plus this node's own
     * text. lil-gui never uses this for reading; setter is what matters.
     *
     * For `<style>` elements, the new text is parsed as a stylesheet
     * and registered with the M2.2 cascade. Subsequent reassignments
     * (lil-gui's pattern: build the rules string, then `style.innerHTML
     * = rules`) replace the previous registration. */
    get textContent() { return this._text; }
    set textContent(v) {
        const newText = v == null ? '' : String(v);
        const changed = this._text !== newText || this.children.length > 0;
        this._text = newText;
        // Setting textContent removes all children per DOM spec. lil-gui
        // uses this pattern on `$display.innerHTML = '...'` to replace
        // the current select option text — there are no real children to
        // drop, but matching the spec keeps the surface predictable.
        while (this.children.length) {
            const c = this.children[this.children.length - 1];
            this.removeChild(c);
        }
        if (this.tagName === 'STYLE') {
            registerStyleSheet(this, this._text);
        }
        invalidateLiveStyle(this);
        // REGRESSION-FIX 2026-06-03: previously called bumpLiveTreeVersion
        // + requestFullRepaint unconditionally to wake the paint loop for
        // async text updates (see [[feedback-swb-textcontent-no-repaint]]).
        // That broke mediaplayer (no audio, time-bar frozen), <video> (no
        // frame advance), and Web Audio (no sound) on real HW — the heavy
        // per-text-change repaints starve the audrv setInterval, killing
        // audio output. Guarded behind `changed` AND only marks dirty (no
        // requestFullRepaint) so the next paint picks up the change but
        // doesn't immediately preempt the timer queue.
        if (changed)
            markLiveDirty(this);
    }
    /** `innerHTML`. A plain string (no `<`) takes the fast path and
     * behaves like `textContent` — preserves lil-gui's short-label
     * assignments ("Controls", "✓", "Linear") and keeps the
     * `textContent` getter accurate. A string containing markup is parsed
     * into child LiveElements via the shared HtmlElement→Live converter,
     * so page scripts that build structured DOM (e.g. an audio player's
     * playlist rows) render with real nested elements + cascade matching,
     * not the raw tag text. */
    get innerHTML() { return this._text; }
    set innerHTML(v) {
        const s = v == null ? '' : String(v);
        if (s.indexOf('<') < 0) {
            this.textContent = s;
            return;
        }
        // Clear existing content (children + _text), then graft the parsed
        // fragment. `textContent = ''` also fires the STYLE-sheet
        // unregister + invalidateLiveStyle paths.
        this.textContent = '';
        parseFragmentInto(this, s);
        invalidateLiveStyle(this);
        bumpLiveTreeVersion(this);
    }
    /** M2.4 form-element accessors. `.value` works for INPUT / SELECT /
     * TEXTAREA; `.checked` for INPUT[type=checkbox]. Storage is a
     * per-element WeakMap in live-form.ts so the LiveElement class
     * stays form-agnostic and tests can mutate widget state without
     * dragging the painter in. */
    get value() { return getInputValue(this); }
    set value(v) {
        setInputValue(this, v == null ? '' : String(v));
        invalidateLiveStyle(this);
    }
    get checked() { return getInputChecked(this); }
    set checked(v) {
        setInputChecked(this, !!v);
        // Mirror to attribute so the M2.2 :checked selector picks it up.
        if (v) {
            if (!this.hasAttribute('checked'))
                this.setAttribute('checked', '');
        }
        else if (this.hasAttribute('checked')) {
            this.removeAttribute('checked');
        }
    }
    // HTMLInputElement reflected attributes. Per the HTML spec `input.min`
    // / `.max` / `.step` are string properties that reflect the matching
    // attribute. Pages rely on them — e.g. an audio player computing a
    // seek position as `Number(seek.value) / Number(seek.max)`. Without
    // these getters `seek.max` was `undefined` → `Number(undefined)` =
    // `NaN` → the computed seek target was `NaN`, which `set currentTime`
    // coerces to 0, so every seek jumped to the start.
    get min() { return this.getAttribute('min') ?? ''; }
    set min(v) { this.setAttribute('min', v == null ? '' : String(v)); }
    get max() { return this.getAttribute('max') ?? ''; }
    set max(v) { this.setAttribute('max', v == null ? '' : String(v)); }
    get step() { return this.getAttribute('step') ?? ''; }
    set step(v) { this.setAttribute('step', v == null ? '' : String(v)); }
    /** Slice 2a HTMLMediaElement-shaped accessors for <video>. State and
     * decoder live in live-video.ts's WeakMap. Reading these on non-VIDEO
     * elements is well-defined (returns paused=true / duration=0 / etc.)
     * since live-video accepts any LiveElement, so we don't gate by tag.
     */
    get currentTime() { return videoCurrentTime(this); }
    set currentTime(v) { videoSeek(this, +v || 0); }
    get duration() { return videoDuration(this); }
    get paused() { return videoIsPaused(this); }
    get ended() { return videoIsEnded(this); }
    get error() { return videoErrorMessage(this); }
    // HTMLMediaElement.volume / .muted — wired to the decoder's audrv gain
    // (videoSetVolume → audrvVoiceSetVolume) + mute. The desired value is
    // remembered in live-video state so it survives decoder re-opens.
    get volume() { return videoGetVolume(this); }
    set volume(v) { videoSetVolume(this, +v); }
    get muted() { return videoIsMuted(this); }
    set muted(v) { videoSetMuted(this, !!v); }
    play() { videoPlay(this); }
    pause() { videoPause(this); }
    /** `HTMLMediaElement.src` reflects the `src` attribute (per spec), so
     * `audio.src = '...'` reaches `resolveSourceForDecoder` (which reads
     * the attribute). A plain JS-property set would NOT, leaving the
     * decoder with no source. */
    get src() { return this.getAttribute('src') ?? ''; }
    set src(v) { this.setAttribute('src', v == null ? '' : String(v)); }
    /** `HTMLMediaElement.load()` — reset the media pipeline so the next
     * `play()` opens a decoder for the CURRENT `src`. Used when switching
     * sources (e.g. an audio player's next/prev track). */
    load() { videoResetSource(this); }
    /** Non-standard: audio-reactive per-band levels (low→high, ~0..1) at the
     * play head, for music visualizers. Empty array when not playing / no
     * audio. Stands in for the absent Web Audio AnalyserNode. */
    getAudioLevels() { return videoGetAudioLevels(this); }
    /** Non-standard: fill `out` with the play-head frequency spectrum
     * (low→high, ~0..1). Returns true when written. ~getByteFrequencyData. */
    getFrequencyData(out) { return videoGetFrequencyData(this, out); }
    /** Non-standard: fill `out` with the play-head time-domain waveform
     * (-1..1). Returns true when written. ~getByteTimeDomainData. */
    getWaveform(out) { return videoGetWaveform(this, out); }
    /** M2.5 scroll accessors. `scrollTop` reads/writes the current
     * vertical scroll offset (clamped to [0, scrollHeight-clientHeight]
     * by the layout / touch handler). `scrollHeight` / `clientHeight`
     * are derived from the M2.3 layout box. */
    _scrollTop = 0;
    get scrollTop() { return this._scrollTop; }
    set scrollTop(v) {
        const nv = Math.max(0, v | 0);
        if (nv === this._scrollTop)
            return;
        this._scrollTop = nv;
        // Scrollable containers are painted as per-frame overlays (NOT baked
        // into the body cache), so a scroll only needs a repaint — NOT a cache
        // rebuild / re-layout (which would be the multi-second freeze on heavy
        // pages). Don't bump the tree version; just request a repaint.
        requestFullRepaint();
    }
    get scrollHeight() {
        const lb = getLayoutBox(this);
        return lb ? Math.max(lb.intrinsicContentH, lb.contentH) : 0;
    }
    get scrollWidth() {
        const lb = getLayoutBox(this);
        return lb ? Math.max(lb.intrinsicContentW, lb.contentW) : 0;
    }
    get clientHeight() {
        const lb = getLayoutBox(this);
        return lb ? lb.contentH : 0;
    }
    get clientWidth() {
        const lb = getLayoutBox(this);
        return lb ? lb.contentW : 0;
    }
    /** Scroll the nearest scrollable ancestor so this element is visible.
     * Page scripts use it to keep a selected list row on screen. Vertical
     * only; the optional arg is accepted for DOM-API shape and ignored. */
    scrollIntoView(_arg) {
        scrollElementIntoView(this);
    }
    get width() { return this._width; }
    set width(v) {
        this._width = v | 0;
        if (this.offscreen && this.tagName === 'CANVAS') {
            // Resizing an OffscreenCanvas in nx.js: assign width/height
            // directly. The 2D context (if already obtained) becomes
            // stale; the next getContext('2d') re-attaches.
            this.offscreen.width = this._width;
        }
    }
    get height() { return this._height; }
    set height(v) {
        this._height = v | 0;
        if (this.offscreen && this.tagName === 'CANVAS') {
            this.offscreen.height = this._height;
        }
    }
    /** Spec-shaped attribute setter — currently only stores. Style
     * attribute (`setAttribute('style', '...')`) re-parses cssText.
     * `class` mirrors into `classList` for future CSS-cascade lookups. */
    setAttribute(name, value) {
        const lower = name.toLowerCase();
        const oldValue = Object.prototype.hasOwnProperty.call(this.attrs, lower)
            ? this.attrs[lower]
            : null;
        this.attrs[lower] = value;
        if (lower === 'style')
            this.style.cssText = value;
        else if (lower === 'class')
            this.classList.value = value;
        // Batch B: `<img src="...">` triggers an async load. onload bumps
        // the live tree version so the cache rebuilds with the loaded
        // image. `romfs:/` / `sdmc:/` work; `brewser://` may not per
        // [[nxjs-image-bypasses-global-fetch]].
        else if (lower === 'src' && this.tagName === 'IMG') {
            this.loadImage(value);
        }
        // `<iframe src="...">` triggers a separate fetch+parse+graft.
        // Tier 1B: content is fetched, parsed, and appended as iframe
        // children. Scripts are skipped; styles get scoped to the
        // iframe's subtree only (see html-to-live.ts loadIframeContents).
        else if (lower === 'src' && this.tagName === 'IFRAME') {
            loadIframeContents(this, value);
        }
        // Phase 3b (2026-05-26): `<canvas width="640" height="360">`
        // — sync the parsed-attr value into `_width` / `_height` so
        // the leaf layout's `getDisplaySize()` returns the canvas's
        // declared intrinsic dims instead of the HTMLCanvasElement
        // 300×150 default. Without this, parsed-but-script-less
        // canvases (or canvases whose script doesn't draw before the
        // first paint) would size at 300×150 regardless of HTML attrs.
        else if ((lower === 'width' || lower === 'height') && this.tagName === 'CANVAS') {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
                if (lower === 'width') {
                    this._width = n;
                    if (this.offscreen)
                        this.offscreen.width = n;
                }
                else {
                    this._height = n;
                    if (this.offscreen)
                        this.offscreen.height = n;
                }
            }
        }
        // M2.2: any attr change can affect CSS cascade ([type=text] etc.).
        invalidateLiveStyle(this);
        notifyAttribute(this, lower, oldValue);
    }
    /** Async-load an image from `src` and cache it on this element so
     * the painter / layout pass can read `naturalWidth` + `drawImage`
     * once the load completes. Loading is fire-and-forget; the live
     * tree version bumps in `onload` to trigger a fresh paint. */
    loadImage(src) {
        this.loadedImage = null;
        this.imageLoadFailed = false;
        // Cancel any GIF ticker from a previous load (src changed,
        // element reused). The next `onload` will start a fresh one if
        // the new image is animated.
        this.stopGifAnimation();
        const resolved = resolveLiveResourceUrl(src);
        _imgDiag('[' + new Date().toISOString() + '] START src=' + src + ' resolved=' + resolved);
        try {
            const img = new globalThis.Image();
            img.onload = () => {
                const anim = img;
                const fc = typeof anim.frameCount === 'number' ? anim.frameCount : 0;
                _imgDiag('[' + new Date().toISOString() + '] LOAD ok src=' + src
                    + ' w=' + img.naturalWidth + ' h=' + img.naturalHeight
                    + ' frames=' + fc);
                this.loadedImage = img;
                // Animated GIF? Start the frame ticker. `frameCount` is a
                // runtime-only nx.js extension on Image (see image.ts);
                // `HTMLImageElement` doesn't know about it, hence the
                // cast. Static images and single-frame GIFs no-op here.
                this.startGifAnimationIfNeeded(img);
                // Phase 2.5.2 (B): when the image has explicit dimensions
                // (style.width AND style.height set as pixels), the load
                // doesn't change layout — only the painted pixels in this
                // image's box. Patch the cache directly + sync version so
                // the next paint blits the updated cache without a full
                // rebuild. Saves ~1-2 s of rebuild cost per image load on
                // dom-elements-class pages.
                //
                // When the cache is still building (initial paint not
                // complete), don't patch — the chunked builder will
                // paint the now-loaded image when it reaches this element.
                // Does this image have a DEFINITE box (width AND height set
                // via inline style, CSS, or HTML attrs)? If so, the decode
                // only fills pixels in a fixed box — layout can't change — so
                // we patch just this element's region into the cache instead
                // of forcing a full re-layout/rebuild. Crucially this also
                // holds mid-build: the chunked builder may have already
                // painted a placeholder for this op (top-of-page logos run
                // early) and won't revisit it, and a bare requestFullRepaint
                // wouldn't replace it — but a region patch does. Avoiding the
                // version bump here is what stops a page with logos (e.g. the
                // welcome page) from rendering twice: an image decoding mid-
                // build used to abort + restart the whole build.
                const cs = getComputedLiveStyle(this);
                const hasW = this.style.width !== undefined || cs.width !== undefined
                    || this.getAttribute('width') !== null;
                const hasH = this.style.height !== undefined || cs.height !== undefined
                    || this.getAttribute('height') !== null;
                // Phase 4 coalescing: defer the patch / mark-dirty +
                // bump + repaint to a setTimeout(0) flush so N
                // near-simultaneous onloads cause ONE batched
                // invalidation instead of N restarts of the chunked
                // cache rebuild. See the Phase 4 block near IMG_DIAG
                // for the full rationale.
                //
                // Explicit-dimension images (hasW && hasH) only need
                // their box patched in place — layout doesn't change.
                // Auto-dimension images need a layout invalidation so
                // patchLiveDirtyRegions re-lays-out the box with the
                // now-known natural width/height; mark dirty + bump
                // happens once-per-batch in the flush.
                queueImageCompletion(this, hasW && hasH);
            };
            img.onerror = (ev) => {
                // Best-effort error message extraction (ErrorEvent.error
                // from nx.js's Image; falls back to a generic tag when the
                // event shape differs).
                let why = 'unknown';
                const e = ev;
                if (e) {
                    if (typeof e.message === 'string')
                        why = e.message;
                    else if (e.error instanceof Error)
                        why = e.error.message;
                    else if (typeof e.error === 'string')
                        why = e.error;
                    else if (e.error)
                        why = String(e.error);
                }
                _imgDiag('[' + new Date().toISOString() + '] LOAD FAIL src=' + src
                    + ' resolved=' + resolved + ' why=' + why);
                // Genuinely broken image: flag it so the painter switches
                // from "render nothing (still loading)" to the alt-text
                // placeholder, and repaint that region so it shows. Box is
                // already reserved by layout, so a region patch suffices
                // — route through the Phase 4 coalescing queue so an
                // onerror that lands among a batch of successful onloads
                // participates in the same flush.
                this.imageLoadFailed = true;
                queueImageCompletion(this, true);
            };
            img.src = resolved;
        }
        catch (e) {
            _imgDiag('[' + new Date().toISOString() + '] LOAD THROW src=' + src
                + ' err=' + (e instanceof Error ? e.message : String(e)));
            /* swallow — bad URL or runtime gap */
        }
    }
    /** Backing Image for `<img>` elements. Null when the element isn't
     * IMG, the src hasn't been set, or the load is still pending /
     * failed. */
    getLoadedImage() { return this.loadedImage; }
    /** True only when the image's load failed (not while it's loading). */
    hasImageError() { return this.imageLoadFailed; }
    /** Pre-warm the backing Image on an `<img>` LiveElement by
     * transplanting an already-decoded HTMLImageElement onto it.
     * Used by the toolbar re-build to carry the previous tree's
     * loaded icons into the new tree's same-src `<img>` slots, so
     * the navigation transition doesn't flash empty / broken-image
     * boxes while the new Image objects' async fetch+decode runs.
     * The element's own async load (started by `loadImage` on `src`
     * assignment) still runs in the background and will overwrite
     * `loadedImage` with a fresh Image when it settles — same bytes,
     * imperceptible swap. No-op on non-IMG elements.
     *
     * Skipped when the element already has a loaded image so we don't
     * stomp on a more-recent decode (e.g. a src reassignment that
     * raced the pre-warm). Also clears any prior `imageLoadFailed`
     * flag so the pre-warmed paint draws the icon instead of the
     * broken-image placeholder. */
    presetLoadedImage(img) {
        if (this.tagName !== 'IMG')
            return;
        if (this.loadedImage)
            return;
        this.loadedImage = img;
        this.imageLoadFailed = false;
    }
    /** If `img` is an animated GIF (`frameCount > 1`), schedule a
     * chained-setTimeout loop that advances frames at each frame's
     * declared delay and patches just this element's region into the
     * live cache so the next paint blits the new frame without rebuilding
     * the whole tree. No-op for static images. */
    startGifAnimationIfNeeded(img) {
        const anim = img;
        const total = typeof anim.frameCount === 'number' ? anim.frameCount : 0;
        if (total <= 1)
            return;
        let idx = 0;
        let cancelled = false;
        let currentTid = null;
        const advance = () => {
            if (cancelled)
                return;
            idx = (idx + 1) % total;
            try {
                anim.setFrame(idx);
            }
            catch (_) {
                return;
            }
            // Per-element region patch — paint the new frame into the
            // element's slot in the offscreen cache.
            //
            // We deliberately do NOT call `syncLiveCacheVersion()` here.
            // On the FIRST `onload` for an auto-dimensioned (no width/
            // height attr) animated GIF, `loadImage`'s `else` branch
            // bumps the live tree version so the engine re-lays-out the
            // element with the now-known `naturalWidth/Height`. If we
            // synced the cache version on the very first tick we'd mask
            // that pending rebuild and freeze the layout box at the
            // pre-load fallback (parent's content width × default
            // intrinsic height) — drawImage would then stretch every
            // frame onto a ~1280×24 strip. Skipping the sync keeps the
            // rebuild scheduled; subsequent ticks fire after layout has
            // settled, so the patch lands in the correct region with no
            // further work needed.
            if (this.inModalLayer)
                bumpModalTreeVersion();
            else
                patchLiveCacheRegion(this);
            requestFullRepaint();
            const delay = clampGifDelay(anim.frameDelay(idx));
            currentTid = setTimeout(advance, delay);
        };
        const ticker = {
            cancel: () => {
                cancelled = true;
                if (currentTid !== null)
                    clearTimeout(currentTid);
            },
        };
        this.gifAnimation = ticker;
        activeGifAnimations.add(ticker);
        currentTid = setTimeout(advance, clampGifDelay(anim.frameDelay(0)));
    }
    /** Stop this element's GIF ticker (if any) and drop it from the
     * global active set. */
    stopGifAnimation() {
        if (this.gifAnimation) {
            this.gifAnimation.cancel();
            activeGifAnimations.delete(this.gifAnimation);
            this.gifAnimation = null;
        }
    }
    getAttribute(name) {
        const lower = name.toLowerCase();
        if (lower === 'class')
            return this.classList.value || null;
        return this.attrs[lower] ?? null;
    }
    hasAttribute(name) {
        const lower = name.toLowerCase();
        if (lower === 'class')
            return this.classList.length > 0;
        return lower in this.attrs;
    }
    /** Element-scoped `querySelector` / `querySelectorAll` for the
     * simple selectors `liveSelectorPredicate` supports — `#id`,
     * `.class`, bare `tag`, `[attr]`, `[attr=value]`. Walks THIS
     * element's subtree (excludes self). Unsupported selectors return
     * null / empty.
     *
     * 2026-06-15: added so spec-shaped patterns like
     * `dialog.querySelectorAll('[data-close]')` work — without it the
     * call threw `TypeError: dialog.querySelectorAll is not a function`
     * and aborted the surrounding inline `<script>` after the very
     * first invocation, which made every subsequent
     * `addEventListener` / `bindClose` in that script silently skipped.
     * Mirrors the `document.querySelector*` shim in canvas-runner;
     * shares the same `liveSelectorPredicate` for selector parsing. */
    querySelector(selector) {
        const pred = liveSelectorPredicate(selector);
        if (!pred)
            return null;
        for (const child of this.children) {
            const hit = findLiveElement(child, pred);
            if (hit)
                return hit;
        }
        return null;
    }
    querySelectorAll(selector) {
        const pred = liveSelectorPredicate(selector);
        const out = [];
        if (!pred)
            return out;
        for (const child of this.children)
            findAllLiveElements(child, pred, out);
        return out;
    }
    removeAttribute(name) {
        const lower = name.toLowerCase();
        const oldValue = Object.prototype.hasOwnProperty.call(this.attrs, lower)
            ? this.attrs[lower]
            : null;
        delete this.attrs[lower];
        if (lower === 'class')
            this.classList.value = '';
        invalidateLiveStyle(this);
        if (oldValue !== null)
            notifyAttribute(this, lower, oldValue);
    }
    /** lil-gui calls `el.toggleAttribute('disabled', state)` to enable
     * / disable inputs. We treat presence as truthy and store the empty
     * string when set (HTML5 spec for boolean attributes). */
    toggleAttribute(name, force) {
        const lower = name.toLowerCase();
        const has = this.hasAttribute(lower);
        const target = force === undefined ? !has : !!force;
        if (target) {
            this.setAttribute(lower, '');
            return true;
        }
        this.removeAttribute(lower);
        return false;
    }
    appendChild(child) {
        if (!isLiveElement(child))
            return child;
        if (child.parent)
            child.parent.removeChild(child);
        // previousSibling for the MutationRecord is the LAST current
        // child (before push). nextSibling stays null since we append
        // at the end.
        const prev = this.children.length ? this.children[this.children.length - 1] : null;
        child.parent = this;
        this.children.push(child);
        propagateAttached(child, this.attached, this.inModalLayer);
        markLiveDirty(this);
        bumpLiveTreeVersion(this);
        // `bumpLiveTreeVersion` only invalidates the cache — on idle
        // pages the paint loop sleeps, so DOM mutations from async
        // paths (e.g. fetch().then() → appendChild) wouldn't visually
        // show up until the next user-driven repaint. Active repaint
        // matches what bg-image onload does (memory:
        // feedback-swb-bg-image-repaint).
        requestFullRepaint();
        notifyChildList(this, [child], [], prev, null);
        maybeLoadScriptElement(child);
        return child;
    }
    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) {
            // Capture siblings BEFORE splice for the MutationRecord.
            const prev = idx > 0 ? this.children[idx - 1] : null;
            const next = idx + 1 < this.children.length ? this.children[idx + 1] : null;
            this.children.splice(idx, 1);
            child.parent = null;
            propagateAttached(child, false);
            if (child.tagName === 'STYLE')
                unregisterStyleSheet(child);
            markLiveDirty(this);
            bumpLiveTreeVersion(this);
            requestFullRepaint();
            notifyChildList(this, [], [child], prev, next);
        }
        return child;
    }
    /** DOM spec: `insertBefore(node, reference)`. `reference == null`
     * appends. lil-gui's slider widget calls
     * `$widget.insertBefore($slider, $input)` to slide the slider in
     * before the number input. */
    insertBefore(child, reference) {
        if (!isLiveElement(child))
            return child;
        if (reference == null)
            return this.appendChild(child);
        const idx = this.children.indexOf(reference);
        if (idx < 0)
            return this.appendChild(child);
        if (child.parent)
            child.parent.removeChild(child);
        const prev = idx > 0 ? this.children[idx - 1] : null;
        child.parent = this;
        this.children.splice(idx, 0, child);
        propagateAttached(child, this.attached, this.inModalLayer);
        markLiveDirty(this);
        bumpLiveTreeVersion();
        requestFullRepaint();
        notifyChildList(this, [child], [], prev, reference);
        maybeLoadScriptElement(child);
        return child;
    }
    replaceChild(newChild, oldChild) {
        if (!isLiveElement(newChild) || !isLiveElement(oldChild))
            return oldChild;
        const idx = this.children.indexOf(oldChild);
        if (idx < 0)
            return oldChild;
        if (newChild.parent)
            newChild.parent.removeChild(newChild);
        const prev = idx > 0 ? this.children[idx - 1] : null;
        const next = idx + 1 < this.children.length ? this.children[idx + 1] : null;
        oldChild.parent = null;
        propagateAttached(oldChild, false);
        newChild.parent = this;
        this.children.splice(idx, 1, newChild);
        propagateAttached(newChild, this.attached, this.inModalLayer);
        markLiveDirty(this);
        bumpLiveTreeVersion(this);
        requestFullRepaint();
        notifyChildList(this, [newChild], [oldChild], prev, next);
        return oldChild;
    }
    /** Detach from parent. lil-gui's `destroy()` removes its panel via
     * `this.domElement.parentElement.removeChild(this.domElement)`. */
    remove() {
        if (this.parent)
            this.parent.removeChild(this);
    }
    contains(other) {
        for (let n = other; n; n = n.parent) {
            if (n === this)
                return true;
        }
        return false;
    }
    addEventListener(type, listener, _opts) {
        if (typeof listener !== 'function')
            return;
        if (!this.listeners)
            this.listeners = new Map();
        const lower = type.toLowerCase();
        let set = this.listeners.get(lower);
        if (!set) {
            set = new Set();
            this.listeners.set(lower, set);
        }
        set.add(listener);
    }
    removeEventListener(type, listener) {
        const set = this.listeners?.get(type.toLowerCase());
        if (set)
            set.delete(listener);
    }
    /** Fire registered listeners + bubble up the parent chain.
     *
     * M2.6: bubbling is required for lil-gui — it registers click on
     * `.slider` (a div), but the hit-test may return the deeper `.fill`
     * child. Without bubble, the click never reaches `.slider`'s
     * handler. Real DOM mouse/touch events bubble; this matches.
     *
     * `event.stopPropagation()` (if supplied by the caller) is wrapped
     * so it ALSO flips an internal `_bubbleCancelled` flag the bubble
     * loop checks. `event.bubbles === false` skips bubbling entirely
     * (some synthetic events shouldn't bubble — drag-target-only ones). */
    dispatchEvent(event) {
        const lower = event.type.toLowerCase();
        const bubbles = event.bubbles !== false;
        const ev = event;
        if (bubbles && typeof ev.stopPropagation !== 'function') {
            ev.stopPropagation = function () { ev._bubbleCancelled = true; };
        }
        else if (bubbles) {
            const orig = ev.stopPropagation;
            ev.stopPropagation = function () {
                ev._bubbleCancelled = true;
                if (typeof orig === 'function') {
                    try {
                        orig.call(ev);
                    }
                    catch (_) { /* swallow */ }
                }
            };
        }
        const isCanvasTouch = this.tagName === 'CANVAS' && lower.startsWith('touch');
        let target = this;
        let listenerIdx = 0;
        while (target) {
            const set = target.listeners?.get(lower);
            if (set) {
                if (isCanvasTouch && target === this) {
                    _diagCanvasDispatchEntry++;
                    if (_diagCanvasDispatchEntry <= 20 || _diagCanvasDispatchEntry % 50 === 0) {
                        console.debug('[probe:canvas-dispatch] n=' + _diagCanvasDispatchEntry +
                            ' type=' + lower +
                            ' listeners=' + set.size);
                    }
                }
                // Set `globalThis.event` to the current event for IE-compat
                // code paths. Cocos Creator's UI Button `dealClickEvents`
                // (in `_virtual_cc-*.js`) does `fp.emitEvents(this.clickEvents,
                // event)` — bare `event` identifier resolved from the global
                // scope. Without this set, every UI button touchend throws
                // ReferenceError mid-dispatch and the onClick emission never
                // runs (visible "pressed" state but no popup). Push/pop so
                // nested dispatches restore the outer event correctly.
                const gthis = globalThis;
                const prevEvent = gthis.event;
                gthis.event = event;
                try {
                    for (const fn of set) {
                        listenerIdx++;
                        try {
                            fn(event);
                        }
                        catch (err) {
                            if (isCanvasTouch) {
                                _diagCanvasDispatchThrow++;
                                if (_diagCanvasDispatchThrow <= 20) {
                                    const msg = (err && err.message) || String(err);
                                    console.debug('[probe:canvas-dispatch] EXC n=' + _diagCanvasDispatchThrow +
                                        ' type=' + lower +
                                        ' listenerIdx=' + listenerIdx +
                                        ' msg=' + msg);
                                }
                            }
                        }
                        if (ev._bubbleCancelled)
                            break;
                    }
                }
                finally {
                    gthis.event = prevEvent;
                }
            }
            if (!bubbles || ev._bubbleCancelled)
                break;
            target = target.parent;
        }
        return true;
    }
    getContext(kind) {
        if (this.tagName !== 'CANVAS') {
            _diagGetContextNonCanvas++;
            if (_diagGetContextNonCanvas <= 5 || _diagGetContextNonCanvas % 50 === 0) {
                console.debug('[probe:getContext] n=' + _diagGetContextNonCanvas +
                    ' nonCanvas tagName=' + this.tagName +
                    ' kind=' + kind);
            }
            return null;
        }
        _diagGetContextCanvas++;
        const offscreenJustCreated = !this.offscreen;
        if (_diagGetContextCanvas <= 10 || _diagGetContextCanvas % 50 === 0) {
            console.debug('[probe:getContext] n=' + _diagGetContextCanvas +
                ' canvas kind=' + kind +
                ' w=' + this._width + ' h=' + this._height +
                ' offscreenJustCreated=' + offscreenJustCreated +
                ' has2d=' + (this.canvasCtx2d ? 'cached' : 'new'));
        }
        if (kind !== '2d')
            return null; // WebGL on dynamic canvases not supported
        if (!this.offscreen) {
            this.offscreen = new OffscreenCanvas(this._width, this._height);
        }
        if (!this.canvasCtx2d) {
            this.canvasCtx2d = this.offscreen.getContext('2d');
            if (this.canvasCtx2d)
                wrapCanvasCtx2dForRepaint(this.canvasCtx2d);
        }
        return this.canvasCtx2d;
    }
    /** `el.focus()` — engines (Cocos Creator's EditBox in particular)
     * create an `<input>` via `document.createElement('input')`, append
     * it under their game container, then call `.focus()` on it to
     * request text input. We funnel INPUT / TEXTAREA focus through the
     * registered input-focus handler so the shell's KeyboardOverlay
     * opens with the input's current value and writes the result back
     * + fires `input` / `change` / `blur` events. Non-form elements
     * (canvas `.focus()` calls — Cocos does that on every MOUSE_DOWN to
     * make sure subsequent keydown events arrive) are a silent no-op so
     * existing engines that rely on `.focus()` not throwing keep
     * working. */
    focus() {
        if (this.tagName !== 'INPUT' && this.tagName !== 'TEXTAREA')
            return;
        if (inputFocusHandler) {
            try {
                inputFocusHandler(this);
            }
            catch (_) { /* swallow */ }
        }
    }
    /** `el.blur()` — paired no-op + blur event for spec compliance. */
    blur() {
        if (this.tagName !== 'INPUT' && this.tagName !== 'TEXTAREA')
            return;
        this.dispatchEvent({ type: 'blur', target: this, currentTarget: this, bubbles: false });
    }
    /** Spec-shaped `<dialog>.show()` — show the dialog as a non-modal.
     * No-op on non-DIALOG tags (spec throws `InvalidStateError`; we
     * silently no-op to stay friendly to libs that probe the method
     * before knowing whether the element is a dialog). The UA defaults
     * in `live-css.ts applyUaDefaults` map the `open` attribute to
     * `display:block + position:fixed`, so setting it flips the
     * cascade-resolved display to visible and the modal paint pass picks
     * the dialog up via the modal-roots registry that `propagateAttached`
     * populated on attach.
     *
     * Modal-mode blocking (focus trap, Esc-to-close, outside-tap-
     * dismiss) is NOT implemented — `showModal()` aliases to the same
     * `open=""` flip. Pages can layer their own behaviour on top via
     * keydown / click listeners, same as the missing-app modal does. */
    show() {
        if (this.tagName !== 'DIALOG')
            return;
        // Non-modal show: NO backdrop, no scroll block, no tap block.
        // Pages stay interactive behind the dialog. Clear any prior
        // modal-mode tag in case the same dialog was previously
        // `showModal()`-opened and is being re-shown non-modally.
        unmarkDialogModalMode(this);
        this.setAttribute('open', '');
    }
    showModal() {
        if (this.tagName !== 'DIALOG')
            return;
        // Modal mode: tag the dialog so `paintModalOverlay` paints a
        // backdrop, the shell scroll handler short-circuits, and
        // `hitTestLive` drops any tap that doesn't land inside this
        // dialog's subtree (mirrors the spec's top-layer + inertness
        // for the user-visible parts — focus trap + esc-to-close
        // aren't implemented today). Cleared in `close()`.
        markDialogModalMode(this);
        this.setAttribute('open', '');
    }
    /** Spec-shaped `<dialog>.close(returnValue?)` — hide the dialog
     * and dispatch a `close` event. The optional `returnValue` argument
     * is stored on `this.returnValue` so the listener can read it (the
     * common spec pattern is `dialog.addEventListener('close', () => …
     * dialog.returnValue)`). */
    close(returnValue) {
        if (this.tagName !== 'DIALOG')
            return;
        if (typeof returnValue === 'string')
            this.returnValue = returnValue;
        unmarkDialogModalMode(this);
        this.removeAttribute('open');
        this.dispatchEvent({ type: 'close', target: this, currentTarget: this, bubbles: false });
    }
    /** Spec-shaped `<dialog>.returnValue` — last value passed to
     * `close()`, or '' if never closed with a value. The spec also lets
     * the page set this directly before calling `close()`; the property
     * is a plain field so reads/writes work the same way. */
    returnValue = '';
    /** Spec-aligned with OffscreenCanvas.convertToBlob — encode this
     * canvas's pixels into a Blob (default PNG). Forwards to the backing
     * OffscreenCanvas. Resolves to a Blob; rejects for non-canvas tags.
     *
     * Lets WHATWG API surfaces that accept HTMLCanvasElement / OffscreenCanvas
     * sources (notably `createImageBitmap(canvas)`) round-trip through a
     * Blob without callers needing to know we wrap an OffscreenCanvas
     * internally. Caught by Cocos Creator engine init at pvzge boot when
     * it called `createImageBitmap(liveCanvasElement)`. */
    async convertToBlob(options) {
        if (this.tagName !== 'CANVAS') {
            throw new Error('convertToBlob is only valid on <canvas> elements');
        }
        if (!this.offscreen) {
            // Force lazy-init via the same path getContext uses, so the
            // offscreen exists even if no 2D context was ever requested.
            this.offscreen = new OffscreenCanvas(this._width, this._height);
        }
        return this.offscreen.convertToBlob(options);
    }
    /** Spec-aligned with HTMLCanvasElement.toBlob — callback-based
     * convenience for code that uses the older sync-style API. Wraps
     * `convertToBlob` and invokes the callback with the Blob (or null
     * if encoding rejected). */
    toBlob(callback, type, quality) {
        if (typeof callback !== 'function')
            return;
        this.convertToBlob({ type, quality }).then((blob) => callback(blob), () => callback(null));
    }
    /**
     * Spec-shaped `getBoundingClientRect`. Returned `x/y/left/top/right/
     * bottom/width/height` are in screen coordinates (the viewport the
     * painter uses — chrome inset already applied for normal mode, 0
     * for fullscreen-canvas mode).
     *
     * M2.0 layout model — for any element, walks up the chain looking
     * for the nearest `position:fixed` ancestor. The bbox origin is
     * `viewport + (ancestor.style.left/top)`; the size is the element's
     * own style width/height, with a canvas display-size fallback (the
     * Stats-pattern container has no size, but its visible canvas does).
     *
     * lil-gui uses this on `$slider.getBoundingClientRect()` to map
     * `clientX` into the slider's [min,max] range. M2.3 (flex layout)
     * will replace the "stack at parent's origin" assumption with real
     * computed bounds; until then sliders inside fixed panels still get
     * the panel's origin (good enough for the M2.0 validation page,
     * which doesn't exercise drag).
     */
    getBoundingClientRect() {
        // M2.3: prefer the laid-out box from the most recent paint.
        // The layout cache is per-frame; if we've painted at least once
        // it has the right answer including flex-distributed widths and
        // padding-aware content boxes.
        const lb = getLayoutBox(this);
        if (lb) {
            if (this.tagName === 'CANVAS') {
                _diagBboxCanvas++;
                if (_diagBboxCanvas <= 10 || _diagBboxCanvas % 100 === 0) {
                    console.debug('[probe:bbox] n=' + _diagBboxCanvas +
                        ' source=layout x=' + lb.x + ' y=' + lb.y +
                        ' w=' + lb.w + ' h=' + lb.h);
                }
            }
            return {
                x: lb.x, y: lb.y, width: lb.w, height: lb.h,
                top: lb.y, left: lb.x,
                right: lb.x + lb.w, bottom: lb.y + lb.h,
            };
        }
        // Fallback (no layout yet — first call before first paint, or
        // element not under a fixed root): M2.0 viewport + fixed-ancestor
        // math.
        const vp = getLiveViewportInternal();
        let originX = vp.x;
        let originY = vp.y;
        for (let n = this; n; n = n.parent) {
            if (n.style.position === 'fixed') {
                originX = vp.x + (n.style.left ?? 0);
                originY = vp.y + (n.style.top ?? 0);
                break;
            }
        }
        // Percent values have no containing block here (this is a
        // fallback when layout cache misses) — drop to undefined and
        // let the canvas-walk supply the size.
        const sw = typeof this.style.width === 'number' ? this.style.width : undefined;
        const sh = typeof this.style.height === 'number' ? this.style.height : undefined;
        let w = sw ?? (this.tagName === 'CANVAS' ? this._width : 0);
        let h = sh ?? (this.tagName === 'CANVAS' ? this._height : 0);
        if (w === 0 || h === 0) {
            let cw = w;
            let ch = h;
            const walk = (node) => {
                if (node.style.display === 'none')
                    return;
                if (node.tagName === 'CANVAS') {
                    const ds = node.getDisplaySize();
                    if (ds.w > cw)
                        cw = ds.w;
                    if (ds.h > ch)
                        ch = ds.h;
                }
                for (const c of node.children)
                    walk(c);
            };
            walk(this);
            w = cw;
            h = ch;
        }
        const result = {
            x: originX, y: originY, width: w, height: h,
            top: originY, left: originX,
            right: originX + w, bottom: originY + h,
        };
        if (this.tagName === 'CANVAS') {
            _diagBboxCanvas++;
            if (_diagBboxCanvas <= 10 || _diagBboxCanvas % 100 === 0) {
                console.debug('[probe:bbox] n=' + _diagBboxCanvas +
                    ' source=fallback x=' + originX + ' y=' + originY +
                    ' w=' + w + ' h=' + h +
                    ' _w=' + this._width + ' _h=' + this._height);
            }
        }
        return result;
    }
    /** Read-only access to the OffscreenCanvas backing a `<canvas>`
     * LiveElement. Used by the overlay painter to drawImage the live
     * pixels onto the screen surface. */
    getOffscreen() {
        return this.offscreen;
    }
    /** Phase 3b (2026-05-26): attach an externally-owned OffscreenCanvas
     * to this `<canvas>` LiveElement. Used by the shell after
     * `runPageScripts` to wire each canvas-runner-managed offscreen into
     * the live tree so the live painter draws what the script rendered.
     *
     * `isWebGL` flags the offscreen as backed by the shared screen GL
     * bridge (per `canvas-runner.ts`'s `webGLBackedCanvases`). The
     * painter consults this to skip drawImage and let the shell's
     * `overlayLiveAnimatedCanvases` pass do the bridge → screen copy. */
    attachOffscreen(off, isWebGL) {
        if (this.tagName !== 'CANVAS')
            return;
        this.offscreen = off;
        // Reset the 2D context cache — if a previous offscreen was
        // attached, its context is stale.
        this.canvasCtx2d = null;
        this._webglBacked = isWebGL;
        // Mirror the offscreen's intrinsic dims onto the LiveElement so
        // layout sees the actual canvas dimensions (rather than the
        // HTMLCanvasElement 300×150 default). The runner sized the
        // offscreen from the parsed canvas element's width/height attrs,
        // which the converter also copied to the LiveElement via
        // setAttribute, but the inline-attribute setter doesn't route
        // width/height through the OffscreenCanvas — only `el.width =`
        // does. Sync explicitly here.
        this._width = off.width;
        this._height = off.height;
    }
    /** Phase 3b: true iff the attached offscreen is currently routed
     * through the shared screen GL bridge. The live painter skips
     * drawImage for these so the shell's per-frame
     * `overlayLiveAnimatedCanvases` can do the bridge → screen direct
     * copy with fresh pixels.
     *
     * Why we don't just trust `_webglBacked`: pages that call
     * `getContext('webgl2')` LAZILY (after the sync boot returns —
     * Cocos Creator, some Three.js init paths) get their offscreen
     * flagged in `canvas-runner`'s `webGLBackedCanvases` set AFTER
     * `attachOffscreen` already committed `_webglBacked = false` on
     * this LiveElement. The cached flag would never flip true and the
     * painter would forever do drawImage on a stale offscreen → gray
     * screen. Consult the live predicate so the canvas joins the bridge
     * copy path as soon as the page actually pins WebGL on it. */
    isWebGLBacked() {
        if (this._webglBacked)
            return true;
        if (this.offscreen && webGLBackedPredicate) {
            return webGLBackedPredicate(this.offscreen);
        }
        return false;
    }
    /** Stats reads `canvas.style.cssText = 'width:80px;height:48px'`
     * and uses that as the *display* size (logical CSS pixels) while
     * `canvas.width`/`height` are the *pixel-buffer* size. We honour
     * the difference here so the overlay can blit at the display
     * size, which is what produces the correct on-screen footprint. */
    getDisplaySize() {
        // Percent-valued style.width has no containing block from here —
        // fall back to the pixel-buffer size. Stats only uses px, so this
        // is a safe default for the one in-tree consumer.
        const sw = this.style.width;
        const sh = this.style.height;
        return {
            w: typeof sw === 'number' ? sw : this._width,
            h: typeof sh === 'number' ? sh : this._height,
        };
    }
}
/** Walk `root`'s subtree (including `root` itself) returning the first
 * element that satisfies `pred`. Pre-order. Used by
 * `LiveElement.querySelector` and the `document.querySelector` shim in
 * canvas-runner so the two share one implementation. */
export function findLiveElement(root, pred) {
    if (pred(root))
        return root;
    for (const child of root.children) {
        const hit = findLiveElement(child, pred);
        if (hit)
            return hit;
    }
    return null;
}
/** Walk `root`'s subtree (including `root` itself), appending every
 * element that satisfies `pred` to `out`, in document order. Used by
 * `LiveElement.querySelectorAll` and the `document.querySelectorAll`
 * shim. */
export function findAllLiveElements(root, pred, out) {
    if (pred(root))
        out.push(root);
    for (const child of root.children)
        findAllLiveElements(child, pred, out);
}
/** Build a match predicate for a SIMPLE CSS selector — `#id`, `.class`,
 * bare `tag`, `[attr]`, or `[attr=value]` (both quoted forms). Compound
 * / descendant / pseudo selectors return null (unsupported). Shared by
 * `LiveElement.querySelector*` and the `document.querySelector*` shim
 * in canvas-runner — one parser, one rule set. */
export function liveSelectorPredicate(selector) {
    const sel = selector.trim();
    if (!sel)
        return null;
    if (sel.charAt(0) === '#') {
        const id = sel.slice(1);
        return (el) => el.getAttribute('id') === id;
    }
    if (sel.charAt(0) === '.') {
        const cls = sel.slice(1);
        return (el) => (el.getAttribute('class') || '').split(/\s+/).indexOf(cls) >= 0;
    }
    const attrMatch = /^\[([a-zA-Z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(sel);
    if (attrMatch) {
        const name = attrMatch[1];
        const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
        if (value === undefined) {
            return (el) => el.hasAttribute(name);
        }
        return (el) => el.getAttribute(name) === value;
    }
    if (/^[a-z][a-z0-9-]*$/i.test(sel)) {
        const want = sel.toUpperCase();
        return (el) => el.tagName === want;
    }
    return null;
}
/** True if `el` is recognised by the engine as a modal-layer root:
 * either the `<browser-modal>` tag's `data-engine-modal="true"` stamp
 * (the engine-blessed authoring API) or a native `<dialog>` element
 * (the spec-shaped path — `dialog.showModal()` / `.close()` toggle the
 * `open` attribute which the UA defaults map to display:flex / none).
 * Used by `propagateAttached` to register the element with the
 * modal-roots registry, by `collectPaintOps` to skip the subtree from
 * the host body cache, and by the fixed-element pass to lay it out but
 * defer paint to `paintModalOverlay`. Keeping the two triggers behind
 * one helper means a future third modal mechanism is a one-line add. */
export function isEngineModalRoot(el) {
    return el.getAttribute('data-engine-modal') === 'true'
        || el.tagName === 'DIALOG';
}
/** Walk a subtree updating the `attached` flag. The live painter
 * relies on this so it can iterate only the registered roots' trees
 * and skip orphan subtrees.
 *
 * 2026-06-14: also propagates `inModalLayer` and registers / unregisters
 * modal roots (`<browser-modal>` with `data-engine-modal="true"`, OR a
 * native `<dialog>` element — see `isEngineModalRoot`) with the
 * modal-roots registry in live-paint-control. The flag is set when
 * EITHER the parent is in a modal layer OR the element itself is a
 * modal root; descendants inherit. On detach the flag is cleared and
 * the registry entry is dropped so the modal paint pass stops walking
 * it. This is the foundation of the modal-layer quarantine — see the
 * module header of live-paint-control.ts. */
function propagateAttached(el, isAttached, parentInModalLayer = false) {
    // `inModalLayer` is recomputed on every (de)attach because subtree
    // hot-swaps via innerHTML re-attach the same children under a
    // freshly-stamped parent, and a previously-detached subtree could be
    // re-parented under a different (non-modal) host. Cheap; one
    // attribute lookup per element on each (de)attach.
    const selfIsModalRoot = isEngineModalRoot(el);
    const newInModalLayer = isAttached && (parentInModalLayer || selfIsModalRoot);
    const layerChanged = el.inModalLayer !== newInModalLayer;
    if (el.attached !== isAttached || layerChanged) {
        el.attached = isAttached;
        el.inModalLayer = newInModalLayer;
        // Modal-root registration tracks only `<browser-modal>` ROOTS
        // (the elements that carry the data-engine-modal stamp), not
        // every descendant inside one. Paint walks descend from the
        // registered root.
        if (selfIsModalRoot) {
            if (isAttached)
                registerModalRoot(el);
            else
                unregisterModalRoot(el);
        }
    }
    for (const c of el.children)
        propagateAttached(c, isAttached, newInModalLayer);
}
/**
 * LiveStyle — proxy-ish object behind `el.style`. Two access shapes:
 *   - `style.cssText = '...';` re-parses the whole text.
 *   - `style.position = 'fixed'; style.top = 0;` mutates one field at
 *     a time. Numeric values can come as numbers OR `'10px'`-style
 *     strings; we coerce.
 *
 * The DOM spec says `style.top` returns the *string* form (e.g. `'0px'`).
 * Stats only writes, never reads (the test would care). For safety we
 * coerce on read back to a string with `px` suffix where it makes sense.
 */
class LiveStyle {
    position;
    top;
    left;
    right;
    bottom;
    // Length-bearing props (width/height/min-*/max-*) need string-aware
    // setters: real-browser DOM accepts `el.style.width = "83.5%"` as a
    // plain string. lil-gui's slider drives `this.$fill.style.width =
    // (i*100)+'%'` directly that way. Without parsing on set, the string
    // "83.5%" lands in the field as a raw string and resolveLength sees
    // neither a number nor a CssPercent → returns NaN.
    _width;
    _height;
    _minWidth;
    _maxWidth;
    _minHeight;
    _maxHeight;
    get width() { return this._width; }
    set width(v) { this._width = coerceLength(v); }
    get height() { return this._height; }
    set height(v) { this._height = coerceLength(v); }
    get minWidth() { return this._minWidth; }
    set minWidth(v) { this._minWidth = coerceLength(v); }
    get maxWidth() { return this._maxWidth; }
    set maxWidth(v) { this._maxWidth = coerceLength(v); }
    get minHeight() { return this._minHeight; }
    set minHeight(v) { this._minHeight = coerceLength(v); }
    get maxHeight() { return this._maxHeight; }
    set maxHeight(v) { this._maxHeight = coerceLength(v); }
    display;
    opacity;
    zIndex;
    cursor;
    background;
    color;
    // M2.1 text props.
    fontFamily;
    fontSize;
    fontWeight;
    fontStyle;
    textAlign;
    lineHeight;
    textDecoration;
    verticalAlign;
    listStyleType;
    // M2.3 layout props.
    paddingTop;
    paddingRight;
    paddingBottom;
    paddingLeft;
    marginTop;
    marginRight;
    marginBottom;
    marginLeft;
    gap;
    flexDirection;
    flexGrow;
    flexShrink;
    flexBasis;
    alignItems;
    justifyContent;
    boxSizing;
    borderTopWidth;
    borderRightWidth;
    borderBottomWidth;
    borderLeftWidth;
    borderTopColor;
    borderRightColor;
    borderBottomColor;
    borderLeftColor;
    borderRadius;
    // M2.5 overflow.
    overflowX;
    overflowY;
    get cssText() { return serializeStyle(this); }
    set cssText(v) {
        // Wipe + reparse.
        this.position = undefined;
        this.top = undefined;
        this.left = undefined;
        this.right = undefined;
        this.bottom = undefined;
        this.width = undefined;
        this.height = undefined;
        this.display = undefined;
        this.opacity = undefined;
        this.zIndex = undefined;
        this.cursor = undefined;
        this.background = undefined;
        this.color = undefined;
        this.fontFamily = undefined;
        this.fontSize = undefined;
        this.fontWeight = undefined;
        this.fontStyle = undefined;
        this.textAlign = undefined;
        this.lineHeight = undefined;
        this.textDecoration = undefined;
        this.verticalAlign = undefined;
        this.listStyleType = undefined;
        this.paddingTop = undefined;
        this.paddingRight = undefined;
        this.paddingBottom = undefined;
        this.paddingLeft = undefined;
        this.marginTop = undefined;
        this.marginRight = undefined;
        this.marginBottom = undefined;
        this.marginLeft = undefined;
        this.gap = undefined;
        this.flexDirection = undefined;
        this.flexGrow = undefined;
        this.flexShrink = undefined;
        this.flexBasis = undefined;
        this.alignItems = undefined;
        this.justifyContent = undefined;
        this.boxSizing = undefined;
        this.minWidth = undefined;
        this.maxWidth = undefined;
        this.minHeight = undefined;
        this.maxHeight = undefined;
        this.overflowX = undefined;
        this.overflowY = undefined;
        this.customProps = undefined;
        const parsed = parseCssText(v);
        Object.assign(this, parsed);
    }
    /** Inline `--foo` custom properties set via `setProperty` or
     * `style="--foo: …"`. Merged into the element's computed-style
     * `customProps` bag in live-css so var() refs resolve against them. */
    customProps;
    /** Object-style write for unknown / camelCased property access.
     * Stats uses dot access (`style.display = 'none'`) which TypeScript
     * sees as the typed fields; this is a fallback for tools that go
     * through `Object.assign`. Custom properties (`--foo`) land in
     * `customProps` via the same applyDecl path. */
    setProperty(name, value) {
        applyDecl(this, name, value);
    }
    /** Spec-shaped `getPropertyValue(name)`. For `--foo` returns the
     * stored custom-prop value (empty string if unset). For regular
     * properties returns a best-effort serialization — most code that
     * cares about resolved values uses `getComputedStyle(el)` instead. */
    getPropertyValue(name) {
        if (name.startsWith('--')) {
            return this.customProps?.[name] ?? '';
        }
        // Best-effort: kebab-case → camelCase field lookup, stringified.
        const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const v = this[camel];
        if (v === undefined || v === null)
            return '';
        return String(v);
    }
}
/**
 * LiveRoot — the single `document.body` equivalent. Children attached
 * here (and recursively) become candidates for the per-frame overlay
 * pass. `attached` is propagated on append/remove so descendants know
 * whether they're live.
 *
 * Singleton-per-script-context: every script runs against the same
 * root within a given page session. Reset on navigation
 * ({@link resetLiveRoot}).
 */
class LiveRoot extends LiveElement {
    constructor() { super('body'); this.attached = true; }
}
let liveRoot = new LiveRoot();
// `liveWindow` + `liveDocumentRef` declarations are below the
// `LiveWindow` class (TS forward-reference rules forbid using a
// class before its declaration in a `let` initializer).
export function getLiveRoot() { return liveRoot; }
/** Reset the live root on page navigation so live elements created
 * by the previous page don't survive into the next. Also resets the
 * window-level event registry (M2.0) so listeners from the previous
 * page don't keep firing under the next one. */
export function resetLiveRoot() {
    liveRoot = new LiveRoot();
    liveWindow = new LiveWindow();
    liveDocumentRef = null;
    // M2.2: clear stylesheet registry + cascade caches.
    resetLiveCss();
    // Phase 1.5: reset the tree version so the new page's cache state
    // starts fresh (without this, the first paint after navigation could
    // hit a stale cache from the previous page).
    resetLiveTreeVersion();
    // CSS background-image cache — entries reference HTMLImageElements
    // owned by the previous page session; flush so the new page's url()
    // references trigger fresh loads against the new base URL.
    clearBackgroundImageCache();
    // Phase 4: drop any pending image-completion work so a deferred
    // flush from the previous page doesn't fire against detached
    // elements after the new page has loaded.
    clearPendingImageCompletions();
    // Modal registry holds direct LiveElement refs into the just-discarded
    // tree. Without this, `paintModalOverlay` keeps walking the old page's
    // modal subtrees during the new page's load frame and renders them on
    // top (Permission / Missing-App / Updates leak-through symptom). Drop
    // the registry in sync with the tree it refers to.
    clearModalRoots();
}
/**
 * Page-level `window` shim that owns the listener registry forwarded
 * to by the shell's touch handler (mouse / touch events lil-gui needs
 * for slider drags). Used internally; pages see the proxy below.
 *
 * Bound to one page session — `resetLiveRoot()` replaces this on
 * navigation so a leaving page's drag handlers don't keep firing.
 */
export class LiveWindow {
    listeners = new Map();
    addEventListener(type, listener, _opts) {
        if (typeof listener !== 'function')
            return;
        if (typeof type !== 'string')
            return; // Cocos engine init iterates
        // over feature-gated event-name lists and may pass `undefined` for
        // optional events (pointerdown, gestureend, etc.); silent no-op
        // instead of throwing keeps the engine init loop alive.
        const lower = type.toLowerCase();
        let set = this.listeners.get(lower);
        if (!set) {
            set = new Set();
            this.listeners.set(lower, set);
        }
        set.add(listener);
    }
    removeEventListener(type, listener, _opts) {
        if (typeof type !== 'string')
            return;
        this.listeners.get(type.toLowerCase())?.delete(listener);
    }
    dispatchEvent(event) {
        if (!event || typeof event.type !== 'string')
            return true;
        const set = this.listeners.get(event.type.toLowerCase());
        if (!set)
            return true;
        for (const fn of set) {
            try {
                fn(event);
            }
            catch (_) { /* swallow — keep loop alive */ }
        }
        return true;
    }
    hasListeners(type) {
        if (typeof type !== 'string')
            return false;
        return (this.listeners.get(type.toLowerCase())?.size ?? 0) > 0;
    }
}
// `let` storage for the per-page LiveWindow + owner-doc ref.
// Defined here (after the class) to satisfy TS forward-reference
// rules. `resetLiveRoot()` (above) reassigns both per page.
let liveWindow = new LiveWindow();
let liveDocumentRef = null;
export function getLiveWindow() { return liveWindow; }
/**
 * Dispatch a synthetic `keydown` (or other key event) into the live
 * page's window+document registry (which the documentShim shares with
 * LiveWindow). Returns `true` if any handler called `preventDefault()`.
 *
 * Used by `controller-shortcuts.ts` to forward D-pad / right-stick
 * presses to page scripts while in `video-fullscreen` mode, so the
 * TikTok-style apps can implement controller-driven swipe navigation.
 * Outside video-fullscreen the engine keeps its normal scroll behavior.
 */
export function dispatchPageKeyEvent(type, key, code) {
    const ev = {
        type,
        key,
        code: code ?? key,
        bubbles: true,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { },
    };
    liveWindow.dispatchEvent(ev);
    return ev.defaultPrevented === true;
}
/** True iff any page-registered listener exists for the named event
 * on the shared window+document registry. Cheap pre-check so the input
 * loop can skip building a synthetic event when nothing will consume
 * it. */
export function pageHasListenerFor(type) {
    return liveWindow.hasListeners(type);
}
/**
 * Returns a Proxy that surface-shadows `window` per page. Intercepts
 * `addEventListener` / `removeEventListener` / `dispatchEvent` so
 * synthetic mouse/touch events from the canvas touch handler land in
 * this page's `LiveWindow` registry. Everything else (devicePixelRatio,
 * requestAnimationFrame, innerWidth, etc.) falls through to globalThis
 * so existing Three.js demos that probe those don't regress.
 *
 * The returned proxy is what the documentShim injects into the
 * AsyncFunction body as the `window` parameter — page scripts that
 * read `window.X` get the proxy; the proxy decides whether to handle
 * X locally or delegate up.
 */
export function getLiveWindowProxy() {
    const win = liveWindow;
    const global = globalThis;
    // Touch-event feature-detect properties that engines (Cocos Creator's
    // input system in particular) probe via `'ontouchstart' in window`
    // before attaching touch listeners. Listing them in the `has` trap
    // makes the `in` check return true; the `get` trap returns null so
    // the property looks like an unassigned event handler. See pvzge
    // 2026-06-07 touch wiring (documentShim has the matching
    // `ontouchstart: null` pair for `document.ontouchstart` probes).
    const TOUCH_FEATURE_PROPS = new Set([
        'ontouchstart', 'ontouchmove', 'ontouchend', 'ontouchcancel',
        // Mouse + pointer event feature flags. Same pattern as the touch
        // flags: engines (Cocos Creator's input system in particular)
        // probe `'onmousedown' in window` before binding listeners; we
        // expose them as null so the `in` check passes and the engine
        // takes the mouse branch. Required for the software-cursor
        // driver in `page-mouse-forwarder.ts` to be visible to the
        // page's input system. See pvzge 2026-06-09 mouse wiring.
        'onmousedown', 'onmousemove', 'onmouseup', 'onclick',
        'oncontextmenu',
        'onpointerdown', 'onpointermove', 'onpointerup',
        'onpointerover', 'onpointerout', 'onpointerenter', 'onpointerleave',
        'onmouseover', 'onmouseout', 'onmouseenter', 'onmouseleave',
    ]);
    const handler = {
        get(_target, prop) {
            if (prop === 'addEventListener')
                return win.addEventListener.bind(win);
            if (prop === 'removeEventListener')
                return win.removeEventListener.bind(win);
            if (prop === 'dispatchEvent')
                return win.dispatchEvent.bind(win);
            if (typeof prop === 'string' && TOUCH_FEATURE_PROPS.has(prop))
                return null;
            // Fall through to globalThis for everything else.
            const v = global[prop];
            return typeof v === 'function' ? v.bind(globalThis) : v;
        },
        has(_target, prop) {
            if (prop === 'addEventListener' || prop === 'removeEventListener' || prop === 'dispatchEvent')
                return true;
            if (typeof prop === 'string' && TOUCH_FEATURE_PROPS.has(prop))
                return true;
            return prop in global;
        },
        set(_target, prop, value) {
            global[prop] = value;
            return true;
        },
    };
    return new Proxy({}, handler);
}
/** The shell's documentShim stashes itself here once per page so
 * LiveElement.ownerDocument can return something. Not used by lil-gui
 * directly, but several third-party libs probe `el.ownerDocument` to
 * locate `document.body` indirectly. */
export function setOwnerDocument(doc) {
    liveDocumentRef = doc;
}
function getOwnerDocument() { return liveDocumentRef; }
/** Module-internal viewport mirror, kept in sync with the painter +
 * hit-tester via setLiveViewport (called by the shell from each
 * render path). Read by `LiveElement.getBoundingClientRect()`. */
let internalLiveViewport = { x: 0, y: 0, width: 0, height: 0 };
export function setInternalLiveViewport(v) {
    internalLiveViewport = v;
}
function getLiveViewportInternal() { return internalLiveViewport; }
/** Public getter for the current live-DOM viewport (origin + size of the
 * area where the page is painted, accounting for the chrome strip in
 * normal mode and the full screen in fullscreen modes). Consumed by the
 * page-mouse-forwarder so cursor hit-tests use the SAME viewport the
 * touch path uses — without this they used a hardcoded full-screen
 * viewport and clicked the wrong elements by the toolbar's y-offset. */
export function getLiveViewport() { return internalLiveViewport; }
/** Module-internal page scroll offset, mirroring the painter's
 * `effectiveScrollY`. Set by the shell after each paintLiveOverlay so
 * hit-test can translate body-local boxes (Phase 1.5, 2026-05-25) into
 * screen coords. Default 0 keeps fullscreen-canvas / pre-paint paths
 * unaffected. */
let internalLiveScrollY = 0;
export function getInternalLiveScrollY() { return internalLiveScrollY; }
export function setInternalLiveScrollY(v) {
    internalLiveScrollY = v;
}
/** Compute the on-screen bounding-box size of a position:fixed live
 * element. If the element itself has explicit `style.width`/`height`,
 * use that; otherwise fall back to the union of visible canvas
 * children's display sizes (the Stats pattern: container has no size,
 * but its visible canvas panel does). */
function computeFixedSize(el) {
    // Percent values can't be resolved without a containing block — this
    // is a Phase-1 fallback used before layout runs, so drop them. The
    // Phase-2 layout (layout-fixed-root) resolves percents properly.
    const sw = typeof el.style.width === 'number' ? el.style.width : undefined;
    const sh = typeof el.style.height === 'number' ? el.style.height : undefined;
    if (sw !== undefined && sh !== undefined)
        return { w: sw, h: sh };
    let w = sw ?? 0;
    let h = sh ?? 0;
    function walk(node) {
        if (node.style.display === 'none')
            return;
        if (node.tagName === 'CANVAS') {
            const ds = node.getDisplaySize();
            if (ds.w > w)
                w = ds.w;
            if (ds.h > h)
                h = ds.h;
        }
        for (const c of node.children)
            walk(c);
    }
    walk(el);
    return { w, h };
}
/**
 * Walk the live tree and return the topmost `position:fixed` element
 * whose bounding box (offset by `viewport.x/y`) contains the screen
 * coordinate `(x, y)`. Used by the touch dispatcher to route synthetic
 * click events to live-DOM overlays (e.g. Stats's tap-to-cycle).
 *
 * Returns the matched element so the caller can `dispatchEvent({type:'click', ...})`
 * on it. Caller is responsible for synthesising the event object;
 * `dispatchEvent` already exists on LiveElement.
 *
 * Sort order: highest z-index first; within the same z, latest
 * document-order first (which is "on top" by the painter's stable
 * sort). `display:none` elements are skipped.
 */
export function hitTestLive(root, x, y, viewport) {
    // M2.3: walk EVERY element in the tree (not just position:fixed)
    // since flex layout now means descendants of a fixed root have
    // their own laid-out bboxes. We use the layout cache; if an element
    // has no laid-out box (off-screen ancestor / display:none /
    // pre-paint), fall back to the M2.0 viewport+fixed-ancestor math
    // for the fixed-rooted case.
    const candidates = [];
    let order = 0;
    function collect(el, inFixed, scrollOff, inheritedZ, clipRect, relOffsetX, relOffsetY) {
        const cs = getComputedLiveStyle(el);
        if (cs.display === 'none' || el.style.display === 'none')
            return;
        const tag = el.tagName;
        if (tag === 'OPTION' || tag === 'OPTGROUP')
            return;
        const elPosition = cs.position ?? el.style.position;
        const nowFixed = inFixed || elPosition === 'fixed';
        const ownZ = cs.zIndex ?? el.style.zIndex ?? 0;
        const effZ = Math.max(ownZ, inheritedZ);
        // position: relative — shift the element's painted bbox + its
        // descendants by (top|-bottom, left|-right) in the same way the
        // painter does via ctx.translate. Cumulative through nested
        // relative ancestors.
        let descRelX = relOffsetX;
        let descRelY = relOffsetY;
        if (elPosition === 'relative') {
            descRelX += (cs.left ?? el.style.left ?? 0) - (cs.right ?? el.style.right ?? 0);
            descRelY += (cs.top ?? el.style.top ?? 0) - (cs.bottom ?? el.style.bottom ?? 0);
        }
        // Phase 1 (2026-05-25): also push non-fixed candidates when they
        // have a layout box from the body-flow pass. Skip the BODY root
        // itself so taps that miss all body children fall through to the
        // static link/button dispatch — otherwise body's full-viewport
        // bbox would steal every tap from the static layer.
        //
        // Phase 1.5 (2026-05-25): body-flow boxes are now stored in body-
        // LOCAL coords (origin 0,0) because the painter applies a
        // ctx.translate(viewport.x, viewport.y - scrollY) before walking.
        // Translate them back to screen-space here so hit-test compares
        // the right rect. Fixed-rooted boxes are already in screen-space
        // — no translation needed.
        const isBodyRoot = el === root;
        if (!isBodyRoot) {
            const lb = getLayoutBox(el);
            let cx, cy, cw, ch;
            if (lb && lb.w > 0 && lb.h > 0) {
                if (nowFixed) {
                    cx = lb.x + descRelX;
                    cy = lb.y - scrollOff + descRelY;
                }
                else {
                    cx = lb.x + viewport.x + descRelX;
                    cy = lb.y + viewport.y - internalLiveScrollY - scrollOff + descRelY;
                }
                cw = lb.w;
                ch = lb.h;
            }
            else if (elPosition === 'fixed') {
                cx = viewport.x + (cs.left ?? el.style.left ?? 0);
                cy = viewport.y + (cs.top ?? el.style.top ?? 0);
                const sz = computeFixedSize(el);
                cw = sz.w;
                ch = sz.h;
            }
            if (cx !== undefined && cy !== undefined && cw !== undefined && ch !== undefined) {
                let bx = cx, by = cy, bw = cw, bh = ch;
                if (clipRect) {
                    const x2 = Math.min(bx + bw, clipRect.x + clipRect.w);
                    const y2 = Math.min(by + bh, clipRect.y + clipRect.h);
                    bx = Math.max(bx, clipRect.x);
                    by = Math.max(by, clipRect.y);
                    bw = Math.max(0, x2 - bx);
                    bh = Math.max(0, y2 - by);
                }
                // Phase 2.5 fix (2026-05-25): body-flow candidates must
                // also be clipped to the viewport rect. Otherwise an atom
                // that's scrolled UP into the toolbar zone (screen y < 30)
                // is still hittable in that area, eating toolbar taps.
                // Fixed-rooted candidates already paint at viewport-origin
                // coords so they don't need this clamp.
                if (!nowFixed) {
                    const vx2 = Math.min(bx + bw, viewport.x + viewport.width);
                    const vy2 = Math.min(by + bh, viewport.y + viewport.height);
                    bx = Math.max(bx, viewport.x);
                    by = Math.max(by, viewport.y);
                    bw = Math.max(0, vx2 - bx);
                    bh = Math.max(0, vy2 - by);
                }
                if (bw > 0 && bh > 0) {
                    candidates.push({
                        el, x: bx, y: by, w: bw, h: bh,
                        z: effZ,
                        order: order++,
                    });
                }
            }
        }
        // M2.6 fix: tighten clip rect for descendants when this element
        // has overflow != visible. Scrollable + hidden containers clip
        // their children visually; hit-test follows so scrolled-out or
        // out-of-overflow items aren't hittable in the cleared area.
        // Phase 1: gate on having a layout box (not on nowFixed) — body-
        // flow elements with overflow:auto need the same clip propagation.
        // Phase 1.5: the clipRect must be in SCREEN space (same as
        // candidate boxes) — translate body-local contentX/Y to screen.
        let descendantClip = clipRect;
        const oy = cs.overflowY ?? 'visible';
        const ox = cs.overflowX ?? 'visible';
        if (oy !== 'visible' || ox !== 'visible') {
            const lb = getLayoutBox(el);
            if (lb) {
                const own = nowFixed
                    ? { x: lb.contentX, y: lb.contentY, w: lb.contentW, h: lb.contentH }
                    : {
                        x: lb.contentX + viewport.x,
                        y: lb.contentY + viewport.y - internalLiveScrollY,
                        w: lb.contentW, h: lb.contentH,
                    };
                if (clipRect) {
                    const x2 = Math.min(own.x + own.w, clipRect.x + clipRect.w);
                    const y2 = Math.min(own.y + own.h, clipRect.y + clipRect.h);
                    descendantClip = {
                        x: Math.max(own.x, clipRect.x),
                        y: Math.max(own.y, clipRect.y),
                        w: Math.max(0, x2 - Math.max(own.x, clipRect.x)),
                        h: Math.max(0, y2 - Math.max(own.y, clipRect.y)),
                    };
                }
                else {
                    descendantClip = own;
                }
            }
        }
        // Phase 2.5 (2026-05-25): if this element has an inline-formatting
        // context, its atoms are stored in the inlineCache rather than
        // child layout boxes. Push each atom as a hit candidate so taps
        // on a specific word / link / inline element resolve correctly.
        const inline = getInlineLayout(el);
        if (inline) {
            for (const atom of inline.atoms) {
                if (atom.isBr)
                    continue;
                if (atom.w <= 0 || atom.h <= 0)
                    continue;
                // Atom boxes are in body-local (or fixed-rooted) space —
                // same coordinate system as the enclosing element's box.
                let bx, by;
                if (nowFixed) {
                    bx = atom.x + descRelX;
                    by = atom.y - scrollOff + descRelY;
                }
                else {
                    bx = atom.x + viewport.x + descRelX;
                    by = atom.y + viewport.y - internalLiveScrollY - scrollOff + descRelY;
                }
                let bw = atom.w, bh = atom.h;
                if (clipRect) {
                    const x2 = Math.min(bx + bw, clipRect.x + clipRect.w);
                    const y2 = Math.min(by + bh, clipRect.y + clipRect.h);
                    bx = Math.max(bx, clipRect.x);
                    by = Math.max(by, clipRect.y);
                    bw = Math.max(0, x2 - bx);
                    bh = Math.max(0, y2 - by);
                }
                // Same viewport clamp as element-level candidates above —
                // atoms scrolled above into the toolbar zone shouldn't
                // eat toolbar taps.
                if (!nowFixed) {
                    const vx2 = Math.min(bx + bw, viewport.x + viewport.width);
                    const vy2 = Math.min(by + bh, viewport.y + viewport.height);
                    bx = Math.max(bx, viewport.x);
                    by = Math.max(by, viewport.y);
                    bw = Math.max(0, vx2 - bx);
                    bh = Math.max(0, vy2 - by);
                }
                if (bw > 0 && bh > 0) {
                    candidates.push({
                        el: atom.el, x: bx, y: by, w: bw, h: bh,
                        z: effZ, order: order++,
                    });
                }
            }
            // Atoms replace the child walk — the inline children's content
            // is already in the atom list.
            return;
        }
        const childScrollOff = scrollOff + (el.scrollTop || 0);
        for (const c of el.children)
            collect(c, nowFixed, childScrollOff, effZ, descendantClip, descRelX, descRelY);
    }
    collect(root, false, 0, 0, null, 0, 0);
    // 2026-06-15 modal-mode tap blocking — if any `<dialog>.showModal()`
    // dialog is currently open (cs.display !== 'none') and registered as
    // modal-mode, drop candidates that aren't inside its subtree. Mirrors
    // the spec's "rest of the page is inert" semantics for the
    // user-visible part: a tap outside the modal does nothing instead
    // of bleeding through to the page underneath. `show()` (non-modal)
    // dialogs aren't tagged → page stays interactive behind them. The
    // candidate sort already gives the modal a z-index boost; this
    // extra filter is the difference between "the modal CAN steal a
    // tap from a same-z body element" and "nothing outside the modal
    // is tappable at all."
    const activeModalDialog = findActiveModalModeDialog(root);
    const filtered = activeModalDialog
        ? candidates.filter((c) => activeModalDialog.contains(c.el))
        : candidates;
    filtered.sort((a, b) => {
        if (a.z !== b.z)
            return b.z - a.z; // higher z first
        return b.order - a.order; // latest in doc order first
    });
    for (const c of filtered) {
        if (c.w <= 0 || c.h <= 0)
            continue;
        if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) {
            return c.el;
        }
    }
    return null;
}
/** Returns the currently-visible `<dialog>` that was opened via
 * `showModal()` (so it's modal-mode-tagged and should block taps to
 * the rest of the page), or null if none. Walks the modal-mode set
 * checking `cs.display !== 'none'` — a stale entry whose `open`
 * attribute was cleared by direct DOM manipulation rather than
 * `close()` is filtered out here. Only one such dialog is expected to
 * be open at a time per spec; the first match wins. */
function findActiveModalModeDialog(root) {
    const dialogs = getModalModeDialogs();
    if (dialogs.length === 0)
        return null;
    for (const d of dialogs) {
        // Must still be in the tree under `root` — a detached dialog
        // shouldn't suppress taps on the page that's actually painted.
        let n = d;
        let inTree = false;
        while (n) {
            if (n === root) {
                inTree = true;
                break;
            }
            n = n.parent;
        }
        if (!inTree)
            continue;
        const cs = getComputedLiveStyle(d);
        if (cs.display === 'none')
            continue;
        return d;
    }
    return null;
}
//# sourceMappingURL=live-dom.js.map