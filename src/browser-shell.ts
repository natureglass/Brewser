import { captureNativeFetch, nxScreen, setNavDebugEnabled, STRICT_PINNED_RUNTIME_KEYS, WebPageSession, WebView, type WebViewDelegate } from '@switch-web/runtime';

// Shell-input diagnostic. Writes which `input.kind` the shell saw and
// before/after the navigateTo dispatch — narrows whether a click ever
// reached navigateTo, vs. the touch listener never firing, vs. the
// navigation hanging in load(). Gated by `config.json` -> `navDebug`;
// flipped on at startup once `loadConfig` runs (see `setShellInputDebugEnabled`
// call in `start()`).
const _SHELL_INPUT_DIAG_PATH = 'sdmc:/switch/brewser/logs/shell-nav-diag.log';
const _shellInputDiagStart = Date.now();
let _shellInputDebugEnabled = false;
function setShellInputDebugEnabled(enabled: boolean): void {
	_shellInputDebugEnabled = enabled;
}
function _shellInputDiag(label: string): void {
	if (!_shellInputDebugEnabled) return;
	try {
		const sw = (globalThis as { Switch?: { appendFileSync?: (p: string, d: string) => void } }).Switch;
		if (sw?.appendFileSync) {
			sw.appendFileSync(_SHELL_INPUT_DIAG_PATH,
				(Date.now() - _shellInputDiagStart) + 'ms\tINPUT: ' + label + '\n');
		}
	} catch { /* swallow */ }
}

import {
	BROWSER_INTERNAL_ORIGIN,
	DEFAULT_CANVAS_HEIGHT,
	DEFAULT_CANVAS_WIDTH,
	DEFAULT_HOME_URL,
} from '@switch-web/runtime';
import {
	clearAnimationFrames,
	clearDynamicBackground,
	clearSharedScreenGLBridge,
	copyBridgeToScreen,
	initDynamicBackground,
	pageHasAnimationActivity,
	presentDynamicBackground,
	requestPaintTick,
	tickAnimationFrames,
} from '@switch-web/runtime';
import { clearCssAnimations, clearGifAnimations, dispatchPageKeyEvent, dispatchPageResizeEvent, getLiveRoot, getLiveTreeVersion, LiveElement, pageHasListenerFor, setCssViewport, setInputFocusHandler, setSwbImgDebugEnabled } from '@switch-web/runtime';
import { setMediaColorScheme } from '@switch-web/runtime';
import { isWebGLBackedCanvas } from '@switch-web/runtime';
import { permissionSlug } from '@switch-web/runtime';
import { getInputChecked, getInputValue, openKeyboardAndApply, setColorPickerOpener, setDateInputDefaultPlaceholder, setDatePickerOpener, setFilePickerOpener, setFilePickerStartDirResolver, setInputValue, setKeyboardOpener, setLiveFormColorScheme, setNumberPickerOpener, setSelectModalOpener, setTimePickerOpener } from '@switch-web/runtime';
import { ColorPickerOverlay, DatePickerOverlay, FilePickerOverlay, NumberPickerOverlay, setColorPickerRepaintDriver, setDatePickerRepaintDriver, setFilePickerRepaintDriver, setNumberPickerRepaintDriver, SelectModalOverlay, setSelectModalRepaintDriver, setTimePickerRepaintDriver, TimePickerOverlay } from '@switch-web/runtime';
import {
	VIDEO_CONTROLS_BAR_H,
	clearAllVideos,
	pageHasActiveVideo,
	pageHasAnyPoster,
	paintVideoControls,
	paintVideoFrameAt,
	setVideoTryHwAccel,
	tickVideo,
	videoPause,
	videoPlay,
	videoSeekRatio,
	videoStop,
	videoToggleMute,
} from '@switch-web/runtime';
import {
	flushPendingScreenBlitsToScreen, forceBridgeReadbackNextPaint, getLiveContentBottom, hasAnyScrollOverlay, isAnyModalOpen, isLiveCacheBuilding, isLiveCacheReady, liveCacheCoversViewportOpaque,
	overlayLiveAnimatedCanvases, paintColorPickerOverlay, paintDatePickerOverlay, paintFilePickerOverlay, paintKeyboardOverlay, paintLiveAboveCanvasOverlay, paintLiveOverlay, paintNumberPickerOverlay, paintScrollOverlaysToScreen, paintSelectModalOverlay, paintTimePickerOverlay,
	paintModalOverlay,
	paintToolbarOverlay,
	patchLiveDirtyRegions, resetLiveOverlayCache, resetToolbarOverlayCache,
	setLiveBuildChunkMs,
	setLiveScrollChunkMs,
} from '@switch-web/runtime';
import {
	bumpToolbarTreeVersion,
	clearPageHasCanvas2dActivity,
	closeTopmostModalModeDialog,
	consumeFullRepaintRequest,
	getColorPickerLiveRoot,
	getDatePickerLiveRoot,
	getFilePickerLiveRoot,
	getModalModeDialogs,
	getModalTreeVersion,
	getKeyboardLiveRoot,
	getKeyboardTopY,
	getNumberPickerLiveRoot,
	getSelectModalLiveRoot,
	getTimePickerLiveRoot,
	getToolbarLiveRoot,
	hasPageCanvas2dActivity,
	isColorPickerOpen,
	isColorPickerOverlayVisible,
	isDatePickerOpen,
	isDatePickerOverlayVisible,
	isFilePickerOpen,
	isFilePickerOverlayVisible,
	isKeyboardOpen,
	isKeyboardOverlayVisible,
	isNumberPickerOpen,
	isNumberPickerOverlayVisible,
	isSelectModalOpen,
	isSelectModalOverlayVisible,
	isTimePickerOpen,
	isTimePickerOverlayVisible,
	isToolbarOverlayVisible,
	popToolbarMutationScope,
	pushToolbarMutationScope,
	requestFullRepaint,
	setColorPickerLiveRoot,
	setDatePickerLiveRoot,
	setFilePickerLiveRoot,
	setKeyboardLiveRoot,
	setKeyboardTopY,
	setNumberPickerLiveRoot,
	setSelectModalLiveRoot,
	setTimePickerLiveRoot,
	setToolbarLiveRoot,
	setToolbarOverlayVisible,
} from '@switch-web/runtime';
import { getLayoutBox } from '@switch-web/runtime';
import { isExternalCssLoading, populateRootFromTree } from '@switch-web/runtime';
import { extractTitle, parseHtml, type HtmlElement } from '@switch-web/runtime';
import { AddressBarInput } from './input/address-bar-input.js';
import {
	computeLivePageBase,
	extractAppDirFromUrl,
	loadAppManifest,
	loadAppManifestButtonMapping,
	resolveNavUrl,
} from './shell/nav-helpers.js';
import { isSaveButtonDisabled, readStagedSettings } from './shell/staged-settings.js';
import { subscribeShellAction } from './input/shell-actions.js';
import {
	installCanvasTouch,
	setTouchScrollHandler,
	peekPendingInput,
	setBrowserMode,
	setFullscreenVideo,
	setChromeRegion,
	setLiveViewport,
	setNavigating,
	setStarEnabled,
	setTouchDebugEnabled,
	waitForControllerInput,
	type BrowserMode,
} from '@switch-web/runtime';
import { KeyboardOverlay, setKeyboardRepaintDriver } from '@switch-web/runtime';
import { installPageTouchForwarder } from '@switch-web/runtime';
import {
	installPageMouseForwarder,
	paintCursorOverlay,
	setCursorIdleMs,
	setCursorOverlaySuppressed,
} from '@switch-web/runtime';
import { clearAppButtonOverlay, setAppButtonOverlay, setButtonMapping } from '@switch-web/runtime';
import {
	preloadClickSound,
	setClickSoundEnabled,
	setClickSoundPath,
} from '@switch-web/runtime';
import { BookmarksStore } from './navigation/bookmarks-store.js';
import { BrowserNavigation } from './navigation/browser-navigation.js';
import { HistoryStore } from './navigation/history-store.js';
import { probeNetwork, type NetworkProbeResult } from '@switch-web/runtime';
import { BrowserPermissionPolicy, setLiveInputPermissionPolicy } from '@switch-web/runtime';
import { BrowserProfile } from './profile/browser-profile.js';
import { type BrowserConfig, DEFAULT_CONFIG, isRevokedInCachedCatalogue, loadBackgroundRegistry, loadConfig, loadStyleRegistry, loadToolbarRegistry, resolveSearchEngine, type ToolbarPosition } from './profile/browser-toolbar.js';
import { parseArtifacts, parseCatalogue, parseStats } from '@switch-web/runtime';
import { BrowserBookmarksLoader } from './resources/browser-bookmarks-loader.js';
import { BrowserHistoryLoader } from './resources/browser-history-loader.js';
import { BrowserResourceLoader } from './resources/browser-resource-loader.js';
import { loadOptionalImage } from '@switch-web/runtime';
import { LocalSchemeFetchLoader } from '@switch-web/runtime';
import { SwitchUaFetchLoader } from '@switch-web/runtime';
import { loadCursorRegistry } from '@switch-web/runtime';

/**
 * Top-level orchestrator for the browser shell.
 *
 *   - **ZR** (rising-edge) OR **tap on the chrome strip** → open the
 *     on-canvas keyboard. Submit navigates; cancel reloads the current page
 *     (to clear the keyboard pixels from the canvas).
 *   - **L + R + Minus** held ~1s → exit the shell.
 */
interface SplashHandle {
	/** Resolves once the fade-out has completed (alpha 1 reached) and
	 * the splash rAF loop has self-terminated. Caller awaits this
	 * after `beginFade()` before calling the warm-cache `repaintAll()`
	 * that paints the home page on top — guarantees the splash's last
	 * frame is fully black, so the home-paint replaces black with
	 * content (no flash of black between splash-fade-end and home-
	 * paint). */
	finishedFading: Promise<void>;
	/** Flips the splash into the fade-out phase. Idempotent. If
	 * `splashFadeMs <= 0`, jumps straight to `done` and resolves
	 * `finishedFading` immediately. */
	beginFade(): void;
}

/** Animated-wallpaper frame cap. 30 fps is plenty for slow shader swells
 * and halves the per-frame compositing tax vs 60 (each pump frame drives a
 * full slow-path repaint — the ~7-8 ms cache blit dominates). */
const DYNAMIC_BG_FPS = 30;
const DYNAMIC_BG_FRAME_MS = Math.round(1000 / DYNAMIC_BG_FPS);
/** Minimum wall-clock the app-launch "Loading <name>" splash stays on screen.
 * An app navigate can complete in well under a frame (local/cached files, no
 * network wait), so without a floor the splash flashes sub-perceptibly. When
 * the load itself takes longer than this, the splash simply covers the whole
 * load and this floor never triggers. */
const LAUNCH_SPLASH_MIN_MS = 600;
/** Global animation-clock multiplier for the shader `t` uniform: the sole,
 * neutral speed control for every animated wallpaper. `1.0` = real elapsed
 * seconds, i.e. the rate a standalone shader page gets at its own `SPEED = 1.0`,
 * so a `.frag` extracted from such a page animates at its authored rate with
 * no per-shader speed knob. Any wallpaper that wants a different pace bakes it
 * into its own shader coefficients (self-contained, like the `zoom` constant).
 * Lower this to slow ALL animated wallpapers at once. */
const DYNAMIC_BG_SPEED = 1.0;

export class BrowserShell {
	private readonly policy: BrowserPermissionPolicy;
	private readonly profile: BrowserProfile;
	private readonly historyStore: HistoryStore;
	private readonly bookmarksStore: BookmarksStore;
	private readonly webView: WebView;
	private readonly navigation: BrowserNavigation;
	private readonly keyboard: KeyboardOverlay;
	private readonly filePicker: FilePickerOverlay;
	private readonly selectModal: SelectModalOverlay;
	private readonly datePicker: DatePickerOverlay;
	private readonly timePicker: TimePickerOverlay;
	private readonly colorPicker: ColorPickerOverlay;
	private readonly numberPicker: NumberPickerOverlay;
	private readonly addressBar: AddressBarInput;

	private currentScrollY = 0;
	/** Runtime-owned per-navigation state — current page URL + the
	 * `runPageScripts` result. The shell creates one session in the
	 * constructor and delegates the resetLiveRoot / populate / scripts
	 * lifecycle to it on every navigation (see {@link handleHtmlResponseLive}).
	 * Phase 5 of the migration extracted this so headless app NROs can
	 * render a page without the brewser shell surface area. */
	private readonly session: WebPageSession;
	/** Synchronous config snapshot captured in the constructor so `run()`
	 * can hoist the boot-splash trigger to its first statement WITHOUT
	 * an awaiting `loadConfig` call beforehand. The splash's first paint
	 * MUST be reachable with no pre-paint await — the whole bug being
	 * fixed is "splash awaits image load before painting and the parallel
	 * navigate's synchronous grid-build takes the JS thread first". A
	 * synchronous `loadConfig` (Switch.readFileSync) is fine here; an
	 * async one would reintroduce the same bug. */
	private readonly startupConfig: BrowserConfig;
	/** Live-DOM cache-build budget for external (http(s)) pages. Stored
	 * here so `onPageStarted` can re-apply it on each WWW navigation
	 * (internal `brewser://` pages get a separate "build everything in
	 * one shot" budget instead). Set from `config.json`'s
	 * `wwwRenderChunkMs` in `run()`. */
	private wwwRenderChunkMs: number = 12;

	/** Parsed HtmlElement tree for `keyboard.html`, loaded once at
	 * shell startup. Re-populated into a fresh `LiveElement('body')`
	 * after every host navigation reset (since `resetLiveRoot` wipes
	 * the cascade and the keyboard's `<style>` registrations along
	 * with it). `null` until {@link loadHtmlKeyboard} runs. */
	private keyboardParsedTree: HtmlElement | null = null;

	/** Parsed HtmlElement tree for `romfs/shell/file-picker.html`, loaded
	 * once at shell startup. Re-populated into a fresh
	 * `LiveElement('div')` after every host navigation reset for the
	 * same `<style>` cascade reasons as the keyboard. `null` until
	 * {@link loadHtmlFilePicker} runs. */
	private filePickerParsedTree: HtmlElement | null = null;

	/** Parsed HtmlElement tree for `romfs/shell/select-modal.html`, loaded
	 * once at shell startup. Same cascade-reset reasoning as the file
	 * picker above. `null` until {@link loadHtmlSelectModal} runs. */
	private selectModalParsedTree: HtmlElement | null = null;

	/** Parsed HtmlElement tree for `romfs/shell/date-picker.html`. */
	private datePickerParsedTree: HtmlElement | null = null;

	/** Parsed HtmlElement tree for `romfs/shell/time-picker.html`. */
	private timePickerParsedTree: HtmlElement | null = null;

	/** Parsed HtmlElement tree for `romfs/shell/color-picker.html`. */
	private colorPickerParsedTree: HtmlElement | null = null;
	/** Parsed HtmlElement tree for `romfs/shell/number-picker.html`. */
	private numberPickerParsedTree: HtmlElement | null = null;

	/** Parsed HtmlElement tree for the active toolbar HTML
	 * (e.g. `themes/toolbars/light.html`). Loaded once at shell
	 * startup and re-loaded by {@link selectToolbar}; re-populated
	 * into a fresh `LiveElement('div')` after every host navigation
	 * reset for the same `<style>` cascade reasons as the keyboard.
	 * `null` until {@link loadHtmlToolbar} runs. */
	private toolbarParsedTree: HtmlElement | null = null;

	/** Re-entry guard for the deferred self-heal retry in
	 * {@link rebuildToolbarLiveRoot}. Without it, the retry's own
	 * rebuild would schedule another retry (etc.), looping forever.
	 * Set when the timer is scheduled, cleared inside the timer
	 * callback. */
	private toolbarRetryScheduled = false;

