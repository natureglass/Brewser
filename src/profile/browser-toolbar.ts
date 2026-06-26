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

import { RUNTIME_CONFIG_DEFAULTS } from '@switch-web/runtime';

export type ToolbarPosition = 'top' | 'bottom';

/** One row in `<profile>/toolbars.json` (also reused by `keyboards.json`
 * and `styles.json` — same `{title, path}` shape). `path` is relative
 * to the profile root unless it carries an absolute scheme (`sdmc:/…`,
 * `romfs:/…`).
 *
 * `background` is the optional per-style wallpaper path painted by the
 * shell between the per-frame page-bg fillRect and `paintLiveOverlay`
 * (see `BrowserShell.paintStyleBackground`). Used today only by
 * `styles.json`; toolbar + keyboard registries simply leave it
 * undefined. Same path-resolution rules as `path` — bare values are
 * relative to the profile root; absolute schemes pass through. Empty
 * string / undefined = no background image for that entry.
 *
 * `height` is the optional per-toolbar chrome strip height in CSS
 * pixels. Used by the toolbar registry only — selecting a toolbar (via
 * the Settings page or `selectToolbar`) caches this value into
 * `config.json`'s `toolbarHeight` so the strip resizes to whatever the
 * picked theme expects. Undefined / non-number = no auto-resize on
 * switch (the existing `toolbarHeight` is preserved). Same clamp band
 * as `loadConfig`'s `toolbarHeight` parse (28-200 px). */
