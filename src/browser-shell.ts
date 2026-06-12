import { captureNativeFetch, nxScreen, setNavDebugEnabled, WebView, type WebViewDelegate } from '@switch-web/runtime';

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
} from './browser-config.js';
import { BrowserUI } from './browser-ui.js';
import {
	clearAnimationFrames,
	clearSharedScreenGLBridge,
	copyBridgeToScreen,
	isWebGLBackedCanvas,
	pageHasAnimationActivity,
	runPageScripts,
	tickAnimationFrames,
	type PageScriptContext,
} from './scripts/canvas-runner.js';
import { clearCssAnimations, clearGifAnimations, dispatchPageKeyEvent, getLiveRoot, getLiveTreeVersion, LiveElement, pageHasListenerFor, resetLiveRoot, setInputFocusHandler, setLivePageBase, setSwbImgDebugEnabled } from './scripts/live-dom.js';
import { setMediaColorScheme } from './scripts/live-css.js';
import { setCssViewport } from './scripts/inline-css.js';
import { getInputChecked, getInputValue, openKeyboardAndApply, setKeyboardOpener, setLiveFormColorScheme } from './scripts/live-form.js';
import {
	VIDEO_CONTROLS_BAR_H,
	clearAllVideos,
	pageHasActiveVideo,
	pageHasAnyPoster,
	paintVideoControls,
	paintVideoFrameAt,
	scanForAutoplayVideos,
	setVideoTryHwAccel,
	tickVideo,
	videoPause,
	videoPlay,
	videoSeekRatio,
	videoStop,
	videoToggleMute,
} from './scripts/live-video.js';
import {
	getLiveContentBottom, isLiveCacheBuilding, isLiveCacheReady,
	overlayLiveAnimatedCanvases, paintKeyboardOverlay, paintLiveOverlay,
	patchLiveDirtyRegions, resetLiveOverlayCache, setLiveBuildChunkMs,
	setLiveScrollChunkMs,
} from './scripts/live-overlay.js';
import {
	clearPageHasCanvas2dActivity,
	consumeFullRepaintRequest,
	getKeyboardLiveRoot,
	getKeyboardTopY,
	hasPageCanvas2dActivity,
	isKeyboardOpen,
	isKeyboardOverlayVisible,
	requestFullRepaint,
	setKeyboardLiveRoot,
	setKeyboardTopY,
} from './scripts/live-paint-control.js';
import { getLayoutBox } from './scripts/live-layout.js';
import { isExternalCssLoading, loadHeadLinkStylesheetsWithFlag, populateLiveRoot, populateRootFromTree } from './scripts/html-to-live.js';
import { extractTitle, parseHtml, type HtmlElement } from './html/html-parser.js';
import { AddressBarInput } from './input/address-bar-input.js';
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
} from './input/controller-shortcuts.js';
import { KeyboardOverlay, setKeyboardRepaintDriver } from './input/keyboard-overlay.js';
import { installPageTouchForwarder } from './input/page-touch-forwarder.js';
import {
	installPageMouseForwarder,
	setCursorIdleMs,
} from './input/page-mouse-forwarder.js';
import { clearAppButtonOverlay, setAppButtonOverlay, setButtonMapping } from './input/button-router.js';
import {
	preloadClickSound,
	setClickSoundEnabled,
	setClickSoundPath,
} from './audio/click-sound.js';
import { BookmarksStore } from './navigation/bookmarks-store.js';
import { BrowserNavigation } from './navigation/browser-navigation.js';
import { HistoryStore } from './navigation/history-store.js';
import { probeNetwork, type NetworkProbeResult } from './network/network-probe.js';
import { BrowserPermissionPolicy } from './permissions/browser-permission-policy.js';
import { BrowserProfile } from './profile/browser-profile.js';
import { DEFAULT_CONFIG, DEFAULT_TEMPLATE, loadConfig, loadTemplate, resolveSearchEngine, type BrowserTemplate, type ToolbarPosition } from './profile/browser-template.js';
import { BrowserBookmarksLoader } from './resources/browser-bookmarks-loader.js';
import { BrowserHistoryLoader } from './resources/browser-history-loader.js';
import { BrowserResourceLoader } from './resources/browser-resource-loader.js';
import { loadChromeIcons, loadOptionalImage } from './resources/chrome-icons.js';
import { SwitchUaFetchLoader } from './resources/switch-ua-fetch-loader.js';

/**
 * Top-level orchestrator for the browser shell.
 *
 *   - **ZR** (rising-edge) OR **tap on the chrome strip** → open the
 *     on-canvas keyboard. Submit navigates; cancel reloads the current page
 *     (to clear the keyboard pixels from the canvas).
 *   - **L + R + Minus** held ~1s → exit the shell.
 */
export class BrowserShell {
	private readonly policy: BrowserPermissionPolicy;
	private readonly profile: BrowserProfile;
	private readonly historyStore: HistoryStore;
	private readonly bookmarksStore: BookmarksStore;
	private readonly webView: WebView;
	private readonly navigation: BrowserNavigation;
	private readonly ui: BrowserUI;
	private readonly keyboard: KeyboardOverlay;
	private readonly addressBar: AddressBarInput;

	private currentScrollY = 0;
	private scriptCtx: PageScriptContext | null = null;
	private currentPageUrl: string = '';
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