	/** Public read-only accessor for the current page URL. Used by
	 * storage modules (local-storage, indexed-db) to route writes to a
	 * `dev/` sub-namespace when the active page is under `brewser://dev/`,
	 * keeping dev test artifacts out of the real user storage roots. */
	getCurrentPageUrl(): string { return this.session.currentPageUrl; }
	/** Expose the profile so main.ts can pass it to the runtime's
	 * `installLocalStorage` / `installIndexedDB`. The profile implements
	 * `StorageProfileLike` (storageRoot + pickStorageNamespace), so the
	 * runtime stays agnostic to the brewser:// dev URL convention. */
	getProfile(): BrowserProfile { return this.profile; }
	/** Expose the permission policy so main.ts can thread it into the
	 * runtime's `installPolyfills` — storage drivers consult
	 * `allowStorage()` on every read/write, so a manifest that omits
	 * `storage` gets denied at the storage API boundary. */
	getPermissionPolicy(): BrowserPermissionPolicy { return this.policy; }
	private mode: BrowserMode = 'normal';
	/** Active chrome strip height (px). Cached from `config.json
	 * toolbarHeight` at boot and refreshed on settings save. Read by
	 * layoutTopInset, the paint sequence, and `publishChromeRegion` —
	 * replaces the old `this.chromeHeight` access path that
	 * died with the engine-drawn `BrowserToolbar` (2026-06-14). */
	private chromeHeight: number = DEFAULT_CONFIG.toolbarHeight;
	/** Non-null while a page-script modal (self-update / download) has hidden
	 * the chrome via `__brewserSetChromeVisible(false)`: holds the chromeHeight
	 * to restore on show. Hiding collapses `chromeHeight` to 0 (mirroring
	 * `showToolbar: false`) so the page paint fills the old strip slice — the
	 * overlay gate alone leaves that slice layout-reserved but unpainted, so a
	 * cache-blit re-composites the stale toolbar over the modal. */
	private chromeHiddenRestoreHeight: number | null = null;
	/** Fallback page background colour for dark theme. Cached from
	 * `config.json pageBackground` at boot. Used by
	 * `effectivePageBackground` to fill the content viewport before
	 * the live-DOM body paints over it. */
	private pageBackground: string = DEFAULT_CONFIG.pageBackground;
	/** Decoded wallpaper image painted between the per-frame viewport
	 * clear and `paintLiveOverlay` (`paintStyleBackground`). Sourced from
	 * the selected `backgrounds.json` entry's `background` field (resolved
	 * from `config.json`'s `themeBackground` title) and loaded
	 * asynchronously at boot + on every Background-picker change in
	 * Settings. `null` when the selected background has no image (e.g.
	 * "None", or a dynamic-only entry) or while the decode is in flight. */
	private backgroundImage: HTMLImageElement | null = null;
	/** Source path the current `backgroundImage` was loaded from, kept
	 * so a no-op background change (picker re-stages the same value)
	 * doesn't re-decode the same PNG. Empty when no image is configured. */
	private backgroundImageRel: string = '';
	/** True when an animated wallpaper shader is armed (the selected
	 * background has a `dynamic` field). Set by `loadStyleDynamic`; drives
	 * `paintStyleBackground` to call `presentDynamicBackground` and drives
	 * the per-frame wallpaper animation in the input loop's `onTick`. When
	 * false the shell uses the static `backgroundImage` path. */
	private dynamicBgActive: boolean = false;
	/** Shader-asset path the current dynamic wallpaper was armed from, kept
	 * to dedupe no-op re-arms (radio re-stages the same style). Empty when
	 * no animated wallpaper is configured. */
	private dynamicBgRel: string = '';
	/** Monotonic-ish clock base (ms, from `performance.now()`) marking when
	 * the current animated wallpaper started, so the shader's `t` uniform
	 * is seconds-since-start. */
	private dynamicBgStartMs: number = 0;
	/** `performance.now()` of the last animated-wallpaper frame, so the
	 * `onTick` driver can cap the repaint rate at {@link DYNAMIC_BG_FPS}. */
	private lastBgFrameMs: number = 0;
	/** Active toolbar position. Sourced from `config.json` (not the
	 * toolbar design) since 2026-06-11 so the user can flip it from
	 * Settings without re-skinning. Drives `publishChromeRegion` +
	 * the paint sequence's choice of overlay rect. */
	private toolbarPosition: ToolbarPosition = DEFAULT_CONFIG.toolbarPosition;
	/** Wall-clock duration (ms) of the most recent content present.
	 * Surfaced on `__scrollStats` for the benchmark page. */
	private lastCpuPresentMs = 0;
	/** Count of content presents since boot. */
	private cpuPresentCallCount = 0;
	/** Remembered attribute-declared size of the canvas we resized for
	 * fullscreen-canvas mode, so we can put it back on exit. `null` when
	 * not currently fullscreening any canvas. */
	private fullscreenCanvasOriginalSize: { width: number; height: number } | null = null;
	/** `true` when the current fullscreen-canvas was entered in "live"
	 * mode (canvas carries `data-fullscreen-live`): we did NOT rerun the
	 * page scripts, so the page kept all its state and its own RAF loop
	 * adapts to the new size. Exit must likewise skip the rerun. */
	private fullscreenCanvasLive = false;
	/** A page script that calls `canvas.requestFullscreen()` from its
	 * top-level body runs BEFORE `this.session.scriptCtx` is wired up (the
	 * assignment is `this.session.scriptCtx = await runPageScripts(...)`, so the
	 * field is still `null` while scripts execute). `toggleFullscreenCanvas`
	 * needs `scriptCtx` to look up the target canvas + rerun, so the
	 * request would otherwise be silently dropped. This field stores the
	 * Promise resolver for the pending request; it is drained immediately
	 * after `scriptCtx` is assigned. Cleared on each new page load. */
	private pendingFullscreenCanvasRequest: (() => void) | null = null;
	/** When the active page is an app (URL under `brewser://apps/<group>/<id>/...`),
	 * the on-disk dir prefix `apps/<group>/<id>/` of that app — used to
	 * make `exit`-action behaviour context-aware (in an app, "exit" means
	 * back to the launcher; on the shell, it means quit Brewser) and to
	 * key the active button-router overlay. `null` when the current page
	 * is anything else (launcher, settings, home, external WWW page). */
	private currentAppDir: string | null = null;
	/** The focused `<video>` element while `mode === 'video-fullscreen'`,
	 * `null` otherwise. Drives `overlayLiveAnimatedCanvases`'s
	 * fullscreen-video paint branch. */
	private fullscreenVideo: LiveElement | null = null;
	/** Last `internetReachable` value passed to `renderChrome`. Used by
	 * onTick's chrome-skip gate to pick up external network-status
	 * changes between explicit `renderChrome` calls — every other input
	 * (URL, canGoBack/Forward, bookmarked) is mutated through methods
	 * that already call `renderChrome` synchronously, so the onTick
	 * gate only needs to poll this one out-of-band signal. */
	private lastChromeReachable: boolean | undefined = undefined;
	/** Last `Switch.operationMode()` value captured by renderChrome. The
	 * onTick gate compares the current libnx-cached mode against this to
	 * fire a chrome redraw on dock/undock without subscribing to any
	 * event — `appletGetOperationMode()` is a cached-int read in libnx
	 * (the value is kept up-to-date asynchronously by an applet hook
	 * inside libnx itself), so polling every tick adds no measurable
	 * cost vs an event subscription. */
	private lastChromeOperationMode: number | undefined = undefined;
	/** Cached toolbar-avatar `src` snapshot. Populated once at shell boot
	 * (unproxied `Switch`, no policy) and refreshed at each navigation
	 * from `handleHtmlResponseLive` AFTER `setManifestPermissions` has
	 * installed the incoming page's policy AND ONLY when that policy is
	 * shell / grant-all (`currentAppId() === null`). The read-only auth
	 * paths live outside every app sandbox and would deny under any
	 * restrictive app policy — the shell-context guard is what keeps
	 * an app-scoped policy from clobbering a valid cached value with
	 * the placeholder. `pushToolbarState` reads this field instead of
	 * calling `resolveActiveSessionAvatarPath` per-frame — the resolver's
	 * two `Switch.readFileSync` calls (`active.json` + `<provider>-auth.json`)
	 * are on-navigation only, keeping the per-rAF-tick renderChrome path
	 * off SDMC. Defaults to the placeholder bitmap so the toolbar has
	 * something to paint from the first frame even before the boot init
	 * call runs at end-of-constructor. */
	private cachedToolbarAvatarSrc: string = DEFAULT_TOOLBAR_AVATAR_SRC;
	/** Effective scrollY at the end of the last slow-path repaintContent.
	 * The video-only fast path uses this to confirm scrollY hasn't
	 * shifted since the cache was last blitted into screen pixels — if
	 * it has, the persistent pixels under the video are stale and the
	 * slow path must run instead. */
	private lastRepaintedScrollY: number = Number.NaN;
	/** Live tree version + viewport last fully painted. The canvas-only
	 * fast path (animated canvas region overwritten by overlay-walk while
	 * the rest of the page is byte-identical to the previous frame) uses
	 * these to skip paintLiveOverlay entirely when nothing else moved.
	 * Saves the ~7-8 ms/frame cache `drawImage(viewport×height)` blit on
	 * inline-WebGL pages where the page itself only mutates through the
	 * bridge. -1 / NaN sentinels force the slow path on first paint. */
	private lastRepaintedLiveVersion: number = -1;
	private lastRepaintedViewportW: number = -1;
	private lastRepaintedViewportH: number = -1;
	/** Live tree version the idle-tick path last repainted. Page-script
	 * timer mutations (setTimeout/setInterval) bump the tree version but
	 * fire no rAF / video frame / tap, so without comparing against this
	 * they'd never reach the screen — e.g. the audio player's 4 Hz
	 * updateTimeline advancing the seek bar + time during passive playback. */
	private lastTickTreeVersion: number = -1;
	/** Modal-layer tree version the idle-tick path last repainted. The
	 * `<browser-modal>` overlays (download / self-update) keep their own
	 * `modalTreeVersion` counter — separate from the host `liveTreeVersion`
	 * above — so per-modal churn doesn't dirty the warm host cache. A
	 * progress bar advancing while a download runs bumps ONLY this counter,
	 * which the host-version check misses; without comparing against this the
	 * bar froze on a static/absent wallpaper until the user moved the cursor. */
	private lastTickModalVersion: number = -1;
	/** User-preferred colour scheme (config.json `theme`). Drives the
	 * `Sec-CH-Prefers-Color-Scheme` request header on external fetches,
	 * the `@media (prefers-color-scheme:…)` cascade in live-css, and the
	 * effective viewport background colour. Defaults to `light` (the
	 * web's expected default); only `<body>` paint actually covers the
	 * viewport, so internal pages that explicitly set their own bg are
	 * unaffected — only external pages without an explicit `<body>` bg
	 * are influenced. */
	private colorScheme: 'light' | 'dark' = 'light';
	/** Momentum-scroll on/off. Mirrors `config.momentumScrolling`; live-
	 * updated by `saveSettings`. When false, `handleScroll` skips velocity
	 * capture and `tickMomentum` short-circuits (one bool compare per tick). */
	private momentumEnabled: boolean = DEFAULT_CONFIG.momentumScrolling;
	/** Current scroll velocity in px-per-active-poll-tick (signed: positive
	 * = downward content travel, matches `handleScroll`'s delta sign). Set
	 * by `handleScroll` from user input, decayed each non-input tick by
	 * `tickMomentum`. Zero = no coast in flight. */
	private momentumVelocityPxPerTick: number = 0;
	/** True when a TOUCH page-scroll delta landed since the last poll-loop
	 * `onTick`. Touch scrolls arrive on an async event callback (not the loop),
	 * so unlike stick / D-pad they don't set the loop's `scrolledThisTick`.
	 * Without this the loop would treat an active finger-drag tick as
	 * "no user scroll" and run the momentum coast ON TOP of the finger's own
	 * 1:1 delta — making the page travel ~1.8x the finger (the reported bug).
	 * `onTick` reads + clears it; velocity is still captured in `handleScroll`
	 * so the post-release flick coast is unchanged. */
	private touchScrolledSinceTick: boolean = false;
	/** Reference to the registered UA-injecting fetch loader, kept so
	 * `setColorScheme` can update the outgoing Client-Hint header
	 * without rebuilding the loader. Null when network is disabled. */
	private uaFetchLoader: SwitchUaFetchLoader | null = null;
	/** Chained-setTimeout pump that prods `requestFullRepaint` so the
	 * shell paint loop keeps ticking while the loading overlay is
	 * shown. Null when not running. Self-cancels when the overlay
	 * stops being painted. */
	private cssLoadingOverlayPumpTid: ReturnType<typeof setTimeout> | null = null;
	/** Wallclock of the most recent `paintCssLoadingOverlay` call. The
	 * paint pump stops itself if this drifts too far in the past
	 * (overlay no longer painting → don't burn CPU). */
	private cssLoadingOverlayLastPaintMs = 0;
	/** App name armed by `__brewserArmLaunchSplash` (called from the app /
	 * warnings modal's Launch click listener, which runs BEFORE the engine's
	 * `findTapIntent` fires the navigate — see warnings-modal.js). `navigateTo`
	 * consumes it one-shot: a non-null value there means this navigation is an
	 * app LAUNCH, so paint the black "Loading <name>" splash over the whole
	 * screen (toolbar included) until the app's first frame. Null for every
	 * other navigation (home / settings / back / links) → no splash. */
	private pendingLaunchName: string | null = null;
	/** True while the launch splash's self-re-arming `nativeRaf` loop is
	 * running. The loop early-returns (stops re-arming) once this flips false
	 * in `stopLaunchSplash`. */
	private launchSplashActive = false;
	/** DIAG: frames the launch splash actually painted this launch. */
	private launchSplashFrames = 0;
	/** Reference to the nxjs runtime's `requestAnimationFrame`, captured
	 * BEFORE the first page navigation. brewser-runtime's `runPageScripts`
	 * calls `ensureRAFInstalled` which replaces `globalThis.requestAnimationFrame`
	 * with a queue that's only drained by `tickAnimationFrames` from the
	 * controller-input tick handler — which doesn't run until AFTER the
	 * boot splash + first navigate complete. The nxjs version, in
	 * contrast, is drained every main-loop iteration via `$.onFrame →
	 * callRafCallbacks` (in nxjs's `packages/runtime/src/index.ts`), so
	 * rAFs scheduled via this reference fire reliably during the boot
	 * splash even while a navigation runs in parallel. */
	private readonly nativeRaf: (cb: () => void) => number =
		globalThis.requestAnimationFrame as unknown as (cb: () => void) => number;
	constructor() {
		this.policy = new BrowserPermissionPolicy();
		// Feed the anchor-tap navigate-intent gate. Any `<a href="http…">`
		// click on an app page whose manifest omits `external_links` will
		// be dropped + logged instead of dispatched to the shell.
		setLiveInputPermissionPolicy(this.policy);
		this.profile = new BrowserProfile();
		this.profile.ensure();
		// Seed `configs/config.json` from romfs synchronously RIGHT HERE —
		// before the `loadConfig` a few lines down. The async `seedRomfs` in
		// `run()` is otherwise the first thing to put the file on disk, but
		// that runs AFTER this constructor, so on a fresh profile the config
		// reads below (colour scheme, button mapping, splash timing, history
		// cap) would fall back to DEFAULT_CONFIG and the very first launch
		// would render light-themed (white) with engine-default buttons until
		// the next launch. Missing-only → a no-op on every seeded profile.
		this.profile.seedConfigSync();
		// One WebPageSession per shell — owns the per-navigation page
		// lifecycle (scriptCtx + currentPageUrl). chromeHeight starts at 0
		// and gets sync'd to the real toolbar height once `run()` has
		// loaded `config.json` (see the `this.session.setChromeHeight`
		// calls there and in `handleHtmlResponseLive`).
		this.session = new WebPageSession({ screen: nxScreen(), chromeHeight: 0 });
		// Read config.json upfront so the HistoryStore is constructed with
		// the user's `maxHistory` cap (loadConfig falls back to DEFAULT_CONFIG
		// on first run before seedRomfs has copied the romfs default in;
		// either way maxHistory ends up at the same value).
		//
		// Also stashed on `this` so `run()` can hoist `startBootSplash`
		// to its first statement (the splash needs `showSplash` /
		// `splashFadeMs` BEFORE any awaiting step; re-doing
		// `loadConfig` from `run()` would be sync too but stashing
		// avoids the double read and makes the splash's "no
		// pre-paint await" contract explicit at the class boundary).
		const startupConfig = this.startupConfig = loadConfig(this.profile.appRoot);
		// Wire the user-editable joycon button mapping. Empty values in
		// `config.json buttonMapping` fall through to engine defaults
		// (A=leftClick, B=rightClick, X=forward, Y=reload,
		// ZR=middleClick, UP/DOWN=scroll). Used by
		// both `page-mouse-forwarder.ts` (which polls the indices the
		// router assigns to leftClick/rightClick/middleClick) and
		// `controller-shortcuts.ts` (which fires shell actions for
		// labels assigned back/forward/reload/etc.).
		setButtonMapping(startupConfig.buttonMapping);
		// Wire the `navDebug` config gate. Off by default; flip on to
		// trace navigation flow + shell input + touch dispatch into
		// `sdmc:/switch/brewser/logs/shell-nav-diag.log` from all three
		// writer sites (runtime WebView, shell input pump, controller-
		// shortcuts touch path).
		setShellInputDebugEnabled(startupConfig.navDebug);
		setNavDebugEnabled(startupConfig.navDebug);
		setTouchDebugEnabled(startupConfig.navDebug);
		// Image-load diagnostic gate (`config.json` -> `swbImgDebug`).
		// Independent of `navDebug` — leave one on while debugging
		// without paying the I/O cost of the other.
		setSwbImgDebugEnabled(startupConfig.swbImgDebug);
		// Click-sound subsystem. `clickSounds` in config.json gates the
		// feature; the path comes from the active profile's seeded
		// asset slot (`<storageRoot>assets/click.wav`). Preload kicks
		// off the fetch + decodeAudioData so the first user press
		// after boot has a buffer ready.
		setClickSoundEnabled(startupConfig.clickSounds);
		setClickSoundPath(this.profile.assetPath('click.wav'));
		void preloadClickSound();
		this.momentumEnabled = startupConfig.momentumScrolling;
		this.colorScheme = startupConfig.theme;
		// Push the colour-scheme preference into the CSS cascade up front so
		// the first stylesheet parse evaluates `@media (prefers-color-scheme:
		// …)` against the right value. Also tells the form-widget painter
		// which default palette to fall back to when a page doesn't set
		// explicit `background`/`color` on its inputs / buttons.
		setMediaColorScheme(this.colorScheme);
		setLiveFormColorScheme(this.colorScheme);
		// Date-input placeholder hint from `config.json local` (e.g.
		// `dd/mm/yyyy`). Time-input default is locale-agnostic and stays
		// at the engine default `-- : --`.
		setDateInputDefaultPlaceholder(startupConfig.local);
		this.historyStore = new HistoryStore({
			path: this.profile.historyPath(),
			maxEntries: startupConfig.maxHistory,
		});
		this.bookmarksStore = new BookmarksStore({ path: this.profile.bookmarksPath() });
		const delegate: WebViewDelegate = {
			onPageStarted: (url: string) => {
				// Reset the permission policy to shell mode (grant-all)
				// BEFORE the fetch runs. `onPageStarted` fires from
				// `WebView.runSession` right after `beginSession` and
				// BEFORE `fetchAndExecute` — so this is the last hook where
				// we can influence the policy that gates the incoming URL's
				// Switch.readFileSync path. If we skip this, the prior
				// page's `setManifestPermissions` call (installed by
				// `handleHtmlResponseLive` on the previous nav) is still
				// active during the new page's HTML read — an
				// app -> shell navigation (e.g. tapping the toolbar's Back
				// button while inside a game) then denies the read of
				// `sdmc:/switch/brewser/shell/settings.html` (path outside
				// the last app's sandbox, and the last app's manifest
				// didn't grant `filesystem_read`), the load fails, the
				// error-page fallback fails for the same reason, and the
				// user sees the previous page frozen while the URL bar
				// updates. Grant-all here is safe: the shell code doing
				// the fetch is trusted, and `handleHtmlResponseLive` will
				// re-install the app-specific restrictive policy AFTER
				// reading the new app's manifest but BEFORE running any
				// of its scripts. Shell URLs stay in grant-all through the
				// whole page lifetime (same as any first-nav shell page).
				this.policy.setManifestPermissions(null, null, null);
				// Per-page render budget: internal `brewser://` pages always
				// render in one shot (their size is bounded — apps grid,
				// settings list, dev probes etc. — and the visible "line-by-
				// line" build animation reads as sluggishness on a UI that
				// users expect to snap in). External http(s) pages use the
				// configured `wwwRenderChunkMs` budget so large web pages
				// don't freeze input during their build.
				//
				// 1e9 ms is the "one-shot" sentinel — the chunk loop in
				// live-overlay checks `Date.now() - chunkStart >= budget`
				// and we'll never hit that within a single page build.
				const isInternal = url.startsWith('brewser://');
				setLiveBuildChunkMs(isInternal ? 1e9 : this.wwwRenderChunkMs);
				// `beforeunload` is dispatched from WebView.endSession
				// (in @switch-web/runtime) BEFORE the browser-shim's
				// per-session listener cleanup runs. That's the only
				// correct point — by the time this delegate callback
				// fires, listeners from the previous page have already
				// been swept by `endAppSession`. See web-view.ts
				// `endSession()`.
				// Drop link rects + scroll state from the previous page so
				// stale taps and scroll positions don't carry over. Also
				// drop any fullscreen mode: the gamepad B button still
				// navigates in fullscreen modes, so without this the user
				// could land on the new page still flagged as fullscreen-
				// canvas while no canvas exists to paint.
				this.currentScrollY = 0;
				this.momentumVelocityPxPerTick = 0;
				this.fullscreenCanvasOriginalSize = null;
				this.fullscreenCanvasLive = false;
				(globalThis as { __swbFullscreenCanvasSize?: { width: number; height: number } | null })
					.__swbFullscreenCanvasSize = null;
				this.navigation.setCurrentTitle(null);
				this.setMode('normal');
				this.session.currentPageUrl = '';
				// Drop any `requestAnimationFrame` callbacks the
				// previous page queued. Without this an animation
				// loop on page A would keep firing under page B (and
				// since the rAF queue is module-level in canvas-runner,
				// the leaked callbacks accumulate forever).
				clearAnimationFrames();
				clearPageHasCanvas2dActivity();
				clearAllVideos();
				// Terminate any active Web Workers the previous page spawned
				// so their pthreads + JSRuntimes don't leak across nav. Calls
				// pthread_join on each — sync; blocks briefly per worker.
				// See [[project-swb-web-workers-milestone]].
				try {
					const g = globalThis as unknown as { __terminateAllWorkers?: () => void };
					if (typeof g.__terminateAllWorkers === 'function') g.__terminateAllWorkers();
				} catch (_) { /* swallow — never let nav fail on worker cleanup */ }
				// Stop any animated-GIF tickers from the prior page —
				// they hold closures over now-detached LiveElements and
				// would otherwise keep firing `setFrame` +
				// patchLiveCacheRegion on stale boxes, clobbering the
				// new page's cache.
				clearGifAnimations();
				// Same lifecycle for CSS-keyframes tickers — they're per-
				// element setTimeout loops that should die with the page.
				clearCssAnimations();
				// Wipe the shared screen GL bridge FBO so the next
				// page's first paint (which may copyBridgeToScreen
				// before any new rAF tick has fired) doesn't carry
				// over the previous page's last rendered frame.
				clearSharedScreenGLBridge();
			},
			onHtmlResponse: async (url, html) => {
				const tree = parseHtml(html);
				this.navigation.setCurrentTitle(extractTitle(tree));
				await this.handleHtmlResponseLive(url, tree);
			},
		};
		this.webView = new WebView(
			{
				width: DEFAULT_CANVAS_WIDTH,
				height: DEFAULT_CANVAS_HEIGHT,
				fullscreen: true,
				origin: BROWSER_INTERNAL_ORIGIN,
				enableWebGL: this.policy.allowWebGL(),
				enableGamepad: this.policy.allowGamepad(),
				enableTouch: this.policy.allowTouch(),
				enableLocalFetch: false,
				// Mirror the policy: when network is off we don't even register
				// `NativeFetchLoader`, so unknown URLs short-circuit to 403 in the
				// runtime fetch wrapper without going anywhere near `nativeFetch`.
				// Without this, an old/cached NRO or an emulator quirk that
				// bypassed the policy could still attempt a real network call.
				enableNetworkFetch: this.policy.networkEnabled,
				permissionPolicy: this.policy,
				// JSON API loaders come first so they claim their `.json`
				// URLs before the static-page loader's classifier would
				// route them as static-asset 404s. `brewser://history/`
				// (no .json) falls through to the static-page loader,
				// which serves `pages/history.html`.
				//
				// `SwitchUaFetchLoader` claims `http(s)://` before the
				// runtime-appended `NativeFetchLoader` (see
				// `web-view.ts`'s `buildLoaders`) so external requests
				// go out with a Switch-browser UA — needed because
				// google.com and many other sites serve a much smaller
				// HTML variant to the Switch UA than to the default
				// libcurl UA.
				resourceLoaders: [
					...(this.policy.networkEnabled
						? [this.uaFetchLoader = new SwitchUaFetchLoader({
							nativeFetch: captureNativeFetch(),
							permissionPolicy: this.policy,
							colorScheme: this.colorScheme,
						})]
						: []),
					new BrowserHistoryLoader(this.historyStore),
					new BrowserBookmarksLoader(this.bookmarksStore),
					new BrowserResourceLoader({
						storageRoot: this.profile.storageRoot,
						appRoot: this.profile.appRoot,
						bookmarksStore: this.bookmarksStore,
						historyStore: this.historyStore,
					}),
					// Claim `sdmc:`, `romfs:`, `file:` URLs BEFORE the
					// runtime's auto-appended `NativeFetchLoader` does —
					// otherwise the permission policy (which only allows
					// http(s)/blob/data) 403s every local-scheme `Image.src`
					// inside a WebView session, e.g. when a toolbar HTML
					// theme references `assets/refresh.png` (resolved
					// against the page that hosts the toolbar live root)
					// and the in-tree `<img>` load fetches the file off
					// the SD card. The captured native fetch reads the
					// bytes straight off the SD card / romfs partition
					// via `fetchFile`, which is what the policy is sitting
					// on top of anyway. Local reads don't touch the network
					// gate.
					new LocalSchemeFetchLoader({
						nativeFetch: captureNativeFetch(),
						permissionPolicy: this.policy,
					}),
				],
			},
			delegate,
		);
		this.navigation = new BrowserNavigation(this.webView, this.historyStore);
		this.keyboard = new KeyboardOverlay();
		this.filePicker = new FilePickerOverlay();
		this.selectModal = new SelectModalOverlay();
		this.datePicker = new DatePickerOverlay();
		this.timePicker = new TimePickerOverlay();
		this.colorPicker = new ColorPickerOverlay();
		this.numberPicker = new NumberPickerOverlay();
		this.addressBar = new AddressBarInput();
		// M2.4: expose the keyboard opener to the live-DOM form widgets
		// so `<input type=text>` taps can spawn the same on-canvas
		// keyboard the URL bar uses. Returns the typed string on Submit
		// or `null` on Cancel. The scroll callback is plumbed through so
		// the page behind the keyboard can be scrolled while it's modal
		// (right-stick Y, swipe above the panel) — same behavior as the
		// URL bar / search paths.
		setKeyboardOpener((initial, options) => this.keyboard.open(initial, {
			onScroll: (delta) => this.handleScroll(delta),
			validate: options?.validate,
		}));
		// 2026-06-17 file picker overlay — opener + start-dir resolver.
		// The opener wraps `FilePickerOverlay.open` so live-form stays
		// scheme-agnostic. The start-dir resolver maps the current page
		// URL onto an sdmc path: when the active page is a `brewser://apps/
		// <group>/<id>/...` URL, the picker starts in
		// `<appRoot>apps/<group>/<id>/`; non-app brewser:// pages start
		// in the storage root; external HTTPS pages start at sdmc root.
		setFilePickerOpener((options) => this.filePicker.open(options));
		setFilePickerStartDirResolver(() => this.resolveFilePickerStartDir());
		// 2026-06-18 select modal — opener wires `<select>` taps to the
		// fullscreen-ish modal dropdown that replaced the cycle-on-tap
		// stand-in.
		setSelectModalOpener((options) => this.selectModal.open(options));
		// 2026-06-18 date + time pickers — openers wire `<input type="date">`
		// and `<input type="time">` taps to the calendar / hour+minute
		// overlays.
		setDatePickerOpener((options) => this.datePicker.open(options));
		setTimePickerOpener((options) => this.timePicker.open(options));
		// 2026-06-18 color picker — opener wires `<input type="color">` taps
		// to the spectrum + RGBA-sliders overlay (replaces the cycle-palette
		// stand-in).
		setColorPickerOpener((options) => this.colorPicker.open(options));
		// 2026-06-18 number picker — opener wires `<input type="number">` taps
		// to the ± stepper / direct-edit overlay (replaces the keyboard
		// fall-through).
		setNumberPickerOpener((options) => this.numberPicker.open(options));
		// Wire `<input>.focus()` calls from page scripts (Cocos Creator's
		// EditBox does `document.createElement('input')` + appendChild +
		// focus()) into the same KeyboardOverlay path that live-DOM form
		// taps already use. openKeyboardAndApply reads the input's current
		// value, opens the keyboard, and on submit writes the result back
		// + fires input/change/blur. Without this, Cocos's text input is
		// dead (its focus() call is a no-op without a registered handler).
		setInputFocusHandler((el) => { void openKeyboardAndApply(el); });
		// 2026-06-08 ROUND 46: expose a page-script-callable function so
		// `canvas.requestFullscreen()` (Web Fullscreen API) can trigger
		// the same fullscreen-canvas flow as the gamepad B-button
		// shortcut. The CanvasShim's `requestFullscreen` method (see
		// canvas-runner.ts) awaits this. Returns a Promise resolved when
		// the mode has flipped + the page has been re-laid-out.
		(globalThis as { __swbRequestFullscreenCanvas?: () => Promise<void> })
			.__swbRequestFullscreenCanvas = async () => {
			if (this.mode === 'fullscreen-canvas') return;
			// Top-level page-script case: the script body that called
			// canvas.requestFullscreen() is itself running INSIDE
			// `runPageScripts`, so `this.session.scriptCtx` is still null and
			// `toggleFullscreenCanvas`'s `if (!this.session.scriptCtx) return;`
			// would silently swallow the request. Queue it; the loader
			// drains the queue right after assigning scriptCtx.
			if (!this.session.scriptCtx) {
				return new Promise<void>((resolve) => {
					this.pendingFullscreenCanvasRequest = () => {
						void this.toggleFullscreenCanvas().then(resolve, resolve);
					};
				});
			}
			await this.toggleFullscreenCanvas();
		};
		// Companion to __swbRequestFullscreenCanvas for non-canvas apps that
		// want their HTML page to fill the screen (chrome strip hidden). The
		// sensors dashboard uses this to start fullscreen on launch. Unlike
		// the canvas case, fullscreen-page mode doesn't need scriptCtx (no
		// canvas resize, no rerun), so we don't need the pending-queue dance.
		(globalThis as { __swbRequestFullscreenPage?: () => Promise<void> })
			.__swbRequestFullscreenPage = async () => {
			if (this.mode === 'fullscreen-page') return;
			await this.toggleFullscreenPage();
		};
		(globalThis as { __swbExitFullscreen?: () => Promise<void> })
			.__swbExitFullscreen = async () => {
			if (this.mode === 'normal') return;
			// `manifest.fullscreen: true` used to be a hard lock; as of
			// 2026-07-12 it's an INITIAL-state hint only — the app can
			// call `document.exitFullscreen()` (routes here via the
			// canvas-runner polyfill) or `__swbExitFullscreen()` directly
			// to drop out of `fullscreen-app` back to `normal`. L+R still
			// stays locked for `fullscreen-app` so a user can't
			// accidentally exit an app that designed itself to own the
			// display; only the app itself decides via a deliberate call.
			await this.exitFullscreen();
		};
		// Page-script-callable "go back to the page that launched this
		// one" — exits any fullscreen mode first (so we don't try to
		// navigate while the canvas is mid-fullscreen-resize) then walks
		// one step back in nav history. Apps like the WebGL demos poll
		// the joycon B button and call this on rising edge so the user
		// gets a one-press exit from fullscreen-canvas to the launcher.
		(globalThis as { __swbNavigateBack?: () => Promise<void> })
			.__swbNavigateBack = async () => {
			// `fullscreen-app`: skip exitFullscreen — the onNavigate
			// delegate at the start of the goBack will do a hard
			// `setMode('normal')` and the destination page's manifest
			// re-read will decide the next mode fresh.
			if (this.mode !== 'normal' && this.mode !== 'fullscreen-app') await this.exitFullscreen();
			await this.runNavigation(() => this.navigation.goBack());
		};
		// Silent variant used by the quit-prompt page (romfs/shell/quit-
		// prompt.html) when the user picks "No, stay". Combines mode-flip
		// and goBack without the intermediate `repaintAll` that
		// exitFullscreen() does — the intermediate paint made the toolbar
		// briefly appear on top of the (still-visible) quit prompt before
		// the navigation swapped in the previous page, which the user
		// perceived as the toolbar "popping up and pushing everything
		// down." Skipping the intermediate paint means the very next
		// visible frame is the previous page in normal mode, no flicker.
		(globalThis as { __swbNavigateBackSilent?: () => Promise<void> })
			.__swbNavigateBackSilent = async () => {
			if (this.mode === 'fullscreen-page') {
				const scr = nxScreen();
				setCssViewport(scr.width, Math.max(1, scr.height - this.chromeHeight));
				this.setMode('normal');
				this.clampScroll();
				// intentional: NO repaintAll here — the goBack below
				// triggers a fresh repaint at the previous page.
			} else if (this.mode === 'fullscreen-app') {
				// Same short-circuit path as fullscreen-page: skip the
				// exitFullscreen intermediate paint (it would flash the
				// toolbar over the still-visible previous page).
			} else if (this.mode !== 'normal') {
				await this.exitFullscreen();
			}
			await this.runNavigation(() => this.navigation.goBack());
		};
		// Page-script-callable reload of the CURRENT page — re-runs the full
		// load pipeline, INCLUDING the resource loader's server-tag expansion.
		// A page script that just wrote a `configs/*.json` the loader reads
		// (my-apps.js writing `configs/my-catalogue.json`) calls this to
		// surface the change — e.g. reveal the freshly-fetched "My Apps" tab —
		// without the user having to navigate away and back.
		(globalThis as { __swbReload?: () => Promise<void> })
			.__swbReload = async () => {
			if (this.mode !== 'normal' && this.mode !== 'fullscreen-app') await this.exitFullscreen();
			await this.runNavigation(() => this.navigation.reload());
		};
		// Page-script-callable reload — exits any fullscreen mode then
		// re-runs the current navigation. Used by updates-modal.js after
		// it writes a fresh `catalogue.json` so the apps grid re-renders
		// with the new versions / new entries. CanvasShim's
		// `location.reload()` is a no-op (see canvas-runner.ts), so
		// pages have no way to trigger this without an explicit shell
		// hook — this is that hook.
		(globalThis as { __swbReload?: () => Promise<void> })
			.__swbReload = async () => {
			if (this.mode !== 'normal') await this.exitFullscreen();
			await this.runNavigation(() => this.navigation.reload());
		};
		// Page-script-callable hard repaint — forces the next shell
		// loop iteration to rebuild the static body cache from scratch
		// (not just patch dirty regions). updates-modal.js drives this
		// after it mutates a batch of catalog cards in-place: the
		// per-element dirty registry alone wasn't producing the right
		// pixels in the currently-visible tab panel (cached pre-mutation
		// colors leaked through under the closed modal). resetLive
		// OverlayCache nukes lastBodyVersion + the offscreen so the
		// next paintLiveOverlay rebuilds the bake from the post-mutation
		// tree; requestFullRepaint flips the consume-once flag so the
		// shell loop doesn't fast-path-skip the rebuild on an otherwise
		// idle frame.
		(globalThis as { __swbRepaint?: () => void })
			.__swbRepaint = () => {
			resetLiveOverlayCache();
			requestFullRepaint();
		};
		// Page-script-callable scroll-to-top + hard repaint. A superset
		// of __swbRepaint: it also snaps the page's scroll offset back to
		// the top. apps-pagination.js calls this when the user pages the
		// app grid (Prev/Next) so the new page's first row lands at the
		// top of the viewport instead of inheriting the previous page's
		// scroll position. Zeroing momentumVelocity kills any residual
		// coast so it can't immediately scroll back down. The overlay-
		// cache reset + full-repaint request match __swbRepaint, needed
		// because the pager also swapped grid.innerHTML in place.
		(globalThis as { __swbScrollTop?: () => void })
			.__swbScrollTop = () => {
			this.currentScrollY = 0;
			this.momentumVelocityPxPerTick = 0;
			resetLiveOverlayCache();
			requestFullRepaint();
		};
		// Page-script-callable chrome (toolbar strip) visibility toggle.
		// self-update-modal.js and download-modal.js call this to hide the
		// toolbar for the ENTIRE download/update process (download → verify →
		// stage → restart) and to restore it on dismiss/abort.
		//
		// It does the SAME thing `showToolbar: false` does at boot (see
		// startup, ~line 1130): collapse `chromeHeight` to 0 so the layout
		// stops reserving the top strip and the page paint fills that slice.
		// The overlay-visibility gate ALONE (`setToolbarOverlayVisible`) is not
		// enough: with `chromeHeight` still > 0 the strip is layout-reserved
		// but no longer painted, so a cache-blit re-composites the stale
		// toolbar pixels over the modal backdrop — the "toolbar still showing
		// during Updating Brewser" bug. Restore puts the height back and
		// repushes toolbar state (renderChrome). `resetToolbarOverlayCache` +
		// `publishChromeRegion` mirror the settings-save toolbar path so the
		// touch region + overlay cache track the height change; a full repaint
		// applies it on the next frame. Only meaningful in normal mode —
		// fullscreen modes already gate the strip off. Idempotent: a second
		// hide keeps the first restore height; `showToolbar: false` globally
		// means chromeHeight is already 0, so hide/restore is a 0→0 no-op.
		(globalThis as { __brewserSetChromeVisible?: (visible: boolean) => void })
			.__brewserSetChromeVisible = (visible: boolean) => {
			const show = !!visible;
			if (show) {
				setToolbarOverlayVisible(true);
				if (this.chromeHiddenRestoreHeight !== null) {
					this.chromeHeight = this.chromeHiddenRestoreHeight;
					this.chromeHiddenRestoreHeight = null;
				}
				resetToolbarOverlayCache();
				this.publishChromeRegion();
				if (this.mode === 'normal') this.renderChrome();
			} else {
				if (this.chromeHiddenRestoreHeight === null) {
					this.chromeHiddenRestoreHeight = this.chromeHeight;
				}
				setToolbarOverlayVisible(false);
				this.chromeHeight = 0;
				resetToolbarOverlayCache();
				this.publishChromeRegion();
			}
			requestFullRepaint();
		};
		// Arm the launch splash. The app / warnings modal's Launch click
		// listener calls this with the app's display name; the click dispatch
		// runs BEFORE the engine's `findTapIntent` fires the navigate (see
		// warnings-modal.js), so the name is in place by the time `navigateTo`
		// consumes it. Best-effort + one-shot: a build without this hook just
		// launches without the splash (the modal guards on typeof === function).
		(globalThis as { __brewserArmLaunchSplash?: (name: string) => void })
			.__brewserArmLaunchSplash = (name: string) => {
			this.pendingLaunchName = typeof name === 'string' ? name : '';
			console.debug(`[launch-splash] armed name="${this.pendingLaunchName}"`);
		};
		// Boot-time snapshot of the toolbar avatar `src`. Runs BEFORE
		// `installPolyfills` (main.ts:50) and therefore BEFORE the runtime's
		// `installSwitchPathResolver` proxy exists, so the two auth reads go
		// through the raw nx.js `Switch.readFileSync` under no policy — safe
		// even if a stray manifestPerms had been pre-seeded. Subsequent
		// refreshes happen in `handleHtmlResponseLive` AFTER each
		// per-navigation `setManifestPermissions` swap, gated to shell
		// context only so the refresh never runs under a restrictive app
		// policy.
		this.refreshCachedToolbarAvatarSrc();
		this.installPlatformBridge();
	}

	/**
	 * Expose the platform client to shell page scripts (updates /
	 * download / missing-app modals) as `globalThis.__brewserPlatformClient`.
	 * The one-door rule: page scripts never parse platform JSON or build
	 * a platform URL themselves — they hand raw text to these functions
	 * and consume the normalized result (whose `fileUrl`/`entryUrl`/
	 * `artifactsUrl` members are the only URL builders). Pure parsing
	 * functions plus two cache readers; nothing here writes.
	 */
	private installPlatformBridge(): void {
		const appRoot = this.profile.appRoot;
		const readText = (path: string): string | null => {
			try {
				const raw = Switch.readFileSync(path);
				return raw && raw.byteLength > 0 ? new TextDecoder().decode(raw) : null;
			} catch (_) {
				return null;
			}
		};
		(globalThis as Record<string, unknown>).__brewserPlatformClient = {
			parseCatalogue,
			parseStats,
			parseArtifacts,
			/** Parse the cached `configs/catalogue.json`; same outcome
			 * union as `parseCatalogue`, or null when no cache exists. */
			readCachedCatalogue: () => {
				const text = readText(`${appRoot}configs/catalogue.json`);
				return text === null ? null : parseCatalogue(text);
			},
			/** Parse the cached `configs/stats.json`, or null. */
			readCachedStats: () => {
				const text = readText(`${appRoot}configs/stats.json`);
				return text === null ? null : parseStats(text);
			},
		};
	}