export interface ToolbarEntry {
	title: string;
	path: string;
	background?: string;
	height?: number;
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
	/** Try NVTEGRA hw-accel video decode first; on first decoder error,
	 * live-video.ts auto-falls-back to software decode for that
	 * element. See [[nvtegra-unreliable-on-citron]] — current Citron
	 * builds always hit the fallback; real Switch hw is expected to
	 * stay on the hw path. */
	videoNVTEGRA: boolean;
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
	/** Minimum visible duration (ms) of the JS-side boot splash before the
	 * fade-out starts. The shell allocates the canvas, blits the stashed
	 * C-side splash bytes in via `nx_framebuffer_init`, then repaints the
	 * splash (`romfs:/shell/assets/loading.jpg`) continuously for this
	 * many ms — independent of how long boot prelude work (seedRomfs,
	 * config parse, HTML parse) took. Larger = more time to read the
	 * splash but slower app launch. Clamped to [0, 10000]; default 1500. */
	splashMinMs: number;
	/** Fade-out duration (ms) from splash → black between the dwell above
	 * and the home page paint. After the dwell, the shell allocates the
	 * canvas, blits the stashed splash into it, then animates a black
	 * overlay from alpha 0→1 over this many ms. Set to 0 to skip the
	 * fade (instant cut from splash to home). Clamped to [0, 5000];
	 * default 500. */
	splashFadeMs: number;
	/** Joycon button → engine action override map. Keys are Switch
	 * face / shoulder labels (A, B, X, Y, L, R, ZL, ZR, MINUS, PLUS,
	 * L_STICK, R_STICK, UP, DOWN, LEFT, RIGHT, HOME, CAPTURE,
	 * LEFT_SL, LEFT_SR, RIGHT_SL, RIGHT_SR). Values are action strings
	 * recognised by `src/input/button-router.ts ButtonAction` (e.g.
	 * `"leftClick"`, `"back"`, `"forward"`, `"reload"`,
	 * `"addressBar"`, `"screenshot"`, …). Empty strings (or missing
	 * keys) fall through to the engine defaults in `DEFAULT_ACTIONS`,
	 * which preserve the previously-hardcoded behaviour (A=leftClick,
	 * B=rightClick, X=forward, Y=reload, ZR=middleClick,
	 * MINUS=screenshot, UP/DOWN=scroll). */
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
	/** Cached path to the wallpaper image for the active style. Sourced
	 * from `styles.json`'s `background` field for the entry matching
	 * `brewserStyle`; resolved + persisted on every `saveSettings` that
	 * stages a `brewserStyle` change (see `BrowserShell.saveSettings`).
	 * Same path-resolution rules as `brewserStyle` itself — bare values
	 * are relative to the profile root, absolute schemes pass through.
	 * Empty string = no background.
	 *
	 * Cached in `config.json` (instead of derived at every paint from
	 * `styles.json`) so the boot path doesn't have to crack a second
	 * JSON file before the first frame, and the shell's boot lookup is
	 * a single field read. The trade-off: a hand edit of `styles.json`'s
	 * `background` field won't take effect until the user toggles their
	 * style in Settings (which re-resolves + re-persists this cache). */
	styleBackground: string;
	/** Where the browser chrome strip sits on screen — `'top'` (above
	 * page content) or `'bottom'` (below it). Hoisted out of the
	 * per-toolbar JSON design on 2026-06-11 so the toggle is a
	 * Settings-page preference instead of a per-toolbar baked-in
	 * value. The shell stamps the value as `data-toolbar-position` on
	 * the toolbar live root so per-theme CSS can switch layout (border
	 * placement, focus ring direction, etc.) accordingly. */
	toolbarPosition: ToolbarPosition;
	/** Which catalog group the home page renders cards for — one of
	 * `'featured'`, `'community'`, `'experimental'`. The home page has
	 * no tab strip (apps.html does), so the user picks the visible
	 * section from the Settings page's "Home Page" radio. Default
	 * `'featured'` preserves the pre-2026-06-12 behaviour where home
	 * always painted Featured Apps. Read by the
	 * `<browser-home-apps>` / `<browser-home-title>` custom tag
	 * expansions at home.html render time. */
	homeSection: CatalogGroup;
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
	/** GitHub Contents API endpoint listing every per-app artifact
	 * manifest (`<id>.json`) the catalog ships. The Download / Update
	 * flow fetches this once and verifies the tapped app has a matching
	 * entry before kicking off the per-file download. Surfaced to the
	 * page via the `<browser-config-artifacts>` custom tag.
	 *
	 * **Strict-pinned** at the runtime layer. */
	artifacts: string;
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
	/** GitHub OAuth App client ID for the Device Authorization Grant
	 * (Settings → Login). Public client — GitHub's device flow honors
	 * RFC 8628's public-client model, so no client_secret is needed.
	 * Register at https://github.com/settings/developers as an OAuth App
	 * with "Enable Device Flow" ticked. Surfaced to githubLogin.html via
	 * the `<browser-config-github-client-id/>` custom tag.
	 *
	 * **Override-allowed runtime fallback**: the bundled default in
	 * `@switch-web/runtime`'s `RUNTIME_CONFIG_DEFAULTS` is used when
	 * user config is empty / missing. A non-empty value in user config
	 * wins, so developers can BYO OAuth app without rebuilding the NRO.
	 * Empty in BOTH user config and the runtime default → the auth
	 * page's misconfiguration stage. */
	githubOAuthClientId: string;
	/** Microsoft Entra application (client) ID for the Device
	 * Authorization Grant. Register a single-tenant or multi-tenant
	 * (recommended: multi-tenant `common`) app at Microsoft Entra >
	 * App registrations, then under Authentication enable
	 * "Allow public client flows" — that's required for device-code.
	 * Surfaced to microsoftLogin.html via the
	 * `<browser-config-microsoft-client-id/>` custom tag.
	 *
	 * **Override-allowed runtime fallback** — see
	 * {@link githubOAuthClientId}. */
	microsoftOAuthClientId: string;
	/** Google OAuth client ID for the Limited Input Device flow.
	 * Register in Google Cloud Console > APIs & Services > Credentials
	 * as an "OAuth 2.0 Client ID" of type "TVs and Limited Input
	 * devices" (any other client type — desktop, web, mobile — won't
	 * issue device codes). Surfaced to googleLogin.html via the
	 * `<browser-config-google-client-id/>` custom tag.
	 *
	 * **Override-allowed runtime fallback** — see
	 * {@link githubOAuthClientId}. */
	googleOAuthClientId: string;
	/** Twitch OAuth application client ID. Register at
	 * https://dev.twitch.tv/console with the Device Code Flow enabled.
	 * (Twitch requires an OAuth Redirect URL to be set — `https://localhost`
	 * is fine since device flow never redirects.) Surfaced to
	 * twitchLogin.html via the `<browser-config-twitch-client-id/>` custom
	 * tag.
	 *
	 * **Override-allowed runtime fallback** — see
	 * {@link githubOAuthClientId}. */
	twitchOAuthClientId: string;
}

