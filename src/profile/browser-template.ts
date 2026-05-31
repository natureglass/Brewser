/**
 * Design-time configuration loaded from `<profile>/Templates/…json` —
 * colours, icon paths, toolbar position + height, page padding, hint
 * text. Everything that used to live as inline constants in
 * `browser-ui`, `browser-config`, and the painter is here so a user
 * can re-skin the browser by editing one JSON file on the SD card.
 *
 * The shell reads `<profile>/templates.json` first — a registry list
 * of `{ title, path }` entries — and loads the first entry's template.
 * Future template-switching UI can update the registry's ordering or
 * add an `active` field; today, "first one wins".
 *
 * Unknown fields are ignored; missing fields fall back to
 * `DEFAULT_TEMPLATE`. A malformed file logs a debug message and the
 * shell carries on with defaults — there's no scenario where a bad
 * template can stop the browser from rendering at all.
 */

export type ToolbarPosition = 'top' | 'bottom';

export interface BrowserTemplate {
	toolbar: {
		position: ToolbarPosition;
		height: number;
		background: string;
		/** Optional background image painted across the toolbar rect
		 * (stretched to fit). Empty string = use `background` only.
		 * Resolved against the profile root unless absolute. */
		image: string;
		border: string;
		divider: string;
		urlText: string;
		hintText: string;
		hint: string;
		glyphActive: string;
		glyphInactive: string;
		starActive: string;
	};
	icons: {
		back: string;
		forward: string;
		refresh: string;
		home: string;
		settings: string;
		bookmarkTrue: string;
		bookmarkFalse: string;
	};
	page: {
		background: string;
		/** Distance from the chrome strip (or the canvas edge in
		 * fullscreen mode) to the first content block. The first
		 * block's own `marginTop` adds to this. */
		topPadding: number;
		/** Horizontal gutter on each side of the content area. */
		sidePadding: number;
	};
	/** On-canvas soft keyboard colours. Layout (row count, key sizes,
	 * positions) stays hardcoded in `KEYBOARD_LAYOUT`; only colours
	 * are templatable today. */
	keyboard: {
		panelBorder: string;
		panelBg: string;
		/** Optional background image painted across the keyboard panel
		 * rect (stretched to fit). Empty string = use `panelBg` only.
		 * Resolved against the profile root unless absolute. */
		image: string;
		/** 0 → keys fully opaque (default). 1 → keys fully transparent
		 * (invisible). Affects the key rectangles AND their labels so
		 * the keyboard background image shows through proportionally;
		 * the panel bg, edit preview, and help footer stay opaque. */
		transparency: number;
		editBg: string;
		editText: string;
		editCursor: string;
		keyBg: string;
		keyFocusBg: string;
		keyText: string;
		keyActionBg: string;
		keyActionFocusBg: string;
		keyActionText: string;
		helpText: string;
	};
}

export const DEFAULT_TEMPLATE: BrowserTemplate = {
	toolbar: {
		position: 'top',
		height: 56,
		background: '#0d1426',
		image: '',
		border: '#1f2c4d',
		divider: '#1a2440',
		urlText: '#e0e8f4',
		hintText: '#7a8aa3',
		hint: '',
		glyphActive: '#e0e8f4',
		glyphInactive: '#3a4866',
		starActive: '#ffd35e',
	},
	icons: {
		back: 'assets/left.png',
		forward: 'assets/right.png',
		refresh: 'assets/refresh.png',
		home: 'assets/home.png',
		settings: 'assets/settings.png',
		bookmarkTrue: 'assets/bookmark_true.png',
		bookmarkFalse: 'assets/bookmark_false.png',
	},
	page: {
		background: '#0b1220',
		topPadding: 12,
		sidePadding: 48,
	},
	keyboard: {
		panelBorder: '#1f2c4d',
		panelBg: '#080d1a',
		image: '',
		transparency: 0,
		editBg: '#101a30',
		editText: '#e0e8f4',
		editCursor: '#7aa2ff',
		keyBg: '#162038',
		keyFocusBg: '#2a3a66',
		keyText: '#dbe5f4',
		keyActionBg: '#1a2c4a',
		keyActionFocusBg: '#3a5688',
		keyActionText: '#ffffff',
		helpText: '#7a8aa3',
	},
};

/** One row in `<profile>/templates.json`. `path` is relative to the
 * profile root unless it carries an absolute scheme (`sdmc:/…`,
 * `romfs:/…`). */
