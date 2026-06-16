/** Logical canvas size in CSS pixels. Matches the player default. */
export declare const DEFAULT_CANVAS_WIDTH = 1280;
export declare const DEFAULT_CANVAS_HEIGHT = 720;
/** Built-in URL the browser opens on launch (and the toolbar Home
 * button targets). The HTML lives on the SD card at
 * `sdmc:/switch/brewser/shell/home.html` (seeded from romfs on first
 * run) so the user can customise it. Renamed from
 * `brewser://welcome/` (welcome.html) 2026-06-02. */
export declare const DEFAULT_HOME_URL = "brewser://home/";
/** Logical origin used by the runtime resource/permission layers for built-in pages. */
export declare const BROWSER_INTERNAL_ORIGIN = "brewser://internal/";
/** Profile root on the SD card. The storageRoot is constructed as
 * `<DEFAULT_PROFILE_ROOT><profile-name>/`; today the only profile is
 * named `shell`, so storageRoot resolves to `sdmc:/switch/brewser/shell/`
 * and holds the seeded chrome pages + their assets plus future per-origin
 * cookies / local-storage. The historical `webprofiles/` intermediate
 * segment was dropped 2026-06-12 alongside the romfs-source rename — the
 * multi-profile design it anticipated was never built. */
export declare const DEFAULT_PROFILE_ROOT = "sdmc:/switch/brewser/";
/** App-level root on the SD card. Holds data shared across profiles:
 * `config.json`, `toolbars.json`, `catalogue.json`, `search_engines.json`,
 * `bookmarks.json`, `history.jsonl`, plus `toolbars/`, `logs/`,
 * `screenshots/`. Lives one level above DEFAULT_PROFILE_ROOT. */
export declare const BREWSER_APP_ROOT = "sdmc:/switch/brewser/";
/** Standard-mapping button indices used by the controller shortcuts. */
export declare const COMBO_BUTTONS: {
    readonly a: 0;
    readonly b: 1;
    readonly x: 2;
    readonly y: 3;
    readonly l: 4;
    readonly r: 5;
    readonly zr: 7;
    readonly minus: 8;
    readonly plus: 9;
    readonly dpadUp: 12;
    readonly dpadDown: 13;
    readonly dpadLeft: 14;
    readonly dpadRight: 15;
};
/** Time the L+R+Minus combo must be held continuously to exit the shell. */
export declare const EXIT_COMBO_HOLD_MS = 1000;
/** On-canvas soft-keyboard layout. All measurements in CSS pixels. */
export declare const KEYBOARD_LAYOUT: {
    /** Top of the keyboard region. Pages keep the area above this strip. */
    readonly topY: 320;
    /** Height of the "edit value" preview between the URL and the keys. */
    readonly editPreviewHeight: 80;
    /** Height of one key row. */
    readonly rowHeight: 60;
    /** Gap between rows. */
    readonly rowGap: 4;
    /** Gap between keys within a row. */
    readonly keyGap: 4;
    /** Horizontal padding inside the keyboard panel. */
    readonly sidePadding: 2;
};
//# sourceMappingURL=browser-config.d.ts.map