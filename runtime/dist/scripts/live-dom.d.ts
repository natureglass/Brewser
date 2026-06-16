/// <reference types="@nx.js/runtime" />
import { type CssLength, type InlineStyle } from './inline-css.js';
declare const LIVE_ELEMENT_BRAND: unique symbol;
export declare function clearGifAnimations(): void;
export declare function clearCssAnimations(): void;
/** Per-frame interpolated values for an element under CSS animation.
 * The painter reads this in `paintBoxedElement` (via `getCssAnimState`)
 * and wraps the element's draw with ctx.transform / globalAlpha. */
export type CssAnimState = {
    rotateRad?: number;
    scaleX?: number;
    scaleY?: number;
    opacity?: number;
};
/** Painter-side lookup: current interpolated values for `el`, or
 * undefined if no animation is running. */
export declare function getCssAnimState(el: LiveElement): CssAnimState | undefined;
/** Painter-side keyframe stop carrier (the registry stores arrays of
 * these — see live-css's `KeyframeStop`). Re-declared here to avoid
 * importing CSS internals from a callback signature. */
type KeyframeStop = {
    offset: number;
    rotateRad?: number;
    scaleX?: number;
    scaleY?: number;
    opacity?: number;
};
/** Start a CSS-animation ticker for `el` if its computed style carries
 * an `animation: <name> <duration> …` shorthand AND the named
 * `@keyframes` rule has been registered. Idempotent. */
export declare function ensureCssAnimation(el: LiveElement, spec: {
    name: string;
    durationMs: number;
    iterationCount: number | 'infinite';
}, keyframesLookup: (name: string) => KeyframeStop[] | undefined): void;
/** Image source for a CSS background — either a raster `HTMLImageElement`
 * (nx.js's Image, decoded by the C-side decoder) or an OffscreenCanvas
 * we rasterize ourselves for SVG. Both are valid `CanvasImageSource`
 * args to `drawImage`. */
export type BgImageSource = HTMLImageElement | OffscreenCanvas;
/** Lookup-or-load a background-image URL. Returns the loaded image, or
 * `null` while still loading / on permanent failure. Triggers a fresh
 * load + tree-version bump on first call per URL. */
export declare function getBackgroundImage(url: string): BgImageSource | null;
/** Wipe the background-image cache on page navigation so loads from
 * the previous page don't leak into the new one. */
export declare function clearBackgroundImageCache(): void;
/** Toggle the swb image-load diag log. Off by default; the shell flips
 * it on at startup when `config.json`'s `swbImgDebug` key is `true`. */
export declare function setSwbImgDebugEnabled(enabled: boolean): void;
/** SD-card directory of the page currently loaded (e.g.
 * `sdmc:/switch/brewser/apps/mediaplayer/` for app pages, or `sdmc:/switch/brewser/shell/<rest>/` for per-profile pages). Set by
 * the shell per navigation; used to resolve PAGE-relative `<img>` srcs
 * (`./assets/x.png`) so `index.html` acts as the base, like a real browser. */
export declare function setLivePageBase(dir: string): void;
/** Resolve a live-DOM resource URL (`<img>` src, `<audio>`/`<video>` src)
 * to a fetchable absolute URL using the page-relative architecture. Shared
 * so every resource reference resolves the same way. */
export declare function resolveLiveResourceUrl(src: string): string;
/** Bump the live tree version, routing to the appropriate counter
 * based on (a) an active mutation scope (kb / toolbar / modal) or (b)
 * the optional `el`'s `inModalLayer` flag — set on attach when the
 * element or an ancestor carries `data-engine-modal="true"` (the
 * `<browser-modal>` tag's expansion). The element parameter lets
 * per-mutation callers (LiveTokenList.notify, LiveElement.setAttribute,
 * etc.) auto-route to `modalTreeVersion` without the page script
 * having to push an explicit scope. */
