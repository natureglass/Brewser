/** Logical canvas size in CSS pixels. Matches the player default. */
export const DEFAULT_CANVAS_WIDTH = 1280;
export const DEFAULT_CANVAS_HEIGHT = 720;

/** Built-in URL the browser opens on launch (and the toolbar Home
 * button targets). The HTML lives on the SD card at
 * `sdmc:/switch/brewser/shell/home.html` (seeded from romfs on first
 * run) so the user can customise it. Renamed from
 * `brewser://welcome/` (welcome.html) 2026-06-02. */
export const DEFAULT_HOME_URL = 'brewser://home/';

/** Logical origin used by the runtime resource/permission layers for built-in pages. */
export const BROWSER_INTERNAL_ORIGIN = 'brewser://internal/';

/** Profile root on the SD card. The storageRoot is constructed as
 * `<DEFAULT_PROFILE_ROOT><profile-name>/`; today the only profile is
 * named `shell`, so storageRoot resolves to `sdmc:/switch/brewser/shell/`
 * and holds the seeded chrome pages + their assets plus future per-origin
 * cookies / local-storage. The historical `webprofiles/` intermediate
 * segment was dropped 2026-06-12 alongside the romfs-source rename — the
 * multi-profile design it anticipated was never built. */
export const DEFAULT_PROFILE_ROOT = 'sdmc:/switch/brewser/';

/** App-level root on the SD card. Holds data shared across profiles:
 * `config.json`, `toolbars.json`, `catalogue.json`, `search_engines.json`,
 * `bookmarks.json`, `history.jsonl`, plus `toolbars/`, `logs/`,
 * `screenshots/`. Lives one level above DEFAULT_PROFILE_ROOT. */
export const BREWSER_APP_ROOT = 'sdmc:/switch/brewser/';

/** Standard-mapping button indices used by the controller shortcuts. */
export const COMBO_BUTTONS = {
	a: 0,
	b: 1,
	x: 2,
	y: 3,
	l: 4,
	r: 5,
	zr: 7,
	minus: 8,
	plus: 9,
	dpadUp: 12,
	dpadDown: 13,
	dpadLeft: 14,
	dpadRight: 15,
} as const;

/** Time the L+R+Minus combo must be held continuously to exit the shell. */
export const EXIT_COMBO_HOLD_MS = 1000;

// Chrome strip layout pre-2026-06-14 was a pixel-keyed back/forward/
// refresh/home/star/URL/settings table (`CHROME_LAYOUT`, `CHROME_HEIGHT`).
// Both ripped when the toolbar moved to HTML-driven themes: layout now
// lives in each theme's `<style>` block, height comes from
// `BrowserConfig.toolbarHeight`, and tap dispatch hit-tests the toolbar
// live root for `data-action` ancestors instead of comparing pixel
// ranges. See `live-input-dispatch.ts dispatchChromeTap`.

/** On-canvas soft-keyboard layout. All measurements in CSS pixels. */
export const KEYBOARD_LAYOUT = {
	/** Top of the keyboard region. Pages keep the area above this strip. */
	topY: 320,
	/** Height of the "edit value" preview between the URL and the keys. */
	editPreviewHeight: 80,
	/** Height of one key row. */
	rowHeight: 60,
	/** Gap between rows. */
	rowGap: 4,
	/** Gap between keys within a row. */
	keyGap: 4,
	/** Horizontal padding inside the keyboard panel. */
	sidePadding: 2,
} as const;
