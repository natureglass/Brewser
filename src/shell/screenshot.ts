import {
	nxScreen,
	requestFullRepaint,
	type NxScreenCanvas,
} from '@switch-web/runtime';
import type { BrowserMode } from '@switch-web/runtime';

/**
 * Frame state the screenshot helpers need to compute the safe paint
 * rect. The shell snapshots its own fields into one of these before
 * calling — none of the helpers retain a reference.
 */
export interface ShellPaintFrame {
	chromeHeight: number;
	mode: BrowserMode;
	toolbarPosition: 'top' | 'bottom';
}

declare const Switch: {
	mkdirSync(path: string): void;
	writeFileSync(path: string, data: ArrayBuffer | Uint8Array | string): void;
};

/**
 * Capture the current screen contents as a PNG into the profile's
 * `screenshots/` dir.
 *
 * `screenshotDir` is the (already trailing-slashed) absolute SD-card
 * directory the file lands under — typically `<profile.appRoot>screenshots/`.
 * The directory is created lazily so the shell doesn't have to ensure
 * it at boot.
 *
 * After `toBlob` finishes its internal canvas read we briefly flash
 * the screen white as visual feedback that the shot landed, then
 * persist the bytes to disk. Errors at either step are logged via
 * `console.debug` and otherwise swallowed — the shell stays responsive.
 */
export function captureScreenshot(screenshotDir: string, frame: ShellPaintFrame): void {
	const canvas = nxScreen();
	try { Switch.mkdirSync(screenshotDir); } catch (_) { /* already exists */ }
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const path = `${screenshotDir}screenshot_${ts}.png`;
	canvas.toBlob((blob: Blob | null) => {
		if (!blob) {
			console.debug('[brewser] screenshot: toBlob returned null');
			return;
		}
		// Flash AFTER toBlob's internal canvas read so the saved PNG
		// does NOT include the flash. Visual confirmation that the
		// shot landed; cleared by a single subsequent cache-blit.
		flashScreenshotFeedback(canvas, frame);
		blob.arrayBuffer().then((buf: ArrayBuffer) => {
			try {
				Switch.writeFileSync(path, buf);
				console.debug('[brewser] screenshot saved: ' + path);
			} catch (e) {
				console.debug('[brewser] screenshot write failed: '
					+ (e instanceof Error ? e.message : String(e)));
			}
		});
	});
}

/**
 * Brief white-flash overlay on the screen canvas to confirm a
 * successful screenshot. Drawn DIRECTLY on the framebuffer (one
 * `fillRect`), then cleared by a single `requestFullRepaint` after
 * ~80 ms — the next loop tick blits the live-cache offscreen back
 * over the flashed pixels. Critically:
 *   - No `bumpLiveTreeVersion`, no `markLiveDirty`, no
 *     `patchLiveDirtyRegions` — the live tree / layout state is
 *     unchanged, so the next paint takes the cache-blit fast path
 *     (not the rebuild path).
 *   - No `OffscreenCanvas` allocation, no `getImageData`/`putImageData`
 *     round-trip. One fillRect into the screen ctx + one timer.
 */
export function flashScreenshotFeedback(canvas: NxScreenCanvas, frame: ShellPaintFrame): void {
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	// Clip the flash to the page-content area so the toolbar isn't
	// touched. Fullscreen modes have no chrome, so both insets become
	// 0 and the flash covers everything — the right behaviour for
	// video / fullscreen-canvas / fullscreen-page shots.
	const isBottomToolbar = frame.toolbarPosition === 'bottom';
	const topInset = frame.mode === 'normal' && !isBottomToolbar ? frame.chromeHeight : 0;
	const bottomInset = frame.mode === 'normal' && isBottomToolbar ? frame.chromeHeight : 0;
	const flashH = canvas.height - topInset - bottomInset;
	if (flashH <= 0) { setTimeout(() => requestFullRepaint(), 80); return; }
	ctx.save();
	try {
		ctx.fillStyle = 'rgba(255,255,255,0.85)';
		ctx.fillRect(0, topInset, canvas.width, flashH);
	} finally { ctx.restore(); }
	setTimeout(() => requestFullRepaint(), 80);
}
