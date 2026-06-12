import { nxScreen } from '@switch-web/runtime';
import { CHROME_LAYOUT } from './browser-config.js';
import type { BrowserToolbar, ToolbarPosition } from './profile/browser-toolbar.js';
import { DEFAULT_CONFIG, DEFAULT_TOOLBAR } from './profile/browser-toolbar.js';
import type { ChromeIcons } from './resources/chrome-icons.js';

const PADDING_X = 24;
/** Edge in CSS pixels around an icon inside its button rect. Keeps
 * the icon a few pixels in from the rect so adjacent buttons don't
 * look like one big strip. */
const ICON_INSET = 12;

export interface AddressBarState {
	currentURL: string;
	canGoBack: boolean;
	canGoForward: boolean;
	/** Whether the current URL is in the bookmarks store. Controls the
	 * star button's colour: gold when saved, dim grey when not. */
	bookmarked?: boolean;
	/** Whether the current URL can be bookmarked at all (http/https).
	 * Local `brewser://` pages aren't bookmarkable, so the star button
	 * is hidden and the URL reclaims its space. Defaults to true. */
	bookmarkable?: boolean;
	/** Result of the boot-time HTTP/HTTPS probe (excluding the
	 * romfs-only probe). Drives the status circle to the left of the
	 * Settings button: green when an HTTP(S) attempt succeeded, red
	 * otherwise. `undefined` while the probe is still running — the
	 * indicator is hidden in that case. */
	internetReachable?: boolean;
}

/**
 * Browser chrome.
 *
 * Colours, heights, icon paths, hint text, and toolbar position
 * (`'top'` | `'bottom'`) all come from `BrowserToolbar`. The
 * `renderAddressBar` painter translates the canvas context so each
 * draw helper can use local `0..chromeHeight` coords regardless of
 * where the toolbar actually sits on screen.
 *
 * Touch dispatch in `controller-shortcuts.ts` is told the chrome's
 * screen-space y-range via `setChromeRegion` so taps in either
 * position route to the same chrome-button branches.
 */
export class BrowserUI {
	private icons: ChromeIcons | null = null;
	private toolbar: BrowserToolbar = DEFAULT_TOOLBAR;
	private toolbarPosition: ToolbarPosition = DEFAULT_CONFIG.toolbarPosition;
	private toolbarBackground: Image | null = null;

	setIcons(icons: ChromeIcons): void {
		this.icons = icons;
	}

	setToolbar(toolbar: BrowserToolbar): void {
		this.toolbar = toolbar;
	}

	/** Push the active `config.json` `toolbarPosition` onto the UI.
	 * Called at boot from the shell and again from `saveSettings` when
	 * the user flips the radio so the chrome strip jumps to the new
	 * edge on the next paint. */
	setToolbarPosition(position: ToolbarPosition): void {
		this.toolbarPosition = position;
	}

	/** Background image for the toolbar strip. `null` (or never set)
	 * means draw the bg colour alone. The image is stretched to fit
	 * the toolbar rect so authors can size it to match the strip
	 * width / height in their toolbar. */
	setToolbarBackground(image: Image | null): void {
		this.toolbarBackground = image;
	}

