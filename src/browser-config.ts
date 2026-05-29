/** Logical canvas size in CSS pixels. Matches the player default. */
export const DEFAULT_CANVAS_WIDTH = 1280;
export const DEFAULT_CANVAS_HEIGHT = 720;

/** Built-in URL the browser opens on launch. The HTML lives on the SD
 * card at `sdmc:/switch/webprofiles/default/pages/welcome.html` (seeded
 * from romfs on first run) so the user can customise it. */
export const DEFAULT_HOME_URL = 'browser://welcome/';

/** Logical origin used by the runtime resource/permission layers for built-in pages. */
export const BROWSER_INTERNAL_ORIGIN = 'browser://internal/';

/** Profile root on the SD card. Per-origin storage is created under this path. */
export const DEFAULT_PROFILE_ROOT = 'sdmc:/switch/webprofiles/';

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

/** Height in CSS pixels of the chrome strip drawn on top of the page. */
export const CHROME_HEIGHT = 56;

/**
 * Chrome strip layout: back / forward / home buttons on the left, URL
 * in the middle, Settings button anchored to the right edge. Pixel
 * coordinates match the chrome strip's top-left at `(0, 0)` and the
 * default canvas width (`DEFAULT_CANVAS_WIDTH`). Buttons fill the full
 * chrome height vertically; touch dispatch in
 * `controller-shortcuts.ts` matches the x-ranges defined here.
 */
const CHROME_RIGHT_PADDING = 24;
// Match the other nav buttons' slot (back / forward / home are 56 px)
// so the settings icon sits with the same `ICON_INSET` breathing room
// rather than swimming in a wide ~32-px pad on each side. The icon
// itself is unchanged — its rendered size is `min(width, chromeHeight)
// - 2 * ICON_INSET = 32 px`, capped by chromeHeight, not slot width.
const SETTINGS_BUTTON_WIDTH = 56;
export const CHROME_LAYOUT = {
	backX: 0,
	backWidth: 56,
	forwardX: 56,
	forwardWidth: 56,
	/** Home button — navigates to `DEFAULT_HOME_URL`. */
	homeX: 112,
	homeWidth: 56,
	/** Star button — toggles the current URL in the bookmarks store.
	 * Sits just left of the URL because its action is "operate on the
	 * thing in the URL bar". */
	starX: 180,
	starWidth: 48,
	/** Where the URL text starts (after a small visual separator). */
	urlX: 240,
	/** Settings button — anchored to the right edge of the chrome strip.
	 * Opens `browser://settings/` (settings.html); icon is
	 * `template.icons.settings`. */
	settingsX: DEFAULT_CANVAS_WIDTH - CHROME_RIGHT_PADDING - SETTINGS_BUTTON_WIDTH,
	settingsWidth: SETTINGS_BUTTON_WIDTH,
} as const;

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