export declare function bumpLiveTreeVersion(el?: LiveElement): void;
export declare function getLiveTreeVersion(): number;
export declare function setWebGLBackedPredicate(fn: (off: OffscreenCanvas) => boolean): void;
/**
 * Minimal `DOMTokenList` shim returned by `el.classList`. Stores tokens
 * in insertion order with set semantics (duplicates ignored). Backed by
 * a plain `Set<string>` for O(1) contains.
 *
 * lil-gui calls .add / .toggle / .contains heavily ("controller", "name",
 * "widget", "number", "hasSlider", "active" etc.). The painter's CSS
 * cascade (M2.2) will read this list via `.contains` and `forEach`.
 */
export declare class LiveTokenList {
    private readonly tokens;
    /** Owning element — set by LiveElement's constructor. Mutations
     * notify the element's invalidation hook so the M2.2 CSS cascade
     * recomputes on the next paint. Optional so tests can construct a
     * standalone token list. */
    owner: LiveElement | null;
    private notify;
    get length(): number;
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
    toggle(name: string, force?: boolean): boolean;
    replace(oldName: string, newName: string): boolean;
    forEach(fn: (value: string) => void): void;
    values(): IterableIterator<string>;
    get value(): string;
    set value(v: string);
    toString(): string;
}
/** Detect a LiveElement without `instanceof` (works across class-
 * identity issues if the module ever gets re-evaluated). */
export declare function isLiveElement(v: unknown): v is LiveElement;
export declare function wrapCanvasCtx2dForRepaint(ctx: OffscreenCanvasRenderingContext2D): void;
/** Handler the shell registers to translate `<input>.focus()` calls
 * from page scripts into a KeyboardOverlay open + write-back cycle.
 * Cocos Creator's EditBox: `document.createElement('input')` →
 * `container.appendChild(input)` → `input.focus()`. Without this hook
 * focus() is a no-op and the engine never gets a keyboard. The shell
 * sets this from browser-shell.ts at boot. */