export const DEFAULT_CONFIG: BrowserConfig = {
	toolbar: 'themes/toolbars/dark.html',
	toolbarHeight: 56,
	pageBackground: '#0b1220',
	videoNVTEGRA: true,
	searchEngine: 'DuckDuckGo',
	wwwRenderChunkMs: 12,
	scrollChunkMs: 4,
	maxHistory: 30,
	theme: 'light',
	clickSounds: true,
	mouseIdleMs: 3000,
	autoRotate: true,
	momentumScrolling: true,
	navDebug: false,
	swbImgDebug: false,
	showSplash: true,
	splashMinMs: 1500,
	splashFadeMs: 500,
	buttonMapping: {},
	keyboardHeight: 400,
	keyboard: 'themes/keyboards/default.html',
	brewserStyle: 'themes/styles/dark.css',
	styleBackground: '',
	toolbarPosition: 'top',
	homeSection: 'featured',
	local: 'dd/mm/yyyy',
	warnings: ['low', 'medium', 'high'],
	// Strict-pinned + override-allowed fields all pull their default
	// from the runtime bundle (@switch-web/runtime). The strict-pinned
	// URLs are also returned unconditionally by `loadConfig` (the user
	// config value, if any, is ignored); the OAuth IDs are the runtime
	// fallback consulted when user config is empty / missing.
	catalogue: RUNTIME_CONFIG_DEFAULTS.catalogue,
	artifacts: RUNTIME_CONFIG_DEFAULTS.artifacts,
	downloads: RUNTIME_CONFIG_DEFAULTS.downloads,
	ratings: RUNTIME_CONFIG_DEFAULTS.ratings,
	telemetry: RUNTIME_CONFIG_DEFAULTS.telemetry,
	githubOAuthClientId: RUNTIME_CONFIG_DEFAULTS.githubOAuthClientId,
	microsoftOAuthClientId: RUNTIME_CONFIG_DEFAULTS.microsoftOAuthClientId,
	googleOAuthClientId: RUNTIME_CONFIG_DEFAULTS.googleOAuthClientId,
	twitchOAuthClientId: RUNTIME_CONFIG_DEFAULTS.twitchOAuthClientId,
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
			videoNVTEGRA: typeof parsed?.videoNVTEGRA === 'boolean' ? parsed.videoNVTEGRA : DEFAULT_CONFIG.videoNVTEGRA,
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
			navDebug: typeof parsed?.navDebug === 'boolean'
				? parsed.navDebug
				: DEFAULT_CONFIG.navDebug,
			swbImgDebug: typeof parsed?.swbImgDebug === 'boolean'
				? parsed.swbImgDebug
				: DEFAULT_CONFIG.swbImgDebug,
			showSplash: typeof parsed?.showSplash === 'boolean'
				? parsed.showSplash
				: DEFAULT_CONFIG.showSplash,
			splashMinMs: typeof parsed?.splashMinMs === 'number' && Number.isFinite(parsed.splashMinMs)
				? Math.max(0, Math.min(10000, Math.trunc(parsed.splashMinMs)))
				: DEFAULT_CONFIG.splashMinMs,
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
			// Permissive empty-string passthrough — unlike `brewserStyle`,
			// "no background" is a valid persisted value (Amber + Neon
			// ship with `background: ""` in `styles.json`). The shell
			// treats empty as "skip the drawImage" rather than falling
			// back to the default theme's image.
			styleBackground: typeof parsed?.styleBackground === 'string'
				? parsed.styleBackground
				: DEFAULT_CONFIG.styleBackground,
			toolbarPosition: parsed?.toolbarPosition === 'top' || parsed?.toolbarPosition === 'bottom'
				? parsed.toolbarPosition
				: DEFAULT_CONFIG.toolbarPosition,
			homeSection: parsed?.homeSection === 'featured'
				|| parsed?.homeSection === 'community'
				|| parsed?.homeSection === 'experimental'
				? parsed.homeSection
				: DEFAULT_CONFIG.homeSection,
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
			artifacts: RUNTIME_CONFIG_DEFAULTS.artifacts,
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
			githubOAuthClientId: typeof parsed?.githubOAuthClientId === 'string'
				&& parsed.githubOAuthClientId.length > 0
				? parsed.githubOAuthClientId
				: DEFAULT_CONFIG.githubOAuthClientId,
			microsoftOAuthClientId: typeof parsed?.microsoftOAuthClientId === 'string'
				&& parsed.microsoftOAuthClientId.length > 0
				? parsed.microsoftOAuthClientId
				: DEFAULT_CONFIG.microsoftOAuthClientId,
			googleOAuthClientId: typeof parsed?.googleOAuthClientId === 'string'
				&& parsed.googleOAuthClientId.length > 0
				? parsed.googleOAuthClientId
				: DEFAULT_CONFIG.googleOAuthClientId,
			twitchOAuthClientId: typeof parsed?.twitchOAuthClientId === 'string'
				&& parsed.twitchOAuthClientId.length > 0
				? parsed.twitchOAuthClientId
				: DEFAULT_CONFIG.twitchOAuthClientId,
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
	/** Catalog group this entry came from (`featured` / `community` /
	 * `experimental`). Surfaced for the same modal-payload reason as
	 * `id`. */
	group: CatalogGroup;
	title: string;
	description: string;
	logo: string;
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
}

