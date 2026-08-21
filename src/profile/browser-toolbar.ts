/**
 * Toolbar design selection + ancillary shell preferences.
 *
 * 2026-06-14 rip-replace: the engine-drawn toolbar is gone. The active
 * toolbar's *visual* spec is now a full HTML document (parallel to the
 * keyboard, see `[[reference-brewser-template-to-toolbar-rename]]` and
 * the kb wiring in browser-shell.ts). Colours / icon paths / layout all
 * live inside the toolbar HTML's `<style>` + `<body>`; this file no
 * longer carries a `BrowserToolbar` interface.
 *
 * What survives here:
 *   - `BrowserConfig` — every shell preference, including the active
 *     toolbar HTML path (`toolbar`), the chrome strip pixel height
 *     (`toolbarHeight`), and the dark-theme page-bg fill colour
 *     (`pageBackground`).
 *   - `ToolbarEntry` + `loadToolbarRegistry` — the Settings page's
 *     "Toolbar" radio list.
 *
 * Legacy `themes/toolbars/<X>.json` paths in on-disk configs are
 * rewritten in-memory to `themes/toolbars/<X>.html` by `loadConfig` and
 * by `loadToolbarRegistry`. On the next `saveSettings` the rewritten
 * path is persisted, so users who had a `.json` toolbar selected
 * before the migration end up with the matching `.html` selected
 * silently.
 */

import {
	buildDownloadsTab,
	buildLibraryTabs,
	buildMyAppsTab,
	enumerateInstalledApps,
	joinLibrary,
	parseCatalogue,
	parseStats,
	RUNTIME_CONFIG_DEFAULTS,
	type LibraryApp,
	type LibraryTabId,
	type LibraryTabView,
	type NormalizedCatalogue,
	type ParsedStats,
} from '@switch-web/runtime';

export type ToolbarPosition = 'top' | 'bottom';

/** One row in `<profile>/toolbars.json` (also reused by `keyboards.json`
 * and `styles.json` — same `{title, path}` shape). `path` is relative
 * to the profile root unless it carries an absolute scheme (`sdmc:/…`,
 * `romfs:/…`).
 *
 * `height` is the optional per-toolbar chrome strip height in CSS
 * pixels. Used by the toolbar registry only — selecting a toolbar (via
 * the Settings page or `selectToolbar`) caches this value into
 * `config.json`'s `toolbarHeight` so the strip resizes to whatever the
 * picked theme expects. Undefined / non-number = no auto-resize on
 * switch (the existing `toolbarHeight` is preserved). Same clamp band
 * as `loadConfig`'s `toolbarHeight` parse (28-200 px).
 *
 * Wallpapers are NOT part of a style anymore — they live in their own
 * `<profile>/themes/backgrounds.json` registry ({@link BackgroundEntry}),
 * selected independently via `config.json`'s `themeBackground`. */
export interface ToolbarEntry {
	title: string;
	path: string;
	height?: number;
}

/** One row in `<profile>/themes/backgrounds.json` — the wallpaper
 * registry, decoupled from styles/toolbars/keyboards so a background can
 * be chosen independently of the CSS theme. Selected by `title` via
 * `config.json`'s `themeBackground` (the Settings page's Background
 * picker). Every entry needs a unique `title`; the "no wallpaper" option
 * is a normal entry with both fields empty (conventionally titled
 * "None").
 *
 * `background` is the optional static wallpaper image path, painted by
 * the shell between the per-frame page-bg fillRect and `paintLiveOverlay`
 * (see `BrowserShell.paintStyleBackground`).
 *
 * `dynamic` is the optional ANIMATED wallpaper — a self-contained WebGL1
 * fragment-shader asset (`themes/backgrounds/*.frag`) with no per-entry settings
 * (any tuning is baked into the shader source). When set, the shell renders
 * it every frame in place of the static `background`, which remains the
 * fallback when the shader is missing / fails to compile. Both path fields
 * follow the same resolution rules as `ToolbarEntry.path`. */
export interface BackgroundEntry {
	title: string;
	background?: string;
	dynamic?: string;
}

/** In-memory `.json` → `.html` rewrite for legacy toolbar paths. The
 * pre-2026-06-14 toolbar was a JSON design spec; the new one is a
 * full HTML doc at the matching `<name>.html` path. Users with an
 * older `config.json` (or a hand-edited `toolbars.json`) get
 * transparently upgraded — the rewrite happens at read time, and the
 * next `saveSettings` / `selectToolbar` writes the `.html` form back
 * to disk. Paths that don't match the legacy shape pass through
 * unchanged. */