type InputFocusHandler = (el: LiveElement) => void;
export declare function setInputFocusHandler(fn: InputFocusHandler | null): void;
export declare class LiveElement {
    readonly [LIVE_ELEMENT_BRAND]: true;
    readonly tagName: string;
    readonly style: LiveStyle;
    readonly attrs: Record<string, string>;
    readonly classList: LiveTokenList;
    parent: LiveElement | null;
    readonly children: LiveElement[];
    private listeners;
    /** For `<canvas>`: lazy-allocated OffscreenCanvas backing the 2D
     * context. `null` for non-canvas tags. Also re-pointed by Phase 3b
     * `attachOffscreen` to share a canvas-runner-owned offscreen. */
    private offscreen;
    private canvasCtx2d;
    /** Phase 3b: true iff the attached offscreen is fed by the shared
     * screen GL bridge (live painter skips drawImage, shell's per-frame
     * overlay does copyBridgeToScreen instead). Always false for
     * canvases obtained by `getContext('2d')` from this LiveElement. */
    private _webglBacked;
    /** For `<img>`: the loaded Image instance (or null while loading
     * or on failure). Set asynchronously from `loadImage()` on first
     * `src` attribute assignment. Painter reads via `getLoadedImage()`. */
    private loadedImage;
    /** True once an `<img>` src fails to load. The painter shows the
     * `alt` placeholder ONLY in this state; a still-loading image renders
     * nothing (just reserves its box). Reset on each new `loadImage`. */
    private imageLoadFailed;
    /** Animated-GIF frame ticker. Null for static images and for
     * elements whose load hasn't completed (or whose decoded image has
     * `frameCount <= 1`). Cancelled by `loadImage` on re-load, and by
     * `clearGifAnimations()` from the shell on page navigation. */
    private gifAnimation;
    /** Per-element width/height, used both as canvas-pixel dims (when
     * tag is `canvas`) and as fallback paint-size for fixed div
     * backgrounds. Defaults match HTMLCanvasElement (300×150). */
    private _width;
    private _height;
    /** Tracks whether this element (or an ancestor) is currently
     * attached to the live root. Maintained by appendChild/removeChild
     * so the registry-driven painter can shortcut traversal. */
    attached: boolean;
    /** 2026-06-14: true when this element OR any ancestor in its current
     * attachment chain carries `data-engine-modal="true"` (the
     * `<browser-modal>` tag's expansion stamp). Set by
     * `propagateAttached` on every attach + cleared on detach. Mutations
     * on flagged elements route through `modalTreeVersion` instead of
     * the host's `liveTreeVersion`, so per-modal opens / closes / image
     * loads don't dirty the host page cache (and don't leak modal pixels
     * into it — the class of bug closed by this rewrite). See
     * `live-paint-control.ts` for the modal-layer rationale. */
    inModalLayer: boolean;
    /** Plain text content (set via `.textContent =` / `.innerHTML =`).
     * Stored in M2.0; rendered by the painter in M2.1. innerHTML strips
     * tags rather than parsing (lil-gui only assigns text strings, not
     * markup, so this is fine). */
    private _text;
    constructor(tag: string);
    get nodeName(): string;
    /** DOM spec: ELEMENT_NODE = 1, TEXT_NODE = 3. */
    get nodeType(): number;
    /** Text nodes only. `el.data` mirrors `el.textContent` for `#text`
     * elements — that's the inline-flow content payload. For non-text
     * elements this is a no-op getter returning ''. Real DOM puts this
     * on CharacterData; here we expose it on LiveElement for simplicity. */
    get data(): string;
    set data(v: string);
    /** Spec alias for `data` on text nodes. Modern code uses
     * `node.nodeValue` interchangeably. Same MutationObserver fire. */
    get nodeValue(): string;
    set nodeValue(v: string);
    /** DOM-spec `parentElement` getter. Real DOM distinguishes it from
     * `parentNode` (returns `null` for non-element parents); here our
     * tree only has elements, so both alias `parent`. */
    get parentElement(): LiveElement | null;
    get parentNode(): LiveElement | null;
    get ownerDocument(): unknown;
    get firstChild(): LiveElement | null;
    get lastChild(): LiveElement | null;
    get nextSibling(): LiveElement | null;
    get previousSibling(): LiveElement | null;
    get childNodes(): LiveElement[];
    /** Spec `className` accessor — round-trips via classList so both
     * forms (`el.className = 'a b'` and `el.classList.add('a')`) stay in
     * sync. lil-gui's stylesheet selectors lean on this. */
    get className(): string;
    set className(v: string);
    /** Spec `id` accessor — round-trips via `setAttribute('id', …)` so
     * the cascade matcher (which reads `el.attrs.id`) sees the change.
     * Without this, `box.id = 'slice1'` was setting a plain JS property
     * that the matcher never consulted — ID-selector rules silently
     * skipped freshly-created elements. */
    get id(): string;
    set id(v: string);
    /** `textContent` — concatenates all child text plus this node's own
     * text. lil-gui never uses this for reading; setter is what matters.
     *
     * For `<style>` elements, the new text is parsed as a stylesheet
     * and registered with the M2.2 cascade. Subsequent reassignments
     * (lil-gui's pattern: build the rules string, then `style.innerHTML
     * = rules`) replace the previous registration. */
    get textContent(): string;
    set textContent(v: string);
    /** `innerHTML`. A plain string (no `<`) takes the fast path and
     * behaves like `textContent` — preserves lil-gui's short-label
     * assignments ("Controls", "✓", "Linear") and keeps the
     * `textContent` getter accurate. A string containing markup is parsed
     * into child LiveElements via the shared HtmlElement→Live converter,
     * so page scripts that build structured DOM (e.g. an audio player's
     * playlist rows) render with real nested elements + cascade matching,
     * not the raw tag text. */
    get innerHTML(): string;
    set innerHTML(v: string);
    /** M2.4 form-element accessors. `.value` works for INPUT / SELECT /
     * TEXTAREA; `.checked` for INPUT[type=checkbox]. Storage is a
     * per-element WeakMap in live-form.ts so the LiveElement class
     * stays form-agnostic and tests can mutate widget state without
     * dragging the painter in. */
    get value(): string;
    set value(v: string);
    get checked(): boolean;
    set checked(v: boolean);
    get min(): string;
    set min(v: string);
    get max(): string;
    set max(v: string);
    get step(): string;
    set step(v: string);
    /** Slice 2a HTMLMediaElement-shaped accessors for <video>. State and
     * decoder live in live-video.ts's WeakMap. Reading these on non-VIDEO
     * elements is well-defined (returns paused=true / duration=0 / etc.)
     * since live-video accepts any LiveElement, so we don't gate by tag.
     */
    get currentTime(): number;
    set currentTime(v: number);
    get duration(): number;
    get paused(): boolean;
    get ended(): boolean;
    get error(): string | null;
    get volume(): number;
    set volume(v: number);
    get muted(): boolean;
    set muted(v: boolean);
    play(): void;
    pause(): void;
    /** `HTMLMediaElement.src` reflects the `src` attribute (per spec), so
     * `audio.src = '...'` reaches `resolveSourceForDecoder` (which reads
     * the attribute). A plain JS-property set would NOT, leaving the
     * decoder with no source. */
    get src(): string;
    set src(v: string);
    /** `HTMLMediaElement.load()` — reset the media pipeline so the next
     * `play()` opens a decoder for the CURRENT `src`. Used when switching
     * sources (e.g. an audio player's next/prev track). */
    load(): void;
    /** Non-standard: audio-reactive per-band levels (low→high, ~0..1) at the
     * play head, for music visualizers. Empty array when not playing / no
     * audio. Stands in for the absent Web Audio AnalyserNode. */
    getAudioLevels(): number[];
    /** Non-standard: fill `out` with the play-head frequency spectrum
     * (low→high, ~0..1). Returns true when written. ~getByteFrequencyData. */
    getFrequencyData(out: Float32Array): boolean;
    /** Non-standard: fill `out` with the play-head time-domain waveform
     * (-1..1). Returns true when written. ~getByteTimeDomainData. */
    getWaveform(out: Float32Array): boolean;
    /** M2.5 scroll accessors. `scrollTop` reads/writes the current
     * vertical scroll offset (clamped to [0, scrollHeight-clientHeight]
     * by the layout / touch handler). `scrollHeight` / `clientHeight`
     * are derived from the M2.3 layout box. */
    private _scrollTop;
    get scrollTop(): number;
    set scrollTop(v: number);
    get scrollHeight(): number;
    get scrollWidth(): number;
    get clientHeight(): number;
    get clientWidth(): number;
    /** Scroll the nearest scrollable ancestor so this element is visible.
     * Page scripts use it to keep a selected list row on screen. Vertical
     * only; the optional arg is accepted for DOM-API shape and ignored. */
    scrollIntoView(_arg?: unknown): void;
    get width(): number;
    set width(v: number);
    get height(): number;
    set height(v: number);
    /** Spec-shaped attribute setter — currently only stores. Style
     * attribute (`setAttribute('style', '...')`) re-parses cssText.
     * `class` mirrors into `classList` for future CSS-cascade lookups. */
    setAttribute(name: string, value: string): void;
    /** Async-load an image from `src` and cache it on this element so
     * the painter / layout pass can read `naturalWidth` + `drawImage`
     * once the load completes. Loading is fire-and-forget; the live
     * tree version bumps in `onload` to trigger a fresh paint. */
    private loadImage;
    /** Backing Image for `<img>` elements. Null when the element isn't
     * IMG, the src hasn't been set, or the load is still pending /
     * failed. */
    getLoadedImage(): HTMLImageElement | null;
    /** True only when the image's load failed (not while it's loading). */
    hasImageError(): boolean;
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
    presetLoadedImage(img: HTMLImageElement): void;
    /** If `img` is an animated GIF (`frameCount > 1`), schedule a
     * chained-setTimeout loop that advances frames at each frame's
     * declared delay and patches just this element's region into the
     * live cache so the next paint blits the new frame without rebuilding
     * the whole tree. No-op for static images. */
    private startGifAnimationIfNeeded;
    /** Stop this element's GIF ticker (if any) and drop it from the
     * global active set. */
    private stopGifAnimation;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
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
    querySelector(selector: string): LiveElement | null;
    querySelectorAll(selector: string): LiveElement[];
    removeAttribute(name: string): void;
    /** lil-gui calls `el.toggleAttribute('disabled', state)` to enable
     * / disable inputs. We treat presence as truthy and store the empty
     * string when set (HTML5 spec for boolean attributes). */
    toggleAttribute(name: string, force?: boolean): boolean;
    appendChild(child: LiveElement): LiveElement;
    removeChild(child: LiveElement): LiveElement;
    /** DOM spec: `insertBefore(node, reference)`. `reference == null`
     * appends. lil-gui's slider widget calls
     * `$widget.insertBefore($slider, $input)` to slide the slider in
     * before the number input. */
    insertBefore(child: LiveElement, reference: LiveElement | null): LiveElement;
    replaceChild(newChild: LiveElement, oldChild: LiveElement): LiveElement;
    /** Detach from parent. lil-gui's `destroy()` removes its panel via
     * `this.domElement.parentElement.removeChild(this.domElement)`. */
    remove(): void;
    contains(other: LiveElement): boolean;
    addEventListener(type: string, listener: Function, _opts?: unknown): void;
    removeEventListener(type: string, listener: Function): void;
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
    dispatchEvent(event: {
        type: string;
        [key: string]: unknown;
    }): boolean;
    getContext(kind: string): unknown;
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
    focus(): void;
    /** `el.blur()` — paired no-op + blur event for spec compliance. */
    blur(): void;
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
    show(): void;
    showModal(): void;
    /** Spec-shaped `<dialog>.close(returnValue?)` — hide the dialog
     * and dispatch a `close` event. The optional `returnValue` argument
     * is stored on `this.returnValue` so the listener can read it (the
     * common spec pattern is `dialog.addEventListener('close', () => …
     * dialog.returnValue)`). */
    close(returnValue?: string): void;
    /** Spec-shaped `<dialog>.returnValue` — last value passed to
     * `close()`, or '' if never closed with a value. The spec also lets
     * the page set this directly before calling `close()`; the property
     * is a plain field so reads/writes work the same way. */
    returnValue: string;
    /** Spec-aligned with OffscreenCanvas.convertToBlob — encode this
     * canvas's pixels into a Blob (default PNG). Forwards to the backing
     * OffscreenCanvas. Resolves to a Blob; rejects for non-canvas tags.
     *
     * Lets WHATWG API surfaces that accept HTMLCanvasElement / OffscreenCanvas
     * sources (notably `createImageBitmap(canvas)`) round-trip through a
     * Blob without callers needing to know we wrap an OffscreenCanvas
     * internally. Caught by Cocos Creator engine init at pvzge boot when
     * it called `createImageBitmap(liveCanvasElement)`. */
    convertToBlob(options?: {
        type?: string;
        quality?: number;
    }): Promise<Blob>;
    /** Spec-aligned with HTMLCanvasElement.toBlob — callback-based
     * convenience for code that uses the older sync-style API. Wraps
     * `convertToBlob` and invokes the callback with the Blob (or null
     * if encoding rejected). */
    toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
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
    getBoundingClientRect(): {
        x: number;
        y: number;
        width: number;
        height: number;
        top: number;
        left: number;
        right: number;
        bottom: number;
    };
    /** Read-only access to the OffscreenCanvas backing a `<canvas>`
     * LiveElement. Used by the overlay painter to drawImage the live
     * pixels onto the screen surface. */
    getOffscreen(): OffscreenCanvas | null;
    /** Phase 3b (2026-05-26): attach an externally-owned OffscreenCanvas
     * to this `<canvas>` LiveElement. Used by the shell after
     * `runPageScripts` to wire each canvas-runner-managed offscreen into
     * the live tree so the live painter draws what the script rendered.
     *
     * `isWebGL` flags the offscreen as backed by the shared screen GL
     * bridge (per `canvas-runner.ts`'s `webGLBackedCanvases`). The
     * painter consults this to skip drawImage and let the shell's
     * `overlayLiveAnimatedCanvases` pass do the bridge → screen copy. */
    attachOffscreen(off: OffscreenCanvas, isWebGL: boolean): void;
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
    isWebGLBacked(): boolean;
    /** Stats reads `canvas.style.cssText = 'width:80px;height:48px'`
     * and uses that as the *display* size (logical CSS pixels) while
     * `canvas.width`/`height` are the *pixel-buffer* size. We honour
     * the difference here so the overlay can blit at the display
     * size, which is what produces the correct on-screen footprint. */
    getDisplaySize(): {
        w: number;
        h: number;
    };
}
/** Walk `root`'s subtree (including `root` itself) returning the first
 * element that satisfies `pred`. Pre-order. Used by
 * `LiveElement.querySelector` and the `document.querySelector` shim in
 * canvas-runner so the two share one implementation. */