/** Catalog group name — every entry in `catalogue.json` lives under one
 * of these three top-level arrays. The Apps page renders each group
 * in its own tab; the welcome page renders only `featured`. */
export type CatalogGroup = 'featured' | 'community' | 'experimental';

export const CATALOG_GROUPS: readonly CatalogGroup[] = ['featured', 'community', 'experimental'];

/** One entry as authored in `catalogue.json`. The catalog is the single
 * source of truth — apps are grouped under three top-level arrays
 * (`featured`, `community`, `experimental`), and each entry carries
 * everything needed to render a card AND to find the app on disk:
 *
 *   - `id` — reverse-DNS folder name under
 *     `sdmc:/switch/brewser/apps/<group>/<id>/` (and the brewser://
 *     equivalent).
 *   - `name` — display title on the card.
 *   - `description` — short blurb under the title.
 *   - `logo` — relative path to the card's image, resolved against
 *     the app's own dir (e.g. `assets/tiktok_logo.png` →
 *     `brewser://apps/<group>/<id>/assets/tiktok_logo.png`).
 *   - `entry` — relative path to the launcher HTML
 *     (e.g. `index.html`).
 *
 * Other catalog fields (version, permissions, features, files…) are
 * ignored by the shell today; future code can read them from the
 * raw catalog without changing this interface. */
interface RawCatalogEntry {
	id: string;
	name: string;
	description?: string;
	logo?: string;
	entry: string;
	version?: string;
	license?: string;
	category?: string;
	developer?: string;
	source?: string;
	/** Capability flags from the manifest (`["video", "controller", …]`).
	 * Free-form strings — the missing-app modal renders them comma-
	 * separated; no validation against an enum. */
	features?: string[];
	/** Permissions the app declares it needs (`["network", "storage", …]`).
	 * Same shape + rendering as `features`. */
	permissions?: string[];
	/** Allowed third-party origins the app may fetch from
	 * (`["https://api.example.com", …]`). Empty array displays as `—`
	 * in the modal. */
	allowed_origins?: string[];
	/** Total download size in bytes (sum of every file in the app's
	 * artifact manifest). Surfaced in the missing-app modal as a
	 * megabyte figure so the user sees the install footprint before
	 * tapping Download/Update. Omitted entries display no size chip. */
	sizeBytes?: number;
}

/** URL of the generic "download" logo painted on cards whose backing
 * app folder isn't on disk. Lives in `<storageRoot>assets/` so it's
 * mirrored from `romfs:/shell/assets/` into the per-profile storageRoot
 * by `seedRomfs` and served through the
 * normal `brewser://assets/...` route. */
const MISSING_APP_LOGO_URL = 'brewser://assets/download.png';

/** Read + validate `<profile>/catalogue.json` and return the entries for
 * the requested group, mapped to `AppEntry` cards. Missing / malformed
 * file → empty list; entries missing any required field are dropped.
 *
 * `logo` and `url` are emitted as `brewser://apps/<group>/<id>/...`
 * paths so they flow through the resource loader (same path as the
 * launched app). The brewser:// scheme keeps the on-device file layout
 * (sdmc vs. romfs) hidden from the page. */