function migrateLegacyToolbarPath(p: string): string {
	if (typeof p !== 'string' || p.length === 0) return p;
	if (!p.toLowerCase().endsWith('.json')) return p;
	// Only rewrite known toolbar-themed paths so a user's hand-rolled
	// `.json` outside `themes/toolbars/` doesn't silently swap to a
	// `.html` they never authored.
	if (!/themes\/toolbars\//i.test(p)) return p;
	return p.slice(0, -'.json'.length) + '.html';
}

/** Shell-level preferences from `<profile>/config.json`. The active
 * toolbar's path is the historical primary key; additional shell
 * preferences slot in alongside.
 *
 * IMPORTANT: when adding a field here, also (a) parse it in
 * `loadConfig` below with the same DEFAULT_CONFIG fallback, AND
 * (b) add it to `romfs/config.json` so the seeded profile copy
 * carries the default value. The toolbar-toggle write path in
 * browser-shell.ts spreads existing keys forward unchanged, so any
 * key present in on-disk config (whether user-set or seeded) survives
 * toolbar changes — keep it that way. */
export interface BrowserConfig {
	/** Path to the active toolbar HTML (e.g. `themes/toolbars/light.html`).
	 * Renamed from `template` 2026-06-12; rip-replaced from a `.json`
	 * design spec to a full HTML doc 2026-06-14. Legacy `.json` paths
	 * pointing inside `themes/toolbars/` are rewritten to `.html` on
	 * read by {@link loadConfig}; the next `saveSettings` persists the
	 * `.html` form. The shell parses the file once at boot into its
	 * own scoped live root (`__brewser-toolbar-root`) and paints it
	 * into the chrome strip area each frame. */
	toolbar: string;
	/** Chrome strip height in CSS pixels. The toolbar HTML's `<body>`
	 * uses `min-height: 100vh` so it stretches to fit whatever value
	 * sits here. Clamped at load time to keep small enough that one
	 * row of page content stays visible above (top) or below (bottom)
	 * the strip. Mirrors the {@link keyboardHeight} pattern. */
	toolbarHeight: number;
	/** Fallback page background colour for the dark theme (the engine
	 * fills the content viewport with this before the live-DOM body
	 * paints over it). Light theme always uses `#ffffff`. Hoisted
	 * out of the old `BrowserToolbar.page.background` field 2026-06-14
	 * when the engine-drawn toolbar was ripped out. */
	pageBackground: string;
	/** Solid "desktop" backdrop painted behind the shell's transparent-body
	 * chrome pages (home / apps / settings / …) when the selected
	 * `themeBackground` is "None" (no static image, no animated shader).
	 * `backLightTheme` is used when `theme: light`, `backDarkTheme` when
	 * `theme: dark`. Unlike {@link pageBackground} (the generic content-fill
	 * behind ALL pages, including external web pages), this is a shell-only
	 * desktop colour: it is painted by `paintStyleBackground`, which is gated
	 * to shell pages, so external pages keep the web-default white fill.
	 * Without it, a "None" background leaves the transparent-body shell pages
	 * without a per-frame opaque fill and nav elements smear/trail on
	 * scroll + animation (the live cache marks a `transparent` body bg as
	 * "opaque", so the shell's page-bg backstop `fillRect` is skipped). */
	backLightTheme: string;
	backDarkTheme: string;
	/** Try NVTEGRA hw-accel video decode first; on first decoder error,
	 * live-video.ts auto-falls-back to software decode for that
	 * element. See [[nvtegra-unreliable-on-citron]] — current Citron
	 * builds always hit the fallback; real Switch hw is expected to
	 * stay on the hw path. */
	videoNVTEGRA: boolean;
	/** When true, the first attempt to open an `http(s)://` URL (address
	 * bar, link, or search) pops a confirm modal warning that internet
	 * browsing is experimental before loading — Continue proceeds, Cancel
	 * drops the request. `brewser://` internal pages, app launches, and
	 * Back/Forward history replay are never gated. Read fresh per
	 * navigation by `BrowserShell.navigateTo`. Default true. */
	browsingWarning: boolean;
	/** Title of the active search engine (matched against an entry's
	 * `title` in `search_engines.json`). Drives the welcome page's
	 * search-bar logo + where the query is sent. */
	searchEngine: string;
	/** Per-frame time budget (ms) for the progressive page render — the
	 * live-DOM cache build paints ops until this many ms elapse, then yields
	 * so scroll input + animation frames keep firing, resuming next frame.
	 * Higher = pages snap in with fewer visible build steps but choppier
	 * scroll/animation during that initial paint; lower = smoother but more
	 * drawn-out fill-in. Clamped to [1, 1000]; default 12. Pushed into
	 * live-overlay via `setLiveBuildChunkMs`. **Applies ONLY to external
	 * http(s)/www navigation** — `brewser://` internal pages have
	 * predictable size and always render in a single shot regardless of
	 * this value (BrowserShell.onPageStarted overrides the budget). */
	wwwRenderChunkMs: number;
	/** Per-frame paint budget (ms) used while the user is SCROLLING a page
	 * whose cache is still building — deliberately smaller than
	 * `wwwRenderChunkMs` so each scroll tick stays cheap and scrolling stays
	 * near 60 FPS while content fills in. Clamped to [1, 1000]; default 4.
	 * Pushed into live-overlay via `setLiveScrollChunkMs`. */
	scrollChunkMs: number;
	/** Cap on persisted visits in `history.jsonl`. When a new visit pushes
	 * the count past this, the oldest entry is dropped on the spot (see
	 * `HistoryStore.record`). Clamped to [1, 10000]; default 30. */
	maxHistory: number;
	/** Number of app cards shown per pagination page on the Apps grid (and
	 * the Home teaser). Drives `apps-pagination.js` client-side: only this
	 * many cards are visible per page, and only the visible page's banners
	 * are fetched — so a large catalogue pulls just the ~`maxPerPage` remote
	 * `appbanner.jpg` images the user can see instead of every one up front.
	 * Surfaced to the page scripts via the `<browser-config-maxperpage>` tag
	 * (→ `<body data-max-per-page>`). Clamped to [1, 60]; default 12. */
	maxPerPage: number;
	/** User-preferred colour scheme. Sent to external pages as the
	 * `Sec-CH-Prefers-Color-Scheme` client hint so servers can serve a
	 * matching theme up front; also drives the engine-side viewport
	 * background colour (white for `light`, the toolbar's
	 * `page.background` for `dark`) and the `@media
	 * (prefers-color-scheme:…)` cascade. Defaults to `light` to match
	 * the wider web's expected default. */
	theme: 'light' | 'dark';
	/** Play a short `click.wav` when the user activates a link,
	 * button, or chrome-strip control. Audio feedback only — the
	 * shell still works identically with sounds off. File is seeded
	 * from `romfs:/shell/assets/click.wav` into
	 * `<storageRoot>assets/click.wav` on first run. */
	clickSounds: boolean;
	/** Milliseconds of stick-idle (no left-stick motion past the
	 * cursor deadzone, no A-press) before the software cursor hides
	 * itself. Reappears on the next motion or A-press. Set to a very
	 * large value (or `Infinity`-ish via JSON `null` etc.) to
	 * effectively keep the cursor always on; values <= 0 hide
	 * immediately after motion stops. Default 3000 ms. */
	mouseIdleMs: number;
	/** Reserved for a future auto-rotate-canvas feature. Carried through
	 * the settings round-trip so the value survives Save, but the shell
	 * does not act on it today — flipping it from the Settings page is a
	 * no-op until a consumer is wired up. */
	autoRotate: boolean;
	/** When true, scroll input (right-stick, D-pad, swipe) leaves
	 * residual velocity behind on release; the shell tick decays it
	 * with friction so the content coasts to a stop instead of stopping
	 * dead. Off makes every scroll input a pure 1:1 delta. */
	momentumScrolling: boolean;
	/** When true, the engine composites a small semi-transparent FPS box at
	 * the top-left of the screen at present time (nxjs-extended fps.cc,
	 * `screen.setFpsOverlayEnabled`). Because it's drawn in the native
	 * compositor — not the DOM — it persists across the shell and every
	 * in-runtime app (WebGL included). Off by default. */
	showFps: boolean;
	/** Enable navigation-flow diagnostic logging to
	 * `sdmc:/switch/brewser/logs/shell-nav-diag.log`. Off by default;
	 * flip on when investigating a hung navigation, a click that didn't
	 * trigger a load, or a touch sink that swallowed an intent. Writes
	 * from three sites in lockstep: `_navDiag` in the WebView runtime
	 * (load/endSession/fetchAndExecute boundaries), `_shellInputDiag` in
	 * the shell input pump, and `_touchDiag` in controller-shortcuts. */
	navDebug: boolean;
	/** Enable per-image load diagnostic logging to
	 * `sdmc:/switch/brewser/logs/swb_img_diag.log`. Off by default. Useful
	 * for diagnosing missing-image bugs (the resolved fetch URL, decode
	 * success, naturalWidth/Height) without needing visible stdout on
	 * real Switch hardware. Capped at 500 entries per session so a
	 * broken page can't fill the SD card. Gates `_imgDiag` in
	 * `scripts/live-dom.ts`. */
	swbImgDebug: boolean;
	/** Whether to run the JS-side boot splash dwell + fade-out before
	 * the home page paints. When `false`, the shell skips
	 * `runBootSplashFade` entirely and goes straight to
	 * `navigateTo(home)` — the C-side `nx_render_loading_image` may still
	 * present `romfs:/shell/assets/loading.jpg` for a brief moment at
	 * boot (it's part of the nxjs runtime, not gated by config); delete
	 * or rename that file in romfs to suppress the C-side splash too.
	 * Default `true`. */
	showSplash: boolean;
	/** Whether the chrome-strip toolbar is present at all. When `false`,
	 * the shell boots with `chromeHeight` forced to 0 and the toolbar
	 * overlay marked invisible, so page content paints edge-to-edge and
	 * no fullscreen exit path can re-introduce the strip (every paint
	 * inset + CSS viewport reduction keys off `chromeHeight`, and every
	 * toolbar paint site is gated on the overlay-visible flag). The
	 * configured toolbar HTML is not even loaded from disk in this
	 * mode. Read once at boot — a runtime flip requires restart.
	 * Default `true`. */
	showToolbar: boolean;
	/** Fade-out duration (ms) from splash → black between the boot navigate
	 * completing and the home page paint. Once the navigate lands, the shell
	 * animates a black overlay from alpha 0→1 over this many ms on top of
	 * the already-blitted splash. Set to 0 to skip the fade (instant cut
	 * from splash to home). Clamped to [0, 5000]; default 500. */
	splashFadeMs: number;
	/** Joycon button → engine action override map. Keys are Switch
	 * face / shoulder labels (A, B, X, Y, L, R, ZL, ZR, MINUS, PLUS,
	 * L_STICK, R_STICK, UP, DOWN, LEFT, RIGHT, HOME, CAPTURE,
	 * LEFT_SL, LEFT_SR, RIGHT_SL, RIGHT_SR). Values are action strings
	 * recognised by `src/input/button-router.ts ButtonAction` (e.g.
	 * `"leftClick"`, `"back"`, `"forward"`, `"reload"`,
	 * `"addressBar"`, …). Empty strings (or missing
	 * keys) fall through to the engine defaults in `DEFAULT_ACTIONS`,
	 * which preserve the previously-hardcoded behaviour (A=leftClick,
	 * B=rightClick, X=forward, Y=reload, ZR=middleClick,
	 * UP/DOWN=scroll). */
	buttonMapping: Record<string, string>;
	/** Height in CSS pixels of the on-screen virtual keyboard panel.
	 * The keyboard root renders into this slice anchored at the BOTTOM
	 * of the screen — y range `[canvasH - keyboardHeight, canvasH)` —
	 * so larger values give the panel more vertical room (taller keys),
	 * smaller values leave more of the host page visible above it. The
	 * keyboard.html CSS lays out rows + keys with `flex-grow: 1` so the
	 * whole panel scales to whatever this value is. Clamped to a sane
	 * range at load time; default 400. */
	keyboardHeight: number;
	/** Active virtual-keyboard panel design. Path is relative to the
	 * app-level root (e.g. `keyboards/default.html` →
	 * `<appRoot>keyboards/default.html`); absolute schemes
	 * (`sdmc:/…`, `romfs:/…`) pass through unchanged. Pairs with
	 * `keyboards.json` — the registry the Settings page lists. Each
	 * file is a full keyboard panel (scoped CSS + the same #urlInput /
	 * #closeBtn / #clearBtn / .letter / .key contract `KeyboardOverlay`
	 * relies on); selecting a new entry rewrites this field and the
	 * shell re-parses + rebuilds the keyboard live root on the spot. */
	keyboard: string;
	/** Active visual style sheet served at `brewser://assets/main.css`.
	 * Path is relative to the app-level root (e.g. `styles/dark.css` →
	 * `<appRoot>styles/dark.css`); absolute schemes (`sdmc:/…`,
	 * `romfs:/…`) pass through unchanged. Pairs with `styles.json` —
	 * the registry the Settings page lists. The resource loader reads
	 * the configured file and serves its bytes in place of the baked
	 * `shell/assets/main.css`, so every built-in page's
	 * `<link rel="stylesheet" href="brewser://assets/main.css">` ends
	 * up loading the picked style. Missing / unreadable falls back to
	 * the baked default so a broken pointer can't blank the chrome. */
	brewserStyle: string;
	/** Selected wallpaper — the `title` of a {@link BackgroundEntry} in
	 * `<profile>/themes/backgrounds.json` (the Settings page's Background
	 * picker). Decoupled from `brewserStyle` since 2026-07-30 so a
	 * wallpaper can be chosen independently of the CSS theme. The shell
	 * resolves this title to the entry's `background` / `dynamic` at boot +
	 * on save (see `BrowserShell` `resolveSelectedBackground` /
	 * `applySelectedBackground`). `"None"` / an unmatched title = no
	 * wallpaper. */
	themeBackground: string;
	/** Where the browser chrome strip sits on screen — `'top'` (above
	 * page content) or `'bottom'` (below it). Hoisted out of the
	 * per-toolbar JSON design on 2026-06-11 so the toggle is a
	 * Settings-page preference instead of a per-toolbar baked-in
	 * value. The shell stamps the value as `data-toolbar-position` on
	 * the toolbar live root so per-theme CSS can switch layout (border
	 * placement, focus ring direction, etc.) accordingly. */
	toolbarPosition: ToolbarPosition;
	/** Which library tab the home page renders cards for — one of
	 * `'featured'`, `'recent'`, `'popular'`, `'toprated'` (the four
	 * browse tabs). The home page has no tab strip (apps.html does), so
	 * the user picks the visible section from the Settings page's
	 * "Home Page" radio. Default `'featured'` — the eventual default is
	 * `'recent'`, but that flips only once `publishedAt` is flowing
	 * from the platform (the WP backfill); until then Recent renders
	 * unavailable and would make an empty home page. Old tier values
	 * (`community` / `experimental`) are not migrated (D1). */
	homeSection: LibraryTabId;
	/** Optional autorun target. When non-empty, the shell navigates to
	 * this URL at boot instead of {@link DEFAULT_HOME_URL}. Root-relative
	 * paths (`/apps/experimental/foo/index.html`) resolve against the
	 * `brewser://` origin; absolute URLs with a scheme (`brewser://…`,
	 * `http(s)://…`) pass through unchanged. Empty string = disabled
	 * (default), boot navigates to the home page as before. The Home
	 * button (chrome + button-router action) always targets
	 * `DEFAULT_HOME_URL` regardless of this field — autorun only affects
	 * the initial boot navigation, so the user can still reach the home
	 * page via the toolbar after launch. */
	autorunApp: string;
	/** Date-format hint used as the placeholder for empty
	 * `<input type="date">` fields that don't carry an explicit
	 * `placeholder` attribute. Free-form string — typically `dd/mm/yyyy`
	 * (Europe), `mm/dd/yyyy` (US), or `yyyy-mm-dd` (ISO). Surfaced to the
	 * runtime via `setDateInputDefaultPlaceholder`. */
	local: string;
	/** Which severities of permission warning should appear when an app
	 * launches. Subset of `['low','medium','high']`; warnings-modal.js
	 * filters the rendered list against this set. Empty array suppresses
	 * the modal entirely (catalog → launch is silent). Default is the
	 * full set — show everything until the user opts out. The Settings
	 * page exposes three checkboxes (`warningLow` / `warningMedium` /
	 * `warningHigh`) that compose into this array on save (see
	 * `BrowserShell.saveSettings`). */
	warnings: ('low' | 'medium' | 'high')[];
	/** Remote URL the apps.html "Check for Updates" button fetches when
	 * the user wants to refresh their on-disk `catalogue.json`. The fetched
	 * bytes are written verbatim to `<appRoot>catalogue.json` after a 2xx
	 * + JSON-parse check; failure shows an error in the modal. Routes
	 * through SwitchUaFetchLoader so the request carries the Switch UA,
	 * same as any other http(s) fetch the shell makes.
	 *
	 * **Strict-pinned** at the runtime layer (see
	 * `@switch-web/runtime`'s `RUNTIME_CONFIG_DEFAULTS`). User config is
	 * ignored — a tampered `config.json` cannot redirect the catalog
	 * refresh to an attacker. */
	catalogue: string;
	/** Remote URL of `stats.json` (C2 operational counters). Fetched by
	 * the Check-for-Updates flow alongside the catalogue and written to
	 * `<appRoot>configs/stats.json` only when it parses. Missing or
	 * unparseable is NOT a sync failure — the stats-driven tabs degrade
	 * visibly. Surfaced to the page via `<browser-config-stats>`.
	 *
	 * **Strict-pinned** at the runtime layer. */
	stats: string;
	/** Remote URL of the per-app download-count telemetry file. The
	 * apps.html "Check for Updates" button fetches the bytes alongside
	 * the catalog and writes them verbatim to
	 * `<appRoot>configs/downloads.json` (replacing any existing copy).
	 * Read by missing-app-modal.js to surface a Downloads count on the
	 * detail card.
	 *
	 * **Strict-pinned** at the runtime layer. */
	downloads: string;
	/** Remote URL of the per-app rating telemetry file (array of
	 * `{packageId, count, average}`). Fetched alongside `downloads` by
	 * the Check-for-Updates flow and written to
	 * `<appRoot>configs/ratings.json`. Read by missing-app-modal.js to
	 * surface a star row on the detail card.
	 *
	 * **Strict-pinned** at the runtime layer. */
	ratings: string;
	/** Endpoint the per-app rating POST lands on (the apps.html / home.html
	 * star-tap path in missing-app-modal.js). Surfaced to the page via
	 * `<browser-config-telemetry>` (stamped onto `<body data-telemetry-url>`)
	 * so the script doesn't have to fetch `configs/config.json` to find
	 * it.
	 *
	 * **Strict-pinned** at the runtime layer — user config is ignored,
	 * preventing a tampered `config.json` from redirecting telemetry
	 * POSTs to an attacker-controlled endpoint. */
	telemetry: string;
	/** Microsoft Entra application (client) ID for the Device
	 * Authorization Grant. Register a single-tenant or multi-tenant
	 * (recommended: multi-tenant `common`) app at Microsoft Entra >
	 * App registrations, then under Authentication enable
	 * "Allow public client flows" — that's required for device-code.
	 * Surfaced to microsoftLogin.html via the
	 * `<browser-config-microsoft-client-id/>` custom tag.
	 *
	 * **Override-allowed runtime fallback**: the bundled default in
	 * `@switch-web/runtime`'s `RUNTIME_CONFIG_DEFAULTS` is used when
	 * user config is empty / missing. A non-empty value in user config
	 * wins, so developers can BYO OAuth app without rebuilding the NRO.
	 * Empty in BOTH user config and the runtime default → the auth
	 * page's misconfiguration stage. */
	microsoftOAuthClientId: string;
	/** Google OAuth client ID for the Limited Input Device flow.
	 * Register in Google Cloud Console > APIs & Services > Credentials
	 * as an "OAuth 2.0 Client ID" of type "TVs and Limited Input
	 * devices" (any other client type — desktop, web, mobile — won't
	 * issue device codes). Surfaced to googleLogin.html via the
	 * `<browser-config-google-client-id/>` custom tag.
	 *
	 * **Override-allowed runtime fallback** — see
	 * {@link microsoftOAuthClientId}. */
	googleOAuthClientId: string;
	/** Google OAuth client secret for the Limited Input Device flow.
	 * Required alongside `googleOAuthClientId` at the /token exchange
	 * step — Google's TV/Limited-Input Device flow requires
	 * `client_secret` on the poll body. Surfaced to googleLogin.html
	 * via the `<browser-config-google-client-secret/>` custom tag.
	 *
	 * **Override-allowed runtime fallback** — see
	 * {@link microsoftOAuthClientId}. */
	googleOAuthClientSecret: string;
}

export const DEFAULT_CONFIG: BrowserConfig = {
	toolbar: 'themes/toolbars/dark.html',
	toolbarHeight: 56,
	pageBackground: '#0b1220',
	backLightTheme: '#f0f0f0',
	backDarkTheme: '#444444',
	videoNVTEGRA: true,
	browsingWarning: true,
	searchEngine: 'DuckDuckGo',
	wwwRenderChunkMs: 12,
	scrollChunkMs: 4,
	maxHistory: 30,
	maxPerPage: 12,
	theme: 'light',
	clickSounds: true,
	mouseIdleMs: 3000,
	autoRotate: true,
	momentumScrolling: true,
	showFps: false,
	navDebug: false,
	swbImgDebug: false,
	showSplash: true,
	showToolbar: true,
	splashFadeMs: 500,
	buttonMapping: {},
	keyboardHeight: 400,
	keyboard: 'themes/keyboards/default.html',
	brewserStyle: 'themes/styles/dark.css',
	themeBackground: 'None',
	toolbarPosition: 'top',
	homeSection: 'featured',
	autorunApp: '',
	local: 'dd/mm/yyyy',
	warnings: ['low', 'medium', 'high'],
	// Strict-pinned + override-allowed fields all pull their default
	// from the runtime bundle (@switch-web/runtime). The strict-pinned
	// URLs are also returned unconditionally by `loadConfig` (the user
	// config value, if any, is ignored); the OAuth IDs are the runtime
	// fallback consulted when user config is empty / missing.
	catalogue: RUNTIME_CONFIG_DEFAULTS.catalogue,
	stats: RUNTIME_CONFIG_DEFAULTS.stats,
	downloads: RUNTIME_CONFIG_DEFAULTS.downloads,
	ratings: RUNTIME_CONFIG_DEFAULTS.ratings,
	telemetry: RUNTIME_CONFIG_DEFAULTS.telemetry,
	microsoftOAuthClientId: RUNTIME_CONFIG_DEFAULTS.microsoftOAuthClientId,
	googleOAuthClientId: RUNTIME_CONFIG_DEFAULTS.googleOAuthClientId,
	googleOAuthClientSecret: RUNTIME_CONFIG_DEFAULTS.googleOAuthClientSecret,
};


/** One entry in `search_engines.json`. `query` is the search-URL
 * prefix the encoded query string is appended to (e.g.
 * `https://www.google.com/search?q=`). `url` is the engine homepage. */
export interface SearchEngine {
	title: string;
	logo: string;
	url: string;
	query: string;
}

const DEFAULT_SEARCH_ENGINE: SearchEngine = {
	title: 'DuckDuckGo',
	logo: 'assets/duckduckgo_logo.png',
	url: 'https://duckduckgo.com/',
	query: 'https://duckduckgo.com/?q=',
};

const decoder = new TextDecoder();

/** Read `<profile>/config.json`. Missing / malformed / wrong-typed
 * fields fall back to `DEFAULT_CONFIG` field-by-field, so a partial
 * config is fine (the user only needs to set what they want to change). */
export function loadConfig(appRoot: string): BrowserConfig {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${appRoot}configs/config.json`);
	} catch (_) {
		return DEFAULT_CONFIG;
	}
	if (!raw) return DEFAULT_CONFIG;
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		return {
			toolbar: typeof parsed?.toolbar === 'string'
				? migrateLegacyToolbarPath(parsed.toolbar)
				: DEFAULT_CONFIG.toolbar,
			// 120-200 px keeps a single tall slider; 28 is the floor so
			// the smallest reasonable icon size + breathing room still
			// fits. Mirrors `keyboardHeight`'s clamp pattern.
			toolbarHeight: typeof parsed?.toolbarHeight === 'number' && Number.isFinite(parsed.toolbarHeight)
				? Math.max(28, Math.min(200, Math.trunc(parsed.toolbarHeight)))
				: DEFAULT_CONFIG.toolbarHeight,
			pageBackground: typeof parsed?.pageBackground === 'string' && parsed.pageBackground.length > 0
				? parsed.pageBackground
				: DEFAULT_CONFIG.pageBackground,
			backLightTheme: typeof parsed?.backLightTheme === 'string' && parsed.backLightTheme.length > 0
				? parsed.backLightTheme
				: DEFAULT_CONFIG.backLightTheme,
			backDarkTheme: typeof parsed?.backDarkTheme === 'string' && parsed.backDarkTheme.length > 0
				? parsed.backDarkTheme
				: DEFAULT_CONFIG.backDarkTheme,
			videoNVTEGRA: typeof parsed?.videoNVTEGRA === 'boolean' ? parsed.videoNVTEGRA : DEFAULT_CONFIG.videoNVTEGRA,
			browsingWarning: typeof parsed?.browsingWarning === 'boolean' ? parsed.browsingWarning : DEFAULT_CONFIG.browsingWarning,
			searchEngine: typeof parsed?.searchEngine === 'string' ? parsed.searchEngine : DEFAULT_CONFIG.searchEngine,
			wwwRenderChunkMs: typeof parsed?.wwwRenderChunkMs === 'number' && Number.isFinite(parsed.wwwRenderChunkMs)
				? Math.max(1, Math.min(1000, parsed.wwwRenderChunkMs))
				: DEFAULT_CONFIG.wwwRenderChunkMs,
			scrollChunkMs: typeof parsed?.scrollChunkMs === 'number' && Number.isFinite(parsed.scrollChunkMs)
				? Math.max(1, Math.min(1000, parsed.scrollChunkMs))
				: DEFAULT_CONFIG.scrollChunkMs,
			maxHistory: typeof parsed?.maxHistory === 'number' && Number.isFinite(parsed.maxHistory)
				? Math.max(1, Math.min(10000, Math.trunc(parsed.maxHistory)))
				: DEFAULT_CONFIG.maxHistory,
			// 1 is the floor (a single card per page still paginates); 60 is a
			// generous ceiling so a user who wants "basically no paging" can set
			// it high without the grid ever rendering an unbounded page.
			maxPerPage: typeof parsed?.maxPerPage === 'number' && Number.isFinite(parsed.maxPerPage)
				? Math.max(1, Math.min(60, Math.trunc(parsed.maxPerPage)))
				: DEFAULT_CONFIG.maxPerPage,
			theme: parsed?.theme === 'dark' || parsed?.theme === 'light'
				? parsed.theme
				: DEFAULT_CONFIG.theme,
			clickSounds: typeof parsed?.clickSounds === 'boolean'
				? parsed.clickSounds
				: DEFAULT_CONFIG.clickSounds,
			mouseIdleMs: typeof parsed?.mouseIdleMs === 'number' && Number.isFinite(parsed.mouseIdleMs)
				? Math.max(0, Math.min(3_600_000, parsed.mouseIdleMs))
				: DEFAULT_CONFIG.mouseIdleMs,
			autoRotate: typeof parsed?.autoRotate === 'boolean'
				? parsed.autoRotate
				: DEFAULT_CONFIG.autoRotate,
			momentumScrolling: typeof parsed?.momentumScrolling === 'boolean'
				? parsed.momentumScrolling
				: DEFAULT_CONFIG.momentumScrolling,
			showFps: typeof parsed?.showFps === 'boolean'
				? parsed.showFps
				: DEFAULT_CONFIG.showFps,
			navDebug: typeof parsed?.navDebug === 'boolean'
				? parsed.navDebug
				: DEFAULT_CONFIG.navDebug,
			swbImgDebug: typeof parsed?.swbImgDebug === 'boolean'
				? parsed.swbImgDebug
				: DEFAULT_CONFIG.swbImgDebug,
			showSplash: typeof parsed?.showSplash === 'boolean'
				? parsed.showSplash
				: DEFAULT_CONFIG.showSplash,
			showToolbar: typeof parsed?.showToolbar === 'boolean'
				? parsed.showToolbar
				: DEFAULT_CONFIG.showToolbar,
			splashFadeMs: typeof parsed?.splashFadeMs === 'number' && Number.isFinite(parsed.splashFadeMs)
				? Math.max(0, Math.min(5000, Math.trunc(parsed.splashFadeMs)))
				: DEFAULT_CONFIG.splashFadeMs,
			// `buttonMapping` is a permissive bag — the button-router
			// validates each key/value at apply time. Just pass it
			// through as-is when the JSON has an object there;
			// otherwise empty object.
			buttonMapping: parsed?.buttonMapping && typeof parsed.buttonMapping === 'object' && !Array.isArray(parsed.buttonMapping)
				? parsed.buttonMapping as Record<string, string>
				: {},
			// Clamp to a sane band — too small and the keyboard becomes
			// unusable, too tall and it would eat the chrome strip area.
			// 120 px is roughly two rows; 700 px keeps a sliver of host
			// page visible above on the 720 p canvas.
			keyboardHeight: typeof parsed?.keyboardHeight === 'number' && Number.isFinite(parsed.keyboardHeight)
				? Math.max(120, Math.min(700, Math.trunc(parsed.keyboardHeight)))
				: DEFAULT_CONFIG.keyboardHeight,
			keyboard: typeof parsed?.keyboard === 'string' && parsed.keyboard.length > 0
				? parsed.keyboard
				: DEFAULT_CONFIG.keyboard,
			brewserStyle: typeof parsed?.brewserStyle === 'string' && parsed.brewserStyle.length > 0
				? parsed.brewserStyle
				: DEFAULT_CONFIG.brewserStyle,
			// Selected wallpaper: a `backgrounds.json` entry title. Any
			// non-empty string passes through (resolved against the registry
			// at boot / save); absent → the "None" default.
			themeBackground: typeof parsed?.themeBackground === 'string' && parsed.themeBackground.length > 0
				? parsed.themeBackground
				: DEFAULT_CONFIG.themeBackground,
			toolbarPosition: parsed?.toolbarPosition === 'top' || parsed?.toolbarPosition === 'bottom'
				? parsed.toolbarPosition
				: DEFAULT_CONFIG.toolbarPosition,
			// Old tier values (community/experimental) are NOT migrated
			// (D1) — they fall through to the default like any unknown.
			homeSection: parsed?.homeSection === 'featured'
				|| parsed?.homeSection === 'recent'
				|| parsed?.homeSection === 'popular'
				|| parsed?.homeSection === 'toprated'
				? parsed.homeSection
				: DEFAULT_CONFIG.homeSection,
			// Free-form path/URL. Empty string means "no autorun" (boot
			// navigates to the home page as usual). The consumer in
			// `browser-shell.ts` normalises a leading-slash path to a
			// `brewser://` URL; absolute schemes pass through.
			autorunApp: typeof parsed?.autorunApp === 'string'
				? parsed.autorunApp
				: DEFAULT_CONFIG.autorunApp,
			local: typeof parsed?.local === 'string' && parsed.local.length > 0
				? parsed.local
				: DEFAULT_CONFIG.local,
			// Permission-warning severity gate. Accept any array; filter
			// to the three valid risk strings, dedupe (preserve canonical
			// low/medium/high order), and fall back to the default when
			// the on-disk value is missing, non-array, or filters down to
			// nothing useful. An array that filters to `[]` is preserved
			// — the user explicitly opted out of every severity.
			warnings: Array.isArray(parsed?.warnings)
				? (() => {
					const valid = new Set<'low' | 'medium' | 'high'>();
					for (const v of parsed.warnings) {
						if (v === 'low' || v === 'medium' || v === 'high') valid.add(v);
					}
					return (['low', 'medium', 'high'] as const).filter((r) => valid.has(r));
				})()
				: DEFAULT_CONFIG.warnings,
			// Strict-pinned: runtime value is authoritative. The user's
			// on-disk `config.json` may still carry these keys from an
			// older seeded copy (or hand edits), but we deliberately
			// ignore them — the bundled-runtime value is the canonical
			// source. See `[[runtime-defaults]]` in
			// `@switch-web/runtime` for the rationale.
			catalogue: RUNTIME_CONFIG_DEFAULTS.catalogue,
			stats: RUNTIME_CONFIG_DEFAULTS.stats,
			downloads: RUNTIME_CONFIG_DEFAULTS.downloads,
			ratings: RUNTIME_CONFIG_DEFAULTS.ratings,
			telemetry: RUNTIME_CONFIG_DEFAULTS.telemetry,
			// Override-allowed: a non-empty user value wins; empty /
			// missing / non-string falls back to the runtime default
			// (sourced via DEFAULT_CONFIG). Treating empty-string as
			// "fall back" is the policy difference from the other
			// string fields — it lets a fresh install ship working
			// sign-in via the bundled runtime ID without forcing every
			// installer to provision their own OAuth app.
			microsoftOAuthClientId: typeof parsed?.microsoftOAuthClientId === 'string'
				&& parsed.microsoftOAuthClientId.length > 0
				? parsed.microsoftOAuthClientId
				: DEFAULT_CONFIG.microsoftOAuthClientId,
			googleOAuthClientId: typeof parsed?.googleOAuthClientId === 'string'
				&& parsed.googleOAuthClientId.length > 0
				? parsed.googleOAuthClientId
				: DEFAULT_CONFIG.googleOAuthClientId,
			googleOAuthClientSecret: typeof parsed?.googleOAuthClientSecret === 'string'
				&& parsed.googleOAuthClientSecret.length > 0
				? parsed.googleOAuthClientSecret
				: DEFAULT_CONFIG.googleOAuthClientSecret,
		};
	} catch (error) {
		console.debug(`[brewser] config.json parse failed: ${error}`);
		return DEFAULT_CONFIG;
	}
}

