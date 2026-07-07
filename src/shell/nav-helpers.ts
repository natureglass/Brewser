/**
 * Pure URL + manifest helpers extracted from `browser-shell.ts`.
 *
 * None of these need the live `BrowserShell` instance — they take
 * profile paths or the current URL as plain string arguments. Kept
 * separate so a future `BrowserShell` PR-split doesn't have to keep
 * dragging them around, and so unit-testing the resolution rules
 * doesn't require booting the shell.
 */

/**
 * The two profile-rooted directories on the SD card the brewser:// URL
 * scheme can target. Apps + dev fixtures live at the app-level root
 * (shared across profiles); everything else lives in the per-profile
 * storage root.
 */
export interface ProfileRoots {
	/** App-level root, e.g. `sdmc:/switch/brewser/`. Hosts `apps/`,
	 * `dev/`, `themes/`, `configs/`. */
	appRoot: string;
	/** Per-profile storage root, e.g. `sdmc:/switch/brewser/shell/`. Hosts
	 * the seeded chrome HTML pages, per-origin state. */
	storageRoot: string;
}

/**
 * Resolve a typed URL against a base URL (typically `session.currentPageUrl`).
 *
 * Absolute schemes (`http://`, `brewser://`, `data:`, …) pass through.
 * `brewser://` bases follow the engine's own segment-walking rules to
 * produce another `brewser://` URL. `http(s)://` bases (external pages
 * like google.com) defer to the standard URL parser so `/search`
 * becomes `https://<host>/search` etc. — required for tier3 form-submit
 * navigation and for relative `<a href>` on external pages.
 */
export function resolveNavUrl(url: string, currentPageUrl: string): string {
	const u = url.trim();
	if (!u) return u;
	if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;          // has scheme → absolute
	const base = currentPageUrl;
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
	// Preserve the trailing slash from a directory-style href (e.g.
	// `./demo/`). Without this, `currentPageUrl` becomes the file-form
	// `brewser://.../demo` after the link load; a subsequent
	// `<a href="../index.html">` then treats `demo` as a sibling file and
	// pops one directory too many (the parent's `index.html` becomes the
	// grandparent's). Same rule as RFC 3986 §5.2 reference resolution.
	const trailing = path.endsWith('/') ? '/' : '';
	for (const seg of path.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') { parts.pop(); continue; }
		parts.push(seg);
	}
	return `brewser://${parts.join('/')}${trailing}${tail}`;
}

/**
 * Compute the page-relative URL base passed to {@link setLivePageBase}
 * after a navigation.
 *
 * External http(s) pages: return the full page URL so the live-DOM
 * resource resolver can hand it straight to `new URL` for spec-correct
 * relative resolution. Crucial for tier3-style pages like google.com
 * whose logo is referenced as a root-relative `/images/branding/…gif`
 * — without the page URL as base, the IMG src reaches the image
 * pipeline as a path with no scheme/host and 404s.
 *
 * brewser:// pages: walk the URL through the same `apps/` + `dev/`
 * routing the `BrowserResourceLoader` uses (apps + dev live at the
 * app-level root; everything else lives in the per-profile storage
 * root). Pick parent dir vs `<path>/` based on whether the matching
 * `.html` candidate exists on disk.
 */