export interface TemplateEntry {
	title: string;
	path: string;
}

/** Shell-level preferences from `<profile>/config.json`. The active
 * template's path is the historical primary key; additional shell
 * preferences slot in alongside.
 *
 * IMPORTANT: when adding a field here, also (a) parse it in
 * `loadConfig` below with the same DEFAULT_CONFIG fallback, AND
 * (b) add it to `romfs/config.json` so the seeded profile copy
 * carries the default value. The template-toggle write path in
 * browser-shell.ts spreads existing keys forward unchanged, so any
 * key present in on-disk config (whether user-set or seeded) survives
 * template changes — keep it that way. */
export interface BrowserConfig {
	template: string;
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
	 * live-overlay via `setLiveBuildChunkMs`. */
	renderChunkMs: number;
	/** Per-frame paint budget (ms) used while the user is SCROLLING a page
	 * whose cache is still building — deliberately smaller than
	 * `renderChunkMs` so each scroll tick stays cheap and scrolling stays
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
	 * background colour (white for `light`, the template's
	 * `page.background` for `dark`) and the `@media
	 * (prefers-color-scheme:…)` cascade. Defaults to `light` to match
	 * the wider web's expected default. */
	theme: 'light' | 'dark';
}

export const DEFAULT_CONFIG: BrowserConfig = {
	template: 'Templates/default.json',
	videoNVTEGRA: true,
	searchEngine: 'DuckDuckGo',
	renderChunkMs: 12,
	scrollChunkMs: 4,
	maxHistory: 30,
	theme: 'light',
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
	logo: '../pages/assets/duckduckgo_logo.png',
	url: 'https://duckduckgo.com/',
	query: 'https://duckduckgo.com/?q=',
};

const decoder = new TextDecoder();

/** Read `<profile>/config.json`. Missing / malformed / wrong-typed
 * fields fall back to `DEFAULT_CONFIG` field-by-field, so a partial
 * config is fine (the user only needs to set what they want to change). */
export function loadConfig(profileRoot: string): BrowserConfig {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${profileRoot}config.json`);
	} catch (_) {
		return DEFAULT_CONFIG;
	}
	if (!raw) return DEFAULT_CONFIG;
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		return {
			template: typeof parsed?.template === 'string' ? parsed.template : DEFAULT_CONFIG.template,
			videoNVTEGRA: typeof parsed?.videoNVTEGRA === 'boolean' ? parsed.videoNVTEGRA : DEFAULT_CONFIG.videoNVTEGRA,
			searchEngine: typeof parsed?.searchEngine === 'string' ? parsed.searchEngine : DEFAULT_CONFIG.searchEngine,
			renderChunkMs: typeof parsed?.renderChunkMs === 'number' && Number.isFinite(parsed.renderChunkMs)
				? Math.max(1, Math.min(1000, parsed.renderChunkMs))
				: DEFAULT_CONFIG.renderChunkMs,
			scrollChunkMs: typeof parsed?.scrollChunkMs === 'number' && Number.isFinite(parsed.scrollChunkMs)
				? Math.max(1, Math.min(1000, parsed.scrollChunkMs))
				: DEFAULT_CONFIG.scrollChunkMs,
			maxHistory: typeof parsed?.maxHistory === 'number' && Number.isFinite(parsed.maxHistory)
				? Math.max(1, Math.min(10000, Math.trunc(parsed.maxHistory)))
				: DEFAULT_CONFIG.maxHistory,
			theme: parsed?.theme === 'dark' || parsed?.theme === 'light'
				? parsed.theme
				: DEFAULT_CONFIG.theme,
		};
	} catch (error) {
		console.debug(`[switch-web-browser] config.json parse failed: ${error}`);
		return DEFAULT_CONFIG;
	}
}

/** One entry in `apps.json`. `logo` + `url` are paths relative to the
 * profile root's `pages/` dir (e.g. `../pages/apps/foo/logo.png`),
 * authored the same way the welcome page's relative asset paths are.
 * `logo` is used verbatim as an `<img src>`; `url` is rewritten to an
 * absolute `browser://` URL for the card link (see `renderAppCards`). */
export interface AppEntry {
	title: string;
	description: string;
	logo: string;
	url: string;
}

/** Read + validate `<profile>/apps.json` — the catalog the Apps page
 * lists as cards. Returns the entries in source order; missing,
 * malformed, or non-array files yield an empty list (the page then
 * shows its empty-state). Each entry must carry all four string
 * fields; partial entries are dropped. */
export function loadApps(profileRoot: string): AppEntry[] {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${profileRoot}apps.json`);
	} catch (_) {
		return [];
	}
	if (!raw) return [];
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((e): e is AppEntry =>
			!!e && typeof e.title === 'string' && typeof e.description === 'string'
			&& typeof e.logo === 'string' && typeof e.url === 'string',
		);
	} catch (error) {
		console.debug(`[switch-web-browser] apps.json parse failed: ${error}`);
		return [];
	}
}

/** Read + validate `<profile>/search_engines.json`. Returns the
 * built-in DuckDuckGo entry as a single-element list if the file is
 * missing / malformed, so search always has a usable engine. */
export function loadSearchEngines(profileRoot: string): SearchEngine[] {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${profileRoot}search_engines.json`);
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
		console.debug(`[switch-web-browser] search_engines.json parse failed: ${error}`);
		return [DEFAULT_SEARCH_ENGINE];
	}
}