/** One rendered card on the Apps / Featured page. The shape is shared
 * between every catalog group — `loadCatalogGroup` constructs these
 * from the unified `catalogue.json` schema (id + name + entry + logo)
 * and the rendering code in `browser-resource-loader.ts` just emits
 * `.app-card` markup. `logo` is used verbatim as an `<img src>`; `url`
 * is rewritten to an absolute `brewser://` URL for the card link
 * (see `renderAppCards`). */
export interface AppEntry {
	/** Reverse-DNS folder name (`catalogue.json`'s `id`). Surfaced so the
	 * renderer can stamp it onto the card markup — the missing-app modal
	 * keys its `data-app-detail` payload on this. */
	id: string;
	title: string;
	/** Short card blurb shown under the title — the normalized `summary`
	 * (the human "Short description", or a derived fallback). */
	description: string;
	/** Full HTML description for the detail modal (rendered as HTML in a
	 * scrollable block). '' when neither the catalogue entry nor the local
	 * manifest carries one. */
	fullDescription: string;
	logo: string;
	/** Card banner image URL. Installed → on-disk banner; available →
	 * remote catalogue banner (`logoUrl`); final fallback download.png. */
	banner: string;
	/** Raw rating average (0–5) from cached stats.json; 0 when unrated /
	 * no stats. `ratingCount` gates the "Not rated yet" vs numeric display. */
	ratingAvg: number;
	/** Number of ratings from stats.json; 0 when unrated / no stats. */
	ratingCount: number;
	/** Download count from stats.json; 0 when none / no stats. */
	downloads: number;
	url: string;
	/** Semantic version string from `catalogue.json`'s `version` field
	 * (e.g. `"1.0.0"`). Empty string when the entry omits it — the
	 * renderer suppresses the version chip in that case rather than
	 * showing a blank pill. */
	version: string;
	/** SPDX-ish license identifier from `catalogue.json`'s `license`
	 * field (e.g. `"MIT"`, `"Apache-2.0"`). Empty string when absent;
	 * the renderer treats empty the same as a missing version. */
	license: string;
	/** Free-form category from `catalogue.json` (`"app"`, `"game"`, …).
	 * Empty string when absent. Surfaced for the missing-app modal. */
	category: string;
	/** Developer / author display name from `catalogue.json`. Empty when
	 * absent. Surfaced for the missing-app modal. */
	developer: string;
	/** Upstream source URL (typically a Git repo) from `catalogue.json`.
	 * Empty when absent. Surfaced for the missing-app modal. */
	source: string;
	/** Version reported by the on-disk `apps/<group>/<id>/manifest.json`
	 * when it differs from the catalog's `version`. Empty when the app
	 * is missing, when the manifest can't be read/parsed, when the
	 * manifest has no `version`, or when the versions match. The
	 * renderer keys the upgrade-chip ("`1.0.0 → 1.0.1`", yellow
	 * background) on this field being non-empty — so a non-empty
	 * `installedVersion` implies "an upgrade is available on the
	 * catalog side." */
	installedVersion: string;
	/** Capability flags from the manifest, comma-joined for direct
	 * display (`"video, controller"`). Empty when the catalog entry
	 * omits the array or has no entries. Surfaced for the missing-app
	 * modal. */
	features: string;
	/** Declared permissions, comma-joined (`"network, storage"`).
	 * Empty same as `features`. */
	permissions: string;
	/** Allowed third-party fetch origins, comma-joined. Empty same as
	 * `features`. The modal renders an empty value as the em-dash
	 * placeholder so the row reads intentionally-empty rather than
	 * accidentally-missing. */
	allowedOrigins: string;
	/** True when the catalog references this entry but its launcher file
	 * (`apps/<group>/<id>/<entry>`) isn't present on disk. The renderer
	 * swaps the card's logo for the generic download.png and the
	 * launcher page intercepts taps to open the missing-app modal
	 * instead of navigating to a guaranteed 404. */
	missing: boolean;
	/** Relative path to the launcher file (`catalogue.json`'s `entry`,
	 * typically `index.html`). Already embedded in `url` as the final
	 * path segment, but surfaced separately so the download-modal can
	 * reorder it to last in the install loop without re-parsing the URL.
	 * Leading slashes stripped. */
	entry: string;
	/** Total download size in bytes from `catalogue.json`'s `sizeBytes`.
	 * Zero when the entry omits the field — the missing-app modal
	 * suppresses the size chip when this is zero so a catalog without
	 * size data renders the same as the pre-`sizeBytes` layout. */
	sizeBytes: number;
	/** Per-user "My Apps" lifecycle badge: 'published' | 'unpublished' |
	 * 'staged'. '' for every ordinary catalogue card (the public catalogue
	 * carries no status) — the renderer shows a status pill only when set. */
	status: string;
}