export declare function findLiveElement(root: LiveElement, pred: (el: LiveElement) => boolean): LiveElement | null;
/** Walk `root`'s subtree (including `root` itself), appending every
 * element that satisfies `pred` to `out`, in document order. Used by
 * `LiveElement.querySelectorAll` and the `document.querySelectorAll`
 * shim. */
export declare function findAllLiveElements(root: LiveElement, pred: (el: LiveElement) => boolean, out: LiveElement[]): void;
/** Build a match predicate for a SIMPLE CSS selector — `#id`, `.class`,
 * bare `tag`, `[attr]`, or `[attr=value]` (both quoted forms). Compound
 * / descendant / pseudo selectors return null (unsupported). Shared by
 * `LiveElement.querySelector*` and the `document.querySelector*` shim
 * in canvas-runner — one parser, one rule set. */
export declare function liveSelectorPredicate(selector: string): ((el: LiveElement) => boolean) | null;
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
export declare function isEngineModalRoot(el: LiveElement): boolean;
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
declare class LiveStyle implements InlineStyle {
    position?: InlineStyle['position'];
    top?: number;
    left?: number;
    right?: number;
    bottom?: number;
    private _width?;
    private _height?;
    private _minWidth?;
    private _maxWidth?;
    private _minHeight?;
    private _maxHeight?;
    get width(): CssLength | undefined;
    set width(v: CssLength | string | undefined);
    get height(): CssLength | undefined;
    set height(v: CssLength | string | undefined);
    get minWidth(): CssLength | undefined;
    set minWidth(v: CssLength | string | undefined);
    get maxWidth(): CssLength | undefined;
    set maxWidth(v: CssLength | string | undefined);
    get minHeight(): CssLength | undefined;
    set minHeight(v: CssLength | string | undefined);
    get maxHeight(): CssLength | undefined;
    set maxHeight(v: CssLength | string | undefined);
    display?: InlineStyle['display'];
    opacity?: number;
    zIndex?: number;
    cursor?: string;
    background?: string;
    color?: string;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: InlineStyle['fontWeight'];
    fontStyle?: InlineStyle['fontStyle'];
    textAlign?: InlineStyle['textAlign'];
    lineHeight?: number;
    textDecoration?: InlineStyle['textDecoration'];
    verticalAlign?: InlineStyle['verticalAlign'];
    listStyleType?: InlineStyle['listStyleType'];
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    marginTop?: number;
    marginRight?: number;
    marginBottom?: number;
    marginLeft?: number;
    gap?: number;
    flexDirection?: InlineStyle['flexDirection'];
    flexGrow?: number;
    flexShrink?: number;
    flexBasis?: number;
    alignItems?: InlineStyle['alignItems'];
    justifyContent?: InlineStyle['justifyContent'];
    boxSizing?: InlineStyle['boxSizing'];
    borderTopWidth?: number;
    borderRightWidth?: number;
    borderBottomWidth?: number;
    borderLeftWidth?: number;
    borderTopColor?: string;
    borderRightColor?: string;
    borderBottomColor?: string;
    borderLeftColor?: string;
    borderRadius?: InlineStyle['borderRadius'];
    overflowX?: InlineStyle['overflowX'];
    overflowY?: InlineStyle['overflowY'];
    get cssText(): string;
    set cssText(v: string);
    /** Inline `--foo` custom properties set via `setProperty` or
     * `style="--foo: …"`. Merged into the element's computed-style
     * `customProps` bag in live-css so var() refs resolve against them. */
    customProps?: Record<string, string>;
    /** Object-style write for unknown / camelCased property access.
     * Stats uses dot access (`style.display = 'none'`) which TypeScript
     * sees as the typed fields; this is a fallback for tools that go
     * through `Object.assign`. Custom properties (`--foo`) land in
     * `customProps` via the same applyDecl path. */
    setProperty(name: string, value: string): void;
    /** Spec-shaped `getPropertyValue(name)`. For `--foo` returns the
     * stored custom-prop value (empty string if unset). For regular
     * properties returns a best-effort serialization — most code that
     * cares about resolved values uses `getComputedStyle(el)` instead. */
    getPropertyValue(name: string): string;
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
declare class LiveRoot extends LiveElement {
    constructor();
}
export declare function getLiveRoot(): LiveRoot;
/** Reset the live root on page navigation so live elements created
 * by the previous page don't survive into the next. Also resets the
 * window-level event registry (M2.0) so listeners from the previous
 * page don't keep firing under the next one. */
export declare function resetLiveRoot(): void;
/**
 * Page-level `window` shim that owns the listener registry forwarded
 * to by the shell's touch handler (mouse / touch events lil-gui needs
 * for slider drags). Used internally; pages see the proxy below.
 *
 * Bound to one page session — `resetLiveRoot()` replaces this on
 * navigation so a leaving page's drag handlers don't keep firing.
 */
export declare class LiveWindow {
    private listeners;
    addEventListener(type: string, listener: Function, _opts?: unknown): void;
    removeEventListener(type: string, listener: Function, _opts?: unknown): void;
    dispatchEvent(event: {
        type: string;
        [key: string]: unknown;
    }): boolean;
    hasListeners(type: string): boolean;
}
export declare function getLiveWindow(): LiveWindow;
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
export declare function dispatchPageKeyEvent(type: 'keydown' | 'keyup', key: string, code?: string): boolean;
/** True iff any page-registered listener exists for the named event
 * on the shared window+document registry. Cheap pre-check so the input
 * loop can skip building a synthetic event when nothing will consume
 * it. */
export declare function pageHasListenerFor(type: string): boolean;
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
export declare function getLiveWindowProxy(): unknown;
/** The shell's documentShim stashes itself here once per page so
 * LiveElement.ownerDocument can return something. Not used by lil-gui
 * directly, but several third-party libs probe `el.ownerDocument` to
 * locate `document.body` indirectly. */
export declare function setOwnerDocument(doc: unknown): void;
export declare function setInternalLiveViewport(v: LiveViewport): void;
/** Public getter for the current live-DOM viewport (origin + size of the
 * area where the page is painted, accounting for the chrome strip in
 * normal mode and the full screen in fullscreen modes). Consumed by the
 * page-mouse-forwarder so cursor hit-tests use the SAME viewport the
 * touch path uses — without this they used a hardcoded full-screen
 * viewport and clicked the wrong elements by the toolbar's y-offset. */
export declare function getLiveViewport(): LiveViewport;
export declare function getInternalLiveScrollY(): number;
export declare function setInternalLiveScrollY(v: number): void;
/** Viewport rect used by both the overlay painter and the touch
 * hit-tester. See `live-overlay.ts` for the painter side. */
export interface LiveViewport {
    x: number;
    y: number;
    width: number;
    height: number;
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
export declare function hitTestLive(root: LiveElement, x: number, y: number, viewport: LiveViewport): LiveElement | null;
export {};
//# sourceMappingURL=live-dom.d.ts.map