export function computeLivePageBase(url: string, roots: ProfileRoots): string {
	if (/^https?:\/\//i.test(url)) return url;
	if (!/^brewser:\/\//i.test(url)) return '';
	const stripped = url.replace(/^brewser:\/\//i, '')
		.split('?')[0].split('#')[0].replace(/^\/+/, '').replace(/\/+$/, '');
	// Apps live at the app-level root (shared across profiles); the
	// apps.html launcher (no slash after `apps`) stays per-profile.
	// `dev/` is the app-level dev-fixtures + Khronos conformance tree.
	// Mirror of BrowserResourceLoader.resolveContentPath.
	const root = (stripped.startsWith('apps/') || stripped.startsWith('dev/'))
		? roots.appRoot
		: roots.storageRoot;
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

/**
 * If `url` points inside an installed app — i.e. matches
 * `brewser://apps/<group>/<id>/...` — return the `apps/<group>/<id>/`
 * dir prefix. Otherwise `null`. Used to gate the per-app button-router
 * overlay + the context-aware `exit` action.
 */
export function extractAppDirFromUrl(url: string): string | null {
	if (!/^brewser:\/\//i.test(url)) return null;
	const stripped = url.replace(/^brewser:\/\//i, '')
		.split('?')[0].split('#')[0].replace(/^\/+/, '');
	if (!stripped.startsWith('apps/')) return null;
	const parts = stripped.split('/');
	// Need at least `apps/<group>/<id>/...` — three segments + a tail.
	if (parts.length < 4 || !parts[1] || !parts[2]) return null;
	return `apps/${parts[1]}/${parts[2]}/`;
}

/**
 * Parsed shape of an app's `manifest.json`.
 *
 * Only the fields the runtime + shell consult today are typed; unknown
 * keys survive on the parsed object but aren't part of the contract.
 * Every field is optional — a missing manifest, malformed JSON, or a
 * manifest that omits a field must not crash callers.
 */
export interface AppManifest {
	/** Reverse-DNS app id, e.g. `com.natureglass.spectraplay`. Used as
	 * the log-context marker in permission-deny lines. */
	id?: string;
	name?: string;
	version?: string;
	description?: string;
	logo?: string;
	entry?: string;
	category?: string;
	features?: string[];
	/** Manifest-declared permissions. Each string maps to a key in
	 * `configs/warnings.json` (`network`, `storage`, `system`,
	 * `filesystem_read`, `filesystem_write`, `device_info`, `account`,
	 * `external_links`). The runtime consults this on every gated API
	 * to decide whether to permit or deny the call. */
	permissions?: string[];
	compatibility?: string[];
	allowed_origins?: string[];
	developer?: string;
	source?: string;
	license?: string;
	data?: string[];
	/** Map from action name (e.g. `exit`, `refresh`) to button label
	 * (`PLUS`, `B`, …). Used by the shell's button-router overlay so an
	 * app can rebind e.g. `exit` off of the default combo onto a single
	 * button for the lifetime of its navigation. */
	buttonMapping?: Record<string, unknown>;
}

/**
 * Read `<appRoot><appDir>manifest.json` and return the full parsed
 * manifest, or `null` when the file is absent / unreadable / malformed.
 * Callers pick out the fields they care about — button mapping goes to
 * the button-router overlay, permissions go to the permission policy,
 * etc. Kept as a single read so a navigation only touches the SD card
 * once for manifest lookup.
 */
export function loadAppManifest(
	appDir: string,
	appRoot: string,
): AppManifest | null {
	try {
		const path = `${appRoot}${appDir}manifest.json`;
		const raw = (globalThis as { Switch?: { readFileSync?: (p: string) => ArrayBuffer | null } })
			.Switch?.readFileSync?.(path);
		if (!raw) return null;
		const parsed = JSON.parse(new TextDecoder().decode(raw));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as AppManifest;
	} catch (_) {
		return null;
	}
}

/**
 * Read `<appRoot><appDir>manifest.json` and return its parsed
 * `buttonMapping` object (or `null` when absent / malformed). Other
 * manifest fields are ignored here — they belong to the launcher's
 * catalog rendering, which goes through `catalogue.json` instead.
 *
 * Thin wrapper around {@link loadAppManifest} kept for callers that
 * only need the button mapping.
 */
export function loadAppManifestButtonMapping(
	appDir: string,
	appRoot: string,
): Record<string, unknown> | null {
	const manifest = loadAppManifest(appDir, appRoot);
	const bm = manifest?.buttonMapping;
	if (!bm || typeof bm !== 'object' || Array.isArray(bm)) return null;
	return bm as Record<string, unknown>;
}