	async run(): Promise<void> {
		// Boot splash: HOISTED to the first statement of run() so its
		// synchronous first paint commits to canvas->data BEFORE any of
		// the awaiting setup work below (seedRomfs, 8× loadHtml*,
		// modal/toolbar parses, navigateTo + grid build) takes the JS
		// thread. Reads `this.startupConfig` (sync-captured in the
		// constructor) so no awaiting `loadConfig` precedes the paint.
		// `startBootSplash`'s first `rafCallback()` runs synchronously
		// inside its own body — see its contract comment.
		const splashHandle: SplashHandle | null = this.startupConfig.showSplash
			? this.startBootSplash(this.startupConfig.splashFadeMs)
			: null;
		this.webView.initialize();
		// Touch listener must be installed after the WebView has touched up
		// the canvas; it stays installed for the whole shell lifetime. It
		// handles both chrome strip taps and content-area link taps.
		installCanvasTouch();
		// Page-script touch forwarder: dispatches each screen TouchEvent
		// to the page's primary `<canvas>` LiveElement + LiveWindow as
		// both TouchEvent and PointerEvent. Inline-canvas page games
		// (Cocos Creator, hand-rolled WebGL) register `touchstart` on
		// canvas / window without going through swb's live-DOM layout
		// pass, so the chrome handler's `hitTestLive` walk misses them.
		// Runs in parallel with the chrome handler; the two dispatch to
		// different targets so duplicate handlers aren't a concern.
		installPageTouchForwarder();
		// Page-script mouse forwarder: the left joycon stick drives a
		// software cursor; A press = left click, B = right click (when
		// the page has a mouse listener — falls through to shell-back
		// otherwise), ZR = middle click (falls through to address-bar
		// otherwise). The cursor sprite is painted as the last step of
		// each repaint mode below. See `page-mouse-forwarder.ts`.
		installPageMouseForwarder();
		// Wire swipe-to-scroll: the touch handler opens a page-scroll
		// session on body-content swipes and dispatches `dy` deltas
		// through this callback. Same handler as right-stick / D-pad
		// scrolling so the clamp + repaint path is shared.
		setTouchScrollHandler((delta) => {
			// Flag the tick so `onTick` suppresses the momentum coast while the
			// finger is actively driving the scroll (the finger delta already
			// moves the page 1:1). Velocity is still captured in `handleScroll`
			// for the flick that coasts after the finger lifts.
			this.touchScrolledSinceTick = true;
			this.handleScroll(delta);
		});
		// Action-bus subscribers for chrome actions whose handlers are
		// safe to fire from the bus's synchronous dispatch:
		//  - `bookmark` is a sync toggle, no I/O.
		// Navigation-class actions (back / forward / reload / home /
		// settings / exit) still flow through the ControllerInput
		// switch below because they need the main loop's `await` to
		// serialize concurrent presses. Adding them to the bus would
		// drop into emit's fire-and-forget path and race.
		//
		// The runtime's `controller-shortcuts.checkShellRisingEdge` sees
		// the bus subscription via `hasActionHandler` and skips queuing
		// a ControllerInput for the migrated action — no double-dispatch.
		subscribeShellAction('bookmark', () => this.toggleBookmark());

		// Splash is rendered C-side by `nx_render_loading_image` (nxjs-source
		// main.c) from `romfs:/loading.jpg` BEFORE JS init begins — fires
		// ~+50ms after NRO launch and is held by the display engine until
		// the first page navigation paints. That covers the entire boot
		// window (seedRomfs, plInitialize, JS module eval, page build) with
		// no visible black-screen gap. The previous JS-side `paintBootSplash`
		// was redundant once the C-side path existed.
		// Copy missing built-in pages, toolbar icons, and toolbars.json
		// from romfs into the profile dir. Cheap on every launch
		// (existence check + skip for files that already exist) so the
		// user's edits survive but a deleted file is restored next run.
		await this.profile.seedRomfs();
		// HTML-driven keyboard: parse `keyboard.html` once into a second
		// live-DOM root. Painted below `KEYBOARD_LAYOUT.topY` when
		// `KeyboardOverlay.open()` flips the overlay-visible flag on.
		await this.loadHtmlKeyboard();
		// Keyboard's open() ticks repaints via this driver since the
		// main shell loop is suspended on its promise. Single-arg
		// arrow keeps `this` bound to the shell.
		setKeyboardRepaintDriver(() => this.repaintContent());
		// 2026-06-17 file picker overlay — same shape as the kb above.
		// Parsed once, painted on top of everything while
		// `<input type="file">` taps are in flight.
		await this.loadHtmlFilePicker();
		setFilePickerRepaintDriver(() => this.repaintContent());
		// 2026-06-18 select modal — same shape as the file picker. Parsed
		// once, painted on top of everything while a `<select>` tap session
		// is in flight.
		await this.loadHtmlSelectModal();
		setSelectModalRepaintDriver(() => this.repaintContent());
		// 2026-06-18 date + time pickers — same shape.
		await this.loadHtmlDatePicker();
		setDatePickerRepaintDriver(() => this.repaintContent());
		await this.loadHtmlTimePicker();
		setTimePickerRepaintDriver(() => this.repaintContent());
		// 2026-06-18 color picker — same shape.
		await this.loadHtmlColorPicker();
		setColorPickerRepaintDriver(() => this.repaintContent());
		// 2026-06-18 number picker — same shape.
		await this.loadHtmlNumberPicker();
		setNumberPickerRepaintDriver(() => this.repaintContent());
		// Apply shell-level preferences from config.json. Done before
		// scanForAutoplayVideos runs (it reads videoTryHwAccel via
		// openDecoder) and before the toolbar live root is built so the
		// chrome height + position are settled by the first paint.
		const shellConfig = loadConfig(this.profile.appRoot);
		setVideoTryHwAccel(shellConfig.videoNVTEGRA);
		// Stash the WWW budget for onPageStarted to re-apply on each external
		// navigation. The initial setLiveBuildChunkMs below is overridden the
		// moment the first navigation starts, but we keep it as a sane default
		// for any cache-build that fires before the first onPageStarted.
		this.wwwRenderChunkMs = shellConfig.wwwRenderChunkMs;
		setLiveBuildChunkMs(shellConfig.wwwRenderChunkMs);
		setLiveScrollChunkMs(shellConfig.scrollChunkMs);
		setCursorIdleMs(shellConfig.mouseIdleMs);
		// Config-driven keyboard panel height. The kb paint pass, the
		// touch-routing branch in controller-shortcuts, and the gamepad
		// A path in keyboard-overlay all read this via getKeyboardTopY().
		// Anchor at canvas height so the panel sits flush at the bottom
		// regardless of any future canvas-size change.
		setKeyboardTopY(nxScreen().height - shellConfig.keyboardHeight);
		// Chrome strip metrics: cache the height + position the engine
		// uses for the chrome rect, then build the HTML-driven toolbar
		// root so the first chrome paint already has something to blit.
		// `showToolbar: false` in `config.json` disables the chrome strip
		// entirely — chromeHeight forced to 0 collapses every paint
		// inset + CSS viewport reduction (`layoutTopInset`,
		// `publishChromeRegion`, the paint sites at lines 1979/2567/3645,
		// the `syncCanvasSize` viewport calc), and skipping the overlay
		// load + leaving it invisible means no fullscreen-exit path can
		// re-introduce the strip.
		this.chromeHeight = shellConfig.showToolbar ? shellConfig.toolbarHeight : 0;
		this.pageBackground = shellConfig.pageBackground;
		this.toolbarPosition = shellConfig.toolbarPosition;
		if (shellConfig.showToolbar) {
			await this.loadHtmlToolbar();
			setToolbarOverlayVisible(true);
		} else {
			setToolbarOverlayVisible(false);
		}
		this.publishChromeRegion();
		// Selected wallpaper. The STATIC image + the idle-animation flag are
		// safe to set up now (no GL). The ANIMATED (`dynamic`) shader is
		// deferred to after the home page's first paint (below the splash/nav
		// block) — acquiring the shared screen GL context + enabling the GPU
		// bridge HERE, mid-boot while the splash is still compositing 2D and
		// before any page has painted, blanks the whole screen. Once a 2D
		// paint has happened the GL bridge composites over it fine (the same
		// path a runtime Background-picker change already exercises).
		void this.loadStyleBackground(this.resolveSelectedBackground(shellConfig).background);
		// Pre-decode the system cursor sprites + animated APNG frames from
		// `themes/cursors.json` so `<body>`'s computed `cursor:` value can
		// swap the on-screen cursor through the page-mouse-forwarder. Fire-
		// and-forget — until the registry lands the cursor falls back to
		// the coded default arrow.
		void loadCursorRegistry(
			this.profile.stylePath('themes/cursors.json'),
			(rel) => this.profile.stylePath(rel),
		);
		// Detect launch mode. Applet-mode launches (typically
		// `LibraryApplet = 2`, the default hbmenu-via-Album hop) have
		// restricted memory that the live-DOM content cache's
		// OffscreenCanvas allocations can OOM on tall pages. Application
		// mode (libnx `AppletType_Application = 0`, what hbmenu title-
		// override produces) is the recommended environment. Warn the
		// user when they're not in Application mode.
		const appletType = readAppletType();
		// Expose to the benchmark page so a user can verify what
		// their launcher produced.
		(globalThis as { __appletType?: number }).__appletType = appletType;
		const isApplication = appletType === APPLET_TYPE_APPLICATION;
		if (!isApplication) {
			await this.showLibraryAppletWarning(appletType);
		}
		// Kick off the network probe in the background — don't block boot
		// on its ~1–15 s round-trip. The toolbar reachability indicator
		// (green/red dot) reads `__browserNetworkStatus` per render and
		// the onTick gate already redraws the chrome when that value
		// flips, so the dot lights up the moment the first probe lands.
		// Plus a 60 s background re-probe so the indicator tracks
		// connect / disconnect / dock-change events instead of being
		// frozen at boot-time state. 60 s is well above the per-probe
		// timeout budget (≤15 s) so probes never overlap.
		void probeNetwork().then(stashNetworkStatus);
		setInterval(() => { void probeNetwork().then(stashNetworkStatus); }, 60_000);

		// Home navigation + fade gating.
		//
		// The splash is ALREADY running (hoisted to run()-entry above)
		// and has been painting its frame every rAF tick from the
		// instant Skia was initialized — covering the entire span
		// above (seedRomfs, 8× loadHtml*, modal/toolbar parses, applet
		// warning, etc.). Now we just need to await the home navigate
		// (which guarantees the live-DOM cache is built so the
		// post-fade `repaintAll()` is a fast cache-blit, not a
		// rebuild), then fade and hand off. The fade's final frame
		// paints alpha=1 black, then `repaintAll` blits home on top —
		// no flash of black between fade-end and home-paint (the
		// splash rAF self-terminates on `phase === 'done'`, so it
		// won't repaint the black layer after `repaintAll` lands).
		//
		// `showSplash: false` bypasses all of the above for fastest
		// boot (no rAF cost, no fade). C-side
		// `nx_render_loading_image` (if present in the runtime build)
		// may still flash loading.jpg briefly during init.
		// `config.autorunApp` overrides the boot target when non-empty
		// (e.g. `/apps/experimental/foo/index.html` → the shell launches
		// straight into that app instead of the home page). Leading-slash
		// paths resolve against the `brewser://` origin; absolute schemes
		// pass through. Any parse issue falls back to home. The Home
		// button still targets `DEFAULT_HOME_URL` so autorun doesn't
		// trap the user in the app.
		const bootUrl = resolveAutorunUrl(shellConfig.autorunApp) ?? DEFAULT_HOME_URL;
		if (splashHandle) {
			await this.navigateTo(bootUrl);
			splashHandle.beginFade();
			await splashHandle.finishedFading;
			// Warm-cache repaint. Should be ~10 ms (cache blit only).
			this.repaintAll();
		} else {
			await this.navigateTo(bootUrl);
			// No splash → no repaintAll above; force one 2D paint before the
			// deferred GL arm below so the bridge composites over an
			// established surface (see the boot wallpaper note above).
			this.repaintAll();
		}
		// Deferred animated-wallpaper arm. Now that the home page has been
		// navigated AND painted (repaintAll above), acquiring the shared GL
		// context + enabling the GPU bridge is safe — doing it earlier (mid
		// boot, pre-first-paint) blanked the screen. Static wallpapers armed
		// at boot above are unaffected; this only touches the `dynamic` shader.
		{
			const bootBg = this.resolveSelectedBackground(shellConfig);
			if (bootBg.dynamic) this.loadStyleDynamic(bootBg.dynamic);
		}

		try {
			while (true) {
				const input = await waitForControllerInput({
					onScroll: (delta) => this.handleScroll(delta),
					// Drain any queued `requestAnimationFrame` callbacks
					// each poll iteration so animated demos (e.g. the
					// Three.js cube) get a steady ~60 Hz tick. The
					// callbacks render into the screen WebGL bridge;
					// after firing, the canvas-runner's per-page
					// readback hook refreshes each WebGL-tagged
					// OffscreenCanvas. We then repaint the page so the
					// painter blits the updated offscreen at the canvas
					// slot. On animated pages `repaintContent` skips
					// the (stale) cache and re-paints from layout, so
					// every frame shows the latest cube pose. Chrome
					// must be redrawn too because Three.js's
					// `renderer.render` calls `gl.clear`, which triggers
					// the bridge's full-FBO flush into screen cairo —
					// the chrome strip gets clobbered by the bridge's
					// clearColor outside the cube viewport.
					onTick: (info) => {
						// Software-cursor driver. `tickMouseInput` ran in
						// `waitForControllerInput` before the shell's
						// rising-edge checks so B/ZR could be claimed by
						// the page mouse layer; we just consume the
						// result here to schedule a same-tick repaint
						// when the cursor moved or a click fired.
						const mouseTick = info.mouseTick;
						// Evaluate animation + video ticks separately so we
						// can tell the two cases apart at chrome-redraw
						// decision time. Animation/WebGL ticks clobber the
						// chrome strip via bridge clearColor and so demand a
						// chrome redraw; video-only ticks don't touch chrome
						// at all (it sits above the painter's viewport).
						// 2026-07-10 — run BOTH ticks each iteration. The
						// prior short-circuit (`animFired ? false : tickVideo()`)
						// starved the video decoder whenever a page had ANY
						// rAF-shaped animation running, because
						// tickAnimationFrames() returns true first and skipped
						// tickVideo entirely. Three.js's `webgl_materials_video`
						// (and any demo that drives `VideoTexture` under a
						// `setAnimationLoop` render loop) hit this: the
						// decoder opened, got metadata, but never advanced —
						// `hasFirstFrame` stayed false, `video.readyState`
						// stayed 0, and Three.js's VideoTexture.update()
						// (which needs `readyState >= HAVE_CURRENT_DATA`)
						// never fired, so `texture.needsUpdate` never became
						// true and the material rendered black. The two ticks
						// touch disjoint state (rAF callbacks vs. per-video
						// decoder ring buffers) and both are cheap enough to
						// run together every iteration — the OR-composed
						// `fired` flag drives the chrome-redraw decision.
						const animFired = tickAnimationFrames();
						const videoFired = tickVideo();
						const fired = animFired || videoFired;
						// Phase 1.5+1.6 follow-up: live-form's handleFormTap
						// flags `requestFullRepaint()` after a tap mutates
						// state (radio/range/checkbox/label-for/summary).
						// Consume it here so the shell refreshes the screen
						// even when the page has no rAF loop. Without this,
						// taps appear to do nothing until the user scrolls.
						//
						// Phase 2.5.4 (2026-05-25): if the user already
						// scrolled this iteration, the scroll path already
						// repainted the screen. Skip the build-continuation
						// repaint to avoid doing the expensive cache build
						// chunk on top of the scroll repaint — that's what
						// dropped scroll FPS to ~20 during the initial
						// build. rAF callbacks (animated pages) still fire
						// regardless. The next idle tick (no scroll) will
						// consume the repaint flag and advance the build.
						//
						// Slice-2a perf (2026-05-26 evening): chrome strip
						// was being redrawn on every fired tick (~16ms
						// per frame), even on video-only ticks where
						// nothing on the chrome could possibly have changed.
						// Gate the per-tick renderChrome on whether
						// chrome-affecting state could plausibly have
						// changed since the last render: animation pages
						// clobber via bridge clear, or the external
						// internet-reachability probe flipped between ticks.
						// Explicit state mutations (navigate, bookmark,
						// back/forward) call `renderChrome` directly outside
						// the tick path so they're already covered.
						const reachableNow = readInternetReachable();
						const reachableChanged = reachableNow !== this.lastChromeReachable;
						// Dock/undock detection: poll libnx's cached
						// operation-mode int (free; updated in the background
						// by libnx's own applet hook). When it differs from
						// the last value we painted, force a chrome redraw
						// so the toolbar HANDHELD/DOCKED label flips
						// immediately — even on idle pages with no rAF or
						// video activity firing.
						const modeNow = readOperationMode();
						const modeChanged = modeNow !== this.lastChromeOperationMode;
						if (fired) {
							// Video-only fast path eligibility: only video
							// ticked this turn, no scroll input, mode is
							// normal (cache-blit path applies). repaintContent
							// itself adds the cache-built + scroll-unchanged
							// checks before actually taking the fast path.
							const videoOnlyFast = videoFired && !animFired
								&& !info.scrolledThisTick
								&& this.mode === 'normal';
							this.repaintContent({ videoOnlyFast });
							if (this.mode === 'normal' && (animFired || reachableChanged || modeChanged)) {
								this.renderChrome();
							}
							return true;
						}
						// Read + clear the touch-scroll flag every tick (set by the
						// touch scroll handler on each finger-drag delta).
						const touchScrolledThisTick = this.touchScrolledSinceTick;
						this.touchScrolledSinceTick = false;
						if (info.scrolledThisTick) {
							return false; // build-continuation deferred to next idle tick
						}
						// A touch page-scroll delta landed this tick: the finger already
						// moved the page 1:1. Report active (keep the loop at scroll
						// cadence so the next touchmove is handled promptly) but DON'T
						// coast momentum on top — that concurrent coast is what made the
						// page outrun the finger. The captured velocity coasts once the
						// finger lifts (no more deltas → flag stays false → tickMomentum
						// runs below).
						if (touchScrolledThisTick) {
							return true;
						}
						// Momentum-scroll coast: user input stopped this tick but
						// `handleScroll` left residual velocity behind. Decay one
						// step, apply, and report active so the loop polls at
						// the scroll cadence rather than the idle cadence — the
						// content keeps moving until friction zeros velocity or
						// it hits a scroll boundary. Short-circuits cheaply when
						// momentum is off or velocity is zero (one bool compare
						// + one float compare in `tickMomentum`).
						if (this.tickMomentum()) {
							return true;
						}
						// Idle tick. Drive an in-progress live-DOM content build
						// straight from here instead of trusting the chunked
						// builder's own setTimeout→requestFullRepaint
						// continuation: on a fully STATIC page (no rAF/video
						// activity) that continuation didn't reliably fire, so
						// the build stalled after its first ~12 ms chunk and the
						// page rendered only partially (e.g. the audio player's
						// library + lower controls never painted). Re-painting
						// every active tick while `isLiveCacheBuilding()` is true
						// advances the chunked build to completion regardless of
						// rAF — and `repaintContent` is a no-op-cheap cache blit
						// once the build finishes and the flag clears.
						const repaintRequested = consumeFullRepaintRequest();
						if (repaintRequested || isLiveCacheBuilding()) {
							this.repaintContent();
							if (this.mode === 'normal' && (reachableChanged || modeChanged)) this.renderChrome();
							this.lastTickTreeVersion = getLiveTreeVersion();
							return true;
						}
						// Page-script timer mutations (setTimeout/setInterval)
						// bump the live tree version but fire no rAF, video
						// frame, or tap — e.g. the audio player's 4 Hz
						// updateTimeline advancing the seek bar + time label
						// during passive playback. The branches above wouldn't
						// catch them, so detect the version change here and run
						// the same partial repaint the tap path uses (it patches
						// just the changed regions, or punts to a full rebuild).
						const treeVersionNow = getLiveTreeVersion();
						if (treeVersionNow !== this.lastTickTreeVersion) {
							this.lastTickTreeVersion = treeVersionNow;
							const patched = patchLiveDirtyRegions();
							if (consumeFullRepaintRequest() || patched) {
								this.repaintContent();
								if (this.mode === 'normal' && (reachableChanged || modeChanged)) this.renderChrome();
								return true;
							}
						}
						// Modal-layer mutations (a `<browser-modal>` overlay's page
						// script updating its own subtree — the download / self-update
						// PROGRESS BAR advancing per file, or its MB/counter labels)
						// route through `modalTreeVersion`, NOT the host `liveTreeVersion`
						// the check above watches. The modal keeps its own counter so
						// per-modal churn doesn't dirty the warm host cache — but that
						// means the host-version check never notices it, so on a fully
						// idle tick (static or no wallpaper, no input) nothing serviced
						// the update and the bar froze until the user moved the cursor.
						// A dynamic wallpaper masked it by repainting every frame via
						// `tickDynamicBackground`. Detect the modal version change here
						// and repaint: `repaintContent` rebuilds ONLY the small modal
						// offscreen cache (its cache key is `getLiveTreeVersion() +
						// getModalTreeVersion()`, see live-overlay), so the host page
						// cache stays warm. `repaintContent` reads the version, never
						// bumps it, so this can't self-retrigger into a paint loop.
						const modalVersionNow = getModalTreeVersion();
						if (modalVersionNow !== this.lastTickModalVersion) {
							this.lastTickModalVersion = modalVersionNow;
							this.repaintContent();
							return true;
						}
						// Idle tick: nothing else fired, but if the
						// operation mode just changed we still want to
						// flip the toolbar label this frame. Render the
						// chrome strip alone (cheap — overlay paint only;
						// content cache untouched) and signal the loop to
						// present.
						if (this.mode === 'normal' && modeChanged) {
							this.renderChrome();
							return true;
						}
						// Cursor moved or button edge fired. V8 migration:
						// the QuickJS-era engine compositor that read the
						// cursor's (x, y) at present time is gone
						// (NXJS_PATCHES_NEEDED.md #4 dropped); the cursor
						// is now drawn Skia-side as the last step of
						// `repaintContent` via `paintCursorOverlay`. So
						// a cursor move REQUIRES a content repaint — both
						// to render the cursor at the new position AND to
						// restore the area under the prior position from
						// the live-cache blit (the cursor was destructive
						// when drawn; without the redraw the prior
						// position would leave a trail). repaintContent's
						// steady-state cost on an idle page is a single
						// cache `drawImage` (~1-3 ms per the
						// repaintContent JSDoc), cheap enough to run on
						// every cursor-move tick. Animated cursors also
						// need this every tick so the spinner advances.
						if (mouseTick.cursorChanged) {
							this.repaintContent();
							return true;
						}
						// Animated wallpaper: on an otherwise-idle tick (nothing
						// above fired), advance it. Driven here rather than from a
						// setTimeout pump so it keeps animating at full idle — and
						// a no-op (returns false) when no dynamic wallpaper is
						// armed, so the normal idle path is unchanged.
						if (this.tickDynamicBackground(performance.now())) return true;
						return false;
					},
				});
				_shellInputDiag('input.kind=' + input.kind +
					(input.kind === 'navigate' ? ' url=' + input.url : ''));
				switch (input.kind) {
					case 'exit':
						// 2026-06-15: if a `<dialog>.showModal()` modal-mode
						// dialog is open, exit means DISMISS THE MODAL first
						// — same shape as Esc in real browsers and the
						// existing `back` action below. Otherwise the user
						// would have to chase a Close button on every modal
						// page, and apps that map `exit:B` (the dom-html-css
						// app does) couldn't use B to close native dialogs
						// at all. `close()` dispatches the spec `close`
						// event so page listeners still observe the
						// dismissal.
						// If our confirm-to-quit modal is already open, PLUS is a
						// no-op. Without this guard, the closeTopmostModalModeDialog
						// gate below would close the modal on rising-edge #1 and the
						// next PLUS press would re-open it — user perceives a rapid
						// close/reopen thrash. B still cancels (via the back-case
						// closeTopmostModalModeDialog gate); the "No, stay" click
						// still works.
						if (document.getElementById("__swb_quit_prompt")) break;
						if (closeTopmostModalModeDialog()) break;
						// Context-aware. While an app page is active (URL
						// under `brewser://apps/<group>/<id>/...`), "exit"
						// means EXIT THE APP — close any fullscreen-canvas
						// then walk one nav step back to the launcher. On
						// any non-app page, the historical shell-quit
						// semantic holds and we return from the input loop.
						if (this.currentAppDir) {
							// Skip exitFullscreen for the manifest-owned
							// `fullscreen-app` mode — the onNavigate delegate
							// at goBack() will reset the mode cleanly, and
							// the previous page's manifest re-read decides
							// the next mode fresh (returning to launcher =
							// normal; nested fullscreen app page = re-enter).
							if (this.mode !== 'normal' && this.mode !== 'fullscreen-app') await this.exitFullscreen();
							await this.runNavigation(() => this.navigation.goBack());
							break;
						}
						// Shell context: inject a native <dialog> modal into the
						// current page live-DOM instead of navigating away. The
						// runtime paintModalOverlay paints a spec-shaped 55%-dark
						// backdrop over the page viewport on showModal(), so the
						// underlying launcher / home / settings page stays visible-
						// dimmed underneath. Yes -> Switch.exit(); No -> dialog.close()
						// which also happens on the standard B action via
						// closeTopmostModalModeDialog at the top of this case.
						this.openQuitConfirmModal();
						break;
					case 'address-bar':
						await this.promptAndNavigate();
						break;
					case 'back':
						// 2026-06-15: matching `exit` above — if a
						// `<dialog>.showModal()` modal is open, close it
						// first instead of walking history back. Same
						// "Esc closes modal" affordance.
						if (closeTopmostModalModeDialog()) break;
						// In a fullscreen mode (video or canvas), B exits
						// back to the page rather than navigating history —
						// same affordance as the L+R combo.
						if (this.mode === 'video-fullscreen' || this.mode === 'fullscreen-canvas') {
							await this.exitFullscreen();
						} else {
							// Give the page a chance to consume B as a
							// synthetic `Escape` keydown — same model as
							// the ArrowUp/Down forwarding ([[swb-page-input-limits]]).
							// Page handlers call preventDefault() to keep
							// the shell from navigating back, enabling
							// multi-stage Back (close modal → exit). If no
							// page handler or page doesn't preventDefault,
							// fall through to history goBack as before.
							if (pageHasListenerFor('keydown')) {
								const consumed = dispatchPageKeyEvent('keydown', 'Escape', 'Escape');
								if (consumed) break;
							}
							await this.runNavigation(() => this.navigation.goBack());
						}
						break;
					case 'forward':
						await this.runNavigation(() => this.navigation.goForward());
						break;
					case 'home':
						await this.navigateTo(DEFAULT_HOME_URL);
						break;
					case 'settings':
						await this.navigateTo('brewser://settings/');
						break;
					case 'avatar':
						// Google is the sole sign-in provider — send the tap
						// straight to the Google device-flow page. That page
						// owns both the sign-in stages and the logged-in /
						// Log out state, so no separate picker landing is
						// needed.
						await this.navigateTo('brewser://googleLogin/');
						break;
					case 'reload':
						await this.runNavigation(() => this.navigation.reload());
						break;
					// `case 'star':` (bookmark) removed 2026-06-16 in the
					// chrome-handler → action-bus migration.
					// `controller-shortcuts.checkShellRisingEdge` no longer
					// queues a ControllerInput for it; the bus subscriber
					// wired in `run()` handles the rising edge directly.
					case 'navigate': {
						// Link (`<a href>`) taps: resolve a relative href against
						// the current page's URL, same page-relative architecture
						// as `<img>` srcs. Absolute URLs pass through unchanged.
						const navUrl = this.resolveNavUrl(input.url);
						_shellInputDiag('navigateTo about to be called for ' + navUrl);
						await this.navigateTo(navUrl);
						_shellInputDiag('navigateTo returned for ' + navUrl);
						break;
					}
					case 'button-action':
						await this.dispatchButtonAction(input.action);
						break;
					case 'summary-toggle':
						this.toggleLiveSummary(input.summary);
						break;
					case 'video-fullscreen-enter':
						this.enterVideoFullscreen(input.video);
						break;
					case 'video-play':
						videoPlay(input.video);
						this.paintVideoInline(input.video);
						break;
					case 'video-pause':
						videoPause(input.video);
						this.paintVideoInline(input.video);
						break;
					case 'video-stop':
						videoStop(input.video);
						this.paintVideoInline(input.video);
						break;
					case 'video-mute-toggle':
						videoToggleMute(input.video);
						this.paintVideoInline(input.video);
						break;
					case 'video-seek':
						videoSeekRatio(input.video, input.ratio);
						this.paintVideoInline(input.video);
						break;
					case 'lr-combo':
						// L+R exits whichever fullscreen mode is active.
						// Ignored in normal mode (so user can still hold
						// L+R+Minus for the shell-exit combo). Also ignored
						// in `fullscreen-app` — the manifest owns that
						// mode for the app's lifetime; L+R is a no-op.
						if (this.mode !== 'normal' && this.mode !== 'fullscreen-app') await this.exitFullscreen();
						break;
				}
			}
		} finally {
			this.webView.destroy();
		}
	}

	private async runNavigation(action: () => Promise<void>): Promise<void> {
		setNavigating(true);
		try {
			await action();
			this.renderChrome();
		} finally {
			setNavigating(false);
		}
	}

	/** Resolve a link `href` against the current page's URL, mirroring how
	 * `<img>` srcs resolve page-relative. Absolute URLs (any scheme) pass
	 * through. `brewser://` bases follow the engine's own segment-walking
	 * rules to produce another `brewser://` URL. `http(s)://` bases
	 * (external pages like google.com) defer to the standard URL parser
	 * so `/search` becomes `https://<host>/search` etc. — required for
	 * tier3 form-submit navigation and for relative `<a href>` on
	 * external pages. */
	private resolveNavUrl(url: string): string {
		return resolveNavUrl(url, this.session.currentPageUrl);
	}

	private async navigateTo(url: string): Promise<void> {
		setNavigating(true);
		// Launch splash. A non-null `pendingLaunchName` (armed by the Launch
		// tap's click listener, which ran just before this) marks an app
		// launch: black-fill the whole screen and show "Loading <name>" until
		// the app's first frame. One-shot consume so a stray arm can't ride
		// into a later, unrelated navigation. Every non-launch navigate leaves
		// it null → this whole block is a no-op and behaviour is unchanged.
		const launchName = this.pendingLaunchName;
		this.pendingLaunchName = null;
		console.debug(`[launch-splash] navigateTo url=${url} launchName=${JSON.stringify(launchName)}`);
		const splashStart = performance.now();
		if (launchName !== null) {
			this.startLaunchSplash(launchName);
			// The synchronous first paint above only draws into the framebuffer
			// — it is presented by the C-side frame loop (`$.onFrame`), which
			// runs only while the JS thread is IDLE. `navigate()` below is
			// largely synchronous (parse / layout / GL teardown; even its
			// network fetches fail fast, no await), so it never yields and the
			// splash would be overwritten before it is ever shown (the observed
			// "stop after 1 frame"). Yield here so the loop presents the splash
			// FIRST; its last frame then persists on the framebuffer through the
			// blocking load.
			await new Promise<void>((resolve) => setTimeout(resolve, 48));
		}
		try {
			await this.navigation.navigate(url);
			this.renderChrome(url);
		} finally {
			setNavigating(false);
			if (launchName !== null) {
				// Hold for a minimum on-screen time so a fast (local/cached)
				// load still shows the splash. Each idle `setTimeout` wait lets
				// `$.onFrame` drain the splash's `nativeRaf` loop, which repaints
				// it over the just-loaded app until we stop it.
				for (
					let left = LAUNCH_SPLASH_MIN_MS - (performance.now() - splashStart);
					left > 0;
					left = LAUNCH_SPLASH_MIN_MS - (performance.now() - splashStart)
				) {
					await new Promise<void>((resolve) => setTimeout(resolve, Math.min(48, left)));
				}
				// Stop the re-arm loop, then paint the loaded app as the final
				// frame so the splash can't flicker back on top.
				this.stopLaunchSplash();
				this.repaintAll();
			}
		}
	}

	/** Re-resolve the toolbar avatar `src` from the SDMC auth records and
	 * stash it in `cachedToolbarAvatarSrc` so subsequent `renderChrome`
	 * calls can paint it without touching the disk. Called exactly at
	 * (1) end-of-constructor (boot, unproxied `Switch`, no policy) and
	 * (2) `handleHtmlResponseLive` AFTER `setManifestPermissions` swaps
	 * the runtime policy AND ONLY when that policy is shell / grant-all
	 * — the resolver reads shell-owned paths that only resolve under
	 * grant-all, so calling this while a restrictive app policy is
	 * installed would deny both reads and clobber the cached value with
	 * the placeholder. See the field's own comment for the rationale.
	 *
	 * MUST NOT be called from any per-frame code path. `pushToolbarState`
	 * — the only user of `cachedToolbarAvatarSrc` — reads the field
	 * directly. Adding this call to any tick-driven surface would
	 * reintroduce the pre-2026-07-09 60 Hz `sdmc:/switch/brewser/shell/auth/`
	 * read flood on animated app pages (see `handleHtmlResponseLive`'s
	 * refresh site for the full history). */
	private refreshCachedToolbarAvatarSrc(): void {
		this.cachedToolbarAvatarSrc = resolveActiveSessionAvatarPath() ?? DEFAULT_TOOLBAR_AVATAR_SRC;
	}

	private renderChrome(fallbackURL = ''): void {
		const url = this.navigation.currentURL ?? fallbackURL;
		const reachable = readInternetReachable();
		const mode = readOperationMode();
		const modeLabel = mode === 0 ? 'HANDHELD' : mode === 1 ? 'DOCKED' : '';
		// Only real web pages (http/https) can be bookmarked — local
		// `brewser://` pages hide the star. Keep the touch handler's
		// star-slot gate in sync so its tap falls through to the URL bar.
		const bookmarkable = isBookmarkable(url);
		setStarEnabled(bookmarkable);
		this.pushToolbarState({
			url,
			canGoBack: this.navigation.controller.canGoBack,
			canGoForward: this.navigation.controller.canGoForward,
			bookmarked: bookmarkable && !!url ? this.bookmarksStore.has(url) : false,
			bookmarkable,
			internetReachable: reachable,
			modeLabel,
		});
		// Capture so onTick's chrome-skip gate notices external state
		// (network reachability + dock/undock) changes between explicit
		// renderChrome calls.
		this.lastChromeReachable = reachable;
		this.lastChromeOperationMode = mode;
		// No cursor work needed here — the engine composites the cursor
		// onto `display_buffer` every present, independent of what we
		// paint into canvas->data. See `composite_cursor_overlay` in
		// nxjs-source/source/main.c.
	}

