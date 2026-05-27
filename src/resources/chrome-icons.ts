/**
 * Lazy loader for the toolbar icon set. Paths come from
 * `BrowserTemplate.icons` (resolved against the profile root by the
 * shell) so a user can swap or relocate icons by editing
 * `template.json`. Each PNG becomes an `Image` the chrome paint code
 * blits with `ctx.drawImage`.
 *
 * Loading is async; the shell should `await loadChromeIcons(...)`
 * once at startup before the first chrome render. Any icon that
 * fails to load is left as `null` and `BrowserUI` falls back to its
 * text/glyph rendering for that button.
 */
export interface ChromeIcons {
	left: Image | null;
	right: Image | null;
	home: Image | null;
	library: Image | null;
	bookmarkTrue: Image | null;
	bookmarkFalse: Image | null;
}

export interface ChromeIconPaths {
	left: string;
	right: string;
	home: string;
	library: string;
	bookmarkTrue: string;
	bookmarkFalse: string;
}

export async function loadChromeIcons(paths: ChromeIconPaths): Promise<ChromeIcons> {
	const [left, right, home, library, bookmarkTrue, bookmarkFalse] = await Promise.all([
		loadImage(paths.left),
		loadImage(paths.right),
		loadImage(paths.home),
		loadImage(paths.library),
		loadImage(paths.bookmarkTrue),
		loadImage(paths.bookmarkFalse),
	]);
	return { left, right, home, library, bookmarkTrue, bookmarkFalse };
}

/** Load an image whose template path may be empty. An empty / missing
 * path resolves to `null` immediately (no fetch, no error log) so the
 * caller can use it as the "no background image" sentinel. */
export function loadOptionalImage(src: string): Promise<Image | null> {
	if (!src) return Promise.resolve(null);
	return loadImage(src);
}

function loadImage(src: string): Promise<Image | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => {
			console.debug(`[switch-web-browser] icon load failed: ${src}`);
			resolve(null);
		};
		img.src = src;
	});
}