/** Home-section choices = the four library tabs. Labels for the
 * Settings radios + home-page title live in
 * `browser-resource-loader.ts homeSectionTitle`. */
export const HOME_SECTIONS: readonly LibraryTabId[] = ['featured', 'recent', 'popular', 'toprated'];

/** URL of the generic "download" logo painted on cards whose backing
 * app folder isn't on disk. Lives in `<storageRoot>assets/` so it's
 * mirrored from `romfs:/shell/assets/` into the per-profile storageRoot
 * by `seedRomfs` and served through the
 * normal `brewser://assets/...` route. */
export const MISSING_APP_LOGO_URL = 'brewser://assets/download.png';

/** One rendered library tab: availability + reason + card entries. */
export interface LibraryTabRender {
	available: boolean;
	reason: string;
	entries: AppEntry[];
}

/**
 * Build the four library tab views (D2a + Phase 4 tab semantics):
 * DISK IS AUTHORITATIVE for what is installed — `apps/<id>/
 * manifest.json` dirs are enumerated once and rendered from their
 * local manifests; the cached catalogue (`configs/catalogue.json`,
 * parsed by the platform client, never here) joins BY ID to annotate
 * availability, updates, curation, and revocation; the cached
 * `configs/stats.json` drives the Popular / Top Rated ordering. A
 * missing / stale / unparseable catalogue still yields the complete
 * installed library; missing stats degrade only the stats-driven tabs.
 *
 * This replaced the old per-catalogue-entry disk probes: installedness
 * comes from one enumeration, not N manifest reads driven by the
 * catalogue (which silently hid anything the catalogue forgot).
 *
 * One call = one disk pass — the resource loader calls this once per
 * page render and feeds every tab tag from the same result.
 */