	/**
	 * Star-button handler: toggle the current URL in the bookmarks
	 * store, then redraw the chrome so the star colour reflects the
	 * new state. URL with no current page (e.g. immediately after a
	 * failed navigation) is a no-op.
	 */
	private toggleBookmark(): void {
		const url = this.navigation.currentURL;
		// Only http/https pages are bookmarkable; local brewser:// pages
		// have no star (defensive — the tap handler already gates this).
		if (!url || !isBookmarkable(url)) return;
		const title = this.navigation.currentTitle || url;
		this.bookmarksStore.toggle({ url, title, addedAt: Date.now() });
		this.renderChrome();
	}

	/** Shell-context PLUS → confirm-to-quit modal.
	 *
	 * Injects a native `<dialog>` into the current page's live-DOM and
	 * calls `showModal()`. The runtime's `paintModalOverlay`
	 * (live-overlay.ts:3028) paints a spec-shaped `rgba(8, 13, 26, 0.55)`
	 * backdrop over the page viewport whenever a dialog is in modal-mode,
	 * so the underlying launcher/home/settings page stays visible-dimmed
	 * underneath — which the page-navigation approach couldn't do
	 * (`repaintContentInner` black-fills before painting a new page, so
	 * there's no previous-page pixels to peek through).
	 *
	 * Buttons: `Yes, quit` → `Switch.exit()` (bypasses the `beforeunload`
	 * suppressor in main.ts since it's direct, not via the runtime's
	 * `onFrame` handler). `No, stay` → `dialog.close()` which fires the
	 * spec `close` event; the listener removes the injected node from
	 * the DOM so a subsequent PLUS re-injects fresh. B (rightClick /
	 * `back`) closes it via the standard `closeTopmostModalModeDialog`
	 * gate that already sits at the top of the `case 'exit'` and
	 * `case 'back'` branches. A single guarded-by-id prevents stacking. */
	private openQuitConfirmModal(): void {
		if (document.getElementById('__swb_quit_prompt')) return;
		const dialog = document.createElement('dialog') as unknown as HTMLDialogElement;
		dialog.id = '__swb_quit_prompt';
		// Make the dialog itself fill the viewport with a transparent
		// background, then flex-center the card inside. CSS `transform`
		// isn't reliably applied by the runtime's live layout engine, so
		// classic 50%/50% + translate(-50%, -50%) centering left the
		// modal in the top-left. Flexbox on the dialog is honored (both
		// spectraplay + several shell pages use it) so this is the
		// simpler + more robust centering path.
		dialog.setAttribute('style',
			'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
			'margin:0;padding:0;background:transparent;border:none;' +
			'color:#eaf2ff;display:flex;align-items:center;' +
			'justify-content:center;');
		dialog.innerHTML =
			'<div style="width:640px;padding:44px 48px 36px;background:#14202d;' +
			'border:1px solid #314672;border-radius:16px;text-align:center;' +
			'box-shadow:0 24px 72px rgba(0,0,0,0.6);">' +
			'<h1 style="font-size:28px;font-weight:700;margin:0 0 14px;">Quit Brewser?</h1>' +
			'<p style="color:#9bb1d6;font-size:15px;margin:0 0 30px;line-height:1.5;">' +
			'Do you really want to exit Brewser?</p>' +
			'<div style="display:flex;gap:18px;justify-content:center;">' +
			'<button id="__swb_quit_no" autofocus style="min-width:200px;padding:14px 24px;' +
			'font-size:15px;font-weight:600;border-radius:10px;border:1px solid #2f4d80;' +
			'background:#1f3a64;color:#eaf2ff;cursor:pointer;">No, stay</button>' +
			'<button id="__swb_quit_yes" style="min-width:200px;padding:14px 24px;' +
			'font-size:15px;font-weight:600;border-radius:10px;border:1px solid #ef4444;' +
			'background:#dc2626;color:#eaf2ff;cursor:pointer;">Yes, quit</button>' +
			'</div>' +
			'<div style="margin-top:22px;font-size:12px;color:#6b7c9a;">' +
			'Press A on the highlighted button, or B to cancel.</div>' +
			'</div>';
		document.body.appendChild(dialog);
		const cleanup = () => {
			try { dialog.parentNode?.removeChild(dialog); } catch (_) { /* swallow */ }
		};
		dialog.addEventListener('close', cleanup);
		const yes = document.getElementById('__swb_quit_yes');
		if (yes) yes.addEventListener('click', () => {
			try {
				const s = (globalThis as { Switch?: { exit?: () => void } }).Switch;
				if (s && typeof s.exit === 'function') s.exit();
			} catch (_) { /* swallow */ }
		});
		const no = document.getElementById('__swb_quit_no');
		if (no) no.addEventListener('click', () => {
			try { dialog.close(); } catch (_) { /* swallow */ }
		});
		try { dialog.showModal(); } catch (_) { /* swallow */ }
		this.repaintAll();
	}

	private async promptAndNavigate(): Promise<void> {
		const current = this.navigation.currentURL ?? '';
		this.addressBar.setText(current);

		const typed = await this.keyboard.open(current, {
			onScroll: (delta) => this.handleScroll(delta),
		});
		if (typed === null) {
			// Cancel. If a touch already queued the next input (e.g. tap on a
			// content link or chrome button dismissed the keyboard), let the
			// main loop dispatch it — it will redraw on its own. Otherwise
			// just flag a repaint: the live-overlay cache is still valid (the
			// keyboard wrote directly to the screen canvas without mutating
			// the live DOM), so the next idle tick blits it back over the
			// keyboard pixels. Re-render the chrome strip too — with a bottom
			// toolbar it sits inside the keyboard panel area and was hidden.
			if (peekPendingInput()) return;
			requestFullRepaint();
			if (this.mode === 'normal') this.renderChrome();
			return;
		}

		this.addressBar.setText(typed);
		const resolved = this.addressBar.resolve();
		if (!resolved) {
			await this.navigateTo(current || DEFAULT_HOME_URL);
			return;
		}

		await this.navigateTo(resolved);
	}

	private handleScroll(delta: number): void {
		// User-input scroll sink: apply first, then track velocity for
		// the momentum coast only when the scroll actually moved (a
		// boundary-clamped no-op or mode-gated drop must NOT leave
		// velocity behind to re-emerge later). Multiple touchmove
		// events per tick stream through this — the IIR smoother
		// (alpha = 0.5) keeps the velocity from spiking on the last
		// micro-move before finger release while still tracking a real
		// flick within 2–3 samples.
		const applied = this.applyScrollDelta(delta);
		if (applied && this.momentumEnabled) {
			this.momentumVelocityPxPerTick =
				0.5 * this.momentumVelocityPxPerTick + 0.5 * delta;
		}
	}

	/**
	 * Apply a scroll delta to `currentScrollY` + repaint. Returns true
	 * iff the position actually changed (false = mode-gated or already
	 * at boundary). Callers: user input via `handleScroll`, and
	 * momentum-decay via `tickMomentum` (which bypasses velocity capture
	 * so the decayed step doesn't re-baseline velocity).
	 */
	private applyScrollDelta(delta: number): boolean {
		// Scrolling is meaningless in fullscreen-canvas (no layout flow)
		// and in video-fullscreen (the page underneath isn't visible —
		// scrolling its hidden position would surprise the user on exit).
		if (this.mode === 'fullscreen-canvas') return false;
		if (this.mode === 'video-fullscreen') return false;
		// 2026-06-17 file picker overlay: the picker is fullscreen
		// modal — scrolling the host page underneath while it's up
		// would visibly slide content behind the picker. The picker
		// owns its own internal scroll for `#fp-list` via the right-
		// stick / touch-swipe paths; the shell's d-pad / right-stick
		// shell-loop scroll routes (which call handleScroll → here)
		// would otherwise leak through because the shell-side input
		// loop keeps polling while the picker's open() promise is in
		// flight.
		if (isFilePickerOpen()) return false;
		// 2026-06-18 select modal — same shape as the file picker gate.
		// Modal owns its own internal scroll for `#sm-list`; shell-loop
		// scroll routes shouldn't leak through and slide the page behind it.
		if (isSelectModalOpen()) return false;
		// 2026-06-18 date + time pickers — same shape.
		if (isDatePickerOpen()) return false;
		if (isTimePickerOpen()) return false;
		// 2026-06-18 color picker — same shape.
		if (isColorPickerOpen()) return false;
		// 2026-06-18 number picker — same shape.
		if (isNumberPickerOpen()) return false;
		// 2026-07-27 `<browser-modal>` overlays (app-detail / download /
		// warnings) — same shape as the picker/dialog gates. While one is
		// open the page behind is inert; scrolling it would slide content
		// under the modal (the reported bug). The modal owns its own inner
		// scroll — the app detail's description scrolls via `element.scrollTop`
		// (touch-drag → `liveScrollSession`), which never routes through here.
		if (isAnyModalOpen()) return false;
		// 2026-06-15: while any `<dialog>.showModal()`-opened dialog is
		// visible (still has the `open` attribute), scrolling the host
		// page is a spec violation — the modal-blocking semantics make
		// the rest of the page inert. Drop the scroll silently.
		// `show()` (non-modal) dialogs aren't tagged → don't enter this
		// branch. Cheap check; iterates a usually-empty Set.
		for (const d of getModalModeDialogs()) {
			if (d.getAttribute('open') !== null) return false;
		}
		const next = Math.max(0, Math.min(this.maxScroll(), this.currentScrollY + delta));
		if (next === this.currentScrollY) return false;
		const t0 = performance.now();
		this.currentScrollY = next;
		// HTML keyboard is up: route through the clipped-to-above-topY
		// path so the engine doesn't repaint the kb panel slice this
		// tick (the kb cache stays warm, the scroll just moves content
		// above topY). The normal path would also work — `paintKeyboardOverlay`
		// re-blits the kb cache on top — but `behindKeyboard` saves the
		// content fillRect + paintLiveOverlay walk over the kb area.
		if (isKeyboardOpen()) {
			this.repaintContent({ behindKeyboard: true });
		} else {
			this.repaintContent();
		}
		// Record wall-clock + work-duration per scroll tick into a
		// ring buffer the benchmark page reads to surface real-world
		// scroll smoothness numbers.
		scrollStats.presentCallCount = this.cpuPresentCallCount;
		recordScrollSample(t0, performance.now() - t0, this.lastCpuPresentMs);
		return true;
	}

	/**
	 * Momentum decay step. Called from `onTick` when the user didn't
	 * scroll this iteration. Returns true iff there's still residual
	 * velocity worth ticking (caller uses the bool to keep the input
	 * loop on the active-poll cadence). Exponential per-tick decay
	 * (0.93 → ~480 ms to die at the active-poll rate). A boundary hit
	 * (`applyScrollDelta` returns false because we're already at scroll
	 * 0 or `maxScroll`) zeros velocity so we don't burn ticks pushing
	 * against the clamp.
	 */
	private tickMomentum(): boolean {
		if (!this.momentumEnabled) return false;
		if (this.momentumVelocityPxPerTick === 0) return false;
		const decayed = this.momentumVelocityPxPerTick * 0.93;
		if (Math.abs(decayed) < 0.5) {
			this.momentumVelocityPxPerTick = 0;
			return false;
		}
		this.momentumVelocityPxPerTick = decayed;
		const step = Math.round(decayed);
		// Sub-pixel velocity: keep decaying without spending a paint.
		if (step === 0) return true;
		if (!this.applyScrollDelta(step)) {
			this.momentumVelocityPxPerTick = 0;
			return false;
		}
		return true;
	}

	/**
	 * Where the *layout* reserves space at the top: chromeHeight when
	 * the toolbar is at the top of the screen (content has to start
	 * below chrome), 0 when the toolbar is at the bottom.
	 */
	private layoutTopInset(): number {
		return this.toolbarPosition === 'top' ? this.chromeHeight : 0;
	}

	/**
	 * Maximum allowed userScrollY for the current mode. In fullscreen
	 * modes the chrome's height becomes visible content area, so the
	 * user needs that much less scroll to reach the bottom. Content
	 * height comes from the live painter's body intrinsic-height cache.
	 */
	private maxScroll(): number {
		const canvas = nxScreen();
		const chromeHeight = this.chromeHeight;
		const visibleHeight = this.mode === 'normal' ? canvas.height - chromeHeight : canvas.height;
		const contentBottom = getLiveContentBottom();
		if (contentBottom <= 0) return 0;
		return Math.max(0, contentBottom - visibleHeight - this.paintScrollAdjust());
	}

	/** SD-card directory of a `brewser://` page, used as the base for
	 * page-relative `<img>` srcs (`./assets/x.png`), like a browser uses the
	 * document URL. Mirrors `BrowserResourceLoader.classifyUrl`'s HTML
	 * resolution so the base matches the file that actually loaded:
	 *   - explicit file (`.../index.html`) → its parent dir.
	 *   - directory form (`brewser://home/`) → the loader tries
	 *     `<path>.html` first (→ base is the PARENT, e.g. home.html lives
	 *     in `pages/`), then `<path>/index.html` (→ base is `<path>/`).
	 * Non-`brewser://` URLs return '' (no page base). */
	private computeLivePageBase(url: string): string {
		return computeLivePageBase(url, {
			appRoot: this.profile.appRoot,
			storageRoot: this.profile.storageRoot,
		});
	}

	private extractAppDirFromUrl(url: string): string | null {
		return extractAppDirFromUrl(url);
	}

