import { nxScreen, WebView, type WebViewDelegate } from '@switch-web/runtime';

// Shell-input diagnostic. Writes which `input.kind` the shell saw and
// before/after the navigateTo dispatch — narrows whether a click ever
// reached navigateTo, vs. the touch listener never firing, vs. the
// navigation hanging in load().
const _SHELL_INPUT_DIAG_PATH = 'sdmc:/switch/webprofiles/default/khronos-logs/shell-nav-diag.log';
const _shellInputDiagStart = Date.now();
function _shellInputDiag(label: string): void {
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
	KEYBOARD_LAYOUT,
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
import { getLiveRoot, getLiveTreeVersion, resetLiveRoot, setLiveProfileRoot, setLivePageBase, type LiveElement } from './scripts/live-dom.js';
import { getComputedLiveStyle } from './scripts/live-css.js';
import { setCssViewport } from './scripts/inline-css.js';
import { setKeyboardOpener } from './scripts/live-form.js';
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
	overlayLiveAnimatedCanvases, paintLiveOverlay, patchLiveDirtyRegions,
	resetLiveOverlayCache, setLiveBuildChunkMs, setLiveScrollChunkMs,
} from './scripts/live-overlay.js';
import {
	consumeFullRepaintRequest, isKeyboardOpen, requestFullRepaint,
} from './scripts/live-paint-control.js';
import { getLayoutBox } from './scripts/live-layout.js';
import { populateLiveRoot } from './scripts/html-to-live.js';
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
	waitForControllerInput,
	type BrowserMode,
} from './input/controller-shortcuts.js';
import { KeyboardOverlay } from './input/keyboard-overlay.js';
import { BookmarksStore } from './navigation/bookmarks-store.js';
import { BrowserNavigation } from './navigation/browser-navigation.js';
import { HistoryStore } from './navigation/history-store.js';
import { probeNetwork, type NetworkProbeResult } from './network/network-probe.js';
import { BrowserPermissionPolicy } from './permissions/browser-permission-policy.js';
import { BrowserProfile } from './profile/browser-profile.js';
import { DEFAULT_TEMPLATE, loadConfig, loadTemplate, resolveSearchEngine, type BrowserTemplate } from './profile/browser-template.js';
import { BrowserBookmarksLoader } from './resources/browser-bookmarks-loader.js';
import { BrowserHistoryLoader } from './resources/browser-history-loader.js';
import { BrowserResourceLoader } from './resources/browser-resource-loader.js';
import { loadChromeIcons, loadOptionalImage } from './resources/chrome-icons.js';

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
	private mode: BrowserMode = 'normal';
	private template: BrowserTemplate = DEFAULT_TEMPLATE;
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

	constructor() {
		this.policy = new BrowserPermissionPolicy();
		this.profile = new BrowserProfile();
		this.profile.ensure();
		// Read config.json upfront so the HistoryStore is constructed with
		// the user's `maxHistory` cap (loadConfig falls back to DEFAULT_CONFIG
		// on first run before seedTemplates has copied the romfs default in;
		// either way maxHistory ends up at the same value).
		const startupConfig = loadConfig(this.profile.storageRoot);
		this.historyStore = new HistoryStore({
			path: this.profile.historyPath(),
			maxEntries: startupConfig.maxHistory,
		});
		this.bookmarksStore = new BookmarksStore({ path: this.profile.bookmarksPath() });
		const delegate: WebViewDelegate = {
			onPageStarted: () => {
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
				clearAllVideos();
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
				// route them as static-asset 404s. `browser://history/`
				// (no .json) falls through to the static-page loader,
				// which serves `pages/history.html`.
				resourceLoaders: [
					new BrowserHistoryLoader(this.historyStore),
					new BrowserBookmarksLoader(this.bookmarksStore),
					new BrowserResourceLoader({
						profileRoot: this.profile.storageRoot,
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
		setKeyboardOpener((initial) => this.keyboard.open(initial, {
			onScroll: (delta) => this.handleScroll(delta),
		}));
		// Let live-DOM `<img>` resolve profile-pages-relative srcs
		// (`../pages/<rest>`) to the absolute SD-card profile path, so page
		// images load the editable profile copy instead of nx.js's romfs
		// base (which needs a .nro rebuild + redeploy to update).
		setLiveProfileRoot(this.profile.storageRoot);
	}

	async run(): Promise<void> {
		this.webView.initialize();
		// Touch listener must be installed after the WebView has touched up
		// the canvas; it stays installed for the whole shell lifetime. It
		// handles both chrome strip taps and content-area link taps.
		installCanvasTouch();
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
		await this.profile.seedBuiltinAssets();
		await this.profile.seedTemplates();
		// Apply shell-level preferences from config.json. Done before
		// loadTemplate so any future config-driven template overrides
		// can layer on top, and before scanForAutoplayVideos runs (it
		// reads videoTryHwAccel via openDecoder).
		const shellConfig = loadConfig(this.profile.storageRoot);
		setVideoTryHwAccel(shellConfig.videoNVTEGRA);
		setLiveBuildChunkMs(shellConfig.renderChunkMs);
		setLiveScrollChunkMs(shellConfig.scrollChunkMs);
		// Load the design template + push it into the UI, keyboard,
		// and touch dispatcher so the very first chrome paint already
		// reflects the user's customisations.
		this.template = loadTemplate(this.profile.storageRoot);
		this.ui.setTemplate(this.template);
		this.keyboard.setTemplate(this.template);
		this.publishChromeRegion();
		this.ui.setIcons(await loadChromeIcons(this.resolveIconPaths()));
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
						return false;
					},
				});
				_shellInputDiag('input.kind=' + input.kind +
					(input.kind === 'navigate' ? ' url=' + input.url : ''));
				switch (input.kind) {
					case 'exit':
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
						await this.navigateTo('browser://settings/');
						break;
					case 'star':
						this.toggleBookmark();
						break;
					case 'reload':
						await this.runNavigation(() => this.navigation.reload());
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
	 * `<img>` srcs resolve page-relative — but producing a `browser://` URL
	 * (navigation goes through the resource loaders, which serve
	 * `browser://`). Absolute URLs (any scheme) pass through; a root-relative
	 * `/foo` re-roots at the browser origin; everything else resolves against
	 * the current page's directory with `.`/`..` handling. */
	private resolveNavUrl(url: string): string {
		const u = url.trim();
		if (!u) return u;
		if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;          // has scheme → absolute
		const base = this.currentPageUrl;
		if (!/^browser:\/\//i.test(base)) return u;            // no browser base → leave as-is
		if (u.startsWith('#')) return base.split('#')[0] + u;  // same-page fragment
		if (u.startsWith('/')) return `browser://${u.replace(/^\/+/, '')}`; // root-relative
		const basePath = base.replace(/^browser:\/\//i, '').split('?')[0].split('#')[0];
		const slash = basePath.lastIndexOf('/');
		const parts = (slash >= 0 ? basePath.slice(0, slash) : '').split('/').filter(Boolean);
		const [path, tail] = [u.split(/[?#]/)[0], u.slice(u.split(/[?#]/)[0].length)];
		for (const seg of path.split('/')) {
			if (seg === '' || seg === '.') continue;
			if (seg === '..') { parts.pop(); continue; }
			parts.push(seg);
		}
		return `browser://${parts.join('/')}${tail}`;
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
		// `browser://` pages hide the star. Keep the touch handler's
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
	}

	/**
	 * Star-button handler: toggle the current URL in the bookmarks
	 * store, then redraw the chrome so the star colour reflects the
	 * new state. URL with no current page (e.g. immediately after a
	 * failed navigation) is a no-op.
	 */
	private toggleBookmark(): void {
		const url = this.navigation.currentURL;
		// Only http/https pages are bookmarkable; local browser:// pages
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
		// On-canvas keyboard is up: paint only the page area above the
		// keyboard panel via the clipped path so the keyboard's pixels
		// stay intact. The normal repaintContent path early-returns on
		// `isKeyboardOpen()` and would otherwise no-op the scroll.
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
		return this.template.toolbar.position === 'top' ? this.template.toolbar.height : 0;
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

	/** SD-card directory of a `browser://` page, used as the base for
	 * page-relative `<img>` srcs (`./assets/x.png`), like a browser uses the
	 * document URL. Mirrors `BrowserResourceLoader.classifyUrl`'s HTML
	 * resolution so the base matches the file that actually loaded:
	 *   - explicit file (`.../index.html`) → its parent dir.
	 *   - directory form (`browser://welcome/`) → the loader tries
	 *     `<path>.html` first (→ base is the PARENT, e.g. welcome.html lives
	 *     in `pages/`), then `<path>/index.html` (→ base is `<path>/`).
	 * Non-`browser://` URLs return '' (no page base). */
	private computeLivePageBase(url: string): string {
		if (!/^browser:\/\//i.test(url)) return '';
		const root = this.profile.storageRoot;
		const stripped = url.replace(/^browser:\/\//i, '')
			.split('?')[0].split('#')[0].replace(/^\/+/, '').replace(/\/+$/, '');
		if (!stripped) return `${root}pages/`;
		const slash = stripped.lastIndexOf('/');
		const lastSeg = stripped.slice(slash + 1);
		const parentDir = slash >= 0 ? stripped.slice(0, slash + 1) : '';
		// Explicit file → base is its parent directory.
		if (!url.endsWith('/') && lastSeg.includes('.')) {
			return `${root}pages/${parentDir}`;
		}
		// Directory form: prefer the `<path>.html` candidate (loaded from the
		// PARENT dir) when that file exists, else `<path>/index.html`.
		const htmlCandidate = `${root}pages/${stripped}.html`;
		let htmlExists = false;
		try {
			const sw = (globalThis as { Switch?: { readFileSync?: (p: string) => unknown } }).Switch;
			if (sw && typeof sw.readFileSync === 'function') htmlExists = !!sw.readFileSync(htmlCandidate);
		} catch (_) { htmlExists = false; }
		return htmlExists ? `${root}pages/${parentDir}` : `${root}pages/${stripped}/`;
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
		// Page-relative `<img>` base: the SD-card directory of THIS page, so
		// `./assets/x.png` resolves like a browser would (index.html as base).
		setLivePageBase(this.computeLivePageBase(url));
		// Resolve `vw`/`vh` units against the CONTENT area (the canvas minus
		// the toolbar chrome), not the full screen. Set BEFORE scripts run +
		// the first computed-style resolution so a page's `height: 100vh`
		// fills exactly the visible content area instead of overflowing it by
		// the toolbar height (which forced a scroll on the SwitchSurf player's
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

		const allowScripts = url.startsWith('browser://');
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

		// Apply template-defined body insets via padding on the live root,
		// but only when the page itself didn't set them (via `<body
		// style="padding:...">` or similar). The body's box still spans
		// the full viewport so its bg color extends edge-to-edge; only
		// the contentX/contentW inset so text + tables don't hug the
		// screen edges.
		const liveRoot = getLiveRoot();
		const sidePad = this.template.page.sidePadding ?? 0;
		const topPad = this.template.page.topPadding ?? 0;
		// Skip the template chrome inset for full-bleed pages — a body that
		// hides overflow is a fixed-viewport app laying itself out to the
		// screen edges (e.g. a `width:100vw; height:100vh` grid). Injecting
		// side padding there double-insets the left AND pushes the 100vw
		// child past the right edge (the SwitchSurf player's big left gap +
		// clipped library). Such pages own their insets via their own
		// padding. Scrolling content pages (overflow visible/auto) still get
		// the inset so text/tables don't hug the screen edges.
		const rootCs = getComputedLiveStyle(liveRoot);
		const fullBleed = rootCs.overflowX === 'hidden' || rootCs.overflowY === 'hidden';
		if (!fullBleed) {
			if (liveRoot.style.paddingLeft === undefined) liveRoot.style.paddingLeft = sidePad;
			if (liveRoot.style.paddingRight === undefined) liveRoot.style.paddingRight = sidePad;
			if (liveRoot.style.paddingTop === undefined) liveRoot.style.paddingTop = topPad;
		}

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
		// On-canvas keyboard is modal — its panel is drawn directly to
		// the screen by `KeyboardOverlay.render` and owns the screen
		// while open. The shell's content + overlay repaint paths would
		// stomp those pixels every frame (rAF heartbeat / scroll tick
		// / animated-canvas overlay all fire while the keyboard is up).
		// Gate the WHOLE repaint here so the keyboard stays on top of
		// everything. When the keyboard closes, `setKeyboardOpen(false)`
		// auto-flags `requestFullRepaint()` so the next call clears the
		// keyboard pixels by re-painting the page underneath.
		//
		// `behindKeyboard` opts in to the scroll-behind-keyboard path:
		// the page is re-blitted under a clip rect that ends at the
		// keyboard panel's top edge so the panel pixels stay intact
		// while content scrolls underneath. See the branch below.
		if (isKeyboardOpen() && !opts.behindKeyboard) return;
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
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
		const isBottomToolbar = this.template.toolbar.position === 'bottom';
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
		ctx.fillStyle = this.template.page.background;
		ctx.fillRect(
			0, paintTopInset,
			canvas.width, canvas.height - paintTopInset - paintBottomInset,
		);
		const t0 = performance.now();
		paintLiveOverlay(ctx, getLiveRoot(), viewport, effectiveScrollY);
		// Skip the walk on otherwise-static pages.
		if (pageHasAnimationActivity() || pageHasActiveVideo() || pageHasAnyPoster()) {
			overlayLiveAnimatedCanvases(
				ctx, getLiveRoot(), viewport, effectiveScrollY,
				copyBridgeToScreen,
			);
		}
		setLiveViewport(viewport, effectiveScrollY);
		this.lastCpuPresentMs = performance.now() - t0;
		this.cpuPresentCallCount++;
		this.lastRepaintedScrollY = effectiveScrollY;
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
		const isBottomToolbar = this.template.toolbar.position === 'bottom';
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
		const panelTop = KEYBOARD_LAYOUT.topY;
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
			ctx.fillStyle = this.template.page.background;
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
	 * Search-bar handler: opens the on-screen keyboard for a query, then
	 * navigates to the active search engine's results URL (engine chosen
	 * via `config.json` → `search_engines.json`). Empty / cancelled
	 * input just repaints the current page.
	 */
	private async promptAndSearch(): Promise<void> {
		const engine = resolveSearchEngine(this.profile.storageRoot);
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
		const configPath = `${this.profile.storageRoot}config.json`;
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
				next = { ...loadConfig(this.profile.storageRoot), template: path };
			}
			Switch.writeFileSync(configPath, JSON.stringify(next, null, 2));
		} catch (error) {
			console.debug(`[switch-web-browser] write config.json failed: ${error}`);
			return;
		}
		this.template = loadTemplate(this.profile.storageRoot);
		this.ui.setTemplate(this.template);
		this.keyboard.setTemplate(this.template);
		this.publishChromeRegion();
		// Icons may have changed paths between templates — refresh them
		// before the next chrome render.
		this.ui.setIcons(await loadChromeIcons(this.resolveIconPaths()));
		await this.refreshTemplateBackgrounds();
		// Reload the current page: re-runs the resource loader (so the
		// new active template row shows) and re-paints with the new
		// colours / padding.
		await this.runNavigation(() => this.navigation.reload());
	}

	/** Load (or clear) the toolbar + keyboard background images
	 * referenced by the current template and hand them to the UI /
	 * keyboard. Empty / missing / failed paths come back as `null`,
	 * which the painters treat as "no image — bg colour only". */
	private async refreshTemplateBackgrounds(): Promise<void> {
		const [toolbarBg, keyboardBg] = await Promise.all([
			loadOptionalImage(this.resolveAssetPath(this.template.toolbar.image)),
			loadOptionalImage(this.resolveAssetPath(this.template.keyboard.image)),
		]);
		this.ui.setToolbarBackground(toolbarBg);
		this.keyboard.setPanelBackground(keyboardBg);
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
		const isBottomToolbar = this.template.toolbar.position === 'bottom';
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
		ctx.fillStyle = this.template.page.background;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		this.repaintContent();
		if (this.mode === 'normal') this.renderChrome();
	}

	/** Resolve each `template.icons.X` path against the profile root
	 * unless the user supplied an absolute scheme. Lets a custom
	 * template point at icons elsewhere (e.g. `romfs:/assets/...`,
	 * `sdmc:/themes/.../home.png`). */
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
		if (this.template.toolbar.position === 'top') {
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
	 * decoder renders RGB as invisible (see SwitchSurf_logo.png). */
	private async paintBootSplash(): Promise<void> {
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#00010a';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		const logo = await loadOptionalImage('romfs:/assets/SwitchSurf_logo.png');
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
			ctx.fillText('SwitchSurf', canvas.width / 2, canvas.height / 2);
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

/** Only real web pages are bookmarkable. Local `browser://` pages (and
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