export interface LibraryPager {
	/** The four main tab views, each holding SORTED `LibraryApp` references
	 * (shared across tabs — `buildLibraryTabs` copies the array, not the
	 * objects). Mapping to card models is deferred to `pagerPageEntries`. */
	views: Record<LibraryTabId, LibraryTabView>;
	/** The "Downloads" facet: apps physically installed on this SD card
	 * (`installed !== null`) — the same disk truth that dims not-installed
	 * cards. Never null: unlike My Apps / Favorites it needs no signed-in
	 * document, so the tab is always present (an empty install set renders the
	 * plain empty state). */
	downloads: LibraryTabView;
	/** The per-user "My Apps" view, or null when no cached my-catalogue exists
	 * (the tab + label stay hidden in that case). */
	myApps: LibraryTabView | null;
	/** The per-user Favorites view, or null when no cached favorites.json
	 * exists. Built exactly like `myApps` — a second catalogue (the WordPress-
	 * generated favorites document) joined against the same disk enumeration —
	 * and rendered on the standalone favorites.html page, not an apps.html tab. */
	favorites: LibraryTabView | null;
	stats: ParsedStats | null;
	appRoot: string;
}

/**
 * Parse + join + sort the whole library ONCE and retain the ordered views so a
 * client-side pager can render ONE page at a time on demand. The catalogue can
 * hold thousands of apps; mapping every entry × every tab up front (the old
 * `loadLibraryTabs` shape) would both defeat the pagination and hold N×4 card
 * models in memory. This keeps only `LibraryApp` REFERENCES (≈ the catalogue's
 * own size, unavoidable) — `pagerPageEntries` maps just the visible page's
 * ~maxPerPage apps to card models when asked.
 *
 * DISK IS AUTHORITATIVE for installedness (one enumeration, reused for both the
 * main tabs and My Apps); the cached catalogue joins BY ID; the cached stats
 * drive Popular / Top Rated. A missing / stale / unparseable catalogue still
 * yields the complete installed library; missing stats degrade only the
 * stats-driven tabs.
 */