	/** Pick the file picker's start directory based on the active page
	 * URL (per Q2: "the location of the app that initiates this picker").
	 *
	 *   - `brewser://apps/<group>/<id>/...` → `<appRoot>apps/<group>/<id>/`
	 *     i.e. the on-disk dir the app was loaded from.
	 *   - any other `brewser://...` page → `<storageRoot>` (the shell
	 *     pages' parent dir).
	 *   - external https://... → `<appRoot>` (sane sdmc-side default
	 *     since we have no on-disk equivalent for an external page). */
	private resolveFilePickerStartDir(): string {
		const url = this.session.currentPageUrl;
		const appDir = extractAppDirFromUrl(url);
		if (appDir) return `${this.profile.appRoot}${appDir}`;
		if (/^brewser:\/\//i.test(url)) return this.profile.storageRoot;
		return this.profile.appRoot;
	}

	private loadAppManifestButtonMapping(appDir: string): Record<string, unknown> | null {
		return loadAppManifestButtonMapping(appDir, this.profile.appRoot);
	}

	/**
	 * onHtmlResponse implementation. Resets the live root + cascade,
	 * populates it from the parsed tree, runs page scripts with
	 * `preserveLiveRoot:true` so `document.body` is already wired
	 * before any script runs, then attaches each per-canvas
	 * OffscreenCanvas to its corresponding LiveElement via the
	 * parsed→live map.
	 *
	 * Why the `resetLiveOverlayCache()` call: `resetLiveRoot()` resets
	 * `liveTreeVersion` to 0. If the new page's populate produces the
	 * same number of bumps as the prior page's last paint (e.g. two
	 * loads of the Settings page wrapping the same toolbars),
	 * `paintLiveOverlay`'s dirty check would say "cache valid" and skip
	 * the rebuild — but the cache's WeakMap is keyed by old (now-
	 * discarded) LiveElement instances, so the new tree has no layout
	 * boxes. `hitTestLive` would then return null for every tap. The
	 * explicit reset breaks the version coincidence.
	 */
	private async handleHtmlResponseLive(url: string, tree: HtmlElement): Promise<void> {
		_shellInputDiag('handleHtmlResponseLive url=' + url);
		// Drop the prior page's live tree + paint cache. Done BEFORE the
		// chrome rebuilds so their fresh `<style>` blocks re-register
		// against a cleared cascade. WebPageSession.reset is the runtime
		// extraction of the resetLiveOverlayCache+resetLiveRoot pair.
		this.session.reset();
		// Rebuild the HTML-driven keyboard + toolbar live roots so their
		// `<style>` blocks re-register with the now-cleared cascade. The
		// toolbar rebuild pre-warms its new `<img>` LiveElements with
		// the previous tree's already-loaded `Image` objects (keyed by
		// src) so the navigation transition doesn't flash 1-2 s of
		// broken icons while the new Image objects re-decode — see
		// `pendingToolbarImgPrewarm` for the mechanism.
		this.rebuildKeyboardLiveRoot();
		this.rebuildFilePickerLiveRoot();
		this.rebuildSelectModalLiveRoot();
		this.rebuildDatePickerLiveRoot();
		this.rebuildTimePickerLiveRoot();
		this.rebuildColorPickerLiveRoot();
		this.rebuildNumberPickerLiveRoot();
		this.rebuildToolbarLiveRoot();
		// App-context tracking: if this page is under `brewser://apps/<group>/<id>/...`,
		// pick up the app's `manifest.json buttonMapping` as a button-router
		// overlay (so e.g. `"exit": "B"` rebinds B from rightClick to the
		// app-exit action for the lifetime of this navigation). On any
		// non-app navigation, drop the overlay so the launcher / settings /
		// home pages get the unmodified shell mapping. Done BEFORE scripts
		// run so the very first gamepad poll inside the app sees the new
		// mapping.
		const appDir = this.extractAppDirFromUrl(url);
		this.currentAppDir = appDir;
		// Manifest-declared launch-fullscreen intent. Captured here so it
		// can override the CSS-viewport height passed to the session
		// BEFORE `populateAndRunScripts` (first-paint fullscreen, no re-
		// layout jank) AND drive the `setMode('fullscreen-app')` call
		// after populate. Reset on every navigation — non-app pages
		// (launcher / settings) always get `false`.
		let appLaunchFullscreen = false;
		if (appDir) {
			// D3 revoked guard — the one catalogue signal allowed to remove
			// local capability. Sits at THIS choke point (the html-response
			// handler) so every route into an app — card tap, direct URL,
			// history back/forward — hits it. The dir segment is the id
			// (flat layout, folder == id). On a hit: no overlay, deny-all
			// sandbox, and replace the page with the revoked notice.
			const dirAppId = appDir.split('/')[1] ?? '';
			if (dirAppId && isRevokedInCachedCatalogue(this.profile.appRoot, dirAppId)) {
				console.debug(`[brewser] blocked launch of revoked app ${dirAppId}`);
				clearAppButtonOverlay();
				this.policy.setManifestPermissions(null, [], `${this.profile.appRoot}${appDir}`);
				(globalThis as { __brewserRevokedAppId?: string }).__brewserRevokedAppId = dirAppId;
				void this.navigateTo('brewser://revoked/');
				return;
			}
			// Read the full manifest once per navigation and feed both the
			// button-router overlay AND the permission policy from the same
			// parsed object — one SD read, two consumers.
			const manifest = loadAppManifest(appDir, this.profile.appRoot);
			const bm = manifest?.buttonMapping;
			const buttonMapping = (bm && typeof bm === 'object' && !Array.isArray(bm))
				? { ...(bm as Record<string, unknown>) } : null;
			// Root-level `exitGame` is the new home for "which Switch button
			// quits this app" — declaring it at the top of the manifest keeps
			// the `buttonMapping` block focused on keyboard-key mappings.
			// Merged into the buttonMapping overlay as an `exit` action so the
			// existing action-router path (emitAction('exit') + ControllerInput
			// {kind:'exit'} → shell $.exit()) fires unchanged. Wins over any
			// legacy `exit` entry inside `buttonMapping` for apps mid-migration.
			const exitGame = manifest?.exitGame;
			if (typeof exitGame === 'string' && exitGame !== '') {
				const overlay = buttonMapping ?? {};
				overlay.exit = exitGame;
				setAppButtonOverlay(overlay);
			} else {
				setAppButtonOverlay(buttonMapping);
			}
			// Update the runtime's permission policy for the app that's
			// about to run. Sandbox root = the app's own on-disk dir; any
			// filesystem read/write inside it is always allowed. Reads/
			// writes outside require `filesystem_read` / `filesystem_write`
			// / `system` in the manifest. Storage APIs require `storage`,
			// network fetches require `network`, external anchor navs
			// require `external_links`.
			const appId = typeof manifest?.id === 'string' ? manifest.id : null;
			// D5 transition shim: platform manifests carry Title-Case
			// taxonomy term NAMES (`"Usb"`, `"Device Info"`); the policy
			// keys on slugs. Normalize through the platform client so
			// `Device Info` gates `device_info` instead of silently
			// matching nothing. Becomes a no-op (and is deleted) once
			// WordPress emits slugs.
			const manifestPerms = manifest?.permissions;
			const perms = Array.isArray(manifestPerms)
				? manifestPerms
					.filter((p): p is string => typeof p === 'string')
					.map(permissionSlug)
				: [];
			const sandboxRoot = `${this.profile.appRoot}${appDir}`;
			this.policy.setManifestPermissions(appId, perms, sandboxRoot);
			// Capture the manifest's launch-fullscreen intent. Only takes
			// effect when the toolbar is enabled globally — with
			// `showToolbar: false` in `config.json` there's no chrome to
			// hide, so the mode flip is a no-op (paint gates + CSS
			// viewport already match).
			appLaunchFullscreen = manifest?.fullscreen === true && this.chromeHeight > 0;
		} else {
			clearAppButtonOverlay();
			// Shell page (brewser://home/, brewser://settings/, ...): grant
			// all manifest-scoped gates. The global `network` toggle in
			// Settings still applies via `policy.networkEnabled`, but
			// no manifest declaration is required for shell code paths.
			this.policy.setManifestPermissions(null, null, null);
		}
		// Snapshot the toolbar avatar `src` for this navigation. MUST run
		// AFTER the `setManifestPermissions` swap above AND gated to shell
		// context (`currentAppId() === null` — grant-all). The two auth
		// reads (`active.json` + `<provider>-auth.json`) target shell-
		// owned paths outside every app sandbox, so they only resolve
		// under grant-all; running them under a restrictive app policy
		// would deny and cache the placeholder. Placement + guard together
		// guarantee the refresh executes only when the freshly-installed
		// policy is shell context: covers every shell→shell / app→shell
		// / boot→shell transition (login/logout is picked up here) and
		// correctly skips every shell→app / app→app transition (the
		// cached value from the last shell landing carries through the
		// app run so the toolbar keeps painting the real avatar under
		// the restrictive app policy).
		if (this.policy.currentAppId() === null) {
			this.refreshCachedToolbarAvatarSrc();
		}
		// A queued fullscreen request from any prior page should never
		// leak across navigations — the new page's scripts will queue
		// their own if they want it. Done BEFORE the session runs scripts
		// because `__swbRequestFullscreenCanvas`'s queue-and-defer branch
		// writes this field during script eval; the reset must precede
		// the writes the new page's scripts may produce.
		this.pendingFullscreenCanvasRequest = null;
		// Keep the session in sync with the shell's chrome height so its
		// internal `setCssViewport` resolves `vh`/`vw` against the visible
		// content rect, not the full screen. Fullscreen-manifest apps
		// override this to 0 so `100vh` resolves to the full screen
		// height on first paint — otherwise the initial layout would use
		// the chrome-trimmed height (720−56) and the mode flip below
		// would trigger a full re-layout to widen it.
		this.session.setChromeHeight(appLaunchFullscreen ? 0 : this.chromeHeight);
		// Hand off the page-lifecycle core: setLivePageBase, install fetch
		// + Worker wrappers, setCssViewport, populateLiveRoot,
		// scanForAutoplayVideos, external stylesheet fetches, runPageScripts,
		// canvas-offscreen wiring, currentPageUrl stamp. Returns the
		// parsed→live map for any shell-specific post-processing (none
		// today — Cocos / GameMaker / etc. attach their offscreens via the
		// session, not a shell hook).
		const allowExt = url.startsWith('http://') || url.startsWith('https://') || url.startsWith('brewser://');
		const result = await this.session.populateAndRunScripts(url, tree, {
			allowScripts: url.startsWith('brewser://'),
			pageBase: this.computeLivePageBase(url),
			loadExternalStylesheets: allowExt,
		});
		_shellInputDiag('  → populated ' + result.byParsed.size + ' parsed→live mappings');

		this.fullscreenCanvasOriginalSize = null;
		this.fullscreenCanvasLive = false;
		this.currentScrollY = 0;
		this.momentumVelocityPxPerTick = 0;

		// Manifest-declared launch fullscreen: enter `fullscreen-app`
		// mode BEFORE the pending-fullscreen drain below so a page that
		// also calls `canvas.requestFullscreen()` synchronously at load
		// upgrades cleanly from fullscreen-app → fullscreen-canvas. The
		// CSS viewport was already set to the full screen height inside
		// `populateAndRunScripts` (we passed `chromeHeight = 0` above),
		// so no viewport update is needed here — the mode flip only
		// suppresses chrome paint + adjusts the paint-inset gates. Held
		// to `mode === 'normal'` so we don't clobber `fullscreen-canvas`
		// left over from a stale in-flight page-scripted transition
		// (defensive — the `onNavigate` delegate resets to `'normal'`
		// at nav start).
		if (appLaunchFullscreen && this.mode === 'normal') {
			this.setMode('fullscreen-app');
		}

		// Drain a fullscreen request queued by a top-level script body
		// (e.g. apps/com.natureglass.webgl1demo/index.html that calls
		// `canvas.requestFullscreen()` synchronously at load). Done after
		// scriptCtx is wired up AND the per-nav fullscreen-canvas state
		// fields above are reset to their defaults — otherwise those
		// resets would clobber the mode/state that toggleFullscreenCanvas
		// just established.
		// Cast: TS narrows the field to `null` from the per-nav reset
		// earlier in this method and cannot see that populateAndRunScripts
		// (between the reset and here) may have queued a request.
		const pendingFullscreen = this.pendingFullscreenCanvasRequest as (() => void) | null;
		this.pendingFullscreenCanvasRequest = null;
		if (pendingFullscreen) pendingFullscreen();

		// Page padding is the page's responsibility — the engine no longer
		// injects toolbar-defined body insets. The previous behaviour
		// (applying `toolbar.page.topPadding` / `sidePadding` when the
		// page hadn't set explicit padding) silently overrode page CSS
		// that used the `padding:` shorthand, because the check inspected
		// only the long-hand inline `style.paddingLeft` etc. The
		// `topPadding` / `sidePadding` fields remain in the toolbar
		// schema for back-compat but are unused; pages are expected to
		// set their own `<body>` padding.

		this.repaintAll();
	}

	/** Toggle the `open` attribute on a `<details>` parent of the
	 * tapped `<summary>` LiveElement. The mutation bumps
	 * `liveTreeVersion` (via toggleAttribute → invalidateLiveStyle), so
	 * the next `paintLiveOverlay` rebuilds the cache automatically. */
	private toggleLiveSummary(summary: LiveElement): void {
		const details = summary.parent;
		if (!details || details.tagName !== 'DETAILS') return;
		const wasOpen = details.hasAttribute('open');
		details.toggleAttribute('open', !wasOpen);
		requestFullRepaint();
	}

	/**
	 * Painter-side scroll offset on top of `currentScrollY`.
	 *
	 * Historical: the comment used to claim this shifts the body cache
	 * up to fill the chrome area in fullscreen-page mode, on the
	 * assumption the layout had baked-in `topInset = layoutTopInset()`.
	 * That's never been true in the current runtime — `paintLiveOverlay`
	 * calls `layoutFixedRoot(root, 0, 0, viewport.width, viewport.height)`
	 * (live-overlay.ts:1026) with body anchored at (0, 0). In normal
	 * mode the paint viewport's `y = chromeHeight` already places body
	 * below the chrome strip on screen; in fullscreen-page mode the
	 * paint viewport's `y = 0` places body at the top of the screen,
	 * naturally filling the reclaimed strip. The 56 px adjust the old
	 * code added on top of that produced a net −56 px shift that
	 * clipped the top of the page. Returning 0 leaves the cache blit
	 * aligned with the body's layout origin in all modes.
	 */
	private paintScrollAdjust(): number {
		return 0;
	}

	/**
	 * Colour to fill the content viewport with before the live-DOM body
	 * paints over it. For `theme: light` (the web's expected default)
	 * we use white so external pages without an explicit `<body>`
	 * background look like they do in every other browser. For
	 * `theme: dark` we fall back to the toolbar's `page.background`
	 * so the user's dark-themed chrome and content stay visually
	 * continuous. The body's own background, when set, always paints
	 * on top — so internal pages that explicitly set their own bg
	 * (welcome, settings, …) are unaffected either way.
	 */
	private effectivePageBackground(): string {
		if (this.colorScheme === 'light') return '#ffffff';
		return this.pageBackground;
	}

	/**
	 * Live-DOM content render. The whole content area goes through
	 * `paintLiveOverlay` which owns a chunked OffscreenCanvas cache:
	 *   - Initial / post-mutation paint: chunked build, ~12 ms per
	 *     chunk, yields via `requestFullRepaint` between chunks so
	 *     scroll input + animation frames keep firing.
	 *   - Scroll tick (no mutation): single `drawImage` of the cached
	 *     OffscreenCanvas, ~1-3 ms.
	 *
	 * After the cache blit we walk the live tree for animated
	 * `<canvas>` elements (`overlayLiveAnimatedCanvases`) and either
	 * `drawImage` the script's offscreen (2D-backed) or
	 * `copyBridgeToScreen` the shared screen GL bridge FBO
	 * (WebGL-backed).
	 *
	 * The per-frame `fillRect` of the page background is now gated on
	 * `liveCacheCoversViewportOpaque(viewport.height)` — it only runs
	 * when the cache can't guarantee opaque coverage on its own
	 * (chunked build still in progress, body has no own bg color, or
	 * the cache is shorter than the viewport). For the steady state of
	 * any opaque-body page that fully fits its cache, this skips
	 * entirely. Reclaims the ~10 ms/frame previously attributed to the
	 * ~21 FPS gap on inline-WebGL pages (Three.js cube demo, sensors
	 * dashboard). The cache's own one-time bg fill at build start
	 * covers the "no transparent edges" property that this backstop
	 * was originally defending.
	 */
	private repaintContent(opts: { videoOnlyFast?: boolean; behindKeyboard?: boolean } = {}): void {
		// Old canvas-keyboard era: this returned early on
		// `isKeyboardOpen()` because the keyboard owned the screen and
		// any host repaint would clobber its pixels. The HTML keyboard
		// (`paintHtmlKeyboardIfVisible` at the tail of `repaintContentInner`)
		// paints AFTER the host page each frame, so the host stays
		// animated underneath instead — no gate needed. `behindKeyboard`
		// still routes to the clipped-to-above-topY path below since
		// `handleScroll` uses it to skip repainting the kb panel slice
		// during a page-scroll-under-keyboard gesture.
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		this.repaintContentInner(ctx, canvas, opts);
		// V8 migration: the QuickJS-era native cursor compositor
		// (`composite_cursor_overlay` in nxjs-source/source/main.c) was
		// dropped (NXJS_PATCHES_NEEDED.md #4), so the cursor has no
		// engine-side draw path. Paint it Skia-side here as the LAST
		// step of every screen-paint exit, so the cursor overlays the
		// page content + toolbar chrome + every modal/picker/keyboard
		// overlay. The next `repaintContent` tick restores the area
		// under the prior cursor position from the live-cache blit,
		// preventing cursor trails. `paintCursorOverlay` honors
		// `cursor.visible` and early-returns if the native binding ever
		// ships (so #4 re-port would resume the fast path without
		// rewiring here).
		paintCursorOverlay(ctx, canvas);
	}

	private repaintContentInner(
		ctx: CanvasRenderingContext2D,
		canvas: ReturnType<typeof nxScreen>,
		opts: { videoOnlyFast?: boolean; behindKeyboard?: boolean },
	): void {
		if (opts.behindKeyboard) {
			this.repaintBehindKeyboard(ctx, canvas.width, canvas.height);
			return;
		}
		if (this.mode === 'fullscreen-canvas') {
			this.repaintFullscreenCanvas(ctx, canvas.width, canvas.height);
			return;
		}
		if (this.mode === 'video-fullscreen' && this.fullscreenVideo) {
			// Wipe behind the video first so the previous page's pixels
			// don't show through letterbox bars when the source aspect
			// doesn't match the canvas.
			ctx.fillStyle = '#000000';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			paintVideoFrameAt(
				ctx, this.fullscreenVideo,
				0, 0, canvas.width, canvas.height,
			);
			// Controls bar pinned to the bottom of the canvas so the
			// user can play/pause/stop without leaving fullscreen. The
			// `controls` attribute on the source element gates it (same
			// rule as inline rendering).
			paintVideoControls(
				ctx, this.fullscreenVideo,
				0, 0, canvas.width, canvas.height,
			);
			return;
		}
		const chromeHeight = this.chromeHeight;
		const isBottomToolbar = this.toolbarPosition === 'bottom';
		const paintTopInset = this.mode === 'normal' && !isBottomToolbar ? chromeHeight : 0;
		const paintBottomInset = this.mode === 'normal' && isBottomToolbar ? chromeHeight : 0;
		const effectiveScrollY = this.currentScrollY + this.paintScrollAdjust();
		// Viewport spans the full content area edge-to-edge. Body content
		// insets are applied via padding on the live root element itself
		// (see `handleHtmlResponseLive`) so the body's bg color extends
		// to the screen edges while text/tables still inset from them.
		const viewport = {
			x: 0,
			y: paintTopInset,
			width: canvas.width,
			height: canvas.height - paintTopInset - paintBottomInset,
		};
		// Slice-2a perf (2026-05-26 evening): when only the video frame
		// needs to change — no animation tick this turn, no scroll
		// delta, cache fully built — skip the per-tick page-bg fillRect
		// + cache `drawImage(1280×664)` blit and just paint the video
		// bitmap over the existing screen pixels. The persistent screen
		// canvas's pixels from the last slow-path tick stay valid
		// underneath, so a small `drawImage(bitmap, x, y)` is all the
		// new work that's needed. Saves ~10 ms per video-only tick. Bail
		// to slow path if scroll shifted (cache offset stale) or the
		// cache isn't fully built (would starve the chunked builder).
		const canFastPath = opts.videoOnlyFast
			&& effectiveScrollY === this.lastRepaintedScrollY
			&& isLiveCacheReady()
			// Same modal-visible bail as the canvas fast path below — see
			// the comment block on `canCanvasFastPath`. A `<select>` open
			// over a video page (small but possible: a settings overlay
			// during playback) would render behind the video frame without
			// this gate.
			&& !isKeyboardOverlayVisible()
			&& !isFilePickerOverlayVisible()
			&& !isSelectModalOverlayVisible()
			&& !isDatePickerOverlayVisible()
			&& !isTimePickerOverlayVisible()
			&& !isColorPickerOverlayVisible()
			&& !isNumberPickerOverlayVisible();
		if (canFastPath) {
			const t0 = performance.now();
			overlayLiveAnimatedCanvases(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
				copyBridgeToScreen,
			);
			// Post-canvas overlay pass — see the canvas-only fast path
			// and slow path below for the full rationale. Any DOM
			// element after a canvas in DOM order (game overlay etc.)
			// gets repainted here so it stays visible over the
			// canvas-composite stomp. Cheap on pages with no such
			// sibling pattern.
			paintLiveAboveCanvasOverlay(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
			);
			this.lastCpuPresentMs = performance.now() - t0;
			this.cpuPresentCallCount++;
			return;
		}
		// Canvas-only fast path: the page is doing rAF / 2D-canvas activity
		// but nothing in the live tree changed since the last full paint —
		// no DOM mutation, no scroll, no viewport change. The persistent
		// screen-canvas pixels from the previous slow-path frame are
		// byte-identical to what a full paint would produce, except inside
		// the animated-canvas regions. Skip paintLiveOverlay (the cache
		// `drawImage(viewport.width × height)` blit at its tail measured
		// ~7-8 ms/frame on the sensors dashboard via [brewser:paint-timing])
		// and just call the canvas overlay walk, which writes fresh pixels
		// into each animated canvas's region on top of the prior frame.
		// Same shape as videoOnlyFast above but auto-detected: the next
		// page mutation (tap → :active, text update, image load, anything
		// that bumps liveTreeVersion) trips the version guard and the
		// slow path repaints everything. Pages with fixed-element overlays
		// that animate independently (e.g. lil-gui FPS counter) bump the
		// version every frame on their own, so the guard fails naturally
		// and the fast path bypasses without a special case.
		// `fullscreen-canvas` and `video-fullscreen` early-return at the
		// top of repaintContentInner, so by the time we reach this gate
		// mode is always `normal`, `fullscreen-page`, or `fullscreen-
		// app`. All three share the same paintLiveOverlay + cache-blit
		// path — the fast path is equally safe for any of them.
		const canCanvasFastPath = (this.mode === 'normal' || this.mode === 'fullscreen-page' || this.mode === 'fullscreen-app')
			&& !opts.videoOnlyFast
			&& (pageHasAnimationActivity() || hasPageCanvas2dActivity())
			&& effectiveScrollY === this.lastRepaintedScrollY
			&& viewport.width === this.lastRepaintedViewportW
			&& viewport.height === this.lastRepaintedViewportH
			&& getLiveTreeVersion() === this.lastRepaintedLiveVersion
			&& isLiveCacheReady()
			// (Was a `!isCursorVisible()` clause here gating against the
			// runtime cursor's trail bug — see git history. Removed now
			// that the engine cursor compositor ships via
			// NXJS_PATCHES_NEEDED.md #4 re-port: cursor pixels live on
			// the EGL back-buffer SkSurface only, not on `s_canvas`, so
			// the fast path skipping `paintLiveOverlay`'s cache blit
			// has no cursor-trail risk to defend against. Removing the
			// gate restores the ~5-7 ms/frame the slow-path force was
			// costing on rAF/canvas-activity pages — Three.js demos
			// stay at 60 fps during cursor-active windows again.)
			// 2026-06-20 speedtest fps fix: ALLOW the fast path even when
			// the page has scroll overlays (`overflow: auto/scroll`). The
			// fast path now calls `paintScrollOverlaysToScreen` with the
			// `blitCacheUnder: true` option just below — that's the
			// translucent-background-compound-alpha fix that closed the
			// spectraplay playlist regression. Refusing the fast path
			// outright was a workaround from before `blitCacheUnder`
			// existed; the per-overlay cache-slice blit + offscreen
			// drawImage costs ~1 ms per scroll container vs the slow
			// path's ~7 ms full-viewport cache blit, so the fast path
			// still wins handily on speedtest (`.log { overflow: auto }`
			// makes it a scroll-overlay page).
			// Bail when any system-modal overlay is up — the slow path is
			// the only place that paints the kb / select modal / file
			// picker / date+time+color+number pickers (lines 1972-1989
			// below), so on a page with an animating inline canvas (the
			// speedtest dial, a Three.js demo) the fast path would skip
			// the modal paint and the canvas would render OVER the modal.
			// `paintModalOverlay` (custom `<browser-modal>` roots) is also
			// only painted by the slow path; gated too for symmetry. */
			&& !isKeyboardOverlayVisible()
			&& !isFilePickerOverlayVisible()
			&& !isSelectModalOverlayVisible()
			&& !isDatePickerOverlayVisible()
			&& !isTimePickerOverlayVisible()
			&& !isColorPickerOverlayVisible()
			&& !isNumberPickerOverlayVisible();
		if (canCanvasFastPath) {
			const t0 = performance.now();
			// Push any cache-region patches that landed since the last
			// paint (image completions via `patchLiveImagePixelsOnly` —
			// album art on spectraplay's library, app icons on home, etc.)
			// from cache to screen. The slow path's full cache blit handles
			// this implicitly; the fast path skips that blit, so without
			// this drain the cache holds the new pixels but the screen
			// stays on the placeholder pixels until the next full repaint
			// (visible as "images appear only on exit modal").
			flushPendingScreenBlitsToScreen(ctx, viewport, effectiveScrollY);
			// 2026-06-20 fast-path scroll-overlay support: scrollable
			// containers were previously a hard-bail for the fast path;
			// now we re-blit them per frame with `blitCacheUnder: true`
			// so any translucent-background scrolling list keeps the
			// cache underneath fresh (the spectraplay-playlist regression
			// fix). Per-overlay cost is one cache-slice drawImage + the
			// container's offscreen drawImage (~1 ms each for typical
			// list sizes). No-op when the page has no scroll overlays. */
			paintScrollOverlaysToScreen(
				ctx, viewport, effectiveScrollY,
				{ blitCacheUnder: true },
			);
			// `blitCacheUnder` is the load-bearing correctness piece for
			// transparent inline canvases (spectraplay's audio visualizer
			// uses `getContext('webgl2', { alpha: true })` + clearColor with
			// vizBgAlpha=0). The bridge composite at [webgl_egl.c:4196]
			// preserves dst pixels for alpha=0 source — without the cache
			// underneath, "dst" is the previous frame's leftover canvas
			// pixels (ghost trails). One small drawImage per canvas region
			// (~38K-115K pixels for typical pages) vs the 921K-pixel full
			// cache blit that the slow path does.
			overlayLiveAnimatedCanvases(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
				copyBridgeToScreen,
				{ blitCacheUnder: true },
			);
			// Post-canvas overlay pass — same rationale as the slow-path
			// call below. The canvas fast path stomps the canvas region
			// with fresh bridge pixels every frame, so any DOM overlay
			// that came AFTER the canvas in DOM order (e.g. Three.js
			// Serpent's `#overlay` for start / dead / finished screens)
			// would flash for one frame (the slow-path repaint after a
			// tree version bump) and then vanish on subsequent fast-path
			// frames. Running the post-canvas pass here keeps the overlay
			// painted on top for every frame. Cheap on canvas-less pages
			// or canvases with no post-canvas siblings.
			paintLiveAboveCanvasOverlay(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
			);
			this.lastCpuPresentMs = performance.now() - t0;
			this.cpuPresentCallCount++;
			return;
		}
		// Per-frame full-viewport backstop. Used to run unconditionally
		// (~10 ms/frame on Citron — the dominant cost on inline-WebGL
		// pages, e.g. the sensors dashboard parked at 38/60 fps; the
		// Three.js cube demo at 39/60 fps). Now gated on the cache being
		// unable to cover the viewport opaquely on its own: when the cache
		// exists, its chunked build is complete, it was filled with body's
		// bg at build start, and it's at least as tall as the viewport,
		// the cache blit below overwrites every painted pixel and this
		// fillRect is redundant. The cache's own bg fill happens once per
		// rebuild at the build site in live-overlay.ts, so the per-frame
		// cost moves from "always 10 ms" to "0 ms in the steady state of
		// any opaque-body page that fully fits its cache."
		if (!liveCacheCoversViewportOpaque(viewport.height)) {
			ctx.fillStyle = this.effectivePageBackground();
			ctx.fillRect(
				0, paintTopInset,
				canvas.width, canvas.height - paintTopInset - paintBottomInset,
			);
		}
		// Per-style wallpaper sits between the page-bg colour fill and
		// the live-DOM cache blit, so the image covers the colour fill
		// and a page with a translucent `body` background lets the
		// image show through (themes opt in by setting `body { background:
		// transparent }`). No-op when the active style has no image.
		this.paintStyleBackground(ctx, viewport);
		const t0 = performance.now();
		paintLiveOverlay(ctx, getLiveRoot(), viewport, effectiveScrollY);
		// Skip the walk on otherwise-static pages. `hasPageCanvas2dActivity`
		// catches setTimeout-driven 2D canvas games (demo-breakout)
		// that don't use rAF — without it the cached-layout fast path
		// freezes the canvas at its first paint.
		if (
			pageHasAnimationActivity()
			|| pageHasActiveVideo()
			|| pageHasAnyPoster()
			|| hasPageCanvas2dActivity()
		) {
			// 2026-06-20: the slow path's `paintLiveOverlay` cache blit
			// just overwrote the canvas region with stale cache pixels
			// (the cache holds the post-script `readbackWebGLEntries`
			// snapshot, taken before any rAF rendered the dial). Force
			// the bridge readback below so the live FBO contents repaint
			// the canvas region on top — without this, every slow-path
			// repaint (modal open/close, dirty mutation, version bump)
			// would erase the dial. The fast path retains its own idle
			// skip via the same flag; we only force it true ahead of
			// the slow path's cache-blit-stomp. */
			forceBridgeReadbackNextPaint();
			overlayLiveAnimatedCanvases(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
				copyBridgeToScreen,
			);
			// Post-canvas overlay pass. Repaints DOM elements that in
			// DOM order come after a canvas at the same parent, so
			// HUD/start-screen overlays inside a canvas container (e.g.
			// `<main id="main"><canvas id="gl"><div id="overlay">…`)
			// render ABOVE the just-composited canvas — matching the
			// standard CSS "later sibling paints on top" stacking rule.
			// Cheap on canvas-less pages: the walker just recurses to
			// hit no-canvas leaves and returns.
			paintLiveAboveCanvasOverlay(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
			);
		}
		// External stylesheets fetched mid-flight: cover the broken pre-CSS
		// layout with a translucent "Loading styles…" overlay until the
		// last sheet registers (then `isExternalCssLoading()` flips false).
		// DDG html-mode is the headline case — without this the page
		// flashes its zero-height-logo layout for ~10s before snapping
		// into the cascade-applied design.
		if (isExternalCssLoading()) {
			this.paintCssLoadingOverlay(ctx, viewport);
		}
		// HTML-driven modal layer — painted ON TOP of the host page
		// content (cache blit + canvas overlay + CSS-loading overlay)
		// but BELOW the chrome toolbar so a modal's `position: fixed`
		// fill doesn't bleed into the chrome strip. Each
		// `<browser-modal>` root has its own offscreen cache + version
		// counter (see `paintModalOverlay` and the modal-layer block
		// in live-paint-control.ts). Cheap on pages without modals:
		// `paintModalOverlay` early-returns when the modal-roots
		// registry is empty.
		paintModalOverlay(ctx, viewport);
		// HTML-driven chrome toolbar — painted in the strip slice the
		// engine reserved at layout time (`paintTopInset` / `paintBottomInset`).
		// Sits ABOVE the host page paint so a page bg fillRect on the
		// strip area can't bleed into the chrome. The kb (below) sits
		// on top of EVERYTHING since it's a modal panel.
		this.paintHtmlToolbarIfVisible(ctx, canvas.width, canvas.height);
		// HTML-driven virtual keyboard — painted ON TOP of the host page's
		// content (and the CSS-loading overlay above) so it stays modal.
		// `KEYBOARD_LAYOUT.topY` is the contract the existing canvas
		// keyboard already advertised: pages keep the area above it, and
		// the panel owns the area below. See `paintKeyboardOverlay` JSDoc
		// for cache + vh/vw scoping notes.
		this.paintHtmlKeyboardIfVisible(ctx, canvas.width, canvas.height);
		// HTML-driven file picker — painted ON TOP of everything (host
		// page, modal layer, toolbar, kb) because it's a fullscreen
		// system modal. While it's up the kb shouldn't be (the picker's
		// poll loop owns the gamepad), but the paint order would be
		// well-defined either way.
		this.paintHtmlFilePickerIfVisible(ctx, canvas.width, canvas.height);
		// HTML-driven select modal — same paint slot semantics as the
		// file picker. Mutually exclusive with the picker at the input-
		// router level, but the paint order is well-defined either way.
		this.paintHtmlSelectModalIfVisible(ctx, canvas.width, canvas.height);
		// 2026-06-18 date + time pickers — same paint slot semantics.
		this.paintHtmlDatePickerIfVisible(ctx, canvas.width, canvas.height);
		this.paintHtmlTimePickerIfVisible(ctx, canvas.width, canvas.height);
		// 2026-06-18 color picker — same paint slot semantics.
		this.paintHtmlColorPickerIfVisible(ctx, canvas.width, canvas.height);
		// 2026-06-18 number picker — same paint slot semantics.
		this.paintHtmlNumberPickerIfVisible(ctx, canvas.width, canvas.height);
		setLiveViewport(viewport, effectiveScrollY);
		this.lastCpuPresentMs = performance.now() - t0;
		this.cpuPresentCallCount++;
		this.lastRepaintedScrollY = effectiveScrollY;
		this.lastRepaintedLiveVersion = getLiveTreeVersion();
		this.lastRepaintedViewportW = viewport.width;
		this.lastRepaintedViewportH = viewport.height;
	}

	/** Paint the HTML keyboard root below `KEYBOARD_LAYOUT.topY` when
	 * `isKeyboardOverlayVisible()` is true and the root is populated.
	 * Defensively no-op if either is false so callers don't need to
	 * branch. */
	private paintHtmlKeyboardIfVisible(
		ctx: CanvasRenderingContext2D,
		canvasW: number,
		canvasH: number,
	): void {
		if (!isKeyboardOverlayVisible()) return;
		const kbRoot = getKeyboardLiveRoot();
		if (!kbRoot) return;
		const topY = getKeyboardTopY();
		paintKeyboardOverlay(ctx, kbRoot, {
			x: 0,
			y: topY,
			width: canvasW,
			height: Math.max(0, canvasH - topY),
		});
	}

	/** Paint the HTML file picker root fullscreen when
	 * `isFilePickerOverlayVisible()` is true and the root is populated.
	 * Defensively no-op if either is false. Mirrors
	 * {@link paintHtmlKeyboardIfVisible} but uses the full canvas
	 * viewport since the picker is a system-modal overlay. */
	private paintHtmlFilePickerIfVisible(
		ctx: CanvasRenderingContext2D,
		canvasW: number,
		canvasH: number,
	): void {
		if (!isFilePickerOverlayVisible()) return;
		const root = getFilePickerLiveRoot();
		if (!root) return;
		paintFilePickerOverlay(ctx, root, {
			x: 0,
			y: 0,
			width: canvasW,
			height: canvasH,
		});
	}

	/** Paint the HTML select modal root fullscreen when
	 * `isSelectModalOverlayVisible()` is true and the root is populated.
	 * Mirrors {@link paintHtmlFilePickerIfVisible}. */
	private paintHtmlSelectModalIfVisible(
		ctx: CanvasRenderingContext2D,
		canvasW: number,
		canvasH: number,
	): void {
		if (!isSelectModalOverlayVisible()) return;
		const root = getSelectModalLiveRoot();
		if (!root) return;
		paintSelectModalOverlay(ctx, root, {
			x: 0,
			y: 0,
			width: canvasW,
			height: canvasH,
		});
	}

	/** Paint the HTML date picker root fullscreen when
	 * `isDatePickerOverlayVisible()` is true and the root is populated.
	 * Mirrors {@link paintHtmlSelectModalIfVisible}. */
	private paintHtmlDatePickerIfVisible(
		ctx: CanvasRenderingContext2D,
		canvasW: number,
		canvasH: number,
	): void {
		if (!isDatePickerOverlayVisible()) return;
		const root = getDatePickerLiveRoot();
		if (!root) return;
		paintDatePickerOverlay(ctx, root, {
			x: 0,
			y: 0,
			width: canvasW,
			height: canvasH,
		});
	}

	/** Paint the HTML time picker root fullscreen when
	 * `isTimePickerOverlayVisible()` is true and the root is populated. */
	private paintHtmlTimePickerIfVisible(
		ctx: CanvasRenderingContext2D,
		canvasW: number,
		canvasH: number,
	): void {
		if (!isTimePickerOverlayVisible()) return;
		const root = getTimePickerLiveRoot();
		if (!root) return;
		paintTimePickerOverlay(ctx, root, {
			x: 0,
			y: 0,
			width: canvasW,
			height: canvasH,
		});
	}

	/** Paint the HTML color picker root fullscreen when
	 * `isColorPickerOverlayVisible()` is true and the root is populated. */
	private paintHtmlColorPickerIfVisible(
		ctx: CanvasRenderingContext2D,
		canvasW: number,
		canvasH: number,
	): void {
		if (!isColorPickerOverlayVisible()) return;
		const root = getColorPickerLiveRoot();
		if (!root) return;
		paintColorPickerOverlay(ctx, root, {
			x: 0,
			y: 0,
			width: canvasW,
			height: canvasH,
		});
	}

	/** Paint the HTML number picker root fullscreen when
	 * `isNumberPickerOverlayVisible()` is true and the root is populated. */
	private paintHtmlNumberPickerIfVisible(
		ctx: CanvasRenderingContext2D,
		canvasW: number,
		canvasH: number,
	): void {
		if (!isNumberPickerOverlayVisible()) return;
		const root = getNumberPickerLiveRoot();
		if (!root) return;
		paintNumberPickerOverlay(ctx, root, {
			x: 0,
			y: 0,
			width: canvasW,
			height: canvasH,
		});
	}

	/** Paint the HTML toolbar root into the chrome strip slice when
	 * `isToolbarOverlayVisible()` is true and the root is populated.
	 * Only fires in `normal` mode — fullscreen-canvas/-page/-video
	 * hide the chrome strip entirely and call this from their own
	 * specialised paint paths if (and only if) they want it. */
	private paintHtmlToolbarIfVisible(
		ctx: CanvasRenderingContext2D,
		canvasW: number,
		canvasH: number,
	): void {
		if (this.mode !== 'normal') return;
		// Nothing to paint when the strip is collapsed. Load-bearing: the
		// overlay's size clamp (`Math.max(1, floor(height))` in
		// paintToolbarOverlay) would otherwise render a chromeHeight-0 request
		// as a stray 1px slice — visible at the top (y=0) and clipped off the
		// bottom edge (y=canvasH). Also covers the transient
		// `__brewserSetChromeVisible(false)` hide and any future 0-height caller.
		if (this.chromeHeight <= 0) return;
		if (!isToolbarOverlayVisible()) return;
		const tbRoot = getToolbarLiveRoot();
		if (!tbRoot) return;
		const y = this.toolbarPosition === 'top' ? 0 : canvasH - this.chromeHeight;
		paintToolbarOverlay(ctx, tbRoot, {
			x: 0,
			y,
			width: canvasW,
			height: this.chromeHeight,
		});
	}

	/** Opaque black overlay + centred rotating-arc spinner painted
	 * over the page content area while external <link rel=stylesheet>s
	 * are still fetching. Caller already drew the page underneath;
	 * this fully masks it so the user never sees the pre-cascade
	 * flash. Spinner is CSS-painted each frame from a wallclock phase
	 * — even at this engine's ~1 Hz paint cadence during CSS-parse
	 * work, an arc-sweep visibly moves around the circle (which a
	 * stepped GIF frame change does not — frames look static when
	 * paint lands on the same index twice). */
	private paintCssLoadingOverlay(
		ctx: CanvasRenderingContext2D,
		viewport: { x: number; y: number; width: number; height: number },
	): void {
		const now = performance.now();
		this.cssLoadingOverlayLastPaintMs = now;
		this.ensureCssLoadingOverlayPaintPump();
		ctx.save();
		ctx.fillStyle = '#000';
		ctx.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
		const cx = viewport.x + viewport.width / 2;
		const cy = viewport.y + viewport.height / 2;
		const radius = 44;
		const lineWidth = 7;
		// One full rotation per 1.5 s — slow enough that even on a
		// ~1 Hz paint cadence (Citron during CSS parse) the visible
		// jump between paints is < 240° rather than a multi-cycle
		// wrap that looks random.
		const cycleMs = 1500;
		const phase = ((now % cycleMs) / cycleMs) * Math.PI * 2;
		// Background ring — full circle in a faint blue so the spinner
		// always reads as "loading" even before the active arc renders.
		ctx.beginPath();
		ctx.arc(cx, cy, radius, 0, Math.PI * 2);
		ctx.lineWidth = lineWidth;
		ctx.strokeStyle = 'rgba(122, 162, 255, 0.20)';
		ctx.stroke();
		// Active arc — 270° of the brighter blue accent, rotating
		// around the ring. lineCap='round' gives the leading edge a
		// soft head that reads as motion.
		ctx.beginPath();
		ctx.arc(cx, cy, radius, phase, phase + Math.PI * 1.5);
		ctx.lineWidth = lineWidth;
		ctx.lineCap = 'round';
		ctx.strokeStyle = '#7aa2ff';
		ctx.stroke();
		ctx.restore();
	}

	/** Chained-setTimeout that periodically prods `requestFullRepaint`
	 * (plus an empty `requestAnimationFrame`) so the shell paint loop
	 * keeps ticking while the loading overlay is shown. Self-cancels
	 * after 3 s without an overlay paint (loading flag flipped off →
	 * no need to keep the loop hot). */
	private ensureCssLoadingOverlayPaintPump(): void {
		if (this.cssLoadingOverlayPumpTid !== null) return;
		const pump = (): void => {
			this.cssLoadingOverlayPumpTid = null;
			if (performance.now() - this.cssLoadingOverlayLastPaintMs > 3000) return;
			// Engine-internal paint tick. Routes the same way as
			// `globalThis.requestAnimationFrame` (push onto rAF queue →
			// next tick's `animFired` branch runs `repaintContent`) but
			// does NOT set `pageHasAnimated`. Setting that sticky flag
			// here locked pages with NO actual canvas (about.html) into
			// the canvas fast path forever — the loading overlay's
			// black fill stayed on screen until the user scrolled. A
			// bare `requestFullRepaint` alone isn't enough — the idle
			// branch may not service it when nothing else is moving
			// (the engine-side draw→submit gap noted in
			// [[feedback-swb-idle-paint-needs-touch]]).
			try { requestPaintTick(); } catch (_) { /* swallow */ }
			requestFullRepaint();
			this.cssLoadingOverlayPumpTid = setTimeout(pump, 40);
		};
		this.cssLoadingOverlayPumpTid = setTimeout(pump, 40);
	}

	private repaintFullscreenCanvas(
		ctx: CanvasRenderingContext2D,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		// Black backdrop so any aspect-ratio gap is obvious. The runner
		// resized the target offscreen to viewport dims so this `drawImage`
		// is a 1:1 copy in the common case.
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, canvasWidth, canvasHeight);
		// Fullscreen-canvas mode shows ONLY the canvas content — the page
		// body underneath stays hidden. paintLiveOverlay is called with
		// `skipFlow: true` so fixed-position UI (e.g. lil-gui control
		// panels) still renders on top of the WebGL output, but the body
		// flow does not. Without skipFlow the body cache was being blitted
		// over the bridge content, leaving the user looking at the page
		// instead of the fullscreen demo.
		const overlayOpts = { skipFlow: true };
		if (!this.session.scriptCtx) {
			{
				const fsViewport = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
				paintLiveOverlay(ctx, getLiveRoot(), fsViewport, 0, overlayOpts);
				setLiveViewport(fsViewport);
			}
			return;
		}
		const target = this.session.scriptCtx.firstCanvas();
		if (!target) {
			{
				const fsViewport = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
				paintLiveOverlay(ctx, getLiveRoot(), fsViewport, 0, overlayOpts);
				setLiveViewport(fsViewport);
			}
			return;
		}
		const offscreen = this.session.scriptCtx.outputs.get(target);
		if (!offscreen) {
			{
				const fsViewport = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
				paintLiveOverlay(ctx, getLiveRoot(), fsViewport, 0, overlayOpts);
				setLiveViewport(fsViewport);
			}
			return;
		}
		// WebGL-backed canvas: the offscreen is only refreshed by a manual
		// readback (which no longer runs per-rAF — see the NOTE above
		// `clearAnimationFrames` in canvas-runner.ts). Copy the live bridge
		// FBO directly to the screen instead so the animation stays
		// continuous, exactly as the normal-mode overlay path does for
		// inline-canvas WebGL slots. Falls back to `drawImage` when the
		// canvas isn't WebGL-backed or the runtime hook isn't available.
		if (isWebGLBackedCanvas(offscreen)) {
			if (copyBridgeToScreen(0, 0, canvasWidth, canvasHeight, 0, 0)) {
				// Fixed elements (lil-gui etc.) paint on top via skipFlow.
				const fsViewport = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
				paintLiveOverlay(ctx, getLiveRoot(), fsViewport, 0, overlayOpts);
				setLiveViewport(fsViewport);
				return;
			}
		}
		ctx.drawImage(offscreen, 0, 0, canvasWidth, canvasHeight);
		{
			const fsViewport = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
			paintLiveOverlay(ctx, getLiveRoot(), fsViewport, 0, overlayOpts);
			setLiveViewport(fsViewport);
		}
	}

	/**
	 * Scroll-while-keyboard repaint. Paints the page area that sits
	 * ABOVE the on-canvas keyboard panel — the keyboard panel pixels
	 * stay put, the chrome strip stays put, and only the slice between
	 * them is rewritten from the live-overlay cache. Called from
	 * `handleScroll` when `isKeyboardOpen()` is true.
	 *
	 * Skips `overlayLiveAnimatedCanvases` entirely: animated canvases
	 * and video frames don't tick while the keyboard is up (the shell's
	 * onTick loop is suspended on the keyboard promise, so rAF/video
	 * heartbeats don't fire), so there's no fresh content for them to
	 * blit and `copyBridgeToScreen` may not honor the canvas clip.
	 */
	private repaintBehindKeyboard(
		ctx: CanvasRenderingContext2D,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const chromeHeight = this.chromeHeight;
		const isBottomToolbar = this.toolbarPosition === 'bottom';
		const paintTopInset = this.mode === 'normal' && !isBottomToolbar ? chromeHeight : 0;
		const paintBottomInset = this.mode === 'normal' && isBottomToolbar ? chromeHeight : 0;
		const effectiveScrollY = this.currentScrollY + this.paintScrollAdjust();
		// Same viewport as the normal path — keeping width AND height
		// identical to lastBodyViewport prevents paintLiveOverlay from
		// classifying this as a "viewport-changed" rebuild (which would
		// trash the warm cache). The clip below restricts which pixels
		// actually get written.
		const viewport = {
			x: 0,
			y: paintTopInset,
			width: canvasWidth,
			height: canvasHeight - paintTopInset - paintBottomInset,
		};
		const panelTop = getKeyboardTopY();
		const clipBottom = Math.min(panelTop, viewport.y + viewport.height);
		if (clipBottom <= viewport.y) return;
		const t0 = performance.now();
		ctx.save();
		try {
			ctx.beginPath();
			ctx.rect(viewport.x, viewport.y, viewport.width, clipBottom - viewport.y);
			ctx.clip();
			// Re-fill the body background inside the clipped slice so a
			// shorter page's bg color extends edge-to-edge above the panel.
			ctx.fillStyle = this.effectivePageBackground();
			ctx.fillRect(viewport.x, viewport.y, viewport.width, clipBottom - viewport.y);
			paintLiveOverlay(ctx, getLiveRoot(), viewport, effectiveScrollY, {
				paintBehindKeyboard: true,
			});
		} finally {
			ctx.restore();
		}
		setLiveViewport(viewport, effectiveScrollY);
		this.lastCpuPresentMs = performance.now() - t0;
		this.cpuPresentCallCount++;
		this.lastRepaintedScrollY = effectiveScrollY;
		this.lastRepaintedLiveVersion = getLiveTreeVersion();
		this.lastRepaintedViewportW = viewport.width;
		this.lastRepaintedViewportH = viewport.height;
	}