/** Resolve the active search engine: the entry whose `title` matches
 * `config.json`'s `searchEngine`, else the first listed engine, else
 * the built-in default. */
export function resolveSearchEngine(profileRoot: string): SearchEngine {
	const engines = loadSearchEngines(profileRoot);
	const selected = loadConfig(profileRoot).searchEngine;
	return engines.find((e) => e.title === selected) ?? engines[0] ?? DEFAULT_SEARCH_ENGINE;
}

/** Read `<profile>/templates.json` and return the validated entries
 * in source order. Missing or malformed file → empty array. */
export function loadTemplateRegistry(profileRoot: string): TemplateEntry[] {
	let raw: ArrayBuffer | null;
	try {
		raw = Switch.readFileSync(`${profileRoot}templates.json`);
	} catch (_) {
		return [];
	}
	if (!raw) return [];
	try {
		const parsed = JSON.parse(decoder.decode(raw));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((e): e is TemplateEntry =>
			!!e && typeof e.title === 'string' && typeof e.path === 'string',
		);
	} catch (error) {
		console.debug(`[switch-web-browser] templates.json parse failed: ${error}`);
		return [];
	}
}

/** Resolve a template-entry path against the profile root unless it
 * already carries an absolute scheme. */
function resolveTemplatePath(profileRoot: string, rel: string): string {
	if (/^(?:sdmc:|romfs:)\/\//.test(rel)) return rel;
	return `${profileRoot}${rel}`;
}

export function loadTemplate(profileRoot: string): BrowserTemplate {
	// Resolution order:
	//   1. config.json's `template` field — the user-chosen active template.
	//   2. First entry in templates.json — sensible fallback if config is
	//      missing or its path points at a deleted/broken file.
	// Each candidate is tried in turn; the first one that reads + parses
	// successfully wins. If all fall through, `DEFAULT_TEMPLATE` keeps
	// the browser usable.
	const config = loadConfig(profileRoot);
	const candidates: string[] = [config.template];
	const registry = loadTemplateRegistry(profileRoot);
	if (registry[0] && registry[0].path !== config.template) {
		candidates.push(registry[0].path);
	}
	for (const rel of candidates) {
		const path = resolveTemplatePath(profileRoot, rel);
		let raw: ArrayBuffer | null;
		try {
			raw = Switch.readFileSync(path);
		} catch (_) {
			continue;
		}
		if (!raw) continue;
		try {
			const parsed = JSON.parse(decoder.decode(raw)) as Partial<BrowserTemplate>;
			return mergeTemplate(DEFAULT_TEMPLATE, parsed);
		} catch (error) {
			console.debug(`[switch-web-browser] template '${rel}' parse failed: ${error}`);
			continue;
		}
	}
	return DEFAULT_TEMPLATE;
}

function mergeTemplate(base: BrowserTemplate, override: Partial<BrowserTemplate>): BrowserTemplate {
	return {
		toolbar: { ...base.toolbar, ...(override.toolbar ?? {}) },
		icons: { ...base.icons, ...(override.icons ?? {}) },
		page: { ...base.page, ...(override.page ?? {}) },
		keyboard: { ...base.keyboard, ...(override.keyboard ?? {}) },
	};
}