export function buildLibraryPager(appRoot: string): LibraryPager {
	// Cached catalogue → normalized model. Anything but Ok → render from disk
	// alone; the outcome is logged here and surfaced in the updates modal's
	// report UI at sync time.
	const text = readTextFile(`${appRoot}configs/catalogue.json`);
	let catalogue: NormalizedCatalogue | null = null;
	if (text !== null) {
		const outcome = parseCatalogue(text);
		if (outcome.kind === 'Ok') {
			catalogue = outcome.catalogue;
			const r = catalogue.report;
			if (r.dropped.length || r.unknownPermissions.length || r.unknownSources.length) {
				console.debug(`[brewser] catalogue report: dropped=${r.dropped.length} unknownPerms=${r.unknownPermissions.join(',')} unknownSources=${r.unknownSources.join(',')}`);
			}
		} else {
			console.debug(`[brewser] cached catalogue rejected (${outcome.kind}) — rendering library from disk only`);
		}
	}

	// Cached stats → parsed or null (null degrades Popular/Top Rated only —
	// deliberately NOT a failure).
	const statsText = readTextFile(`${appRoot}configs/stats.json`);
	let stats: ParsedStats | null = null;
	if (statsText !== null) {
		const so = parseStats(statsText);
		if (so.kind === 'Ok') {
			stats = so.parsed;
		} else {
			console.debug(`[brewser] cached stats rejected (${so.kind}) — stats-driven tabs unavailable`);
		}
	}

	const enumeration = enumerateInstalledApps({
		listAppDirs: () => {
			try {
				return Switch.readDirSync(`${appRoot}apps`) ?? [];
			} catch (_) {
				return [];
			}
		},
		readAppText: (dir: string, rel: string) => readTextFile(`${appRoot}apps/${dir}/${rel}`),
		appFileExists: (dir: string, rel: string) => appFileExists(`${appRoot}apps/${dir}/${rel}`),
	});
	const er = enumeration.report;
	if (er.unreadable.length || er.idMismatches.length || er.brokenEntries.length) {
		console.debug(`[brewser] installed-apps report: unreadable=${JSON.stringify(er.unreadable)} idMismatches=${JSON.stringify(er.idMismatches)} brokenEntries=${JSON.stringify(er.brokenEntries)}`);
	}

	const library = joinLibrary(enumeration.apps, catalogue);
	const views = buildLibraryTabs(library, stats);

	// "Downloads" — the local-install facet from the SAME disk enumeration
	// (installed apps only), always present regardless of catalogue / sign-in.
	const downloads = buildDownloadsTab(library);

	// Per-user "My Apps" — a SECOND catalogue (the WordPress-generated
	// my-catalogue restricted to the signed-in user's own apps). Absent /
	// unparseable ⇒ null (tab + label hidden). Reuses the single enumeration
	// above, and keeps ONLY the apps that document lists (drop installed-but-
	// unlisted rows — My Apps is the authored set, not everything on disk).
	let myApps: LibraryTabView | null = null;
	const myText = readTextFile(`${appRoot}configs/my-catalogue.json`);
	if (myText !== null) {
		const outcome = parseCatalogue(myText);
		if (outcome.kind === 'Ok') {
			const myCatalogue = outcome.catalogue;
			const myLibrary = joinLibrary(enumeration.apps, myCatalogue);
			const mine = myLibrary.apps.filter((a: LibraryApp) => a.listing !== null);
			myApps = buildMyAppsTab({ apps: mine, catalogueAvailable: true, revoked: myCatalogue.revoked });
		} else {
			console.debug(`[brewser] my-catalogue rejected (${outcome.kind}) — My Apps tab hidden`);
		}
	}

	// Per-user Favorites — a THIRD catalogue (the WordPress-generated favorites
	// document, published apps only). Same join-against-disk treatment as My
	// Apps: absent / unparseable ⇒ null (the favorites.html grid + the account-
	// page link stay hidden). Keeps only the apps the document lists.
	let favorites: LibraryTabView | null = null;
	const favText = readTextFile(`${appRoot}configs/favorites.json`);
	if (favText !== null) {
		const outcome = parseCatalogue(favText);
		if (outcome.kind === 'Ok') {
			const favCatalogue = outcome.catalogue;
			const favLibrary = joinLibrary(enumeration.apps, favCatalogue);
			const favs = favLibrary.apps.filter((a: LibraryApp) => a.listing !== null);
			favorites = buildMyAppsTab({ apps: favs, catalogueAvailable: true, revoked: favCatalogue.revoked });
		} else {
			console.debug(`[brewser] favorites rejected (${outcome.kind}) — Favorites page hidden`);
		}
	}

	return { views, downloads, myApps, favorites, stats, appRoot };
}