	/**
	 * Handle a tap on an HTML `<button data-action="...">`. Two
	 * action families are recognised:
	 *   - bare strings (`fullscreen-page`, `fullscreen-canvas`,
	 *     `clear-history`) trigger shell-level handlers.
	 *   - `select-toolbar:<path>` (from the Settings page's
	 *     `<browser-toolbars>` expansion) rewrites `config.json`'s
	 *     `toolbar` field and reloads.
	 * Unknown actions are silently dropped so a malformed
	 * `data-action` doesn't break the page.
	 */
	private async dispatchButtonAction(action: string): Promise<void> {
		if (action.startsWith('select-toolbar:')) {
			await this.selectToolbar(action.slice('select-toolbar:'.length));
			return;
		}
		if (action.startsWith('select-keyboard:')) {
			await this.selectKeyboard(action.slice('select-keyboard:'.length));
			return;
		}
		switch (action) {
			case 'fullscreen-page':
				await this.toggleFullscreenPage();
				break;
			case 'fullscreen-canvas':
				await this.toggleFullscreenCanvas();
				break;
			case 'search':
				await this.promptAndSearch();
				break;
			case 'clear-history':
				await this.clearHistory();
				break;
			case 'clear-bookmarks':
				await this.clearBookmarks();
				break;
			case 'save-settings':
				await this.saveSettings();
				break;
			default:
				// Unknown action — no-op.
				break;
		}
	}

	/**
	 * History-page "Clear History" button handler. Empties the on-disk
	 * `HistoryStore` (rewrites `history.jsonl` to empty) and reloads the
	 * current page so the `<browser-history>` expansion re-runs against
	 * the now-empty store — the list disappears in place.
	 */
	private async clearHistory(): Promise<void> {
		this.historyStore.clear();
		await this.runNavigation(() => this.navigation.reload());
	}

	/**
	 * Bookmarks-page "Clear Bookmarks" button handler. Wipes the on-disk
	 * `BookmarksStore` (rewrites `bookmarks.json` to `[]`) and reloads
	 * the current page so the `<browser-bookmarks>` expansion re-runs
	 * against the now-empty store — the list disappears in place.
	 */
	private async clearBookmarks(): Promise<void> {
		this.bookmarksStore.clear();
		await this.runNavigation(() => this.navigation.reload());
	}

	/**
	 * Search-bar handler: opens the on-screen keyboard for a query, then
	 * navigates to the active search engine's results URL (engine chosen
	 * via `config.json` → `search_engines.json`). Empty / cancelled
	 * input just repaints the current page.
	 */
	private async promptAndSearch(): Promise<void> {
		const engine = resolveSearchEngine(this.profile.appRoot);
		const typed = await this.keyboard.open('', {
			onScroll: (delta) => this.handleScroll(delta),
		});
		if (typed === null || typed.trim() === '') {
			// Cancel / empty — clear the keyboard pixels. Mirrors
			// promptAndNavigate: defer if a tap already queued the next
			// input, else flag a repaint so the next idle tick blits the
			// live-overlay cache back over the keyboard pixels, and re-render
			// chrome (hidden under the panel when the toolbar is at the bottom).
			if (peekPendingInput()) return;
			requestFullRepaint();
			if (this.mode === 'normal') this.renderChrome();
			return;
		}
		await this.navigateTo(engine.query + encodeURIComponent(typed.trim()));
	}