	renderAddressBar(state: AddressBarState, hint?: string): void {
		const canvas = nxScreen();
		const ctx = canvas.getContext('2d');
		const tb = this.toolbar.toolbar;
		const chromeHeight = tb.height;
		const chromeY = this.toolbarPosition === 'bottom' ? canvas.height - chromeHeight : 0;
		const hintText = hint ?? tb.hint;

		ctx.save();
		// Everything from here uses local coordinates inside the chrome
		// strip — y=0 is the top of the strip, y=chromeHeight is the
		// bottom. Helpers reference `chromeHeight / 2` as the vertical
		// centre, which works for both positions.
		ctx.translate(0, chromeY);

		// Strip background. The bg fill is always painted first as a
		// fallback so any transparent area of the image still gets a
		// solid colour. The optional toolbar image (stretched to the
		// strip rect) sits on top, then the 2px accent line lives on
		// the edge facing the content area (bottom for top toolbar,
		// top for bottom toolbar).
		ctx.fillStyle = tb.background;
		ctx.fillRect(0, 0, canvas.width, chromeHeight);
		if (this.toolbarBackground) {
			ctx.drawImage(this.toolbarBackground, 0, 0, canvas.width, chromeHeight);
		}
		ctx.fillStyle = tb.border;
		if (this.toolbarPosition === 'top') {
			ctx.fillRect(0, chromeHeight - 2, canvas.width, 2);
		} else {
			ctx.fillRect(0, 0, canvas.width, 2);
		}

		// Back / forward / refresh / home buttons on the left. Icons when
		// loaded, text-glyph fallback otherwise.
		drawIconOrGlyph(ctx, CHROME_LAYOUT.backX, CHROME_LAYOUT.backWidth, chromeHeight, this.icons?.left ?? null, '‹', state.canGoBack, tb);
		drawIconOrGlyph(ctx, CHROME_LAYOUT.forwardX, CHROME_LAYOUT.forwardWidth, chromeHeight, this.icons?.right ?? null, '›', state.canGoForward, tb);
		drawIconOrLabel(ctx, CHROME_LAYOUT.refreshX, CHROME_LAYOUT.refreshWidth, chromeHeight, this.icons?.refresh ?? null, '⟳', true, tb);
		drawIconOrLabel(ctx, CHROME_LAYOUT.homeX, CHROME_LAYOUT.homeWidth, chromeHeight, this.icons?.home ?? null, 'Home', true, tb);

		// Divider between left-side nav buttons and the URL bar.
		const dividerX = CHROME_LAYOUT.homeX + CHROME_LAYOUT.homeWidth + 4;
		ctx.fillStyle = tb.divider;
		ctx.fillRect(dividerX, 8, 1, chromeHeight - 18);

		// Star button sits immediately before the URL — visually part
		// of the URL bar since its action targets `currentURL`. Two
		// distinct icons so the toggle state is unambiguous. Hidden on
		// non-bookmarkable pages (local `brewser://`): the URL then
		// starts at the star's slot instead, reclaiming the space.
		const bookmarkable = state.bookmarkable ?? true;
		if (bookmarkable) {
			const bookmarked = state.bookmarked ?? false;
			const starIcon = bookmarked ? (this.icons?.bookmarkTrue ?? null) : (this.icons?.bookmarkFalse ?? null);
			drawStarButton(ctx, CHROME_LAYOUT.starX, CHROME_LAYOUT.starWidth, chromeHeight, starIcon, bookmarked, tb);
		}
		const urlX = bookmarkable ? CHROME_LAYOUT.urlX : CHROME_LAYOUT.starX;

		// Settings button (right edge).
		drawIconOrLabel(ctx, CHROME_LAYOUT.settingsX, CHROME_LAYOUT.settingsWidth, chromeHeight, this.icons?.settings ?? null, 'Settings', true, tb);
		// Divider just to the LEFT of the Settings button.
		ctx.fillStyle = tb.divider;
		ctx.fillRect(CHROME_LAYOUT.settingsX - 5, 8, 1, chromeHeight - 18);

		// Network status circle, sitting just left of the Settings button.
		// Green = HTTP(S) probe succeeded, red = failed, hidden while
		// the probe result hasn't been stashed yet.
		const indicatorRadius = 6;
		const indicatorCenterX = CHROME_LAYOUT.settingsX - 22;
		const indicatorRightEdge = indicatorCenterX + indicatorRadius;
		const reachable = state.internetReachable;
		if (reachable !== undefined) {
			ctx.fillStyle = reachable ? '#7eda9f' : '#ff7676';
			ctx.beginPath();
			ctx.arc(indicatorCenterX, chromeHeight / 2, indicatorRadius, 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.textBaseline = 'middle';

		// Right-aligned hint, sitting LEFT of the network indicator so
		// hint + circle + Settings all stay visible. Measured first so
		// the URL knows how much room it has. Skip the draw entirely
		// when the toolbar provides no hint string so the URL bar can
		// claim the full strip.
		const urlRightLimit = reachable !== undefined
			? (indicatorRightEdge - 2 * indicatorRadius - 12)
			: CHROME_LAYOUT.settingsX - 14;
		if (hintText) {
			ctx.font = '14px system-ui';
			const hintWidth = ctx.measureText(hintText).width;
			const hintX = urlRightLimit - hintWidth;
			ctx.fillStyle = tb.hintText;
			ctx.fillText(hintText, hintX, chromeHeight / 2);
		}

		// URL, truncated with an ellipsis if it would collide with the hint.
		ctx.font = '20px system-ui';
		ctx.fillStyle = tb.urlText;
		const maxUrlWidth = urlRightLimit - urlX - 20;
		ctx.fillText(
			truncateToWidth(ctx, state.currentURL, maxUrlWidth),
			urlX,
			chromeHeight / 2,
		);

		ctx.restore();
	}
}

/** Draw a nav-style button: icon if loaded, single-glyph text
 * fallback otherwise. Used for back / forward — both have a
 * meaningful "active" state (inactive = greyed out). */
function drawIconOrGlyph(
	ctx: CanvasRenderingContext2D,
	x: number,
	width: number,
	chromeHeight: number,
	icon: Image | null,
	glyph: string,
	active: boolean,
	tb: BrowserToolbar['toolbar'],
): void {
	if (icon) {
		drawIconCentered(ctx, icon, x, width, chromeHeight, active ? 1 : 0.32);
		return;
	}
	ctx.fillStyle = active ? tb.glyphActive : tb.glyphInactive;
	ctx.font = '32px system-ui';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(glyph, x + width / 2, chromeHeight / 2);
	ctx.textAlign = 'start';
}

/** Draw a label-style button: icon if loaded, text label fallback
 * otherwise. Used for Home / Settings — always active. */
function drawIconOrLabel(
	ctx: CanvasRenderingContext2D,
	x: number,
	width: number,
	chromeHeight: number,
	icon: Image | null,
	label: string,
	active: boolean,
	tb: BrowserToolbar['toolbar'],
): void {
	if (icon) {
		drawIconCentered(ctx, icon, x, width, chromeHeight, active ? 1 : 0.32);
		return;
	}
	ctx.fillStyle = active ? tb.glyphActive : tb.glyphInactive;
	ctx.font = '18px system-ui';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(label, x + width / 2, chromeHeight / 2);
	ctx.textAlign = 'start';
}

/** Star button — gold ★ glyph or the bookmark_true / bookmark_false
 * PNG when loaded. */
function drawStarButton(
	ctx: CanvasRenderingContext2D,
	x: number,
	width: number,
	chromeHeight: number,
	icon: Image | null,
	on: boolean,
	tb: BrowserToolbar['toolbar'],
): void {
	if (icon) {
		drawIconCentered(ctx, icon, x, width, chromeHeight, 1);
		return;
	}
	ctx.fillStyle = on ? tb.starActive : tb.glyphInactive;
	ctx.font = '24px system-ui';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText('★', x + width / 2, chromeHeight / 2);
	ctx.textAlign = 'start';
}

/** Paint an icon centred in the button rect, scaled to fit while
 * preserving aspect ratio. `alpha` dims the icon for inactive states
 * (e.g. back/forward when there's no history in that direction). */
function drawIconCentered(
	ctx: CanvasRenderingContext2D,
	icon: Image,
	x: number,
	width: number,
	chromeHeight: number,
	alpha: number,
): void {
	const available = Math.min(width, chromeHeight) - ICON_INSET * 2;
	const aspect = icon.naturalWidth > 0 ? icon.naturalHeight / icon.naturalWidth : 1;
	let drawW = available;
	let drawH = Math.round(available * aspect);
	if (drawH > available) {
		drawH = available;
		drawW = Math.round(available / Math.max(0.0001, aspect));
	}
	const drawX = x + (width - drawW) / 2;
	const drawY = (chromeHeight - drawH) / 2;
	const prev = ctx.globalAlpha;
	ctx.globalAlpha = alpha;
	ctx.drawImage(icon, drawX, drawY, drawW, drawH);
	ctx.globalAlpha = prev;
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (maxWidth <= 0) return '';
	if (ctx.measureText(text).width <= maxWidth) return text;

	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		const candidate = `${text.slice(0, mid)}…`;
		if (ctx.measureText(candidate).width <= maxWidth) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo === 0 ? '…' : `${text.slice(0, lo)}…`;
}

void PADDING_X;