export function loadCatalogGroup(appRoot: string, group: CatalogGroup): AppEntry[] {
	const raw = readCatalogGroup(appRoot, group);
	return raw.map((e) => {
		const entryRel = stripLeadingSlashes(e.entry);
		// "Missing" = the launcher file the card would navigate to isn't
		// present on disk. We probe via `Switch.readFileSync` (the same
		// call the resource loader uses) so the check matches what the
		// real navigation would see — sdmc override files, robocopy'd
		// app folders, etc. Any thrown error counts as missing too: it's
		// the same outcome the user would see (a 404 / blank page).
		let missing = false;
		try {
			const data = Switch.readFileSync(`${appRoot}apps/${group}/${e.id}/${entryRel}`);
			if (!data) missing = true;
		} catch (_) {
			missing = true;
		}
		// Logo URL is independent from `missing`: after a Check-for-
		// Updates refresh, updates-modal.js seeds the missing app's
		// logo into `apps/<group>/<id>/<logo>` so the card paints the
		// real glyph instead of the generic `download.png` while the
		// entry file is still absent. If the logo file isn't on disk
		// (older sync, fetch failed, no logo specified) we fall back
		// to the generic placeholder — same as before this change.
		const logoRel = typeof e.logo === 'string' ? stripLeadingSlashes(e.logo) : '';
		const hasLogo = logoRel !== ''
			&& appFileExists(`${appRoot}apps/${group}/${e.id}/${logoRel}`);
		const logo = hasLogo
			? `brewser://apps/${group}/${e.id}/${logoRel}`
			: MISSING_APP_LOGO_URL;
		const catalogVersion = typeof e.version === 'string' ? e.version : '';
		// Cross-reference the on-disk manifest's version with the
		// catalog. Only meaningful when the app is installed (missing
		// = no manifest to read), and only worth surfacing when both
		// sides have a version AND they differ — otherwise we leave
		// the field empty so the renderer paints the normal chip.
		const installedVersion = missing
			? ''
			: readInstalledVersionIfChanged(appRoot, group, e.id, catalogVersion);
		return {
			id: e.id,
			group,
			title: e.name,
			description: e.description ?? '',
			logo,
			url: `brewser://apps/${group}/${e.id}/${entryRel}`,
			version: catalogVersion,
			license: typeof e.license === 'string' ? e.license : '',
			category: typeof e.category === 'string' ? e.category : '',
			developer: typeof e.developer === 'string' ? e.developer : '',
			source: typeof e.source === 'string' ? e.source : '',
			features: joinStringArray(e.features),
			permissions: joinStringArray(e.permissions),
			allowedOrigins: joinStringArray(e.allowed_origins),
			installedVersion,
			missing,
			entry: entryRel,
			sizeBytes: typeof e.sizeBytes === 'number' && Number.isFinite(e.sizeBytes) && e.sizeBytes > 0
				? e.sizeBytes
				: 0,
		};
	});
}

/** Read `apps/<group>/<id>/manifest.json` and return its `version`
 * field iff that field differs from `catalogVersion`. Empty string in
 * every other case — manifest absent, malformed, missing version, or
 * matching version. This is the "an upgrade is available" signal the
 * grid renderer keys the yellow chip on; the comparison is a strict
 * string match (no semver parsing — catalog authors decide what
 * counts as a change). */
function readInstalledVersionIfChanged(
	appRoot: string,
	group: CatalogGroup,
	id: string,
	catalogVersion: string,
): string {
	if (!catalogVersion) return '';
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${appRoot}apps/${group}/${id}/manifest.json`);
	} catch (_) {
		return '';
	}
	if (!raw) return '';
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		const installed = typeof parsed?.version === 'string' ? parsed.version : '';
		if (!installed || installed === catalogVersion) return '';
		return installed;
	} catch (_) {
		return '';
	}
}

/** Coerce a catalog `features` / `permissions` / `allowed_origins`
 * field to a flat display string. Non-arrays + non-string entries are
 * dropped silently so a malformed manifest produces an empty cell
 * instead of `[object Object]`. */
function joinStringArray(arr: unknown): string {
	if (!Array.isArray(arr)) return '';
	return arr.filter((s): s is string => typeof s === 'string' && s.length > 0).join(', ');
}

function readCatalogGroup(appRoot: string, group: CatalogGroup): RawCatalogEntry[] {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${appRoot}configs/catalogue.json`);
	} catch (_) {
		return [];
	}
	if (!raw) return [];
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		const arr = parsed && Array.isArray(parsed[group]) ? parsed[group] : null;
		if (!arr) return [];
		return arr.filter((e: unknown): e is RawCatalogEntry =>
			!!e && typeof e === 'object'
			&& typeof (e as RawCatalogEntry).id === 'string'
			&& typeof (e as RawCatalogEntry).name === 'string'
			&& typeof (e as RawCatalogEntry).entry === 'string'
			&& (typeof (e as RawCatalogEntry).logo === 'string'
				|| typeof (e as RawCatalogEntry).logo === 'undefined')
			&& (typeof (e as RawCatalogEntry).description === 'string'
				|| typeof (e as RawCatalogEntry).description === 'undefined'),
		);
	} catch (error) {
		console.debug(`[brewser] catalogue.json parse failed: ${error}`);
		return [];
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
				// Forward the optional `background` field (currently only
				// `styles.json` uses it; toolbar + keyboard registries
				// leave it absent). Treated as an opaque path string —
				// resolution happens at paint time in the shell.
				if (typeof e.background === 'string') out.background = e.background;
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
