/**
 * src/update/splash.ts — the pre-shell framebuffer UI for the applier boot
 * roles (STAGED / RECOVERY / RESTORE / POST-APPLY). Draws directly to the nx.js
 * top-level `screen` canvas, BEFORE the browser shell exists.
 *
 * Implements `UpdaterUi`. Applies the rig's anti-OOM lessons (its biggest time
 * sink was a glyph-cache blow-up from continuous full-screen changing text):
 * a dirty-flag so we only redraw when the state changed, a ~11 fps throttle,
 * integer text positions (kills subpixel-offset strike churn), and one font per
 * size. The applier screen is nearly static, so this stays trivial.
 */
import type { UpdaterUi } from './ui';

const W = screen.width;
const H = screen.height;
const ctx = screen.getContext('2d');

let title = 'Updating Brewser';
let phase = '';
let detail = '';
let frac = -1;

let running = false;
let lastSig = '';
let lastDrawAt = 0;
const MIN_INTERVAL = 90; // ms — ~11 fps backstop against churn

function draw(): void {
	ctx.textAlign = 'center';
	// Background.
	ctx.fillStyle = '#0b1220';
	ctx.fillRect(0, 0, W, H);

	const cx = Math.round(W / 2);

	// Title (fixed, large).
	ctx.fillStyle = '#e8e8e8';
	ctx.textBaseline = 'alphabetic';
	ctx.font = '600 44px sans-serif';
	ctx.fillText(title, cx, Math.round(H / 2 - 56));

	// Phase (medium).
	if (phase) {
		ctx.fillStyle = '#c9d5e8';
		ctx.font = '400 26px sans-serif';
		ctx.fillText(phase, cx, Math.round(H / 2 - 8));
	}

	// Progress bar.
	const bw = Math.round(W * 0.46);
	const bh = 14;
	const bx = Math.round((W - bw) / 2);
	const by = Math.round(H / 2 + 20);
	ctx.fillStyle = '#1e2a3d';
	ctx.fillRect(bx, by, bw, bh);
	if (frac >= 0) {
		const f = Math.max(0, Math.min(1, frac));
		ctx.fillStyle = '#65bc7b';
		ctx.fillRect(bx, by, Math.round(bw * f), bh);
	} else {
		// Indeterminate: a faint full bar (no animation → no churn).
		ctx.fillStyle = '#2f4058';
		ctx.fillRect(bx, by, bw, bh);
	}

	// Detail (small).
	if (detail) {
		ctx.fillStyle = '#7f92ad';
		ctx.font = '400 20px sans-serif';
		ctx.fillText(detail, cx, Math.round(H / 2 + 60));
	}
}

function frame(): void {
	if (!running) return;
	const sig = `${title}|${phase}|${detail}|${frac < 0 ? -1 : frac.toFixed(3)}`;
	const now = performance.now();
	if (sig !== lastSig && now - lastDrawAt >= MIN_INTERVAL) {
		try {
			draw();
		} catch {
			/* rendering must never take the applier down */
		}
		lastSig = sig;
		lastDrawAt = now;
	}
	requestAnimationFrame(frame);
}

/** Start the redraw loop. `initialTitle` overrides the default big title. */
export function start(initialTitle?: string): void {
	if (initialTitle) title = initialTitle;
	if (running) return;
	running = true;
	lastSig = '';
	requestAnimationFrame(frame);
}

/** Stop the redraw loop (call before handing off to the browser shell). */
export function stop(): void {
	running = false;
}

export function setTitle(t: string): void {
	title = t;
}

/** The UpdaterUi the applier reports through. */
export const splashUi: UpdaterUi = {
	status(message: string): void {
		phase = message;
	},
	progress(f: number, label?: string): void {
		frac = f;
		if (label !== undefined) detail = label;
	},
};