	/** Public read-only accessor for the current page URL. Used by
	 * storage modules (local-storage, indexed-db) to route writes to a
	 * `dev/` sub-namespace when the active page is under `brewser://dev/`,
	 * keeping dev test artifacts out of the real user storage roots. */
	getCurrentPageUrl(): string { return this.currentPageUrl; }
	private mode: BrowserMode = 'normal';
	private template: BrowserTemplate = DEFAULT_TEMPLATE;
	/** Active toolbar position. Sourced from `config.json` (not the
	 * template) since 2026-06-11 so the user can flip it from Settings
	 * without re-skinning. Pushed into BrowserUI on every change so
	 * the next paint flips chrome to the new edge. */
	private toolbarPosition: ToolbarPosition = DEFAULT_CONFIG.toolbarPosition;
	/** Last-applied resolved chrome icon paths. Used to gate template-
	 * change icon reloads: when the new template's icon paths match the
	 * already-loaded set, we keep the existing `Image` references on
	 * BrowserUI rather than fetching the same URLs again. Re-fetching
	 * the same icon URL during a Settings-page Save flow was painting
	 * the toolbar with broken/partial Image data on the next chrome
	 * tick (the Image objects from the first load are still in use by
	 * the chrome paint; replacing them mid-flight with a second
	 * concurrent load races the renderer). Initialised lazily on first
	 * apply. */
	private lastResolvedIconPaths: string | null = null;
	/** Last-applied resolved toolbar/keyboard background image paths.
	 * Same race-avoidance rationale as `lastResolvedIconPaths` — when
	 * the new template's image paths match the already-applied ones,
	 * skip the re-fetch. */
	private lastResolvedBackgroundPaths: string | null = null;
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
	 * top-level body runs BEFORE `this.scriptCtx` is wired up (the
	 * assignment is `this.scriptCtx = await runPageScripts(...)`, so the
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
	/** Effective scrollY at the end of the last slow-path repaintContent.
	 * The video-only fast path uses this to confirm scrollY hasn't
	 * shifted since the cache was last blitted into screen pixels — if
	 * it has, the persistent pixels under the video are stale and the
	 * slow path must run instead. */
	private lastRepaintedScrollY: number = Number.NaN;
	/** Live tree version the idle-tick path last repainted. Page-script
	 * timer mutations (setTimeout/setInterval) bump the tree version but
	 * fire no rAF / video frame / tap, so without comparing against this
	 * they'd never reach the screen — e.g. the audio player's 4 Hz
	 * updateTimeline advancing the seek bar + time during passive playback. */
	private lastTickTreeVersion: number = -1;
	/** User-preferred colour scheme (config.json `theme`). Drives the
	 * `Sec-CH-Prefers-Color-Scheme` request header on external fetches,
	 * the `@media (prefers-color-scheme:…)` cascade in live-css, and the
	 * effective viewport background colour. Defaults to `light` (the
	 * web's expected default); only `<body>` paint actually covers the
	 * viewport, so internal pages that explicitly set their own bg are
	 * unaffected — only external pages without an explicit `<body>` bg
	 * are influenced. */
	private colorScheme: 'light' | 'dark' = 'light';
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

	constructor() {
		this.policy = new BrowserPermissionPolicy();
		this.profile = new BrowserProfile();
		this.profile.ensure();
		// Read config.json upfront so the HistoryStore is constructed with
		// the user's `maxHistory` cap (loadConfig falls back to DEFAULT_CONFIG
		// on first run before seedTemplates has copied the romfs default in;
		// either way maxHistory ends up at the same value).
		const startupConfig = loadConfig(this.profile.appRoot);
		// Wire the user-editable joycon button mapping. Empty values in
		// `config.json buttonMapping` fall through to engine defaults
		// (A=leftClick, B=rightClick, X=forward, Y=reload,
		// ZR=middleClick, MINUS=screenshot, UP/DOWN=scroll). Used by
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
		this.colorScheme = startupConfig.theme;
		// Push the colour-scheme preference into the CSS cascade up front so
		// the first stylesheet parse evaluates `@media (prefers-color-scheme:
		// …)` against the right value. Also tells the form-widget painter
		// which default palette to fall back to when a page doesn't set
		// explicit `background`/`color` on its inputs / buttons.
		setMediaColorScheme(this.colorScheme);
		setLiveFormColorScheme(this.colorScheme);
		this.historyStore = new HistoryStore({
			path: this.profile.historyPath(),
			maxEntries: startupConfig.maxHistory,
		});
		this.bookmarksStore = new BookmarksStore({ path: this.profile.bookmarksPath() });
		const delegate: WebViewDelegate = {
			onPageStarted: (url: string) => {
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
				this.fullscreenCanvasOriginalSize = null;
				this.fullscreenCanvasLive = false;
				(globalThis as { __swbFullscreenCanvasSize?: { width: number; height: number } | null })
					.__swbFullscreenCanvasSize = null;
				this.navigation.setCurrentTitle(null);
				this.setMode('normal');
				this.currentPageUrl = '';
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
				],
			},
			delegate,
		);
		this.navigation = new BrowserNavigation(this.webView, this.historyStore);
		this.ui = new BrowserUI();
		this.keyboard = new KeyboardOverlay();
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
			// `runPageScripts`, so `this.scriptCtx` is still null and
			// `toggleFullscreenCanvas`'s `if (!this.scriptCtx) return;`
			// would silently swallow the request. Queue it; the loader
			// drains the queue right after assigning scriptCtx.
			if (!this.scriptCtx) {
				return new Promise<void>((resolve) => {
					this.pendingFullscreenCanvasRequest = () => {
						void this.toggleFullscreenCanvas().then(resolve, resolve);
					};
				});
			}
			await this.toggleFullscreenCanvas();
		};
		(globalThis as { __swbExitFullscreen?: () => Promise<void> })
			.__swbExitFullscreen = async () => {
			if (this.mode === 'normal') return;
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
			if (this.mode !== 'normal') await this.exitFullscreen();
			await this.runNavigation(() => this.navigation.goBack());
		};
	}

	async run(): Promise<void> {
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
		setTouchScrollHandler((delta) => this.handleScroll(delta));

		await this.paintBootSplash();
		// Copy missing built-in pages, toolbar icons, and template.json
		// from romfs into the profile dir. Cheap on every launch
		// (existence check + skip for files that already exist) so the
		// user's edits survive but a deleted file is restored next run.
		await this.profile.seedBuiltinPages();
		await this.profile.seedBuiltinDevPages();
		await this.profile.seedBuiltinAssets();
		await this.profile.seedTemplates();
		await this.profile.seedKeyboards();
		await this.profile.seedStyles();
		// HTML-driven keyboard: parse `keyboard.html` once into a second
		// live-DOM root. Painted below `KEYBOARD_LAYOUT.topY` when
		// `KeyboardOverlay.open()` flips the overlay-visible flag on.
		await this.loadHtmlKeyboard();
		// Keyboard's open() ticks repaints via this driver since the
		// main shell loop is suspended on its promise. Single-arg
		// arrow keeps `this` bound to the shell.
		setKeyboardRepaintDriver(() => this.repaintContent());
		// Apply shell-level preferences from config.json. Done before
		// loadTemplate so any future config-driven template overrides
		// can layer on top, and before scanForAutoplayVideos runs (it
		// reads videoTryHwAccel via openDecoder).
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
		// Load the design template + push it into the UI, keyboard,
		// and touch dispatcher so the very first chrome paint already
		// reflects the user's customisations.
		this.template = loadTemplate(this.profile.appRoot);
		this.ui.setTemplate(this.template);
		this.keyboard.setTemplate(this.template);
		// Toolbar position lives in `config.json` (not the template)
		// since 2026-06-11 — cache it on the shell + push into the UI
		// so chrome paints on the correct edge from the first frame.
		this.toolbarPosition = shellConfig.toolbarPosition;
		this.ui.setToolbarPosition(this.toolbarPosition);
		this.publishChromeRegion();
		await this.refreshChromeIcons();
		await this.refreshTemplateBackgrounds();
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

		await this.navigateTo(DEFAULT_HOME_URL);

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
						// Preserve the prior short-circuit (only run
						// tickVideo when nothing rAF-shaped fired) for
						// back-compat.
						const animFired = tickAnimationFrames();
						const videoFired = animFired ? false : tickVideo();
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
						if (info.scrolledThisTick) {
							return false; // build-continuation deferred to next idle tick
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
						// Cursor moved or button edge fired. The cursor
						// is composited at C-side present time
						// (`composite_cursor_overlay` in main.c) using
						// the bitmap + (x, y) `tickMouseInput` just
						// pushed via `setCursorOverlayPosition`. No JS
						// paint or full repaint is needed here —
						// keeping the loop active is the only reason
						// we still return `true`, so the next vsync
						// memcpy picks up the new position.
						if (mouseTick.cursorChanged) {
							return true;
						}
						return false;
					},
				});
				_shellInputDiag('input.kind=' + input.kind +
					(input.kind === 'navigate' ? ' url=' + input.url : ''));
				switch (input.kind) {
					case 'exit':
						// Context-aware. While an app page is active (URL
						// under `brewser://apps/<group>/<id>/...`), "exit"
						// means EXIT THE APP — close any fullscreen-canvas
						// then walk one nav step back to the launcher. On
						// any non-app page, the historical shell-quit
						// semantic holds and we return from the input loop.
						if (this.currentAppDir) {
							if (this.mode !== 'normal') await this.exitFullscreen();
							await this.runNavigation(() => this.navigation.goBack());
							break;
						}
						return;
					case 'address-bar':
						await this.promptAndNavigate();
						break;
					case 'back':
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
					case 'star':
						this.toggleBookmark();
						break;
					case 'reload':
						await this.runNavigation(() => this.navigation.reload());
						break;
					case 'screenshot':
						this.captureScreenshot();
						break;
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
						// L+R+Minus for the shell-exit combo).
						if (this.mode !== 'normal') await this.exitFullscreen();
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
		const u = url.trim();
		if (!u) return u;
		if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;          // has scheme → absolute
		const base = this.currentPageUrl;
		if (/^https?:\/\//i.test(base)) {
			try {
				return new URL(u, base).toString();
			} catch (_) {
				return u;
			}
		}
		if (!/^brewser:\/\//i.test(base)) return u;            // no recognised base → leave as-is
		if (u.startsWith('#')) return base.split('#')[0] + u;  // same-page fragment
		if (u.startsWith('/')) return `brewser://${u.replace(/^\/+/, '')}`; // root-relative
		const basePath = base.replace(/^brewser:\/\//i, '').split('?')[0].split('#')[0];
		const slash = basePath.lastIndexOf('/');
		const parts = (slash >= 0 ? basePath.slice(0, slash) : '').split('/').filter(Boolean);
		const [path, tail] = [u.split(/[?#]/)[0], u.slice(u.split(/[?#]/)[0].length)];
		for (const seg of path.split('/')) {
			if (seg === '' || seg === '.') continue;
			if (seg === '..') { parts.pop(); continue; }
			parts.push(seg);
		}
		return `brewser://${parts.join('/')}${tail}`;
	}

	private async navigateTo(url: string): Promise<void> {
		setNavigating(true);
		try {
			await this.navigation.navigate(url);
			this.renderChrome(url);
		} finally {
			setNavigating(false);
		}
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
		this.ui.renderAddressBar({
			currentURL: url,
			canGoBack: this.navigation.controller.canGoBack,
			canGoForward: this.navigation.controller.canGoForward,
			bookmarked: bookmarkable && url ? this.bookmarksStore.has(url) : false,
			bookmarkable,
			internetReachable: reachable,
		}, modeLabel);
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
		// Scrolling is meaningless in fullscreen-canvas (no layout flow)
		// and in video-fullscreen (the page underneath isn't visible —
		// scrolling its hidden position would surprise the user on exit).
		if (this.mode === 'fullscreen-canvas') return;
		if (this.mode === 'video-fullscreen') return;
		const next = Math.max(0, Math.min(this.maxScroll(), this.currentScrollY + delta));
		if (next === this.currentScrollY) return;
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
	}

	/**
	 * Where the *layout* reserves space at the top: chromeHeight when
	 * the toolbar is at the top of the screen (content has to start
	 * below chrome), 0 when the toolbar is at the bottom.
	 */
	private layoutTopInset(): number {
		return this.toolbarPosition === 'top' ? this.template.toolbar.height : 0;
	}

	/**
	 * Maximum allowed userScrollY for the current mode. In fullscreen
	 * modes the chrome's height becomes visible content area, so the
	 * user needs that much less scroll to reach the bottom. Content
	 * height comes from the live painter's body intrinsic-height cache.
	 */
	private maxScroll(): number {
		const canvas = nxScreen();
		const chromeHeight = this.template.toolbar.height;
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
		// External http(s) pages: return the full page URL so the
		// live-DOM resource resolver can hand it straight to `new URL`
		// for spec-correct relative resolution. Crucial for tier3-style
		// pages like google.com whose logo is referenced as a root-
		// relative `/images/branding/…gif` — without the page URL as
		// base, the IMG src reaches the image pipeline as a path with
		// no scheme/host and 404s. The brewser:// path below keeps its
		// own directory-style resolution because the runtime fetch
		// can't see `brewser:` and we need to map to a profile dir.
		if (/^https?:\/\//i.test(url)) return url;
		if (!/^brewser:\/\//i.test(url)) return '';
		const stripped = url.replace(/^brewser:\/\//i, '')
			.split('?')[0].split('#')[0].replace(/^\/+/, '').replace(/\/+$/, '');
		// Apps live at the app-level root (shared across profiles); the
		// apps.html launcher (no slash after `apps`) stays per-profile.
		// `dev/` is the app-level dev-fixtures + Khronos conformance tree.
		// Mirror of BrowserResourceLoader.resolveContentPath.
		const root = (stripped.startsWith('apps/') || stripped.startsWith('dev/'))
			? this.profile.appRoot
			: this.profile.storageRoot;
		if (!stripped) return root;
		const slash = stripped.lastIndexOf('/');
		const lastSeg = stripped.slice(slash + 1);
		const parentDir = slash >= 0 ? stripped.slice(0, slash + 1) : '';
		// Explicit file → base is its parent directory.
		if (!url.endsWith('/') && lastSeg.includes('.')) {
			return `${root}${parentDir}`;
		}
		// Directory form: prefer the `<path>.html` candidate (loaded from the
		// PARENT dir) when that file exists, else `<path>/index.html`.
		const htmlCandidate = `${root}${stripped}.html`;
		let htmlExists = false;
		try {
			const sw = (globalThis as { Switch?: { readFileSync?: (p: string) => unknown } }).Switch;
			if (sw && typeof sw.readFileSync === 'function') htmlExists = !!sw.readFileSync(htmlCandidate);
		} catch (_) { htmlExists = false; }
		return htmlExists ? `${root}${parentDir}` : `${root}${stripped}/`;
	}

	/** If `url` points inside an installed app — i.e. matches
	 * `brewser://apps/<group>/<id>/...` — return the `apps/<group>/<id>/`
	 * dir prefix. Otherwise `null`. Used to gate the per-app button-router
	 * overlay + the context-aware `exit` action. */
	private extractAppDirFromUrl(url: string): string | null {
		if (!/^brewser:\/\//i.test(url)) return null;
		const stripped = url.replace(/^brewser:\/\//i, '')
			.split('?')[0].split('#')[0].replace(/^\/+/, '');
		if (!stripped.startsWith('apps/')) return null;
		const parts = stripped.split('/');
		// Need at least `apps/<group>/<id>/...` — three segments + a tail.
		if (parts.length < 4 || !parts[1] || !parts[2]) return null;
		return `apps/${parts[1]}/${parts[2]}/`;
	}

	/** Read `<appRoot><appDir>manifest.json` and return its parsed
	 * `buttonMapping` object (or `null` when absent / malformed). Other
	 * manifest fields are ignored here — they belong to the launcher's
	 * catalog rendering, which goes through `catalog.json` instead. */
	private loadAppManifestButtonMapping(appDir: string): Record<string, unknown> | null {
		try {
			const path = `${this.profile.appRoot}${appDir}manifest.json`;
			const raw = (globalThis as { Switch?: { readFileSync?: (p: string) => ArrayBuffer | null } })
				.Switch?.readFileSync?.(path);
			if (!raw) return null;
			const parsed = JSON.parse(new TextDecoder().decode(raw));
			const bm = parsed?.buttonMapping;
			if (!bm || typeof bm !== 'object' || Array.isArray(bm)) return null;
			return bm as Record<string, unknown>;
		} catch (_) {
			return null;
		}
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
	 * loads of the Settings page wrapping the same templates),
	 * `paintLiveOverlay`'s dirty check would say "cache valid" and skip
	 * the rebuild — but the cache's WeakMap is keyed by old (now-
	 * discarded) LiveElement instances, so the new tree has no layout
	 * boxes. `hitTestLive` would then return null for every tap. The
	 * explicit reset breaks the version coincidence.
	 */
	private async handleHtmlResponseLive(url: string, tree: HtmlElement): Promise<void> {
		_shellInputDiag('handleHtmlResponseLive url=' + url);
		resetLiveOverlayCache();
		resetLiveRoot();
		// Rebuild the HTML-driven keyboard's live root so its `<style>`
		// blocks re-register with the now-cleared cascade. The kb root
		// is otherwise orthogonal to the host page — its tree is small,
		// re-population is cheap, and the keyboard panel reads the same
		// across navigations.
		this.rebuildKeyboardLiveRoot();
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
		if (appDir) {
			const appButtonMapping = this.loadAppManifestButtonMapping(appDir);
			setAppButtonOverlay(appButtonMapping);
		} else {
			clearAppButtonOverlay();
		}
		// Page-relative `<img>` base: the SD-card directory of THIS page, so
		// `./assets/x.png` resolves like a browser would (index.html as base).
		setLivePageBase(this.computeLivePageBase(url));
		// Resolve `vw`/`vh` units against the CONTENT area (the canvas minus
		// the toolbar chrome), not the full screen. Set BEFORE scripts run +
		// the first computed-style resolution so a page's `height: 100vh`
		// fills exactly the visible content area instead of overflowing it by
		// the toolbar height (which forced a scroll on the Brewser player's
		// `100vh` grid). resetLiveRoot above cleared the cascade cache, so the
		// new basis is what every `vh`/`vw` resolves against.
		{
			const screen = nxScreen();
			const chromeH = this.template.toolbar.height;
			setCssViewport(screen.width, Math.max(1, screen.height - chromeH));
		}
		const byParsed = populateLiveRoot(tree);
		scanForAutoplayVideos(getLiveRoot());
		_shellInputDiag('  → populated ' + byParsed.size + ' parsed→live mappings');

		// External `<link rel="stylesheet">` fetches run async — fire and
		// forget. The page renders immediately with inline `<style>` + UA
		// defaults; as each sheet arrives, `registerStyleSheet` bumps the
		// live-tree version so the next paint picks up the new cascade.
		// Without this, pages like DDG html-mode that put ALL their CSS
		// in an external sheet rendered with our UA defaults only (green
		// `<a>` text, no `.frm__select` width, no logo url() image, …).
		// Also fired for `brewser://` pages so the shared
		// `brewser://assets/main.css` linked from every per-profile
		// page actually loads — `loadHeadLinkStylesheets` early-
		// returns if the parsed tree has zero <link rel=stylesheet>,
		// so pages without an external sheet pay only a tree walk.
		if (
			url.startsWith('http://')
			|| url.startsWith('https://')
			|| url.startsWith('brewser://')
		) {
			loadHeadLinkStylesheetsWithFlag(tree, url).then(() => {
				requestFullRepaint();
			}).catch(() => { /* per-sheet failures already logged */ });
		}

		const allowScripts = url.startsWith('brewser://');
		// A queued fullscreen request from any prior page should never
		// leak across navigations — the new page's scripts will queue
		// their own if they want it.
		this.pendingFullscreenCanvasRequest = null;
		// Clear scriptCtx BEFORE running the new page's scripts. Otherwise
		// it still points at the PREVIOUS page's context throughout the new
		// page's script execution — and `__swbRequestFullscreenCanvas`'s
		// `if (!this.scriptCtx)` queue-and-defer branch would never fire,
		// so a top-level `canvas.requestFullscreen()` call would route to
		// the stale `toggleFullscreenCanvas` (which would either target the
		// old page's canvas or no-op via firstCanvas() === null) instead of
		// being deferred to run against the freshly-loaded page.
		this.scriptCtx = null;
		this.scriptCtx = await runPageScripts(tree, {
			allowScripts,
			pageUrl: url,
			preserveLiveRoot: true,
		});

		// Wire each runner-owned OffscreenCanvas into the live tree so
		// the painter / per-frame overlay can find it. WebGL-backed
		// canvases are flagged so the painter skips drawImage; the
		// per-frame `overlayLiveAnimatedCanvases` does the bridge →
		// screen direct copy.
		for (const [parsedCanvas, offscreen] of this.scriptCtx.outputs) {
			const liveCanvas = byParsed.get(parsedCanvas);
			if (liveCanvas) {
				liveCanvas.attachOffscreen(offscreen, isWebGLBackedCanvas(offscreen));
			}
		}

		this.fullscreenCanvasOriginalSize = null;
		this.fullscreenCanvasLive = false;
		this.currentPageUrl = url;
		this.currentScrollY = 0;

		// Drain a fullscreen request queued by a top-level script body
		// (e.g. apps/com.natureglass.webgl1demo/index.html that calls
		// `canvas.requestFullscreen()` synchronously at load). Done after
		// scriptCtx is wired up AND the per-nav fullscreen-canvas state
		// fields above are reset to their defaults — otherwise those
		// resets would clobber the mode/state that toggleFullscreenCanvas
		// just established.
		const pendingFullscreen = this.pendingFullscreenCanvasRequest;
		this.pendingFullscreenCanvasRequest = null;
		if (pendingFullscreen) pendingFullscreen();

		// Page padding is the page's responsibility — the engine no longer
		// injects template-defined body insets. The previous behaviour
		// (applying `template.page.topPadding` / `sidePadding` when the
		// page hadn't set explicit padding) silently overrode page CSS
		// that used the `padding:` shorthand, because the check inspected
		// only the long-hand inline `style.paddingLeft` etc. The
		// `topPadding` / `sidePadding` fields remain in the template
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
	 * Painter-side scroll offset added on top of `currentScrollY` so
	 * the layout (which was computed with `topInset = layoutTopInset()`)
	 * is shifted up to fill the chrome area when fullscreen-page is
	 * engaged. With a bottom toolbar the layout has no top prefix, so
	 * no shift is needed.
	 */
	private paintScrollAdjust(): number {
		return this.mode === 'fullscreen-page' ? this.layoutTopInset() : 0;
	}

	/**
	 * Colour to fill the content viewport with before the live-DOM body
	 * paints over it. For `theme: light` (the web's expected default)
	 * we use white so external pages without an explicit `<body>`
	 * background look like they do in every other browser. For
	 * `theme: dark` we fall back to the template's `page.background`
	 * so the user's dark-themed chrome and content stay visually
	 * continuous. The body's own background, when set, always paints
	 * on top — so internal pages that explicitly set their own bg
	 * (welcome, settings, …) are unaffected either way.
	 */
	private effectivePageBackground(): string {
		if (this.colorScheme === 'light') return '#ffffff';
		return this.template.page.background;
	}

	/**
	 * Capture whatever is currently on the screen canvas and write it
	 * to `<profile>/screenshots/screenshot_<timestamp>.png`. Triggered
	 * by the Minus button rising-edge on the active joy-con (handled
	 * via the `screenshot` shell-input kind from controller-shortcuts).
	 *
	 * Implementation notes:
	 *   - `screen.toBlob` is async (the encode runs on a worker), so
	 *     this method returns immediately and the file write happens
	 *     once the PNG blob is ready. No UI feedback for now — the file
	 *     either lands on disk or doesn't.
	 *   - The screenshots dir is created lazily; subsequent shots reuse
	 *     it without re-touching the filesystem for the mkdir.
	 *   - The timestamp uses `YYYY-MM-DDThh-mm-ss-mmmZ` (dots + colons
	 *     replaced with dashes) so the filename is FAT32-safe and
	 *     sortable lexicographically.
	 */
	private captureScreenshot(): void {
		const canvas = nxScreen();
		const dir = `${this.profile.appRoot}screenshots/`;
		try { Switch.mkdirSync(dir); } catch (_) { /* already exists */ }
		const ts = new Date().toISOString().replace(/[:.]/g, '-');
		const path = `${dir}screenshot_${ts}.png`;
		canvas.toBlob((blob: Blob | null) => {
			if (!blob) {
				console.debug('[brewser] screenshot: toBlob returned null');
				return;
			}
			// Flash AFTER toBlob's internal canvas read so the saved PNG
			// does NOT include the flash. Visual confirmation that the
			// shot landed; cleared by a single subsequent cache-blit.
			this.flashScreenshotFeedback();
			blob.arrayBuffer().then((buf: ArrayBuffer) => {
				try {
					Switch.writeFileSync(path, buf);
					console.debug('[brewser] screenshot saved: ' + path);
				} catch (e) {
					console.debug('[brewser] screenshot write failed: '
						+ (e instanceof Error ? e.message : String(e)));
				}
			});
		});
	}

	/**
	 * Brief white-flash overlay on the screen canvas to confirm a
	 * successful screenshot. Drawn DIRECTLY on the framebuffer (one
	 * `fillRect`), then cleared by a single `requestFullRepaint` after
	 * ~80 ms — the next loop tick blits the live-cache offscreen back
	 * over the flashed pixels. Critically:
	 *   - No `bumpLiveTreeVersion`, no `markLiveDirty`, no
	 *     `patchLiveDirtyRegions` — the live tree / layout state is
	 *     unchanged, so the next paint takes the cache-blit fast path
	 *     (not the rebuild path).
	 *   - No `OffscreenCanvas` allocation, no `getImageData`/`putImageData`
	 *     round-trip. One fillRect into the screen ctx + one timer.
	 */
	private flashScreenshotFeedback(): void {
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		// Clip the flash to the page-content area so the toolbar isn't
		// touched — mirrors the inset math the slow-path paint uses
		// (browser-shell.ts ≈ L1103). Fullscreen modes have no chrome,
		// so both insets become 0 and the flash covers everything,
		// which is the right behaviour for video / fullscreen-canvas /
		// fullscreen-page shots.
		const chromeHeight = this.template.toolbar.height;
		const isBottomToolbar = this.toolbarPosition === 'bottom';
		const topInset = this.mode === 'normal' && !isBottomToolbar ? chromeHeight : 0;
		const bottomInset = this.mode === 'normal' && isBottomToolbar ? chromeHeight : 0;
		const flashH = canvas.height - topInset - bottomInset;
		if (flashH <= 0) { setTimeout(() => requestFullRepaint(), 80); return; }
		ctx.save();
		try {
			ctx.fillStyle = 'rgba(255,255,255,0.85)';
			ctx.fillRect(0, topInset, canvas.width, flashH);
		} finally { ctx.restore(); }
		setTimeout(() => requestFullRepaint(), 80);
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
	 * The per-frame `fillRect` of the page background is defensive.
	 * The cache builder fillRects body's bg color across the whole
	 * cache before chunked ops run, but Citron still produces
	 * stacking artifacts without this per-frame backstop — root cause
	 * not yet pinned. Cost: ~10 ms per frame; this is the ~21 FPS gap
	 * on the Three.js cube demo. Reclaim is open work.
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
		// No cursor work needed — the engine composites the overlay onto
		// `display_buffer` at present time, so what we just painted into
		// canvas->data is exactly what the user sees underneath the
		// cursor.
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
		const chromeHeight = this.template.toolbar.height;
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
			&& isLiveCacheReady();
		if (canFastPath) {
			const t0 = performance.now();
			overlayLiveAnimatedCanvases(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
				copyBridgeToScreen,
			);
			this.lastCpuPresentMs = performance.now() - t0;
			this.cpuPresentCallCount++;
			return;
		}
		ctx.fillStyle = this.effectivePageBackground();
		ctx.fillRect(
			0, paintTopInset,
			canvas.width, canvas.height - paintTopInset - paintBottomInset,
		);
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
			overlayLiveAnimatedCanvases(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
				copyBridgeToScreen,
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
		// HTML-driven virtual keyboard — painted ON TOP of the host page's
		// content (and the CSS-loading overlay above) so it stays modal.
		// `KEYBOARD_LAYOUT.topY` is the contract the existing canvas
		// keyboard already advertised: pages keep the area above it, and
		// the panel owns the area below. See `paintKeyboardOverlay` JSDoc
		// for cache + vh/vw scoping notes.
		this.paintHtmlKeyboardIfVisible(ctx, canvas.width, canvas.height);
		setLiveViewport(viewport, effectiveScrollY);
		this.lastCpuPresentMs = performance.now() - t0;
		this.cpuPresentCallCount++;
		this.lastRepaintedScrollY = effectiveScrollY;
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
		const rafCarrier = globalThis as unknown as {
			requestAnimationFrame?: (cb: (t: number) => void) => number;
		};
		const pump = (): void => {
			this.cssLoadingOverlayPumpTid = null;
			if (performance.now() - this.cssLoadingOverlayLastPaintMs > 3000) return;
			// Queue an empty rAF so the shell's `onTick` hits the
			// `animFired` branch and runs `repaintContent` — that's the
			// route that actually presents pixels. A bare
			// `requestFullRepaint` only sets a flag the idle-tick branch
			// may not service when nothing else is moving (the engine-
			// side draw→submit gap noted in
			// [[feedback-swb-idle-paint-needs-touch]]).
			try { rafCarrier.requestAnimationFrame?.(() => { /* presence is the point */ }); }
			catch (_) { /* swallow */ }
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
		if (!this.scriptCtx) {
			{
				const fsViewport = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
				paintLiveOverlay(ctx, getLiveRoot(), fsViewport, 0, overlayOpts);
				setLiveViewport(fsViewport);
			}
			return;
		}
		const target = this.scriptCtx.firstCanvas();
		if (!target) {
			{
				const fsViewport = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
				paintLiveOverlay(ctx, getLiveRoot(), fsViewport, 0, overlayOpts);
				setLiveViewport(fsViewport);
			}
			return;
		}
		const offscreen = this.scriptCtx.outputs.get(target);
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
		const chromeHeight = this.template.toolbar.height;
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
	}

	/**
	 * Handle a tap on an HTML `<button data-action="...">`. Two
	 * action families are recognised:
	 *   - bare strings (`fullscreen-page`, `fullscreen-canvas`,
	 *     `clear-history`) trigger shell-level handlers.
	 *   - `select-template:<path>` (from the Settings page's
	 *     `<browser-templates>` expansion) rewrites `config.json`'s
	 *     `template` field and reloads.
	 * Unknown actions are silently dropped so a malformed
	 * `data-action` doesn't break the page.
	 */
	private async dispatchButtonAction(action: string): Promise<void> {
		if (action.startsWith('select-template:')) {
			await this.selectTemplate(action.slice('select-template:'.length));
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
	 * Settings-page template switcher. Writes the new template path
	 * into `<profile>/config.json`, re-loads the template + icons,
	 * pushes the new design into the UI / keyboard / chrome region,
	 * then reloads the current page so the chrome AND content paint
	 * with the new colours, and the Settings page's
	 * `<browser-templates>` expansion picks up the new active row.
	 */
	private async selectTemplate(path: string): Promise<void> {
		const configPath = `${this.profile.appRoot}config.json`;
		try {
			// Read the raw existing config and merge `template` onto it
			// so every other key survives — today that's
			// `tessellationFix`, but the spread also preserves any
			// future shell preferences AND any unknown keys a user may
			// have hand-edited in. (Using `loadConfig` here instead
			// would re-emit only the fields the parser knows about,
			// dropping unknowns silently — exactly the bug we're
			// avoiding.) On any read/parse failure we fall back to
			// writing a fresh object with the chosen template plus
			// known defaults so the file ends up valid either way.
			let next: Record<string, unknown> = { template: path };
			try {
				const raw = Switch.readFileSync(configPath);
				if (raw) {
					const parsed = JSON.parse(new TextDecoder().decode(raw));
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						next = { ...(parsed as Record<string, unknown>), template: path };
					}
				}
			} catch (_) {
				// Missing or unreadable config — fall through and write
				// a minimal one with sane defaults baked in.
				next = { ...loadConfig(this.profile.appRoot), template: path };
			}
			Switch.writeFileSync(configPath, JSON.stringify(next, null, 2));
		} catch (error) {
			console.debug(`[brewser] write config.json failed: ${error}`);
			return;
		}
		this.template = loadTemplate(this.profile.appRoot);
		this.ui.setTemplate(this.template);
		this.keyboard.setTemplate(this.template);
		this.publishChromeRegion();
		// Icons may have changed paths between templates — refresh them
		// before the next chrome render. Gated on path change so the
		// shared-icon case skips the re-fetch.
		await this.refreshChromeIcons();
		await this.refreshTemplateBackgrounds();
		// Reload the current page: re-runs the resource loader (so the
		// new active template row shows) and re-paints with the new
		// colours / padding.
		await this.runNavigation(() => this.navigation.reload());
	}

	/** Settings-page keyboard switcher. Writes the new keyboard panel
	 * path into `<appRoot>/config.json`, re-reads + parses the new
	 * panel HTML, and rebuilds the keyboard live root so the new
	 * design is active immediately (next time the overlay opens).
	 * Mirrors `selectTemplate`'s write shape — spread the existing
	 * config forward so unknown user-edited keys survive, then write.
	 * Reloads the current page so the Settings page's
	 * `<browser-keyboards>` expansion re-runs against the new active
	 * row. */
	private async selectKeyboard(path: string): Promise<void> {
		const configPath = `${this.profile.appRoot}config.json`;
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
	 * Template changes go through the same loadTemplate + setTemplate +
	 * refreshTemplateBackgrounds dance `selectTemplate` does so the
	 * chrome / keyboard / icons reflect the new design immediately.
	 * Mirrors selectTemplate's write shape: spread the existing config
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
		if (this.isSaveButtonDisabled()) return;
		const configPath = `${this.profile.appRoot}config.json`;
		const prior = loadConfig(this.profile.appRoot);
		const staged = this.readStagedSettings();
		if (Object.keys(staged).length === 0) return; // nothing to commit

		// Spread the on-disk raw object so user-edited unknown keys
		// survive — same shape `selectTemplate` uses.
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

		// Template + searchEngine are read by the resource loader at
		// render time, so a reload picks them up. If template actually
		// changed, push the new design into the UI / keyboard / icons
		// the same way selectTemplate does — otherwise the chrome would
		// keep painting in the old colours until next launch.
		if ('template' in staged && staged.template !== prior.template) {
			this.template = loadTemplate(this.profile.appRoot);
			this.ui.setTemplate(this.template);
			this.keyboard.setTemplate(this.template);
			this.publishChromeRegion();
			await this.refreshChromeIcons();
			await this.refreshTemplateBackgrounds();
		}
		// Keyboard panel HTML is parsed in-process at boot; on change,
		// re-read + re-parse from the new path and rebuild the kb live
		// root so the next overlay open paints with the new design.
		if ('keyboard' in staged && staged.keyboard !== prior.keyboard) {
			await this.loadHtmlKeyboard();
		}
		// Toolbar position: cache on the shell + push to UI so the
		// chrome strip flips edge on the next paint. layoutTopInset +
		// the isBottomToolbar reads in the shell all read from
		// this.toolbarPosition, so updating both fields here is enough.
		if ('toolbarPosition' in staged && staged.toolbarPosition !== prior.toolbarPosition) {
			this.toolbarPosition = fresh.toolbarPosition;
			this.ui.setToolbarPosition(this.toolbarPosition);
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
	private isSaveButtonDisabled(): boolean {
		const find = (el: LiveElement): LiveElement | null => {
			if (el.getAttribute('data-action') === 'save-settings') return el;
			for (const c of el.children) {
				const found = find(c);
				if (found) return found;
			}
			return null;
		};
		const btn = find(getLiveRoot());
		return !!btn && btn.hasAttribute('disabled');
	}

	/** Walk the live root collecting every `[data-setting="<key>"]`
	 * widget and return the staged value per key, clamped + coerced
	 * to match `loadConfig`'s parser. Radios with the same key collapse
	 * to the single checked one's value; unknown keys are dropped.
	 * Numeric out-of-range inputs are clamped (not rejected) so a
	 * type-in like `9999` in `wwwRenderChunkMs` saves as `1000`. */
	private readStagedSettings(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		const visit = (el: LiveElement): void => {
			const key = el.getAttribute('data-setting');
			if (key) this.captureStaged(out, key, el);
			for (const c of el.children) visit(c);
		};
		visit(getLiveRoot());
		return out;
	}

	private captureStaged(out: Record<string, unknown>, key: string, el: LiveElement): void {
		const tag = el.tagName;
		const type = (el.getAttribute('type') ?? '').toLowerCase();
		// Radio groups: only the checked one contributes. An
		// already-recorded value for the same key (from an earlier
		// sibling radio) wins, so the first checked radio in document
		// order is the staged choice.
		if (tag === 'INPUT' && type === 'radio') {
			if (getInputChecked(el) && !(key in out)) out[key] = getInputValue(el);
			return;
		}
		if (tag === 'INPUT' && type === 'checkbox') {
			out[key] = getInputChecked(el);
			return;
		}
		// Numeric inputs: parse + clamp to the same bounds loadConfig
		// uses, so the on-disk value is always valid even if the user
		// type-ins something outside the range.
		if (tag === 'INPUT' && type === 'number') {
			const raw = parseFloat(getInputValue(el));
			if (!Number.isFinite(raw)) return;
			const min = parseFloat(el.getAttribute('min') ?? '');
			const max = parseFloat(el.getAttribute('max') ?? '');
			let v = raw;
			if (Number.isFinite(min)) v = Math.max(min, v);
			if (Number.isFinite(max)) v = Math.min(max, v);
			// maxHistory in particular must be an integer; trunc when
			// the field exposes an integer-shaped range (min/max both
			// integers and no step="0.xxx" overriding the default 1).
			if (Number.isInteger(min) && Number.isInteger(max)) v = Math.trunc(v);
			out[key] = v;
			return;
		}
		// <select> + plain text inputs: pass the raw string through.
		out[key] = getInputValue(el);
	}

	/** Load (or clear) the toolbar + keyboard background images
	 * referenced by the current template and hand them to the UI /
	 * keyboard. Empty / missing / failed paths come back as `null`,
	 * which the painters treat as "no image — bg colour only". */
	private async refreshTemplateBackgrounds(): Promise<void> {
		const toolbarSrc = this.resolveAssetPath(this.template.toolbar.image);
		const keyboardSrc = this.resolveAssetPath(this.template.keyboard.image);
		// Same paths as last apply — Image objects are already mounted
		// on BrowserUI/keyboard, and re-fetching the same URL races the
		// chrome/keyboard paint while the in-flight Image swap settles.
		// Cf. `lastResolvedIconPaths` for the matching gate on the icon
		// PNGs. Empty paths still get cached so a template switching
		// from "no image" → "no image" stays a no-op.
		const key = `${toolbarSrc}|${keyboardSrc}`;
		if (this.lastResolvedBackgroundPaths === key) return;
		const [toolbarBg, keyboardBg] = await Promise.all([
			loadOptionalImage(toolbarSrc),
			loadOptionalImage(keyboardSrc),
		]);
		this.ui.setToolbarBackground(toolbarBg);
		this.keyboard.setPanelBackground(keyboardBg);
		this.lastResolvedBackgroundPaths = key;
	}

	/** Resolve the active template's icon paths and, if any path
	 * differs from the last applied set, reload the `Image` objects
	 * and push them into the UI. When every path matches the previous
	 * apply (the common case across template switches — every shipped
	 * template uses the same `assets/<name>.png` PNGs) the existing
	 * icon `Image` objects on BrowserUI stay in place, avoiding the
	 * re-fetch race that was painting broken icons during the Save
	 * flow on the Settings page. */
	private async refreshChromeIcons(): Promise<void> {
		const paths = this.resolveIconPaths();
		const key = [
			paths.left, paths.right, paths.refresh, paths.home,
			paths.settings, paths.bookmarkTrue, paths.bookmarkFalse,
		].join('|');
		if (this.lastResolvedIconPaths === key) return;
		this.ui.setIcons(await loadChromeIcons(paths));
		this.lastResolvedIconPaths = key;
	}

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

	/** Resolve a template-supplied asset path against the profile
	 * root unless it carries an absolute scheme. Empty in → empty
	 * out, so callers can pass through optional fields directly. */
	private resolveAssetPath(rel: string): string {
		if (!rel) return '';
		if (/^(?:https?:|sdmc:|romfs:)\/\//.test(rel)) return rel;
		return `${this.profile.storageRoot}${rel}`;
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
		const chromeHeight = this.template.toolbar.height;
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
		this.setMode('fullscreen-page');
		this.clampScroll();
		this.repaintAll();
	}

	private async toggleFullscreenCanvas(): Promise<void> {
		if (this.mode === 'fullscreen-canvas') {
			await this.exitFullscreen();
			return;
		}
		if (!this.scriptCtx) return;
		const target = this.scriptCtx.firstCanvas();
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
		await this.scriptCtx.rerun(resizes);
		this.repaintAll();
	}

	private async exitFullscreen(): Promise<void> {
		const wasFullscreenCanvas = this.mode === 'fullscreen-canvas';
		const wasLive = this.fullscreenCanvasLive;
		this.fullscreenCanvasLive = false;
		(globalThis as { __swbFullscreenCanvasSize?: { width: number; height: number } | null })
			.__swbFullscreenCanvasSize = null;
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
		this.repaintAll();
	}

	private async restoreCanvasSize(): Promise<void> {
		if (!this.scriptCtx || !this.fullscreenCanvasOriginalSize) return;
		const target = this.scriptCtx.firstCanvas();
		if (!target) return;
		// Same RAF cleanup rationale as on entering fullscreen-canvas.
		clearAnimationFrames();
		clearAllVideos();
		const resizes = new Map([[target, this.fullscreenCanvasOriginalSize]]);
		await this.scriptCtx.rerun(resizes);
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

	/** Resolve each `template.icons.X` path against the profile root
	 * unless the user supplied an absolute scheme. Lets a custom
	 * template point at icons elsewhere (e.g.
	 * `romfs:/webprofiles/default/assets/...`, `sdmc:/themes/.../home.png`). */
	private resolveIconPaths() {
		const root = this.profile.storageRoot;
		const resolve = (rel: string) => /^(?:https?:|sdmc:|romfs:)\/\//.test(rel) ? rel : `${root}${rel}`;
		const i = this.template.icons;
		return {
			left: resolve(i.back),
			right: resolve(i.forward),
			refresh: resolve(i.refresh),
			home: resolve(i.home),
			settings: resolve(i.settings),
			bookmarkTrue: resolve(i.bookmarkTrue),
			bookmarkFalse: resolve(i.bookmarkFalse),
		};
	}

	/** Tell the touch dispatcher where the chrome strip lives so taps
	 * in that y-range route to chrome-button branches. Called once at
	 * startup after the template is loaded; the toolbar position can
	 * only change via a template edit + relaunch. */
	private publishChromeRegion(): void {
		const canvas = nxScreen();
		const chromeHeight = this.template.toolbar.height;
		if (this.toolbarPosition === 'top') {
			setChromeRegion(0, chromeHeight);
		} else {
			setChromeRegion(canvas.height - chromeHeight, canvas.height);
		}
	}

	/** First thing drawn at boot: the brand background + centered logo,
	 * so the 1–2 s of profile seeding + first-page build reads as a splash
	 * instead of a black screen. The Switch holds this presented frame
	 * through the (blocking) init that follows; the welcome page's first
	 * paint replaces it. `await`ed in `run()` so the logo's async decode
	 * completes before that blocking work begins. Logo loads from romfs
	 * (mounted at boot, before asset seeding); it must be RGBA — the PNG
	 * decoder renders RGB as invisible (see Brewser_logo.png). */
	private async paintBootSplash(): Promise<void> {
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#00010a';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		const logo = await loadOptionalImage('romfs:/webprofiles/default/assets/Brewser_logo.png');
		const li = logo as unknown as { naturalWidth?: number; width?: number; naturalHeight?: number; height?: number } | null;
		const lw = li ? (li.naturalWidth || li.width || 0) : 0;
		const lh = li ? (li.naturalHeight || li.height || 0) : 0;
		if (logo && lw > 0 && lh > 0) {
			const maxDim = 256;
			const scale = Math.min(1, maxDim / Math.max(lw, lh));
			const w = Math.round(lw * scale);
			const h = Math.round(lh * scale);
			ctx.drawImage(logo, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
		} else {
			// Fallback wordmark if the logo can't be decoded.
			ctx.fillStyle = '#ffd35e';
			ctx.font = 'bold 36px system-ui';
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'center';
			ctx.fillText('Brewser', canvas.width / 2, canvas.height / 2);
			ctx.textAlign = 'start';
		}
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