	/**
	 * Settings-page toolbar switcher. Writes the new toolbar path
	 * into `<profile>/config.json`, re-loads the toolbar + icons,
	 * pushes the new design into the UI / keyboard / chrome region,
	 * then reloads the current page so the chrome AND content paint
	 * with the new colours, and the Settings page's
	 * `<browser-toolbars>` expansion picks up the new active row.
	 */
	private async selectToolbar(path: string): Promise<void> {
		const configPath = `${this.profile.appRoot}configs/config.json`;
		// Per-toolbar height: look up the registry entry first so we can
		// stamp `toolbarHeight` into the same write below. The source of
		// truth is `toolbars.json`, cached into `config.json` so the boot
		// path reads a single field instead of cracking a second JSON. A
		// missing / non-numeric `height` leaves the existing
		// `toolbarHeight` untouched.
		const entry = loadToolbarRegistry(this.profile.appRoot).find((e) => e.path === path);
		const nextHeight = typeof entry?.height === 'number' ? entry.height : undefined;
		try {
			// Read the raw existing config and merge `toolbar` onto it
			// so every other key survives — today that's
			// `tessellationFix`, but the spread also preserves any
			// future shell preferences AND any unknown keys a user may
			// have hand-edited in. (Using `loadConfig` here instead
			// would re-emit only the fields the parser knows about,
			// dropping unknowns silently — exactly the bug we're
			// avoiding.) On any read/parse failure we fall back to
			// writing a fresh object with the chosen toolbar plus
			// known defaults so the file ends up valid either way.
			let next: Record<string, unknown> = { toolbar: path };
			try {
				const raw = Switch.readFileSync(configPath);
				if (raw) {
					const parsed = JSON.parse(new TextDecoder().decode(raw));
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						next = { ...(parsed as Record<string, unknown>), toolbar: path };
					}
				}
			} catch (_) {
				// Missing or unreadable config — fall through and write
				// a minimal one with sane defaults baked in.
				next = { ...loadConfig(this.profile.appRoot), toolbar: path };
			}
			if (nextHeight !== undefined) next.toolbarHeight = nextHeight;
			Switch.writeFileSync(configPath, JSON.stringify(next, null, 2));
		} catch (error) {
			console.debug(`[brewser] write config.json failed: ${error}`);
			return;
		}
		// Apply the height change at runtime so the next paint reflects
		// the new strip size without waiting for a restart. Mirrors the
		// `'toolbarHeight' in staged` block in `saveSettings`.
		if (nextHeight !== undefined && nextHeight !== this.chromeHeight) {
			this.chromeHeight = nextHeight;
			resetToolbarOverlayCache();
			this.publishChromeRegion();
		}
		// Re-read + re-parse the new toolbar HTML into a fresh live
		// root. The toolbar tree is parsed in-process (no fetch round-
		// trip) — same shape as `selectKeyboard` below. The first
		// post-rebuild `renderChrome` happens inside `loadHtmlToolbar`
		// itself so the new theme paints with current state on the
		// next tick.
		await this.loadHtmlToolbar();
		// Reload the current page so the Settings page's
		// `<browser-toolbars>` expansion re-runs against the new
		// active row.
		await this.runNavigation(() => this.navigation.reload());
	}

	/** Settings-page keyboard switcher. Writes the new keyboard panel
	 * path into `<appRoot>/config.json`, re-reads + parses the new
	 * panel HTML, and rebuilds the keyboard live root so the new
	 * design is active immediately (next time the overlay opens).
	 * Mirrors `selectToolbar`'s write shape — spread the existing
	 * config forward so unknown user-edited keys survive, then write.
	 * Reloads the current page so the Settings page's
	 * `<browser-keyboards>` expansion re-runs against the new active
	 * row. */
	private async selectKeyboard(path: string): Promise<void> {
		const configPath = `${this.profile.appRoot}configs/config.json`;
		try {
			let next: Record<string, unknown> = { keyboard: path };
			try {
				const raw = Switch.readFileSync(configPath);
				if (raw) {
					const parsed = JSON.parse(new TextDecoder().decode(raw));
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						next = { ...(parsed as Record<string, unknown>), keyboard: path };
					}
				}
			} catch (_) {
				next = { ...loadConfig(this.profile.appRoot), keyboard: path };
			}
			Switch.writeFileSync(configPath, JSON.stringify(next, null, 2));
		} catch (error) {
			console.debug(`[brewser] write config.json failed: ${error}`);
			return;
		}
		// Re-read + re-parse the new panel into a fresh live root. The
		// keyboard tree is parsed in-process (no fetch round-trip), so
		// the next overlay open paints with the new design.
		await this.loadHtmlKeyboard();
		// Reload the current page so the Settings page's
		// `<browser-keyboards>` expansion picks up the new active row.
		await this.runNavigation(() => this.navigation.reload());
	}

	/**
	 * Settings-page Save button handler. Walks the live DOM for every
	 * `[data-setting="<key>"]` widget the loader emitted, reads the
	 * staged value via `getInputValue` / `getInputChecked`, merges the
	 * result into `<profile>/config.json` (preserving any unknown keys
	 * the user may have hand-edited) using the SAME clamps + type guards
	 * `loadConfig` enforces, then re-applies the keys whose runtime
	 * hooks can take effect without a restart. Keys without a runtime
	 * apply path (`maxHistory`, `autoRotate`, `buttonMapping`) round-
	 * trip into the file and take effect on next launch.
	 *
	 * Toolbar HTML changes go through the same `loadHtmlToolbar` dance
	 * `selectToolbar` does so the new theme paints immediately.
	 * Toolbar height / page bg / position get pushed straight into the
	 * shell fields so the next paint picks them up (toolbar cache reset
	 * for height + position so the strip rebuilds at the new dims).
	 * Mirrors selectToolbar's write shape: spread the existing config
	 * forward, overlay the staged edits, then `Switch.writeFileSync` so
	 * a partial / hand-edited config doesn't lose unknown keys.
	 */
	private async saveSettings(): Promise<void> {
		// Page-rendered Save button carries `disabled` while there are no
		// staged edits (managed by settings.html's inline diff script).
		// findTapIntent ignores disabled state and dispatches the action
		// anyway, so guard here — a no-op save would still rewrite
		// config.json with identical content, costing an unnecessary
		// reload. Walk the live root for the button by its action; if
		// it's missing the page is something else entirely (clean no-op).
		if (isSaveButtonDisabled()) return;
		const configPath = `${this.profile.appRoot}configs/config.json`;
		const prior = loadConfig(this.profile.appRoot);
		const staged = readStagedSettings();
		if (Object.keys(staged).length === 0) return; // nothing to commit

		// Wallpaper is selected independently now (the Settings page's
		// Background picker stages `themeBackground` directly — a
		// `backgrounds.json` entry title), so there's nothing to inject
		// here; the merge + apply path below reacts to the staged value.
		// Toolbar-height cache. Each row in `toolbars.json` can carry a
		// `height` field
		// (clamped by `loadToolbarRegistry`) and selecting a toolbar
		// re-stamps `config.toolbarHeight` from it so the strip resizes
		// to whatever the picked theme expects. Empty / missing `height`
		// in the registry entry → leave `toolbarHeight` untouched (no
		// auto-resize), so a theme that doesn't care preserves the
		// user's existing value. The existing
		// `'toolbarHeight' in staged && staged.toolbarHeight !== prior.toolbarHeight`
		// block below picks the injected value up and runs the same
		// chromeHeight + cache-reset + publishChromeRegion path a manual
		// height edit would take.
		if ('toolbar' in staged && typeof staged.toolbar === 'string') {
			const entry = loadToolbarRegistry(this.profile.appRoot)
				.find((e) => e.path === staged.toolbar);
			if (typeof entry?.height === 'number') {
				staged.toolbarHeight = entry.height;
			}
		}
		// Permission-warning severities. The Settings page exposes one
		// checkbox per severity (`warningLow` / `warningMedium` /
		// `warningHigh`) because `readStagedSettings` is per-widget and
		// a single array-valued widget would need bespoke handling. Read
		// any of the three that landed in `staged`, fill in the others
		// from `prior.warnings` so a partial stage doesn't clobber
		// unchanged severities, then compose the canonical-order array
		// and drop the three intermediate keys so they don't bake into
		// config.json. Same shape as the toolbar-height injection above.
		if ('warningLow' in staged || 'warningMedium' in staged || 'warningHigh' in staged) {
			const pick = (key: 'warningLow' | 'warningMedium' | 'warningHigh', risk: 'low' | 'medium' | 'high'): boolean => (
				key in staged ? !!staged[key] : prior.warnings.includes(risk)
			);
			const next: ('low' | 'medium' | 'high')[] = [];
			if (pick('warningLow', 'low')) next.push('low');
			if (pick('warningMedium', 'medium')) next.push('medium');
			if (pick('warningHigh', 'high')) next.push('high');
			staged.warnings = next;
			delete staged.warningLow;
			delete staged.warningMedium;
			delete staged.warningHigh;
		}

		// Spread the on-disk raw object so user-edited unknown keys
		// survive — same shape `selectToolbar` uses.
		let next: Record<string, unknown> = { ...prior, ...staged };
		try {
			const raw = Switch.readFileSync(configPath);
			if (raw) {
				const parsed = JSON.parse(new TextDecoder().decode(raw));
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					next = { ...(parsed as Record<string, unknown>), ...staged };
				}
			}
		} catch (_) {
			// Missing / unreadable — `next` already carries clamped
			// defaults + staged edits, so writing it produces a valid
			// file either way.
		}
		// Strict-pinned keys live in the runtime bundle
		// (`@switch-web/runtime`'s `RUNTIME_CONFIG_DEFAULTS`). `loadConfig`
		// returns the runtime values regardless of what's on disk, so
		// the spread of `prior` above injected them into `next`. Strip
		// them out so we don't bake whatever the runtime says today
		// into the user's `config.json` — otherwise a future runtime
		// rebuild that rotates the URL would be silently overridden by
		// the stale on-disk copy if `loadConfig`'s strict-pin were ever
		// loosened. The Settings UI doesn't expose these keys anyway.
		for (const key of STRICT_PINNED_RUNTIME_KEYS) {
			delete next[key];
		}
		try {
			Switch.writeFileSync(configPath, JSON.stringify(next, null, 2));
		} catch (error) {
			console.debug(`[brewser] write config.json failed: ${error}`);
			return;
		}

		// Re-apply runtime hooks for keys whose effect we want live
		// without forcing a restart. Keys absent from `staged` go
		// untouched — no point re-pushing a value the user didn't change.
		const fresh = loadConfig(this.profile.appRoot);
		if ('theme' in staged) {
			this.colorScheme = fresh.theme;
			setMediaColorScheme(this.colorScheme);
			setLiveFormColorScheme(this.colorScheme);
		}
		if ('clickSounds' in staged) {
			setClickSoundEnabled(fresh.clickSounds);
		}
		if ('local' in staged) {
			setDateInputDefaultPlaceholder(fresh.local);
		}
		if ('momentumScrolling' in staged) {
			this.momentumEnabled = fresh.momentumScrolling;
			// Zero out any in-flight velocity when the user turns the feature
			// off mid-coast, so the page stops dead instead of finishing the
			// decay cycle.
			if (!this.momentumEnabled) this.momentumVelocityPxPerTick = 0;
		}
		if ('videoNVTEGRA' in staged) {
			setVideoTryHwAccel(fresh.videoNVTEGRA);
		}
		if ('wwwRenderChunkMs' in staged) {
			this.wwwRenderChunkMs = fresh.wwwRenderChunkMs;
			setLiveBuildChunkMs(fresh.wwwRenderChunkMs);
		}
		if ('scrollChunkMs' in staged) {
			setLiveScrollChunkMs(fresh.scrollChunkMs);
		}
		if ('mouseIdleMs' in staged) {
			setCursorIdleMs(fresh.mouseIdleMs);
		}
		if ('navDebug' in staged) {
			setShellInputDebugEnabled(fresh.navDebug);
			setNavDebugEnabled(fresh.navDebug);
			setTouchDebugEnabled(fresh.navDebug);
		}
		if ('swbImgDebug' in staged) {
			setSwbImgDebugEnabled(fresh.swbImgDebug);
		}
		// `maxHistory` is fixed at HistoryStore construction; `autoRotate`
		// has no live consumer today; `buttonMapping` is out of scope for
		// this form. All three round-trip into config.json above and
		// take effect on next launch.

		// Toolbar HTML changed → re-read + re-parse + rebuild the live
		// root so the next paint reflects the new theme. Mirrors
		// `selectToolbar` minus the explicit reload (saveSettings does
		// its own reload at the bottom). The `<browser-toolbars>`
		// expansion in the Settings page re-runs against the new
		// active row on that reload.
		if ('toolbar' in staged && staged.toolbar !== prior.toolbar) {
			await this.loadHtmlToolbar();
		}
		// Keyboard panel HTML is parsed in-process at boot; on change,
		// re-read + re-parse from the new path and rebuild the kb live
		// root so the next overlay open paints with the new design.
		if ('keyboard' in staged && staged.keyboard !== prior.keyboard) {
			await this.loadHtmlKeyboard();
		}
		// Toolbar height: cache on the shell + dump the toolbar paint
		// cache so the strip rebuilds at the new dims. layoutTopInset
		// + paint-inset math read `this.chromeHeight` so the page area
		// resizes on the next paint without a full reload.
		if ('toolbarHeight' in staged && staged.toolbarHeight !== prior.toolbarHeight) {
			// `showToolbar: false` keeps chromeHeight pinned at 0 — a
			// height slider tweak while the strip is disabled must not
			// zombie-revive it.
			this.chromeHeight = fresh.showToolbar ? fresh.toolbarHeight : 0;
			resetToolbarOverlayCache();
			this.publishChromeRegion();
		}
		// Show/hide the toolbar strip when the checkbox is toggled. Same
		// chromeHeight + cache + region-publish sequence the toolbarHeight
		// block above runs — recomputing off the fresh flag flips
		// chromeHeight between 0 and the configured strip height so the
		// post-save reload lays the page area out with (or without) the
		// chrome inset. The paint-overlay GATE must be flipped too, mirroring
		// the boot path (`setToolbarOverlayVisible` at init): a page reload
		// re-renders content but does NOT re-run shell boot, so without this
		// the gate stays armed and `paintHtmlToolbarIfVisible` keeps painting
		// the strip at height 0 — which the overlay's `Math.max(1, …)` size
		// clamp renders as a stray 1px line at the top. Turning it back ON also
		// loads the toolbar root if boot skipped it (booted with the toolbar
		// off), so re-enabling shows the strip without an app restart.
		if ('showToolbar' in staged && staged.showToolbar !== prior.showToolbar) {
			this.chromeHeight = fresh.showToolbar ? fresh.toolbarHeight : 0;
			if (fresh.showToolbar) {
				if (!getToolbarLiveRoot()) await this.loadHtmlToolbar();
				setToolbarOverlayVisible(true);
			} else {
				setToolbarOverlayVisible(false);
			}
			resetToolbarOverlayCache();
			this.publishChromeRegion();
		}
		// Page background: cache so `effectivePageBackground` picks it
		// up on the next paint. No reload needed.
		if ('pageBackground' in staged && staged.pageBackground !== prior.pageBackground) {
			this.pageBackground = fresh.pageBackground;
		}
		// Wallpaper: a Background-picker change re-resolves + re-applies the
		// selected entry live (image decode + arm/disarm shader + repaint). A
		// dynamic wallpaper then animates continuously via the onTick driver.
		if ('themeBackground' in staged && staged.themeBackground !== prior.themeBackground) {
			this.applySelectedBackground(fresh);
		}
		// Toolbar position: cache on the shell + stamp the new value on
		// the toolbar live root so theme CSS can flip its layout via
		// `body[data-toolbar-position="bottom"] { … }`. layoutTopInset
		// + the isBottomToolbar reads in the shell all read from
		// this.toolbarPosition, so updating it here is enough.
		if ('toolbarPosition' in staged && staged.toolbarPosition !== prior.toolbarPosition) {
			this.toolbarPosition = fresh.toolbarPosition;
			const tbRoot = getToolbarLiveRoot();
			if (tbRoot) {
				pushToolbarMutationScope();
				try { tbRoot.setAttribute('data-toolbar-position', this.toolbarPosition); }
				finally { popToolbarMutationScope(); }
			}
			resetToolbarOverlayCache();
			this.publishChromeRegion();
		}

		// Reload the page so the form re-renders against the persisted
		// values (radio + select + number widgets show the saved state,
		// the inline script's "no unsaved changes" baseline resets, and
		// the search-bar logo on any other page reflects the new engine).
		await this.runNavigation(() => this.navigation.reload());
	}

	/** Find the Settings page's Save button in the live root and return
	 * whether it carries the `disabled` attribute. Used by saveSettings
	 * to short-circuit no-op invocations without rewriting config.json
	 * or paying the reload cost. Returns false when the button isn't in
	 * the live tree at all (some other page issued a `save-settings`
	 * action — treat as "go ahead", let the no-staged-widgets fallback
	 * in saveSettings handle it). */
	/** Read + parse the active keyboard panel HTML (per `config.json`'s
	 * `keyboard` field, e.g. `keyboards/default.html`) once at boot and
	 * stash the parsed tree on `this.keyboardParsedTree`. Also runs the
	 * first population into a fresh live root so the kb panel is
	 * available the moment the debug flag (checkpoint 1) or
	 * `KeyboardOverlay.open` (checkpoint 2+) flips visibility on.
	 *
	 * Failure (file missing despite seeding, parse exception) leaves the
	 * tree null + the kb root null — the paint pass early-returns, and
	 * the existing canvas keyboard stays the only visual. Non-fatal.
	 *
	 * Called again from `selectKeyboard` after the user picks a new
	 * panel from the Settings page — re-reads from the new path and
	 * rebuilds the live root in place. */
	private async loadHtmlKeyboard(): Promise<void> {
		const rel = loadConfig(this.profile.appRoot).keyboard;
		const path = this.profile.keyboardPath(rel);
		try {
			const raw = Switch.readFileSync(path);
			if (!raw) return;
			const html = new TextDecoder().decode(raw);
			this.keyboardParsedTree = parseHtml(html);
		} catch (error) {
			console.debug(`[brewser] load keyboard '${rel}' failed: ${error}`);
			return;
		}
		this.rebuildKeyboardLiveRoot();
	}

	/** (Re)build the keyboard live root from the cached parsed tree.
	 * Called once after the initial parse and again from
	 * `handleHtmlResponseLive` after every navigation `resetLiveRoot`
	 * — the host reset clears the global cascade (`resetLiveCss`), so
	 * the keyboard's `<style>` registrations need to be replayed in the
	 * fresh cascade. Rebuilds a brand-new `LiveElement('body')` each
	 * time and registers it via `setKeyboardLiveRoot`; the old root is
	 * dropped (GC handles it). Scope class `__brewser-kb-root` keeps
	 * the keyboard's CSS from leaking into the host page's cascade. */
	private rebuildKeyboardLiveRoot(): void {
		if (!this.keyboardParsedTree) return;
		// Tag is `div`, not `body`, so the host page's generic
		// `body { … }` rules (margin / padding / background / font, etc.)
		// don't match the keyboard root via tag selectors and bleed
		// host styling into the kb panel. The kb's own CSS is class-
		// scoped via `populateRootFromTree`'s rewrite (every selector
		// gets prefixed with `.__brewser-kb-root`), so a non-body tag
		// here doesn't break the kb's own cascade.
		const kbRoot = new LiveElement('div');
		kbRoot.attached = true;
		populateRootFromTree(kbRoot, this.keyboardParsedTree, '__brewser-kb-root');
		setKeyboardLiveRoot(kbRoot);
	}

	/** Read + parse `romfs/shell/file-picker.html` (mirrors
	 * {@link loadHtmlKeyboard}). Picker chrome is fixed (no per-style
	 * variants) so the path is hard-coded against the storage root. */
	private async loadHtmlFilePicker(): Promise<void> {
		const path = `${this.profile.storageRoot}file-picker.html`;
		try {
			const raw = Switch.readFileSync(path);
			if (!raw) return;
			const html = new TextDecoder().decode(raw);
			this.filePickerParsedTree = parseHtml(html);
		} catch (error) {
			console.debug(`[brewser] load file picker failed: ${error}`);
			return;
		}
		this.rebuildFilePickerLiveRoot();
	}

	/** (Re)build the file picker live root from the cached parsed tree.
	 * Called once after the initial parse and again from
	 * `handleHtmlResponseLive` after every navigation `resetLiveRoot`
	 * (same reset reasoning as {@link rebuildKeyboardLiveRoot}). */
	private rebuildFilePickerLiveRoot(): void {
		if (!this.filePickerParsedTree) return;
		const root = new LiveElement('div');
		root.attached = true;
		populateRootFromTree(root, this.filePickerParsedTree, '__brewser-file-picker-root');
		setFilePickerLiveRoot(root);
	}

	/** Read + parse `romfs/shell/select-modal.html` (mirrors
	 * {@link loadHtmlFilePicker}). Chrome is fixed (no per-style variants)
	 * so the path is hard-coded against the storage root. */
	private async loadHtmlSelectModal(): Promise<void> {
		const path = `${this.profile.storageRoot}select-modal.html`;
		try {
			const raw = Switch.readFileSync(path);
			if (!raw) return;
			const html = new TextDecoder().decode(raw);
			this.selectModalParsedTree = parseHtml(html);
		} catch (error) {
			console.debug(`[brewser] load select modal failed: ${error}`);
			return;
		}
		this.rebuildSelectModalLiveRoot();
	}

	/** (Re)build the select modal live root from the cached parsed tree.
	 * Called once after the initial parse and again from
	 * `handleHtmlResponseLive` after every navigation `resetLiveRoot`
	 * (same reset reasoning as {@link rebuildFilePickerLiveRoot}). */
	private rebuildSelectModalLiveRoot(): void {
		if (!this.selectModalParsedTree) return;
		const root = new LiveElement('div');
		root.attached = true;
		populateRootFromTree(root, this.selectModalParsedTree, '__brewser-select-modal-root');
		setSelectModalLiveRoot(root);
	}

	/** Read + parse `romfs/shell/date-picker.html` (mirrors
	 * {@link loadHtmlFilePicker}). */
	private async loadHtmlDatePicker(): Promise<void> {
		const path = `${this.profile.storageRoot}date-picker.html`;
		try {
			const raw = Switch.readFileSync(path);
			if (!raw) return;
			const html = new TextDecoder().decode(raw);
			this.datePickerParsedTree = parseHtml(html);
		} catch (error) {
			console.debug(`[brewser] load date picker failed: ${error}`);
			return;
		}
		this.rebuildDatePickerLiveRoot();
	}

	private rebuildDatePickerLiveRoot(): void {
		if (!this.datePickerParsedTree) return;
		const root = new LiveElement('div');
		root.attached = true;
		populateRootFromTree(root, this.datePickerParsedTree, '__brewser-date-picker-root');
		setDatePickerLiveRoot(root);
	}

	/** Read + parse `romfs/shell/time-picker.html`. */
	private async loadHtmlTimePicker(): Promise<void> {
		const path = `${this.profile.storageRoot}time-picker.html`;
		try {
			const raw = Switch.readFileSync(path);
			if (!raw) return;
			const html = new TextDecoder().decode(raw);
			this.timePickerParsedTree = parseHtml(html);
		} catch (error) {
			console.debug(`[brewser] load time picker failed: ${error}`);
			return;
		}
		this.rebuildTimePickerLiveRoot();
	}

	private rebuildTimePickerLiveRoot(): void {
		if (!this.timePickerParsedTree) return;
		const root = new LiveElement('div');
		root.attached = true;
		populateRootFromTree(root, this.timePickerParsedTree, '__brewser-time-picker-root');
		setTimePickerLiveRoot(root);
	}

	/** Read + parse `romfs/shell/color-picker.html`. */
	private async loadHtmlColorPicker(): Promise<void> {
		const path = `${this.profile.storageRoot}color-picker.html`;
		try {
			const raw = Switch.readFileSync(path);
			if (!raw) return;
			const html = new TextDecoder().decode(raw);
			this.colorPickerParsedTree = parseHtml(html);
		} catch (error) {
			console.debug(`[brewser] load color picker failed: ${error}`);
			return;
		}
		this.rebuildColorPickerLiveRoot();
	}

	private rebuildColorPickerLiveRoot(): void {
		if (!this.colorPickerParsedTree) return;
		const root = new LiveElement('div');
		root.attached = true;
		populateRootFromTree(root, this.colorPickerParsedTree, '__brewser-color-picker-root');
		setColorPickerLiveRoot(root);
	}

	/** Read + parse `romfs/shell/number-picker.html`. */
	private async loadHtmlNumberPicker(): Promise<void> {
		const path = `${this.profile.storageRoot}number-picker.html`;
		try {
			const raw = Switch.readFileSync(path);
			if (!raw) return;
			const html = new TextDecoder().decode(raw);
			this.numberPickerParsedTree = parseHtml(html);
		} catch (error) {
			console.debug(`[brewser] load number picker failed: ${error}`);
			return;
		}
		this.rebuildNumberPickerLiveRoot();
	}

	private rebuildNumberPickerLiveRoot(): void {
		if (!this.numberPickerParsedTree) return;
		const root = new LiveElement('div');
		root.attached = true;
		populateRootFromTree(root, this.numberPickerParsedTree, '__brewser-number-picker-root');
		setNumberPickerLiveRoot(root);
	}

	/** Read + parse the active toolbar HTML (per `config.json`'s
	 * `toolbar` field, e.g. `themes/toolbars/light.html`) once at boot
	 * and stash the parsed tree on `this.toolbarParsedTree`. Also runs
	 * the first population into a fresh live root so the chrome strip
	 * has something to paint from the first frame.
	 *
	 * Failure (file missing despite seeding, parse exception) leaves
	 * the tree null + the toolbar root null — the paint pass early-
	 * returns and the chrome strip renders as the page bg colour with
	 * no widgets. Non-fatal so the user can still drive the shell via
	 * controller shortcuts.
	 *
	 * Called again from {@link selectToolbar} after the user picks a
	 * new theme from the Settings page — re-reads from the new path
	 * and rebuilds the live root in place. Mirrors
	 * {@link loadHtmlKeyboard}. */
	private async loadHtmlToolbar(): Promise<void> {
		const rel = loadConfig(this.profile.appRoot).toolbar;
		const path = this.profile.toolbarPath(rel);
		try {
			const raw = Switch.readFileSync(path);
			if (!raw) return;
			const html = new TextDecoder().decode(raw);
			this.toolbarParsedTree = parseHtml(html);
		} catch (error) {
			console.debug(`[brewser] load toolbar '${rel}' failed: ${error}`);
			return;
		}
		// `rebuildToolbarLiveRoot` itself calls `renderChrome` at the
		// end to push current state into the freshly-populated root,
		// so no extra call needed here.
		this.rebuildToolbarLiveRoot();
	}

	/** Resolve the selected wallpaper from `backgrounds.json` by its title
	 * (`config.themeBackground`, the Settings Background picker). Returns
	 * the empty shape ({ background:'', dynamic:'' }) when the title is
	 * missing / unmatched (e.g. "None") so the caller clears any wallpaper. */
	private resolveSelectedBackground(
		config: ReturnType<typeof loadConfig>,
	): { background: string; dynamic: string } {
		const entry = loadBackgroundRegistry(this.profile.appRoot)
			.find((e) => e.title === config.themeBackground);
		return {
			background: entry?.background ?? '',
			dynamic: entry?.dynamic ?? '',
		};
	}

	/** Apply the selected wallpaper: kick off the static image decode and,
	 * when the selected entry ships a `dynamic` shader, arm the animated
	 * wallpaper (which takes precedence in `paintStyleBackground`, with the
	 * static image as its per-frame fallback). Otherwise disarm any running
	 * shader so the static image (or page-bg colour) shows. A dynamic
	 * wallpaper always animates continuously (it's turned off by selecting
	 * "None"). Used at boot and after a Settings save. Resetting
	 * `dynamicBgRel` first defeats `loadStyleDynamic`'s path-dedupe so
	 * re-selecting the same shader still recompiles. */
	private applySelectedBackground(config: ReturnType<typeof loadConfig>): void {
		const bg = this.resolveSelectedBackground(config);
		void this.loadStyleBackground(bg.background);
		this.dynamicBgRel = '';
		if (bg.dynamic) {
			this.loadStyleDynamic(bg.dynamic);
		} else {
			this.disarmDynamicBg();
			requestFullRepaint();
		}
	}

	/** Decode the wallpaper image at `rel` (resolved through
	 * `profile.stylePath`, so bare paths sit under the profile root and
	 * `sdmc:/…`/`romfs:/…` pass through). Skips work when the path is
	 * unchanged from the current cache, so the no-op `saveSettings`
	 * (radio re-stages the same style) doesn't re-decode. On success,
	 * triggers a single `requestFullRepaint` so the new image lands on
	 * the next paint tick; on empty path or decode failure, clears the
	 * cached image so the per-frame `fillRect` shows through unmodified. */
	private async loadStyleBackground(rel: string): Promise<void> {
		if (rel === this.backgroundImageRel) return;
		this.backgroundImageRel = rel;
		if (!rel) {
			this.backgroundImage = null;
			requestFullRepaint();
			return;
		}
		const src = this.profile.stylePath(rel);
		const img = await loadOptionalImage(src);
		// If another style change raced in while we awaited, abandon
		// this load — the newer call has already set `backgroundImageRel`
		// to a different path and we'd otherwise stomp its image.
		if (this.backgroundImageRel !== rel) return;
		this.backgroundImage = img;
		requestFullRepaint();
	}

	/** Arm (or disarm) the animated wallpaper for the active style. `rel`
	 * is the fragment-shader asset path (resolved through
	 * `profile.stylePath`, same rules as `loadStyleBackground`); empty =
	 * no animated wallpaper. Reads the shader synchronously (a few KB) and
	 * hands it to the runtime's `initDynamicBackground`. On success sets
	 * `dynamicBgActive` (the input loop's `onTick` then animates it every
	 * frame — see `tickDynamicBackground`); the static `backgroundImage`
	 * stays cached as the fallback for any frame where the GL present
	 * fails. On empty path / unreadable / uncompilable shader, disarms
	 * cleanly so `paintStyleBackground` uses the static image (or page
	 * colour). Deduped on the source path so a no-op re-select doesn't
	 * recompile. */
	private loadStyleDynamic(rel: string): void {
		if (rel === this.dynamicBgRel) return;
		this.dynamicBgRel = rel;
		if (!rel) {
			this.disarmDynamicBg();
			requestFullRepaint();
			return;
		}
		let src: string | null = null;
		try {
			const raw = Switch.readFileSync(this.profile.stylePath(rel));
			src = raw && raw.byteLength > 0 ? new TextDecoder().decode(raw) : null;
		} catch (_) { src = null; }
		const ok = src ? initDynamicBackground(src) : false;
		if (!ok) {
			console.debug('[brewser] dynamic wallpaper unavailable — falling back to static background');
			this.disarmDynamicBg();
			requestFullRepaint();
			return;
		}
		this.dynamicBgActive = true;
		this.dynamicBgStartMs = performance.now();
		this.lastBgFrameMs = 0;
		requestFullRepaint();
	}

	/** Tear down the animated wallpaper: drop the runtime program + clear
	 * the active flag (which stops the `onTick` animation driver).
	 * Idempotent. The static `backgroundImage` (if any) is left untouched
	 * so the fallback path keeps working. */
	private disarmDynamicBg(): void {
		this.dynamicBgActive = false;
		clearDynamicBackground();
	}

	/** Whether the shell wallpaper (static image OR animated shader) may be
	 * painted on the CURRENTLY active page.
	 *
	 * The wallpaper is the shell's *desktop* backdrop — it belongs behind the
	 * chrome pages (home / apps launcher / settings / …), not inside a running
	 * app or a web page. Two reasons it must be suppressed off the shell's own
	 * pages:
	 *   1. The animated wallpaper draws into the v1 shared screen-GL bridge FBO
	 *      — the SAME FBO page WebGL canvases render into. Presenting it while an
	 *      app's WebGL canvas is live overwrites the app's just-rendered FBO
	 *      right before the shell reads it back to composite the canvas, so the
	 *      app's canvas shows wallpaper pixels (the reported bug). The runtime's
	 *      dynamic-bg comment states the invariant it relies on: "the wallpaper
	 *      is only visible on the shell's own transparent-body pages, which never
	 *      run page WebGL." This gate enforces it.
	 *   2. Conceptually you're inside an app / on a web page — the shell's
	 *      desktop wallpaper should not bleed through a transparent body.
	 *
	 * Returns false for app pages (`brewser://apps/<id>/…`, via `currentAppDir`),
	 * external http(s) pages, and dev WebGL probes (`brewser://dev/…`); true for
	 * every other internal shell page. Written as "exclude the known non-shell
	 * pages" (rather than "require `brewser://`") so the brief `currentPageUrl
	 * === ''` window mid-navigation doesn't blink the wallpaper off a shell
	 * page. Restores automatically on app exit — walking back to a shell page
	 * flips this true and the next paint revives the wallpaper (the runtime
	 * self-heals the shader program if the app tore the shared GL context
	 * down). */
	private wallpaperAllowedOnCurrentPage(): boolean {
		if (this.currentAppDir !== null) return false;
		const url = this.session.currentPageUrl;
		if (/^https?:\/\//i.test(url)) return false;
		if (/^brewser:\/\/dev\//i.test(url)) return false;
		return true;
	}

	/** Per-frame animated-wallpaper driver, called from the input loop's
	 * `onTick` (which fires every ~16 ms regardless of input). Returns true
	 * when it painted a wallpaper frame so the caller keeps the loop in its
	 * active (vsync) poll — that's what actually presents the frame. Capped
	 * at {@link DYNAMIC_BG_FPS}.
	 *
	 * This REPLACED an earlier `setTimeout`-based pump: on real hardware the
	 * pump's timer is starved once the main loop goes fully idle (no input,
	 * no momentum), so the wallpaper froze the instant interaction stopped
	 * (the engine idle draw→submit gap, [[feedback-swb-idle-paint-needs-touch]]).
	 * Driving the repaint from `onTick` + returning active keeps it animating
	 * continuously. No-op unless a dynamic wallpaper is armed and visible
	 * (normal mode — any fullscreen app/page/canvas/video covers it). */
	private tickDynamicBackground(nowMs: number): boolean {
		if (!this.dynamicBgActive || this.mode !== 'normal' || !this.wallpaperAllowedOnCurrentPage()) return false;
		if (nowMs - this.lastBgFrameMs < DYNAMIC_BG_FRAME_MS) return false;
		this.lastBgFrameMs = nowMs;
		// `requestPaintTick` arms the `fired` branch (the reliable idle
		// present path) for the next tick too; the direct repaint paints the
		// wallpaper now.
		try { requestPaintTick(); } catch (_) { /* swallow */ }
		this.repaintContent();
		return true;
	}

	/** Paint the cached wallpaper inside `viewport` using cover-fit
	 * (center-crop) sizing. Source rect is computed in image space to
	 * match the dst aspect ratio; `drawImage(img, sx, sy, sw, sh, …)`
	 * lets the engine scale + crop in a single op without a `ctx.clip`
	 * stack frame. No-op when no image is loaded — caller already
	 * filled the viewport with the page-bg colour, so we just leave
	 * that fill in place. */
	private paintStyleBackground(
		ctx: CanvasRenderingContext2D,
		viewport: { x: number; y: number; width: number; height: number },
	): void {
		// Desktop-backdrop only: never paint the wallpaper inside an app / web
		// page / dev-WebGL probe. This is the load-bearing guard for the
		// "dynamic background bleeds onto the app canvas" bug — the animated
		// path below shares the v1 screen-GL bridge FBO with page WebGL, so
		// presenting here would clobber the app's canvas (see
		// `wallpaperAllowedOnCurrentPage`). The caller already filled the
		// viewport with the page-bg colour, so returning early just leaves
		// that fill in place.
		if (!this.wallpaperAllowedOnCurrentPage()) return;
		// Animated wallpaper first: render the shader into the shared GL
		// bridge and blit it into the viewport. `presentDynamicBackground`
		// returns false if the shader isn't live / GL failed this frame, in
		// which case we fall through to the static image (or, if there's no
		// image either, the page-bg fill the caller already laid down).
		if (this.dynamicBgActive && viewport.width > 0 && viewport.height > 0) {
			const t = (performance.now() - this.dynamicBgStartMs) / 1000 * DYNAMIC_BG_SPEED;
			if (presentDynamicBackground(t, viewport.width, viewport.height, viewport.x, viewport.y)) {
				return;
			}
		}
		const img = this.backgroundImage;
		if (!img) return;
		const iw = img.naturalWidth;
		const ih = img.naturalHeight;
		if (iw <= 0 || ih <= 0) return;
		if (viewport.width <= 0 || viewport.height <= 0) return;
		const dstAspect = viewport.width / viewport.height;
		const srcAspect = iw / ih;
		let sx = 0, sy = 0, sw = iw, sh = ih;
		if (srcAspect > dstAspect) {
			// Source is wider than dst — crop the sides.
			sw = ih * dstAspect;
			sx = (iw - sw) / 2;
		} else {
			// Source is taller (or matched) — crop top/bottom.
			sh = iw / dstAspect;
			sy = (ih - sh) / 2;
		}
		ctx.drawImage(img, sx, sy, sw, sh, viewport.x, viewport.y, viewport.width, viewport.height);
	}

	/** (Re)build the toolbar live root from the cached parsed tree.
	 * Called once after the initial parse and again from
	 * `handleHtmlResponseLive` after every navigation `resetLiveRoot`
	 * — the host reset clears the global cascade (`resetLiveCss`), so
	 * the toolbar's `<style>` registrations need to be replayed in the
	 * fresh cascade. Rebuilds a brand-new `LiveElement('div')` each
	 * time and registers it via `setToolbarLiveRoot`; the old root is
	 * dropped (GC handles it). Scope class `__brewser-toolbar-root`
	 * keeps the toolbar's CSS from leaking into the host page's
	 * cascade. Also dumps the paint cache so the new layout doesn't
	 * blit through. */
	private rebuildToolbarLiveRoot(): void {
		if (!this.toolbarParsedTree) return;
		// Pre-warm map: capture the previous tree's loaded `<img>` Image
		// objects keyed by src so we can transplant them onto the new
		// tree's same-src `<img>` slots immediately after build. Without
		// this, every navigation rebuild reloads every icon from scratch
		// (visible as 1-2 s of broken-icon placeholders), even though
		// the bytes are identical and the OS-level file fetch is fast.
		// Captured BEFORE the new tbRoot replaces the old via
		// `setToolbarLiveRoot` so `getToolbarLiveRoot()` still points
		// at the old tree here.
		const preWarm = new Map<string, HTMLImageElement>();
		const oldRoot = getToolbarLiveRoot();
		if (oldRoot) {
			const collect = (el: LiveElement): void => {
				if (el.tagName === 'IMG') {
					const img = el.getLoadedImage();
					const src = el.getAttribute('src');
					if (img && src && !preWarm.has(src)) preWarm.set(src, img);
				}
				for (const c of el.children) collect(c);
			};
			collect(oldRoot);
		}
		// Wrap the populate + setAttribute in a toolbar mutation scope so
		// the ~30 `appendChild` calls inside `populateRootFromTree` (one
		// per element + one per <style>) don't bump the shared
		// `liveTreeVersion` and pollute the host page's dirty set. Without
		// this, every navigation re-registration of the toolbar tree dumps
		// ~30 entries onto `dirtyLiveElements` and forces the host's
		// `patchLiveDirtyRegions` to either re-layout detached toolbar
		// elements against the host's layout cache (fail) or punt to a
		// full host rebuild — neither produces correct paint but the
		// `<button><img>` walks during the patch attempt can leave stray
		// paints in the host overlay.
		let tbRoot: LiveElement;
		pushToolbarMutationScope();
		try {
			// `div` not `body` — same rationale as the keyboard root.
			tbRoot = new LiveElement('div');
			tbRoot.attached = true;
			populateRootFromTree(tbRoot, this.toolbarParsedTree, '__brewser-toolbar-root');
			// Stamp the active position on the body root so theme CSS can
			// switch border/padding/order between top + bottom via
			// `body[data-toolbar-position="bottom"] { … }` rules without
			// the engine needing per-theme knowledge.
			tbRoot.setAttribute('data-toolbar-position', this.toolbarPosition);
			// Pre-warm step: for every new `<img>` in the rebuilt tree,
			// look up its src in the captured map and transplant the
			// loaded Image so the first post-rebuild paint already shows
			// the icon. The element's own async load (kicked off by
			// `setAttribute('src', …)` above) still runs and will
			// overwrite `loadedImage` with a fresh Image when it
			// settles — same bytes, imperceptible swap.
			if (preWarm.size > 0) {
				const warm = (el: LiveElement): void => {
					if (el.tagName === 'IMG') {
						const src = el.getAttribute('src');
						const hit = src ? preWarm.get(src) : undefined;
						if (hit) el.presetLoadedImage(hit);
					}
					for (const c of el.children) warm(c);
				};
				warm(tbRoot);
			}
			setToolbarLiveRoot(tbRoot);
			resetToolbarOverlayCache();
		} finally {
			popToolbarMutationScope();
		}
		// Push current chrome state into the just-rebuilt root so the
		// first post-rebuild paint already shows the right URL +
		// back/forward enable + bookmark state. Without this, navigation
		// rebuilds (which create a fresh `<input id="url">` with empty
		// value, fresh buttons with no `data-disabled` attrs) leave the
		// toolbar visually "reset" until the navigation completes and
		// runNavigation's tail-renderChrome runs — visible as the URL
		// text disappearing for the duration of the loading page.
		// renderChrome reads from `this.navigation.currentURL` etc. so
		// it picks up whatever state is current at rebuild time (during
		// navigation, that's typically the OLD URL — same behavior real
		// browsers show during the loading state).
		this.renderChrome();
		// Belt-and-suspenders for the "icons missing on first load" case:
		// at boot the WebView session hasn't yet installed the runtimeFetch
		// wrappers (BrowserResourceLoader + LocalSchemeFetchLoader), so
		// the toolbar's `<img src="sdmc:/...">` loads fall through to the
		// raw nxjs fetch path that doesn't claim sdmc: at shell level —
		// they 404 and the elements get `imageLoadFailed=true`. Once a
		// page navigation completes, the next rebuild's imgs load
		// successfully because the wrappers are now installed.
		//
		// If any img errored on this build, schedule a single re-rebuild
		// after a short delay so the toolbar self-heals into the working
		// state without waiting for the user to refresh. Guard with a
		// retry-once flag to avoid infinite loops if loads keep failing
		// for unrelated reasons (e.g. missing icon files).
		if (this.toolbarRetryScheduled) return;
		this.toolbarRetryScheduled = true;
		setTimeout(() => {
			this.toolbarRetryScheduled = false;
			if (this.anyToolbarImgFailed()) {
				// rebuildToolbarLiveRoot ends with its own renderChrome.
				this.rebuildToolbarLiveRoot();
			} else {
				// All imgs loaded fine — just nudge the cache version so
				// the rebuild paints them in case the onload→bump path
				// raced an earlier `consumeFullRepaintRequest()`.
				bumpToolbarTreeVersion();
				requestFullRepaint();
			}
		}, 500);
	}

	/** Walk the active toolbar live root checking each `<img>` for a
	 * failed load (the `loadImage` error path sets `imageLoadFailed`).
	 * Returns true if any IMG failed — the deferred retry in
	 * `rebuildToolbarLiveRoot` keys on this to decide between a cheap
	 * cache-bump (all imgs loaded) and a full rebuild (some failed and
	 * we need fresh Image objects to retry the loads). */
	private anyToolbarImgFailed(): boolean {
		const root = getToolbarLiveRoot();
		if (!root) return false;
		let failed = false;
		const visit = (el: LiveElement): void => {
			if (failed) return;
			if (el.tagName === 'IMG' && el.hasImageError()) { failed = true; return; }
			for (const c of el.children) visit(c);
		};
		visit(root);
		return failed;
	}

	/** Per-navigation state push into the toolbar live root: address bar
	 * value, back/forward enable, star icon swap, mode label, network
	 * dot. Wrapped in {@link pushToolbarMutationScope} so the bumps
	 * route to `toolbarTreeVersion` instead of the shared
	 * `liveTreeVersion` — the host page cache stays warm across chrome
	 * state pushes, only the small toolbar cache rebuilds.
	 *
	 * Contract with the toolbar HTML themes (see
	 * `romfs/themes/toolbars/*.html`):
	 *
	 *   - `#url`              — `<input>` whose value is set to the URL
	 *   - `#backButton`       — gets `[data-disabled="true"]` toggled
	 *   - `#forwardButton`    — gets `[data-disabled="true"]` toggled
	 *   - `#bookmarkButton`   — `[data-disabled]` toggled on the BUTTON
	 *                           per `bookmarkable` (greyed out + tap
	 *                           no-op on internal `brewser://` pages);
	 *                           child `<img>` is swapped between
	 *                           `data-bookmark-true` and
	 *                           `data-bookmark-false` attrs based on
	 *                           `bookmarked`
	 *   - `#modeLabel`        — first text child set to the mode
	 *                           string ("HANDHELD" / "DOCKED" / "")
	 *   - `#reachableDot`     — `[data-status]` set to
	 *                           `up | down | unknown`
	 *   - body                — `[data-bookmarkable]` set so per-
	 *                           theme CSS can adjust URL bar width
	 *                           when the star is hidden
	 */
	private pushToolbarState(state: {
		url: string;
		canGoBack: boolean;
		canGoForward: boolean;
		bookmarked: boolean;
		bookmarkable: boolean;
		internetReachable: boolean | undefined;
		modeLabel: string;
	}): void {
		const root = getToolbarLiveRoot();
		if (!root) return;
		pushToolbarMutationScope();
		try {
			// body-level flags. Guard on change: an unconditional write here
			// bumps `toolbarTreeVersion` every renderChrome (setAttribute →
			// invalidateLiveStyle → bumpLiveTreeVersion, routed to the toolbar
			// counter inside the mutation scope). renderChrome fires on every
			// `animFired` tick, so under a continuously-animating wallpaper an
			// unconditional bump invalidated + rebuilt the toolbar overlay
			// cache 30×/sec. Only write when the value actually changed.
			const bookmarkable = state.bookmarkable ? 'true' : 'false';
			if (root.getAttribute('data-bookmarkable') !== bookmarkable) {
				root.setAttribute('data-bookmarkable', bookmarkable);
			}
			const urlInput = findToolbarById(root, 'url');
			// `setInputValue` unconditionally bumps the live tree version, so
			// skip it when the address bar already shows this URL — the common
			// case on every animated frame (same page, same URL).
			if (urlInput && getInputValue(urlInput) !== state.url) setInputValue(urlInput, state.url);
			const back = findToolbarById(root, 'backButton');
			if (back) toggleDisabledAttr(back, !state.canGoBack);
			const fwd = findToolbarById(root, 'forwardButton');
			if (fwd) toggleDisabledAttr(fwd, !state.canGoForward);
			const bm = findToolbarById(root, 'bookmarkButton');
			if (bm) {
				// Always show the bookmark button; just disable it on
				// non-bookmarkable pages (internal `brewser://` pages,
				// any URL without an http(s) scheme). Same visual
				// treatment as back/forward when there's no history
				// in that direction.
				toggleDisabledAttr(bm, !state.bookmarkable);
				const img = findToolbarImg(bm);
				if (img) {
					const next = state.bookmarked
						? img.getAttribute('data-bookmark-true')
						: img.getAttribute('data-bookmark-false');
					if (next && img.getAttribute('src') !== next) {
						img.setAttribute('src', next);
					}
				}
			}
			const modeEl = findToolbarById(root, 'modeLabel');
			if (modeEl) setFirstText(modeEl, state.modeLabel);
			const dot = findToolbarById(root, 'reachableDot');
			if (dot) {
				const status = state.internetReachable === undefined
					? 'unknown'
					: state.internetReachable ? 'up' : 'down';
				if (dot.getAttribute('data-status') !== status) {
					dot.setAttribute('data-status', status);
				}
			}
			// Avatar slot — paint from the shell's `cachedToolbarAvatarSrc`
			// snapshot. The snapshot is refreshed once at boot and once
			// per navigation (in `handleHtmlResponseLive` AFTER the
			// permission-policy swap, gated to shell context only); this
			// code path MUST NOT call `resolveActiveSessionAvatarPath` or
			// otherwise hit `Switch.readFileSync` for the auth records.
			// `renderChrome` — which drives `pushToolbarState` — fires
			// PER rAF TICK on animated app pages via the `onTick →
			// animFired` gate at browser-shell.ts:1074-1128, so any disk
			// read here becomes a ~60 Hz flood; under a restrictive app
			// manifest that flood also emits a `perm denied:
			// filesystem_read` deny log line every frame (see
			// switch-path-resolver.ts:136-139). Snapshot-at-navigation
			// keeps the resolver's two reads off the paint path entirely.
			const avatarBtn = findToolbarById(root, 'avatarButton');
			if (avatarBtn) {
				const img = findToolbarImg(avatarBtn);
				if (img) {
					const nextSrc = this.cachedToolbarAvatarSrc;
					if (img.getAttribute('src') !== nextSrc) {
						img.setAttribute('src', nextSrc);
					}
				}
			}
		} finally {
			popToolbarMutationScope();
		}
	}

	/** Repaint just one `<video>` element's box on the screen ctx
	 * (frame + controls bar), without redrawing the rest of the page.
	 * Used after play / pause / stop taps so the bar's time / error
	 * state updates immediately without paying for a full content
	 * repaint. In fullscreen mode the box is the full canvas.
	 *
	 * No background wipe: existing pixels in the box (placeholder from
	 * the cache, or last-painted frame from the overlay walker) stay
	 * visible underneath. If we wiped with the page background, video
	 * elements would flash to the body color until the first frame
	 * decodes — for audio-only files that flash would be permanent. */
	private paintVideoInline(video: LiveElement): void {
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		if (this.mode === 'video-fullscreen' && this.fullscreenVideo === video) {
			const havePainted = paintVideoFrameAt(
				ctx, video, 0, 0, canvas.width, canvas.height);
			if (!havePainted) {
				// Audio-only fullscreen: wipe bar region with black so
				// the translucent bar doesn't compound with previous
				// paints. (For video files paintVideoFrameAt already
				// covered the bar region with frame pixels.)
				const barH = Math.min(VIDEO_CONTROLS_BAR_H, canvas.height);
				ctx.fillStyle = '#000000';
				ctx.fillRect(0, canvas.height - barH, canvas.width, barH);
			}
			paintVideoControls(ctx, video, 0, 0, canvas.width, canvas.height);
			return;
		}
		const box = getLayoutBox(video);
		if (!box || box.w <= 0 || box.h <= 0) return;
		const effectiveScrollY = this.currentScrollY + this.paintScrollAdjust();
		const chromeHeight = this.chromeHeight;
		const isBottomToolbar = this.toolbarPosition === 'bottom';
		const paintTopInset = this.mode === 'normal' && !isBottomToolbar ? chromeHeight : 0;
		const screenX = box.x;
		const screenY = box.y + paintTopInset - effectiveScrollY;
		const visibleTop = paintTopInset;
		const visibleBottom = canvas.height - (this.mode === 'normal' && isBottomToolbar ? chromeHeight : 0);
		if (screenY + box.h <= visibleTop || screenY >= visibleBottom) return;
		ctx.save();
		try {
			ctx.beginPath();
			ctx.rect(0, visibleTop, canvas.width, visibleBottom - visibleTop);
			ctx.clip();
			const havePainted = paintVideoFrameAt(
				ctx, video, screenX, screenY, box.w, box.h);
			if (!havePainted) {
				// Same no-frame-wipe rationale as the overlay walker
				// (see live-overlay.ts) — required so the translucent
				// bar doesn't compound across taps.
				const barH = Math.min(VIDEO_CONTROLS_BAR_H, box.h);
				ctx.fillStyle = '#000000';
				ctx.fillRect(
					screenX, screenY + box.h - barH,
					box.w, barH,
				);
			}
			paintVideoControls(ctx, video, screenX, screenY, box.w, box.h);
		} finally { ctx.restore(); }
	}

	/** Enter video-fullscreen mode focused on the given `<video>` element.
	 * The overlay walker paints just this video (object-fit:contain into
	 * the canvas dims) and skips everything else. B button exits. */
	private enterVideoFullscreen(video: LiveElement): void {
		// If we're already in another fullscreen, undo its baggage first.
		if (this.mode === 'fullscreen-canvas') {
			void this.restoreCanvasSize();
		}
		this.fullscreenVideo = video;
		this.setMode('video-fullscreen');
		setFullscreenVideo(video);
		this.repaintAll();
	}

	private async toggleFullscreenPage(): Promise<void> {
		if (this.mode === 'fullscreen-page') {
			await this.exitFullscreen();
			return;
		}
		// Coming from fullscreen-canvas: undo the canvas resize first so
		// the layout's snapshot of that canvas reverts to its attribute
		// size before we re-enter normal layout flow.
		if (this.mode === 'fullscreen-canvas') await this.restoreCanvasSize();
		// Widen the CSS viewport to the full screen so `100vh` / `100vw`
		// resolve against 720 (not 720 − chromeHeight). The page was
		// originally laid out with cssVpH = screen.height − chromeHeight
		// (see WebPageSession.populateAndRunScripts), which makes a
		// `.wrap { height: 100vh }` element 664 px tall. Without this
		// rewrite, fullscreen-page mode paints content from 0..664 and
		// leaves the bottom 56 px empty, while paintScrollAdjust shifts
		// everything up by chromeHeight so the top of the page clips off.
		const screen = nxScreen();
		setCssViewport(screen.width, screen.height);
		// Notify the page that `innerWidth`/`innerHeight` (and `vh`/`vw`)
		// have shifted so its `resize` listeners can reflow — WebGL apps
		// like gravityballs recompute canvas backing buffer size from
		// `innerHeight * DPR` in a `resize` handler, and without this
		// dispatch the buffer stays at the old chrome-trimmed dims and
		// content ends up clipped to a 664-tall strip inside the widened
		// viewport (the reciprocal of the "ghost toolbar" symptom on exit).
		dispatchPageResizeEvent();
		this.setMode('fullscreen-page');
		this.clampScroll();
		// Same cache-flush rationale as exitFullscreen: the live-overlay
		// and toolbar-overlay caches were built at the chrome-trimmed
		// viewport; a straight repaintAll would blit stale pixels sized
		// for the old viewport into the new fullscreen area, leaving a
		// slice at the bottom (or top) unpainted. Flush + full-repaint
		// so the next paint rebuilds at the current dims.
		resetLiveOverlayCache();
		resetToolbarOverlayCache();
		this.renderChrome();
		requestFullRepaint();
		this.repaintAll();
	}

	private async toggleFullscreenCanvas(): Promise<void> {
		if (this.mode === 'fullscreen-canvas') {
			await this.exitFullscreen();
			return;
		}
		if (!this.session.scriptCtx) return;
		const target = this.session.scriptCtx.firstCanvas();
		if (!target) return;
		const canvas = nxScreen();
		// Remember the attr-declared size so we can restore it on exit.
		const attrW = parseInt(target.attrs.width ?? '', 10);
		const attrH = parseInt(target.attrs.height ?? '', 10);
		this.fullscreenCanvasOriginalSize = {
			width: Number.isFinite(attrW) && attrW > 0 ? attrW : 300,
			height: Number.isFinite(attrH) && attrH > 0 ? attrH : 150,
		};
		// Publish the fullscreen target size so a "live" page can size its
		// render to the screen (the fullscreen present copies the bridge
		// region [0,0,W,H] straight to the screen).
		(globalThis as { __swbFullscreenCanvasSize?: { width: number; height: number } })
			.__swbFullscreenCanvasSize = { width: canvas.width, height: canvas.height };
		// Flip mode (and the page-visible `__swbBrowserMode` global) BEFORE
		// any rerun so the page sees fullscreen-canvas at init time.
		this.fullscreenCanvasLive = 'data-fullscreen-live' in target.attrs;
		this.setMode('fullscreen-canvas');
		// "Live" canvas (e.g. the audio visualizer): it runs its own
		// resize-adaptive render loop and holds page state — playback,
		// selected visualizer, button UI — that a rerun would wipe. Just
		// flip mode + repaint; the page's still-running loop reads the
		// two globals above and re-sizes itself. No clearAnimationFrames
		// (keep its loop alive), no rerun (keep its DOM + audio intact).
		if (this.fullscreenCanvasLive) {
			this.repaintAll();
			return;
		}
		// Drop any `requestAnimationFrame` callbacks the previous script
		// run queued — they reference the old `renderer` / closure state
		// and would race the rerun's fresh setup. Without this the
		// previous animate() loop keeps firing alongside the new one
		// (Three.js demos: scene appears frozen or partially-updated).
		clearAnimationFrames();
		clearAllVideos();
		// Resize the target offscreen + rerun all scripts — a responsive
		// script reads `canvas.width` / `canvas.height` and redraws at
		// the new size. Await so any async script work finishes before
		// we paint.
		const resizes = new Map([[target, { width: canvas.width, height: canvas.height }]]);
		await this.session.scriptCtx.rerun(resizes);
		this.repaintAll();
	}

	private async exitFullscreen(): Promise<void> {
		const wasFullscreenCanvas = this.mode === 'fullscreen-canvas';
		const wasFullscreenPage = this.mode === 'fullscreen-page';
		const wasFullscreenApp = this.mode === 'fullscreen-app';
		const wasLive = this.fullscreenCanvasLive;
		this.fullscreenCanvasLive = false;
		(globalThis as { __swbFullscreenCanvasSize?: { width: number; height: number } | null })
			.__swbFullscreenCanvasSize = null;
		// Undo the fullscreen-page / fullscreen-app CSS viewport widen so
		// vh resolves back to the chrome-trimmed area for normal-mode
		// layout. `fullscreen-app` additionally had its session
		// `chromeHeight` overridden to 0 at launch (browser-shell.ts:1953)
		// so `100vh` would fill the screen on first paint — restore that
		// too so the session's next `setCssViewport` calls resolve
		// against the chrome-trimmed rect again.
		if (wasFullscreenPage || wasFullscreenApp) {
			const screen = nxScreen();
			setCssViewport(screen.width, Math.max(1, screen.height - this.chromeHeight));
		}
		if (wasFullscreenApp) {
			this.session.setChromeHeight(this.chromeHeight);
		}
		// Notify the page that `innerWidth`/`innerHeight` (and `vh`/`vw`)
		// have shifted so its `resize` listeners get a chance to reflow.
		// setCssViewport is a bare setter — without this, apps like
		// gravityballs keep their WebGL backing buffer + physics
		// coordinates at the fullscreen dimensions and content ends up
		// clipped under the returned toolbar strip.
		if (wasFullscreenPage || wasFullscreenApp) {
			dispatchPageResizeEvent();
		}
		// Flip mode (and the global) BEFORE restoreCanvasSize's rerun so
		// the re-executed page scripts see 'normal' and revert to their
		// layout-box sizing.
		this.setMode('normal');
		// A live fullscreen never resized the backing store via rerun, so
		// there's nothing to restore — the page's own loop reverts to its
		// layout-box size once the mode global flips. Only the rerun path
		// needs restoreCanvasSize.
		if (wasFullscreenCanvas && !wasLive) await this.restoreCanvasSize();
		this.clampScroll();
		// 2026-06-21: live-canvas exit defers content repaint by one tick.
		// `data-fullscreen-live` opts out of the rerun path — the page's
		// own animate() reverts `canvas.width/height` (and renderer.setSize)
		// from `syncCanvasSize` reading `__swbBrowserMode === 'normal'`.
		// That hasn't happened yet — we're still inside the input handler
		// that fired `lr-combo`; the page's next rAF callback only runs on
		// the next `onTick`. Calling repaintAll right here would lay out
		// the page using the stale fullscreen 1280×720 canvas dimensions
		// (`LiveCanvas.getDisplaySize` reads `_width/_height` from the
		// element). With `.canvas-frame` containing a 720px-tall canvas,
		// `.layout-row` balloons, `.bottom-row` ends up at y≈870 — past the
		// viewport — and the user sees an apparently broken page (body
		// elements painted off-screen) until the next tick corrects layout.
		// LiveElement's canvas width setter deliberately doesn't bump
		// `liveTreeVersion` (per the 2026-06-20 perf-fix in live-dom.ts) so
		// the cache wouldn't auto-invalidate on the dim revert either.
		// Defer: reset the cache + request a paint. The next onTick
		// `tickAnimationFrames` fires the page's rAF first (reverts dims),
		// then `repaintContent` consumes the request and rebuilds the cache
		// with correct dims. Chrome painted now so the toolbar appears
		// immediately instead of waiting one frame. Screen retains its
		// last fullscreen-canvas frame underneath the chrome for that one
		// frame — visually cleaner than a broken-layout flash.
		if (wasFullscreenCanvas && wasLive) {
			resetLiveOverlayCache();
			this.renderChrome();
			requestFullRepaint();
			return;
		}
		// Fullscreen-page / fullscreen-app: the live-overlay cache and
		// toolbar-overlay cache were built at the fullscreen viewport
		// (`viewport.height = screen.height`, no chrome inset), so a
		// straight `repaintAll` blits stale cache pixels sized for the
		// old viewport into the new chrome-trimmed area. The toolbar
		// strip ends up as an unpainted / stale slice ("ghost toolbar").
		// Flush both caches so the next paint rebuilds them at the
		// current viewport, and force a full repaint so the rebuild
		// isn't skipped by the per-tick idle-fast-path.
		if (wasFullscreenPage || wasFullscreenApp) {
			resetLiveOverlayCache();
			resetToolbarOverlayCache();
			this.renderChrome();
			requestFullRepaint();
		}
		this.repaintAll();
	}

	private async restoreCanvasSize(): Promise<void> {
		if (!this.session.scriptCtx || !this.fullscreenCanvasOriginalSize) return;
		const target = this.session.scriptCtx.firstCanvas();
		if (!target) return;
		// Same RAF cleanup rationale as on entering fullscreen-canvas.
		clearAnimationFrames();
		clearAllVideos();
		const resizes = new Map([[target, this.fullscreenCanvasOriginalSize]]);
		await this.session.scriptCtx.rerun(resizes);
		this.fullscreenCanvasOriginalSize = null;
	}

	private setMode(mode: BrowserMode): void {
		this.mode = mode;
		setBrowserMode(mode);
		// Expose the mode to page scripts (they share the runtime global)
		// so a responsive inline canvas can tell when it's been promoted
		// to fullscreen-canvas and render at the shell-resized backing
		// store instead of its normal-flow layout box. Read by the audio
		// player's visualizer.
		(globalThis as { __swbBrowserMode?: string }).__swbBrowserMode = mode;
		// Leaving video-fullscreen clears the focused element so the
		// overlay walker stops painting it full-canvas.
		if (mode !== 'video-fullscreen') this.fullscreenVideo = null;
		setFullscreenVideo(this.fullscreenVideo);
	}

	private clampScroll(): void {
		const max = this.maxScroll();
		if (this.currentScrollY > max) {
			this.currentScrollY = max;
		}
	}

	/** Full repaint covering chrome + content. Called after a mode
	 * transition where parts of the canvas that used to be chrome are
	 * now content (or vice versa) and stale pixels would otherwise show
	 * through. */
	private repaintAll(): void {
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		// Wipe everything first so a previously-drawn chrome strip
		// (or layout slice) doesn't bleed into the new mode.
		ctx.fillStyle = this.effectivePageBackground();
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		this.repaintContent();
		if (this.mode === 'normal') this.renderChrome();
	}

	/** Black fullscreen "Loading <app>" splash, shown from the moment Launch
	 * is tapped until the launched app's first frame. Item-for-item this is
	 * the requested launch feedback: a full-screen black fill (covering the
	 * page AND the toolbar strip), "Loading <name>" centred with "Please
	 * wait…" beneath, held over the perceptible gap while the app loads.
	 *
	 * Why a `nativeRaf` loop and not a one-shot paint: an app launch is an
	 * `await this.navigation.navigate(url)` that BLOCKS the input loop, so
	 * `onTick` (the normal present driver) is suspended for the whole load.
	 * `this.nativeRaf` is the nxjs-runtime rAF queue drained by `$.onFrame`
	 * every main-loop iteration BEFORE the framebuffer present — the same
	 * reliable path `startBootSplash` uses to keep the boot splash on screen
	 * across the parallel boot navigate. The SYNCHRONOUS first paint commits
	 * the frame the next present shows; the re-arm keeps the text re-drawn
	 * across the load's async yields so an intermediate engine paint can't
	 * leave it half-covered. `save`/`restore` isolates the centred text align
	 * so it can't leak into the app's own text paints after the splash stops. */
	private startLaunchSplash(appName: string): void {
		if (this.launchSplashActive) return;
		this.launchSplashActive = true;
		// Hide the software cursor for the duration. The engine composites the
		// last-set cursor sprite onto every present independent of our black
		// fill, and the input loop is suspended across the launch so the normal
		// idle-hide can't clear it — it would sit frozen over the splash.
		try { setCursorOverlaySuppressed(true); } catch (_) { /* swallow */ }
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		const raf = this.nativeRaf;
		// Guard against an overlong name blowing past the screen edge; the
		// splash is feedback, not a place to render a 200-char title.
		const rawName = typeof appName === 'string' ? appName.trim() : '';
		const name = rawName.length > 42 ? rawName.slice(0, 41) + '…' : rawName;
		const title = name ? `Loading ${name}` : 'Loading…';
		this.launchSplashFrames = 0;
		const paint = (): void => {
			if (!this.launchSplashActive) return;
			const w = canvas.width;
			const h = canvas.height;
			ctx.save();
			ctx.fillStyle = '#000000';
			ctx.fillRect(0, 0, w, h);
			const cx = Math.round(w / 2);
			ctx.textAlign = 'center';
			ctx.textBaseline = 'alphabetic';
			ctx.fillStyle = '#e8e8e8';
			ctx.font = '600 44px sans-serif';
			ctx.fillText(title, cx, Math.round(h / 2 - 6));
			ctx.fillStyle = '#9bb1d6';
			ctx.font = '400 24px sans-serif';
			ctx.fillText('Please wait…', cx, Math.round(h / 2 + 40));
			ctx.restore();
			this.launchSplashFrames++;
			if (this.launchSplashFrames === 1) {
				console.debug(`[launch-splash] first paint w=${w} h=${h} title="${title}"`);
			}
			raf(paint);
		};
		// SYNCHRONOUS first paint — NO `await` may precede this. The frame
		// committed here is presented before `navigate()` takes the JS thread,
		// exactly like `startBootSplash`'s contract.
		paint();
	}

	/** Stop the launch splash's re-arm loop. After this returns the next
	 * `raf(paint)` (if one is queued) early-returns, so the caller can paint
	 * the loaded app as the final frame with no splash flicker on top. */
	private stopLaunchSplash(): void {
		this.launchSplashActive = false;
		// Restore the cursor overlay (re-syncs from the current cursor state).
		try { setCursorOverlaySuppressed(false); } catch (_) { /* swallow */ }
		console.debug(`[launch-splash] stop after ${this.launchSplashFrames} frame(s)`);
	}

	/** Tell the touch dispatcher where the chrome strip lives so taps
	 * in that y-range route to chrome-button branches. Called once at
	 * startup after the toolbar is loaded; the toolbar position can
	 * only change via a toolbar edit + relaunch. */
	private publishChromeRegion(): void {
		const canvas = nxScreen();
		const chromeHeight = this.chromeHeight;
		if (this.toolbarPosition === 'top') {
			setChromeRegion(0, chromeHeight);
		} else {
			setChromeRegion(canvas.height - chromeHeight, canvas.height);
		}
	}

	/** Start the boot splash IMMEDIATELY with a synchronous first paint
	 * and return a handle the caller drives.
	 *
	 * The whole bug being fixed: the old `runBootSplashFade` did
	 * `await loadOptionalImage(...)` BEFORE its first `rafCallback()`
	 * paint. That yield gave the parallel navigate's synchronous
	 * grid-build (1-2 s on the home grid) the JS thread first — so the
	 * splash's first paint was racing the build it was supposed to
	 * cover, and losing. This refactor makes the first paint
	 * SYNCHRONOUS (just a black backdrop — no image needed for the
	 * first frame; the rAF callback null-guards `if (splashImg && ...)`)
	 * and fires `loadOptionalImage` fire-and-forget so the image lands
	 * a frame or two later without blocking anything.
	 *
	 * CRITICAL CONTRACT: NO `await` between the entry of this method
	 * and the first `rafCallback()` invocation. Re-introducing one
	 * yields the JS thread before the splash paint commits to
	 * `canvas->data`, and the parallel navigate's sync chunk paints
	 * black or grid pixels first → the original bug returns.
	 *
	 * Painting uses `this.nativeRaf` — the nxjs-runtime rAF queue
	 * drained by `$.onFrame` every main-loop iteration BEFORE
	 * framebuffer present. The brewser-runtime rAF (installed by
	 * `ensureRAFInstalled` during the parallel navigate) routes into a
	 * different queue that isn't drained until the controller-input
	 * loop starts — AFTER the splash — which is why the constructor
	 * captures `this.nativeRaf` at class-init time, before any page
	 * code can swap the global.
	 *
	 * Returns a `SplashHandle`: `beginFade()` flips into the fade
	 * phase; `finishedFading` resolves once the fade overlay reaches
	 * alpha 1 (or immediately if `splashFadeMs <= 0`). Caller gates
	 * the fade on `navigateTo` completing — see `run()` for the
	 * wiring.
	 *
	 * `splashFadeMs <= 0` skips the fade entirely (instant cut). */
	private startBootSplash(splashFadeMs: number): SplashHandle {
		// Allocate canvas → `nx_framebuffer_init` fires → Skia screen
		// surface initialized. This is the trigger for the engine-side
		// `[skia] GPU screen surface ... ready` log; nothing earlier in
		// the runtime invokes the screen's `getContext`, so Skia is
		// uninitialized until this line.
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');

		// Per-frame paint state. The image starts null and gets filled
		// in by the fire-and-forget `loadOptionalImage` continuation
		// below; the rAF callback null-guards the `drawImage` so the
		// first frame (and any frame before the image lands) paints a
		// pure-black backdrop.
		let splashImg: unknown = null;
		let lw = 0;
		let lh = 0;
		let dx = 0;
		let dy = 0;

		type Phase = 'dwell' | 'fade' | 'done';
		let phase: Phase = 'dwell';
		let fadeStart = 0;
		let resolveFinished: (() => void) | null = null;
		const finishedFading = new Promise<void>((resolve) => {
			resolveFinished = resolve;
		});

		const raf = this.nativeRaf;
		const rafCallback = (): void => {
			if (phase === 'done') return;
			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			if (splashImg && lw > 0 && lh > 0) {
				ctx.drawImage(splashImg as CanvasImageSource, dx, dy, lw, lh);
			}
			if (phase === 'fade') {
				const dt = Date.now() - fadeStart;
				const t = splashFadeMs > 0 ? Math.min(1, dt / splashFadeMs) : 1;
				if (t > 0) {
					ctx.fillStyle = `rgba(0,0,0,${t})`;
					ctx.fillRect(0, 0, canvas.width, canvas.height);
				}
				if (dt >= splashFadeMs) {
					phase = 'done';
					if (resolveFinished) resolveFinished();
					return; // don't re-arm
				}
			}
			raf(rafCallback);
		};

		// SYNCHRONOUS first paint — NO `await` precedes this line. The
		// frame committed here is what the next C-side `framebufferEnd`
		// presents, covering the entire post-Skia interval before
		// `seedRomfs` / `loadHtml*` / `navigateTo` / the grid build can
		// take the JS thread.
		rafCallback();

		// Boot-timing diagnostic: emit the JS-side splash-first-paint
		// timestamp. Pairs with the C-side `[skia]` log's
		// `(+%llu ms since t0)` so the user can compute the post-Skia
		// → first-splash-paint delta. Should be <1 frame (~16 ms) on
		// any working build; if it's seconds, the synchronous-first-
		// paint contract regressed. Reads the boot epoch stashed by
		// `main.ts` very early — falls back to a `splash-first-paint`
		// log without timing if the global isn't there (shouldn't
		// happen in shipping builds; harmless if it does).
		const bootT0 = (globalThis as { __bootT0?: number }).__bootT0;
		if (typeof bootT0 === 'number') {
			console.debug(`[boot] splash-first-paint (+${Date.now() - bootT0}ms since js-t0)`);
		} else {
			console.debug('[boot] splash-first-paint');
		}

		// Async image load — fire and forget. The rAF callback picks
		// up the image automatically once these vars are populated;
		// until then it paints the black backdrop alone (which is what
		// the user sees for the first few frames, then the logo fades
		// in via the next rAF tick).
		void loadOptionalImage('romfs:/shell/assets/loading.jpg').then((img) => {
			if (!img) return;
			const si = img as unknown as { naturalWidth?: number; width?: number; naturalHeight?: number; height?: number };
			const w = si.naturalWidth || si.width || 0;
			const h = si.naturalHeight || si.height || 0;
			if (w <= 0 || h <= 0) return;
			lw = w;
			lh = h;
			dx = Math.round((canvas.width - lw) / 2);
			dy = Math.round((canvas.height - lh) / 2);
			splashImg = img;
		});

		const beginFade = (): void => {
			if (phase !== 'dwell') return;
			if (splashFadeMs <= 0) {
				phase = 'done';
				if (resolveFinished) resolveFinished();
				return;
			}
			phase = 'fade';
			fadeStart = Date.now();
		};

		return { finishedFading, beginFade };
	}

	/**
	 * Show a multi-line warning when the user launches in any applet
	 * mode (typically `LibraryApplet`, the hbmenu-via-Album default).
	 * Waits for any gamepad button press before returning so the user
	 * can read it. Why: applet-mode launches have restricted memory
	 * (the kernel reserves much less heap than for Application titles),
	 * and the live-DOM content cache's OffscreenCanvas allocations can
	 * OOM on tall pages. Application mode (full memory) gives a much
	 * more reliable experience.
	 */
	private async showLibraryAppletWarning(appletType: number): Promise<void> {
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#0b1220';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		const cx = canvas.width / 2;
		const modeLabel = describeAppletType(appletType);
		const lines: { text: string; color: string; size: number; y: number }[] = [
			{ text: 'Recommended: Application Mode', color: '#ffd35e', size: 32, y: canvas.height / 2 - 130 },
			{ text: `This launch is in ${modeLabel} mode (Switch.appletType = ${appletType}).`, color: '#e0e8f4', size: 18, y: canvas.height / 2 - 70 },
			{ text: 'Applet-mode launches have restricted memory, so tall pages and', color: '#9bb1d6', size: 17, y: canvas.height / 2 - 30 },
			{ text: 'large WebGL allocations may OOM mid-session.', color: '#9bb1d6', size: 17, y: canvas.height / 2 - 4 },
			{ text: 'For the full memory allotment, launch with title override (hold R in hbmenu),', color: '#9bb1d6', size: 17, y: canvas.height / 2 + 56 },
			{ text: 'which runs as Application mode.', color: '#9bb1d6', size: 17, y: canvas.height / 2 + 82 },
			{ text: 'Press any button to continue…', color: '#7eda9f', size: 18, y: canvas.height / 2 + 130 },
		];
		for (const line of lines) {
			ctx.fillStyle = line.color;
			ctx.font = `${line.size}px system-ui`;
			ctx.fillText(line.text, cx, line.y);
		}
		ctx.textAlign = 'start';
		await waitForAnyButton();
	}
}

// --- Toolbar live-root helpers ---------------------------------------------
//
// Per the contract in `pushToolbarState`, the engine talks to toolbar
// HTML themes by id-keyed lookups + attribute / value mutations. These
// helpers are the smallest possible "find one element by some property"
// + "tweak one bit of state" walkers. Same shape as the kb-overlay's
// `findUrlInput` / `findLetterTextNode` — recursive walk, leaf-first
// `#text` matching, defensive null returns. Kept module-local because
// no other file mutates the toolbar tree (the page resource loader's
// `<browser-toolbars>` expansion writes to the host body, not the
// toolbar root).

function findToolbarById(root: LiveElement, id: string): LiveElement | null {
	if (root.getAttribute?.('id') === id) return root;
	for (const c of root.children) {
		const f = findToolbarById(c, id);
		if (f) return f;
	}
	return null;
}

function findToolbarImg(within: LiveElement): LiveElement | null {
	if (within.tagName === 'IMG') return within;
	for (const c of within.children) {
		const f = findToolbarImg(c);
		if (f) return f;
	}
	return null;
}

function setFirstText(el: LiveElement, text: string): void {
	for (const c of el.children) {
		if (c.tagName === '#text') {
			const cur = ((c as { data?: string }).data ?? '');
			if (cur !== text) (c as { data: string }).data = text;
			return;
		}
	}
	// No text child yet — create one. (Themes that ship `<span></span>`
	// with no text inside still get populated correctly.)
	const tn = new LiveElement('#text');
	(tn as { data: string }).data = text;
	el.appendChild(tn);
}

function toggleDisabledAttr(el: LiveElement, on: boolean): void {
	const has = el.hasAttribute('data-disabled');
	if (on && !has) {
		el.setAttribute('data-disabled', 'true');
	} else if (!on && has) {
		el.removeAttribute('data-disabled');
	}
}

// --- Toolbar avatar slot ----------------------------------------------------
//
// Reads the active-session pointer (`auth/active.json`) and the named
// provider's auth record to figure out which avatar bitmap the toolbar
// should display. Same disk shape the page-side `auth-shared.js` writes
// — kept in sync there.
//
// Snapshot lifetime, NOT per-frame. `renderChrome` (and its
// `pushToolbarState` tail that repaints the avatar `<img>` src) fires
// per rAF tick on animated app pages via the `onTick → animFired`
// gate at browser-shell.ts:1074-1128 — up to ~60 Hz. Running the two
// `Switch.readFileSync` calls in this resolver on that cadence
// produced a per-frame perm-denied deny log under any restrictive
// app manifest (the shell-owned `sdmc:/switch/brewser/shell/auth/`
// paths are outside every app's sandbox and no app declares
// `filesystem_read`).
//
// The shell now caches the resolved path in
// `BrowserShell.cachedToolbarAvatarSrc` and refreshes it at exactly
// two seams: end-of-constructor (boot; unproxied `Switch`, no policy)
// and `handleHtmlResponseLive` AFTER `setManifestPermissions` installs
// the incoming page's policy AND ONLY when that policy is shell /
// grant-all (`this.policy.currentAppId() === null`). The post-swap +
// shell-context guard is load-bearing: the resolver reads shell-owned
// paths that only succeed under grant-all, so calling it while a
// restrictive app policy is installed would deny both reads and cache
// the placeholder. `pushToolbarState` reads the cached field and never
// calls into this resolver. Do NOT re-introduce a direct call to
// `resolveActiveSessionAvatarPath` from any tick-driven surface AND
// do NOT relocate the `handleHtmlResponseLive` refresh call to before
// the `setManifestPermissions` swap or remove its `currentAppId() ===
// null` guard — verify-patches.sh has #105 checks for both.

const AUTH_DIR_ABS = 'sdmc:/switch/brewser/shell/auth/';
const ACTIVE_PATH_ABS = `${AUTH_DIR_ABS}active.json`;
const DEFAULT_TOOLBAR_AVATAR_SRC = 'sdmc:/switch/brewser/shell/assets/avatar_default.png';
const KNOWN_PROVIDERS = ['google', 'microsoft'] as const;
type KnownProvider = typeof KNOWN_PROVIDERS[number];

function readJsonFile(path: string): unknown {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(path);
	} catch {
		return null;
	}
	if (!raw || raw.byteLength === 0) return null;
	try {
		return JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return null;
	}
}