/** The sorted view for a tab id, or null for an absent My Apps / Favorites. */
function pagerViewOf(pager: LibraryPager, tab: LibraryTabId | 'myapps' | 'favorites' | 'downloads'): LibraryTabView | null {
	if (tab === 'myapps') return pager.myApps;
	if (tab === 'favorites') return pager.favorites;
	if (tab === 'downloads') return pager.downloads;
	return pager.views[tab];
}

/** Total pages for a tab at the given page size (always ≥ 1). Unavailable /
 * empty tabs report 1 page — the renderer shows the reason / empty state and
 * the pager collapses. */
export function pagerTotalPages(pager: LibraryPager, tab: LibraryTabId | 'myapps' | 'favorites' | 'downloads', perPage: number): number {
	const view = pagerViewOf(pager, tab);
	const per = perPage > 0 ? perPage : 1;
	if (!view || !view.available || view.apps.length === 0) return 1;
	return Math.max(1, Math.ceil(view.apps.length / per));
}

/** Map ONE page of a tab to card models — slices the sorted `LibraryApp[]` and
 * maps only that window, so paging stays O(perPage) no matter how large the
 * catalogue is. Clamped to [1, totalPages]. */
export function pagerPageEntries(pager: LibraryPager, tab: LibraryTabId | 'myapps' | 'favorites' | 'downloads', page: number, perPage: number): AppEntry[] {
	const view = pagerViewOf(pager, tab);
	if (!view || !view.available) return [];
	const per = perPage > 0 ? perPage : 1;
	const total = Math.max(1, Math.ceil(view.apps.length / per));
	let p = Math.trunc(page);
	if (!Number.isFinite(p) || p < 1) p = 1;
	if (p > total) p = total;
	return view.apps
		.slice((p - 1) * per, p * per)
		.map((a: LibraryApp) => libraryAppToCard(a, pager.appRoot, pager.stats));
}

/** First-page render descriptor for a tab: availability + reason + page-1
 * entries. Feeds `renderLibraryTab` for the initial server render; the client
 * pager (`__brewserAppsPager`) takes over for pages 2…N. Returns an
 * unavailable/empty descriptor for an absent My Apps (the caller gates the tab
 * on `pager.myApps` and renders nothing in that case). */
export function pagerTabRender(pager: LibraryPager, tab: LibraryTabId | 'myapps' | 'favorites' | 'downloads', perPage: number): LibraryTabRender {
	const view = pagerViewOf(pager, tab);
	if (!view) return { available: false, reason: '', entries: [] };
	if (!view.available) return { available: false, reason: view.reason, entries: [] };
	return { available: true, reason: '', entries: pagerPageEntries(pager, tab, 1, perPage) };
}

/**
 * Nav-level revoked check (D3): ids in the cached catalogue's
 * `revoked` list are blocked from launch even by direct URL. Reads the
 * cache fresh per call — callers invoke once per app navigation, and
 * the read shares the manifest lookup's per-nav SD budget.
 */
export function isRevokedInCachedCatalogue(appRoot: string, appId: string): boolean {
	const text = readTextFile(`${appRoot}configs/catalogue.json`);
	if (text === null) return false;
	const outcome = parseCatalogue(text);
	return outcome.kind === 'Ok' && outcome.catalogue.revoked.includes(appId);
}

/** Map one joined library row onto the card shape the renderer +
 * modal payloads consume. Field authority follows the contract: the
 * catalogue owns availability/version/curation, the local manifest
 * owns behaviour; display fields prefer whichever side is present. */
function libraryAppToCard(app: LibraryApp, appRoot: string, stats: ParsedStats | null): AppEntry {
	const inst = app.installed;
	const listing = app.listing;
	// Directory name is authoritative for paths (flat layout,
	// folder == id; on manifest/folder mismatch the folder wins).
	const dirName = inst ? inst.dirName : app.id;
	const entryRel = stripLeadingSlashes(inst ? inst.entry : listing?.entryRel ?? 'index.html');
	const logoRel = stripLeadingSlashes(inst ? inst.logo : listing?.logoRel ?? '');
	const hasLogo = logoRel !== '' && appFileExists(`${appRoot}apps/${dirName}/${logoRel}`);
	// Card banner. Installed apps show their on-disk banner; not-installed
	// (available) apps have no local file, so we point at the catalogue's
	// remote banner URL (`logoUrl`) — the real image loads on hardware /
	// online. Offline (e.g. Citron) an available app's remote banner can't
	// load; the generic download.png is the final fallback.
	const banner = hasLogo
		? `brewser://apps/${dirName}/${logoRel}`
		: (listing?.logoUrl ?? MISSING_APP_LOGO_URL);
	// Operational counters from the cached stats.json (C2). Absent when
	// stats haven't synced (offline / pre-first-sync) → 0 / "not rated",
	// which is the correct honest state on the card.
	const st = stats?.stats?.[app.id];
	// Marked-and-blocked: a revoked app renders with the missing-card
	// treatment so the launcher intercepts the tap (no navigation).
	// The navigation-level guard for direct URLs lands with Phase 4's
	// consumer rewrite.
	const missing = app.state === 'available' || (inst !== null && !inst.entryExists) || app.revoked;
	return {
		id: app.id,
		title: inst?.name ?? listing?.name ?? app.id,
		description: listing?.summary ?? inst?.summary ?? '',
		fullDescription: listing?.description ?? inst?.description ?? '',
		logo: hasLogo ? `brewser://apps/${dirName}/${logoRel}` : MISSING_APP_LOGO_URL,
		banner,
		ratingAvg: st ? st.ratingAvg : 0,
		ratingCount: st ? st.ratingCount : 0,
		downloads: st ? st.downloads : 0,
		url: `brewser://apps/${dirName}/${entryRel}`,
		version: listing?.version ?? inst?.version ?? '',
		license: listing?.license ?? inst?.license ?? '',
		category: (inst?.categories.length ? inst.categories : listing?.categories ?? []).join(', '),
		developer: listing?.developer ?? inst?.developer ?? '',
		source: '',
		features: (inst?.features.length ? inst.features : listing?.features ?? []).join(', '),
		permissions: (inst?.permissionNamesRaw.length
			? inst.permissionNamesRaw
			: listing?.permissionNamesRaw ?? []).join(', '),
		allowedOrigins: (inst?.allowedOrigins ?? []).join(', '),
		installedVersion: app.state === 'installed-update' ? inst?.version ?? '' : '',
		missing,
		entry: entryRel,
		sizeBytes: listing?.sizeBytes ?? 0,
		// Only the my-catalogue listing carries a status; the public catalogue
		// and disk-only apps leave it ''.
		status: listing?.status ?? '',
	};
}

function readTextFile(path: string): string | null {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(path);
	} catch (_) {
		return null;
	}
	if (!raw) return null;
	try {
		return decoder.decode(raw);
	} catch (_) {
		return null;
	}
}

function stripLeadingSlashes(p: string): string {
	let i = 0;
	while (i < p.length && p[i] === '/') i++;
	return p.slice(i);
}

/** Probe whether a file exists on disk by attempting to read it.
 * `Switch.readFileSync` returns `null` (not throws) for missing files
 * — see [[reference-brewser-switch-readfilesync-returns-null]] — so
 * the null check is load-bearing. A thrown error (e.g. permission
 * issue) also counts as "doesn't exist" for our purposes: the engine
 * would render nothing either way. */
function appFileExists(path: string): boolean {
	let data: ArrayBuffer | null;
	try {
		data = Switch.readFileSync(path);
	} catch (_) {
		return false;
	}
	return data !== null;
}

/** Read + validate `<profile>/search_engines.json`. Returns the
 * built-in DuckDuckGo entry as a single-element list if the file is
 * missing / malformed, so search always has a usable engine. */
export function loadSearchEngines(appRoot: string): SearchEngine[] {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${appRoot}configs/search_engines.json`);
	} catch (_) {
		return [DEFAULT_SEARCH_ENGINE];
	}
	if (!raw) return [DEFAULT_SEARCH_ENGINE];
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		if (!Array.isArray(parsed)) return [DEFAULT_SEARCH_ENGINE];
		const engines = parsed.filter((e): e is SearchEngine =>
			!!e && typeof e.title === 'string' && typeof e.logo === 'string'
			&& typeof e.url === 'string' && typeof e.query === 'string',
		);
		return engines.length > 0 ? engines : [DEFAULT_SEARCH_ENGINE];
	} catch (error) {
		console.debug(`[brewser] search_engines.json parse failed: ${error}`);
		return [DEFAULT_SEARCH_ENGINE];
	}
}

/** Resolve the active search engine: the entry whose `title` matches
 * `config.json`'s `searchEngine`, else the first listed engine, else
 * the built-in default. */
export function resolveSearchEngine(appRoot: string): SearchEngine {
	const engines = loadSearchEngines(appRoot);
	const selected = loadConfig(appRoot).searchEngine;
	return engines.find((e) => e.title === selected) ?? engines[0] ?? DEFAULT_SEARCH_ENGINE;
}

/** Read a theme registry file (`themes/<name>.json`) and return its
 * validated entries in source order. Missing or malformed file →
 * empty array. Each entry is `{ title, path }` where `path` is
 * relative to the app root unless it carries an absolute scheme.
 *
 * `pathMigrator` is applied to every entry's `path` after read so
 * registries authored against an older path convention (e.g. the
 * pre-2026-06-14 `themes/toolbars/<X>.json` toolbar JSONs that became
 * `<X>.html` HTML docs) keep listing the correct file. */
function loadThemeRegistry(
	appRoot: string,
	filename: string,
	pathMigrator: (p: string) => string = (p) => p,
): ToolbarEntry[] {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${appRoot}themes/${filename}`);
	} catch (_) {
		return [];
	}
	if (!raw) return [];
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((e): e is ToolbarEntry =>
				!!e && typeof e.title === 'string' && typeof e.path === 'string',
			)
			.map((e) => {
				const out: ToolbarEntry = { title: e.title, path: pathMigrator(e.path) };
				// Forward the optional `height` field (currently only
				// `toolbars.json` uses it; styles + keyboards leave it
				// absent). Clamped here to the same 28-200 px band
				// `loadConfig` applies to `toolbarHeight` so a malformed
				// registry value can't blow the chrome layout once it
				// rides through `selectToolbar` / `saveSettings` into
				// `config.json`.
				if (typeof e.height === 'number' && Number.isFinite(e.height)) {
					out.height = Math.max(28, Math.min(200, Math.trunc(e.height)));
				}
				return out;
			});
	} catch (error) {
		console.debug(`[brewser] themes/${filename} parse failed: ${error}`);
		return [];
	}
}

/** Theme registries: `<appRoot>themes/{toolbars,keyboards,styles}.json`.
 * The registries drive the Settings page's Toolbar / Keyboard / Style
 * pickers and (for the style registry) the resource loader's
 * `brewser://assets/main.css` redirect. The toolbar registry runs each
 * `.path` through `migrateLegacyToolbarPath` so users with an older
 * seeded `toolbars.json` still see the four shipped themes (the seeder
 * will overwrite it with the `.html` form on next launch since
 * `seedRomfs` is never-overwrite; this migrator is what bridges the
 * gap on a profile that was created pre-rip). */
export function loadKeyboardRegistry(appRoot: string): ToolbarEntry[] {
	return loadThemeRegistry(appRoot, 'keyboards.json');
}
export function loadStyleRegistry(appRoot: string): ToolbarEntry[] {
	return loadThemeRegistry(appRoot, 'styles.json');
}
export function loadToolbarRegistry(appRoot: string): ToolbarEntry[] {
	return loadThemeRegistry(appRoot, 'toolbars.json', migrateLegacyToolbarPath);
}

/** Read the wallpaper registry `<appRoot>themes/backgrounds.json` and
 * return its validated {@link BackgroundEntry} rows in source order.
 * Missing / malformed file → empty array. Each entry needs a `title`
 * (the selection key referenced by `config.json`'s `themeBackground`);
 * the optional `background` / `dynamic` path strings are opaque here
 * (resolved at paint time in the shell). */
export function loadBackgroundRegistry(appRoot: string): BackgroundEntry[] {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${appRoot}themes/backgrounds.json`);
	} catch (_) {
		return [];
	}
	if (!raw) return [];
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((e): e is BackgroundEntry => !!e && typeof e.title === 'string')
			.map((e) => {
				const out: BackgroundEntry = { title: e.title };
				if (typeof e.background === 'string') out.background = e.background;
				if (typeof e.dynamic === 'string') out.dynamic = e.dynamic;
				return out;
			});
	} catch (error) {
		console.debug(`[brewser] themes/backgrounds.json parse failed: ${error}`);
		return [];
	}
}