/** Normalise a `config.autorunApp` value into a full URL suitable for
 * {@link BrowserShell.navigateTo}. Empty/whitespace → `null` (autorun
 * disabled, caller falls back to `DEFAULT_HOME_URL`). A leading slash
 * resolves to the `brewser://` origin (`/apps/foo/index.html` →
 * `brewser://apps/foo/index.html`). Any string that already carries a
 * URL scheme (`brewser://…`, `http(s)://…`, `sdmc:/…`) passes through
 * unchanged. Everything else is treated as a bare `brewser://`-relative
 * path with the leading slash implied. */
function resolveAutorunUrl(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
	return `brewser://${s.replace(/^\/+/, '')}`;
}

function fileHasBytes(path: string): boolean {
	let raw: ArrayBuffer | null;
	try { raw = Switch.readFileSync(path); }
	catch { return false; }
	return !!(raw && raw.byteLength > 0);
}

/** Pick the on-disk bitmap path for the currently active session, or
 * `null` when no session is active (or when the named provider's
 * cached avatar files are all empty/missing — covers the case where
 * the download failed at login time, or where a provider like
 * Microsoft has no avatar on the account). 64×64 thumb preferred over
 * the full bitmap because the toolbar slot is 28×28 — the thumb avoids
 * a needless downscale. */
function resolveActiveSessionAvatarPath(): string | null {
	const active = readJsonFile(ACTIVE_PATH_ABS) as { provider?: unknown } | null;
	const providerRaw = active?.provider;
	if (typeof providerRaw !== 'string') return null;
	if (!(KNOWN_PROVIDERS as readonly string[]).includes(providerRaw)) return null;
	const provider = providerRaw as KnownProvider;
	const rec = readJsonFile(`${AUTH_DIR_ABS}${provider}-auth.json`) as {
		id?: unknown;
		avatar_local_thumb_path?: unknown;
		avatar_local_path?: unknown;
	} | null;
	if (!rec || typeof rec.id !== 'string' || rec.id.length === 0) return null;
	const thumb = typeof rec.avatar_local_thumb_path === 'string' ? rec.avatar_local_thumb_path : '';
	const full  = typeof rec.avatar_local_path       === 'string' ? rec.avatar_local_path       : '';
	if (thumb && fileHasBytes(thumb)) return thumb;
	if (full && fileHasBytes(full)) return full;
	return null;
}

/**
 * `Switch.appletType()` return value for the "Application" type —
 * homebrew launched via full-title takeover (no applet hop). Other
 * values mean launched as some kind of applet (LibraryApplet,
 * OverlayApplet, etc.), which is the typical hbmenu-Album-hop path.
 * Source: libnx `AppletType` enum; `AppletType_Application = 0`.
 */
const APPLET_TYPE_APPLICATION = 0;

function readAppletType(): number {
	try {
		return Switch.appletType();
	} catch {
		// If detection fails for any reason, return -1 so the warning
		// path doesn't trigger on a transient native error.
		return -1;
	}
}

/**
 * Maps `Switch.appletType()` numeric returns to the libnx
 * `AppletType_*` names. Mirrors the libnx enum, including the
 * special `-1` "Default" and `-2` "None" sentinels plus `99` for
 * the call-failed-and-caught case in `readAppletType`. Used by the
 * boot-splash + benchmark page to make the raw number readable.
 */
function describeAppletType(value: number): string {
	switch (value) {
		case -2: return 'None';
		case -1: return 'Default / detection failed';
		case 0:  return 'Application (full-app mode)';
		case 1:  return 'SystemApplet';
		case 2:  return 'LibraryApplet';
		case 3:  return 'OverlayApplet';
		case 4:  return 'SystemApplication';
		default: return 'unknown';
	}
}

/**
 * Polls the gamepad until any button is pressed. Used to gate the
 * full-app-mode warning splash. Imports `waitForControllerInput`
 * are tied to the shell's input dispatcher (which handles touch +
 * scroll); for a one-shot "press anything to continue" we want the
 * simpler bare poll: any pressed button on any connected gamepad
 * returns immediately.
 */
async function waitForAnyButton(): Promise<void> {
	const delay = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));
	// Snapshot of currently-held buttons at entry so the user has to
	// press a NEW button — otherwise a residual press from a prior
	// menu (e.g. the user is still holding A from selecting the NRO)
	// would dismiss the splash immediately.
	let anyHeld = anyButtonPressed();
	while (true) {
		const pressed = anyButtonPressed();
		if (anyHeld && !pressed) anyHeld = false;
		if (!anyHeld && pressed) return;
		await delay(50);
	}
}

function anyButtonPressed(): boolean {
	for (const pad of navigator.getGamepads()) {
		if (!pad || !pad.connected) continue;
		for (const button of pad.buttons) {
			if (button.pressed) return true;
		}
	}
	return false;
}

interface ScrollStats {
	/** Wall-clock timestamp (ms, performance.now origin) of each
	 * scroll-tick start. Same indexing as `durationsMs`. */
	timestampsMs: number[];
	/** Time spent inside `handleScroll` per tick — includes the
	 * `repaintContent` call and the ring-buffer push itself. */
	durationsMs: number[];
	/** Time spent inside the content present alone, parallel to
	 * `durationsMs`. Lets the benchmark page show how much of
	 * `handleScroll` is paint work vs JS overhead. */
	presentDurationsMs: number[];
	/** Maximum samples retained; oldest dropped on overflow. */
	capacity: number;
	/** Running total of content presents since the shell started.
	 * Distinguishes "path inactive" (count==0) from "active but each
	 * call <1 ms" (count>0, durations all 0 due to `performance.now()`'s
	 * 1 ms resolution in nx.js). */
	presentCallCount: number;
}

const SCROLL_STATS_CAP = 240;
const scrollStats: ScrollStats = {
	timestampsMs: [],
	durationsMs: [],
	presentDurationsMs: [],
	capacity: SCROLL_STATS_CAP,
	presentCallCount: 0,
};
(globalThis as { __scrollStats?: ScrollStats }).__scrollStats = scrollStats;

function recordScrollSample(
	timestampMs: number,
	durationMs: number,
	presentDurationMs: number,
): void {
	scrollStats.timestampsMs.push(timestampMs);
	scrollStats.durationsMs.push(durationMs);
	scrollStats.presentDurationsMs.push(presentDurationMs);
	if (scrollStats.timestampsMs.length > scrollStats.capacity) {
		scrollStats.timestampsMs.shift();
		scrollStats.durationsMs.shift();
		scrollStats.presentDurationsMs.shift();
	}
}

function stashNetworkStatus(probe: NetworkProbeResult): void {
	(globalThis as { __browserNetworkStatus?: NetworkProbeResult }).__browserNetworkStatus = probe;
}

/** Read libnx's cached operation mode (0 = handheld, 1 = console /
 * docked) via the nx.js `Switch.operationMode()` shim. The value is
 * kept up-to-date asynchronously by libnx's own applet hook on the
 * `OperationModeChanged` message — so this call is effectively a
 * memory read with no IPC cost, safe to poll every tick. Returns -1
 * when the shim is missing (older runtime) so callers can show a
 * blank label without crashing. */
function readOperationMode(): number {
	const sw = (globalThis as { Switch?: { operationMode?: () => number } }).Switch;
	if (!sw?.operationMode) return -1;
	try {
		return sw.operationMode();
	} catch (_) {
		return -1;
	}
}

/** Only real web pages are bookmarkable. Local `brewser://` pages (and
 * any non-http(s) scheme like `romfs:` / `sdmc:`) hide the star button
 * and ignore the bookmark action. */
function isBookmarkable(url: string | null | undefined): boolean {
	return !!url && /^https?:\/\//i.test(url);
}

/** Read the boot probe and report whether an HTTP(S) attempt actually
 * reached the internet. The probe also runs a romfs read to isolate
 * the socket layer; a romfs success on its own doesn't mean the
 * device has internet, so we filter for `http://` / `https://` URLs.
 * Returns `undefined` while the probe is still running so the chrome
 * indicator can be hidden rather than wrong. */
function readInternetReachable(): boolean | undefined {
	const probe = (globalThis as { __browserNetworkStatus?: NetworkProbeResult }).__browserNetworkStatus;
	if (!probe) return undefined;
	return probe.attempts.some((a) => /^https?:\/\//i.test(a.url) && a.reachable);
}
