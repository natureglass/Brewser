// live-video.ts — slice-2a `<video>` element runtime (video frames only, no
// audio yet — slice 2b adds AAC + audrv).
//
// Owns per-element decoder state via a WeakMap (mirroring live-form.ts's
// valueMap pattern). Each VIDEO element gets a Switch.VideoDecoder backed
// by libavcodec + NVTEGRA hw-accel in nxjs-source/source/video.c. The
// decoder pushes RGBA frames into a ring buffer; tickVideo() polls each
// active decoder once per shell rAF tick and uploads the most-recent
// frame into the element's OffscreenCanvas.
//
// Paint hook: live-overlay.ts's paintVideoPlaceholder calls getVideoFrame
// to fetch the per-element OffscreenCanvas. When non-null, the overlay
// drawImages it instead of the slice-1 black-box-and-play-triangle.
//
// LiveElement integration: live-dom.ts adds the standard HTMLMediaElement
// surface (currentTime, paused, play(), pause(), duration) that
// delegates here.
//
// URL support:
//   - Local paths the native FFmpeg + libnx fopen can open directly:
//     sdmc:/, romfs:/, absolute / relative disk paths.
//   - http(s) URLs: libavformat opens them itself via its http + tls
//     protocols. The TLS backend is libnx (Switch system SSL service);
//     enabled in the switch-ffmpeg port via tls.patch + the configure
//     line `--enable-protocol=...,https,tls,...`. Required for the
//     TikTok demo at romfs/dev/tiktok.html, which feeds
//     a CDN MP4 URL directly to the <video src>.
//   - brewser://, page-relative paths: resolved by resolveLiveResourceUrl
//     before they reach the protocol check below.

import { resolveLiveResourceUrl, type LiveElement } from './live-dom.js';

// =========================================================================
// Native bridge — Switch.VideoDecoder is registered by the nxjs runtime
// layer (packages/runtime/src/switch/video-decoder.ts). The runtime
// deletes globalThis.$ after capturing it, so we can't reach native
// bindings directly; the Switch.VideoDecoder class is the public face.
// =========================================================================

interface VideoFrameData {
	data: ArrayBuffer | null;
	width: number;
	height: number;
	pts: number;
	ended: boolean;
}

interface VideoDecoderHandle {
	readonly width: number;
	readonly height: number;
	readonly duration: number;
	readonly paused: boolean;
	readonly ended: boolean;
	readonly usedHw: boolean;
	readonly usedAudio: boolean;
	readonly usedVideo: boolean;
	readonly muted: boolean;
	readonly volume: number;
	/** Accurate audio playback position in seconds (audrv played-sample
	 * clock). Tracks audio-only playback where there are no video PTS. */
	readonly audioTime: number;
	readonly audioError: string | null;
	readonly error: string | null;
	close(): void;
	play(): void;
	pause(): void;
	seek(seconds: number): void;
	setMuted(muted: boolean): void;
	setVolume(volume: number): void;
	/** Audio-reactive per-band RMS levels at the play head (low→high),
	 * ~0..1 unsmoothed. Empty before audio starts / no-audio sources. */
	getAudioLevels(): number[];
	/** Fill `out` with the frequency spectrum at the play head (low→high,
	 * ~0..1). Returns true when data was written. */
	getFrequencyData(out: Float32Array): boolean;
	/** Fill `out` with the time-domain waveform at the play head (-1..1).
	 * Returns true when data was written. */
	getWaveform(out: Float32Array): boolean;
	nextFrame(): VideoFrameData | null;
}

type VideoDecoderCtor = new (
	url: string,
	opts?: {
		hwAccel?: boolean;
		loop?: boolean;
		muted?: boolean;
		noAudio?: boolean;
	},
) => VideoDecoderHandle;

function getVideoDecoderCtor(): VideoDecoderCtor | null {
	const sw = (globalThis as { Switch?: { VideoDecoder?: VideoDecoderCtor } }).Switch;
	if (!sw || typeof sw.VideoDecoder !== 'function') return null;
	return sw.VideoDecoder;
}

// Frame-delivery primitive added to nxjs-source 2026-05-26 for slice 2a.
// `Switch.createBitmapFromRGBA(bytes, w, h)` allocates an ImageBitmap with
// a backing Cairo surface; `Switch.writeRGBAToBitmap(bmp, bytes)` refreshes
// its pixels in place (no per-frame realloc). The bitmap can then be drawn
// onto any 2D ctx via the standard `ctx.drawImage(bmp, x, y)` path, which
// goes through cairo's well-tested image-surface paint (operator OVER,
// bounded to source rect) — sidestepping the second-call hang we hit with
// `ctx.putImageData` direct to the screen ctx (see
// feedback_nxjs_putimagedata_screen_ctx_hangs_on_second_call).
//
// IMPORTANT (2026-05-26 evening Citron diag): reusing a single ImageBitmap
// across frames via writeRGBAToBitmap HANGS on the second writeRGBA into
// a surface that was previously used as a drawImage source. Same flavor
// as the original putImageData second-call hang — cairo image-surface
// state corruption after the surface is touched as a paint source.
// REUSE between frames (2026-05-26 evening): once the
// JS_NewArrayBuffer free-callback ABI bug was fixed (see
// feedback_nxjs_arraybuffer_free_callback_signature), the original
// reason we were forced onto recreate-per-frame disappeared. Reuse
// is now the perf default: one ImageBitmap per dimension change,
// pixels refreshed in-place each frame via Switch.writeRGBAToBitmap.
// Skips per-frame `imageNew` + `cairo_image_surface_create_for_data`
// + the matching `close()` from the previous frame. Flip back to
// `false` only if a regression appears.
const VIDEO_BITMAP_REUSE_BETWEEN_FRAMES = true;
// Frame-2 stall diag (2026-05-26 evening): even with recreate-per-frame
// the JS thread silently stops after frame 2's createBitmapFromRGBA OK.
// The only structurally-new thing on frame 2 is closing the OLD bitmap
// (which was a drawImage source 4 times) immediately before allocating
// the new one. Set this to false to skip the close() — leaks ~300KB to
// GC per frame, fine for a short A/B test that closes the loop on whether
// the close+immediate-realloc against cairo is the bug.
const VIDEO_BITMAP_EXPLICIT_CLOSE = true;
// NVTEGRA hw-accel toggle. Driven by `videoNVTEGRA` in the profile's
// config.json (see browser-template.ts BrowserConfig). The shell calls
// `setVideoTryHwAccel(config.videoNVTEGRA)` at startup; live-video.ts
// then passes that value as `hwAccel` to new VideoDecoder instances.
// When true and Citron returns `decoder.error` from the hw decoder,
// tickVideo's per-element `hwFallbackAttempted` one-shot transparently
// re-opens with hwAccel:false. See [[nvtegra-unreliable-on-citron]] for
// the failure mode; the green-frame mode does NOT trigger the fallback
// since it doesn't set decoder.error — for that, the user toggles
// videoNVTEGRA:false in config.json.
let videoTryHwAccel = true;
export function setVideoTryHwAccel(enabled: boolean): void {
	videoTryHwAccel = enabled;
}

// Session-wide "HW is broken on this runtime" latch. Flipped to true the
// first time a hw decoder stalls (no first frame within HW_STALL_TIMEOUT_MS
// of play()). Once set, every subsequent openDecoder forces wantHw=false,
// AND any currently-active hw decoders are re-opened in sw on the next
// tickVideo. Stays true for the rest of the process lifetime — there's no
// recovery from a corrupted NVTEGRA device context, only fresh decoders.
//
// Real-hardware path: HW produces first frame in <500 ms; the timeout
// never fires; latch stays false; HW stays on for the whole session.
// Citron path: MP4 hw-decode silently stalls; latch fires; all decoders
// downgrade. User-visible effect: a ~1.5 s warmup on the first stalled
// video, then everything works.
let gHwStallDetected = false;
const HW_STALL_TIMEOUT_MS = 1500;
// Citron NVTEGRA failure mode #2 (2026-06-01, seen on the TikTok demo):
// first frame decodes fine, audio plays through, but the video decoder
// silently stops producing frames after frame 0. Doesn't trip HW_STALL
// (that's gated on !hasFirstFrame). Doesn't set decoder.error (no fatal
// avcodec_send_packet failure surfaces). Watchdog: after the first frame
// arrived, if the decoder has audio AND audioTime advances past this
// many ms but currentPts hasn't moved in that window, fall back to sw.
const HW_FRAME_STALL_AFTER_FIRST_MS = 1500;
type NxImageBitmap = CanvasImageSource & { width: number; height: number };
interface BitmapBridge {
	createBitmapFromRGBA?: (
		bytes: ArrayBuffer | Uint8Array | Uint8ClampedArray,
		w: number,
		h: number,
	) => NxImageBitmap;
	writeRGBAToBitmap?: (
		bmp: NxImageBitmap,
		bytes: ArrayBuffer | Uint8Array | Uint8ClampedArray,
	) => void;
}
function getBitmapBridge(): BitmapBridge | null {
	const sw = (globalThis as { Switch?: BitmapBridge }).Switch;
	if (!sw) return null;
	return sw;
}

// =========================================================================
// Per-element state
// =========================================================================

interface VideoState {
	decoder: VideoDecoderHandle | null;
	url: string | null;
	frameBytes: Uint8ClampedArray | null;
	frameW: number;
	frameH: number;
	// Reusable ImageBitmap holding the current frame's pixels. Allocated
	// once per (frameW, frameH) and refreshed in-place each tick via
	// Switch.writeRGBAToBitmap. Null when the bridge runtime is too old
	// to expose the bitmap helpers (slice 2a fallback path: putImageData
	// directly, see paintVideoFrameAt).
	frameBitmap: NxImageBitmap | null;
	// Slice 2b followup #6: bitmap captured from the very first decoded
	// frame at page-load time (via scanForAutoplayVideos opening with
	// noAudio:true). Survives the close of the preview decoder so the
	// element renders a static still until the user taps play. Cleared
	// when a live frameBitmap takes over OR on clearAllVideos.
	posterBitmap: NxImageBitmap | null;
	currentPts: number;
	loadError: string | null;
	autoplayApplied: boolean;
	hasFirstFrame: boolean;
	// True once we've already tried the hw → sw fallback for this
	// element. One-shot; prevents oscillation if the sw decoder ALSO
	// somehow errors. See VIDEO_TRY_HW_ACCEL.
	hwFallbackAttempted: boolean;
	// `performance.now()` at the most recent videoPlay() call, or null
	// if not currently waiting on a first frame. Used to detect silent
	// hw-decoder stalls (Citron NVTEGRA) — see HW_STALL_TIMEOUT_MS.
	// Cleared when hasFirstFrame goes true or when the decoder is
	// re-opened or stopped.
	playRequestedAt: number | null;
	// Tracks the first frame's wall-clock arrival + the PTS at that
	// moment. After the first frame, if decoder.audioTime advances by
	// HW_FRAME_STALL_AFTER_FIRST_MS but currentPts hasn't budged, we
	// assume the NVTEGRA decoder silently stopped (Citron failure mode
	// #2) and fall back to sw — see HW_FRAME_STALL_AFTER_FIRST_MS.
	firstFrameAtMs: number | null;
	firstFramePts: number;
	// Slice 2b followup #5: set true by scanForVideoPosters when a
	// decoder was opened+played at page load purely to capture the
	// first frame as a static preview. tickVideo pauses + unmutes the
	// decoder once the first frame lands, then clears the flag. User
	// videoPlay also clears it (and unmutes) so a user-initiated play
	// removes any leftover preview-mute state.
	needsPosterPause: boolean;
	// Desired audio gain (0..1) + mute, set from JS (HTMLMediaElement
	// volume/muted) and REMEMBERED here so they survive decoder re-opens
	// (track change, ended-restart, seek-reopen). Applied to each freshly
	// opened decoder via setVolume/setMuted.
	volume: number;
	muted: boolean;
}

const videoStateMap = new WeakMap<LiveElement, VideoState>();
const activeVideos = new Set<LiveElement>();
// Separate from activeVideos: tracks elements that hold a posterBitmap
// after their preview decoder was closed. Used by clearAllVideos to
// free those bitmaps on navigation — they'd otherwise outlive the page.
const elementsWithPosters = new Set<LiveElement>();

function ensureState(el: LiveElement): VideoState {
	let st = videoStateMap.get(el);
	if (!st) {
		st = {
			decoder: null,
			url: null,
			frameBytes: null,
			frameW: 0,
			frameH: 0,
			frameBitmap: null,
			posterBitmap: null,
			currentPts: 0,
			loadError: null,
			autoplayApplied: false,
			hasFirstFrame: false,
			hwFallbackAttempted: false,
			playRequestedAt: null,
			firstFrameAtMs: null,
			firstFramePts: 0,
			needsPosterPause: false,
			volume: 1,
			muted: false,
		};
		videoStateMap.set(el, st);
	}
	return st;
}

// =========================================================================
// Source-URL resolution — slice-2a accepts only paths the native fopen
// can handle. Anything else returns null and the painter falls back to
// the slice-1 placeholder.
// =========================================================================

function resolveSourceForDecoder(el: LiveElement): string | null {
	const direct = el.getAttribute('src');
	const candidates: string[] = [];
	if (direct) candidates.push(direct);
	for (const child of el.children) {
		if (child.tagName !== 'SOURCE') continue;
		const s = child.getAttribute('src');
		if (s) candidates.push(s);
	}
	for (const c of candidates) {
		// Resolve page-relative srcs (`./song.mp3`, `../media/x.mp3`,
		// `brewser://...`) the same way `<img>` does, then accept the native
		// paths the FFmpeg + libnx fopen can open.
		const r = resolveLiveResourceUrl(c);
		if (
			r.startsWith('sdmc:/') ||
			r.startsWith('romfs:/') ||
			r.startsWith('https://') ||
			r.startsWith('http://') ||
			r.startsWith('/')
		) {
			return r;
		}
	}
	return null;
}

// =========================================================================
// Decoder lifecycle
// =========================================================================

function openDecoder(
	el: LiveElement, st: VideoState, wantHw: boolean,
	opts: { noAudio?: boolean; silentOnError?: boolean } = {},
): void {
	const Ctor = getVideoDecoderCtor();
	if (!Ctor) {
		st.loadError = 'Switch.VideoDecoder missing — rebuild nxjs.nro';
		return;
	}
	const url = resolveSourceForDecoder(el);
	if (!url) {
		st.loadError = 'no playable source (accepts sdmc:/, romfs:/, http(s)://, or absolute paths)';
		return;
	}
	// Session-wide HW kill switch: once any decoder has stalled while
	// using NVTEGRA hw-accel (Citron emulation issue), every subsequent
	// open forces sw regardless of the per-call wantHw arg.
	if (gHwStallDetected) wantHw = false;
	// `<video loop>` → native auto-re-seek on EOF (slice-2b followup #3).
	// JS can't drive looping after EOF because all three decoder threads
	// exit at that point; the native side has to either keep them alive
	// (loop branch) or send the EOS marker that tears them down (non-loop).
	const wantLoop = el.hasAttribute('loop');
	const noAudio = opts.noAudio === true;
	try {
		const dec = new Ctor(url, {
			hwAccel: wantHw, loop: wantLoop, noAudio,
		});
		st.decoder = dec;
		st.url = url;
		st.frameW = dec.width;
		st.frameH = dec.height;
		activeVideos.add(el);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		// Construction-time hw failure (e.g. NVTEGRA session limit hit when
		// many `<video>` elements coexist on a page). The tickVideo
		// fallback only handles runtime errors on an already-constructed
		// decoder — for construction failures we have to retry sw HERE,
		// otherwise the element gets stuck on the slice-1 placeholder
		// while siblings that won the hw lottery play normally. Mirrors
		// the tickVideo fallback's hwFallbackAttempted one-shot guard.
		if (wantHw) {
			st.hwFallbackAttempted = true;
			try {
				const dec = new Ctor(url, {
					hwAccel: false, loop: wantLoop, noAudio,
				});
				st.decoder = dec;
				st.url = url;
				st.frameW = dec.width;
				st.frameH = dec.height;
				activeVideos.add(el);
				return;
			} catch (e2: unknown) {
				if (opts.silentOnError) return;
				const msg2 = e2 instanceof Error ? e2.message : String(e2);
				st.loadError = `VideoDecoder open failed (sw retry): ${msg2}`;
				return;
			}
		}
		// `silentOnError` is set by the poster-preview pass: an open
		// failure there just means "this source can't preview as a
		// frame" (typically audio-only files under noAudio:true), not
		// that the element is broken — the user can still tap play
		// later and openDecoder runs again without noAudio.
		if (opts.silentOnError) return;
		st.loadError = `VideoDecoder open failed: ${msg}`;
	}
}

function closeDecoder(el: LiveElement, st: VideoState): void {
	if (st.decoder) {
		try { st.decoder.close(); }
		catch { /* ignore: already closed or runtime tearing down */ }
	}
	st.decoder = null;
	st.frameBytes = null;
	// Drop the per-element bitmap. ImageBitmap exposes a `close()` method;
	// call it if present so the underlying cairo surface + js-malloc'd
	// backing buffer get released without waiting for GC.
	if (st.frameBitmap) {
		const bmp = st.frameBitmap as unknown as { close?: () => void };
		try { bmp.close?.(); } catch { /* ignore */ }
		st.frameBitmap = null;
	}
	st.hasFirstFrame = false;
	st.playRequestedAt = null;
	st.firstFrameAtMs = null;
	st.firstFramePts = 0;
	activeVideos.delete(el);
	// Note: posterBitmap is deliberately NOT closed here. The whole
	// point of the poster is to outlive its preview decoder so the
	// element still has a static still after we close. clearAllVideos
	// drops the posters on page navigation.
}

/** Called by live-overlay's paintVideoPlaceholder. If the element doesn't
 * have a decoder yet, this kicks one off (lazy open on first paint).
 * Returns the OffscreenCanvas holding the latest decoded frame, or null
 * to fall through to the placeholder. */
/** Paint the latest decoded frame for `el` onto `ctx`, scaled to fit
 * the given layout box (`dstW` × `dstH`) using object-fit:contain
 * semantics (preserve aspect ratio, letterbox/pillarbox black bars in
 * any unused area of the box). Returns true if a frame was painted,
 * false if no frame is ready (caller falls through to the placeholder).
 *
 * Sized variant added 2026-05-27 (slice-2b followup #1: scaled
 * rendering). The pre-2b code used a 3-arg drawImage at the source's
 * intrinsic dims — when the layout box didn't match source dims (e.g.
 * a 480×270 box with a 320×240 source), the placeholder leaked through
 * the gap. Now: aspect-fit rect inside (dstX, dstY, dstW, dstH); only
 * when there's actual letterboxing do we paint a black background to
 * mask the cached placeholder beneath.
 *
 * Primary path: drawImage of a per-element reusable ImageBitmap whose
 * pixels were refreshed in tickVideo via Switch.writeRGBAToBitmap.
 * Goes through cairo's image-surface paint (operator OVER, bounded
 * to source rect) instead of putImageData's cairo_paint with operator
 * SOURCE — bypasses [[nxjs-putimagedata-screen-ctx-hangs-on-2nd-call]].
 *
 * Fallback (only when the runtime is too old to expose the bitmap
 * helpers): putImageData of the raw frame bytes — does NOT scale, paints
 * at native source dims. Acceptable regression on stale runtimes since
 * the bitmap bridge has been in nxjs since 2026-05-26. */
export function paintVideoFrameAt(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	dstX: number,
	dstY: number,
	dstW: number,
	dstH: number,
): boolean {
	const st = videoStateMap.get(el);
	if (!st || dstW <= 0 || dstH <= 0) return false;
	// Pick the highest-priority bitmap we have: live frame > poster.
	// A poster bitmap survives the close of its preview decoder so we
	// can keep painting a static still until the user taps play and
	// the fresh decoder produces a new live frame.
	const useBitmap = st.frameBitmap ?? st.posterBitmap ?? null;
	if (!useBitmap && !st.hasFirstFrame) return false;
	if (st.frameW <= 0 || st.frameH <= 0) return false;
	// object-fit:contain — preserve aspect, letterbox/pillarbox the rest.
	const frameAspect = st.frameW / st.frameH;
	const boxAspect = dstW / dstH;
	let innerW: number;
	let innerH: number;
	let innerX: number;
	let innerY: number;
	if (frameAspect > boxAspect) {
		// Source is wider per unit height than the box — fit to box width,
		// letterbox top + bottom.
		innerW = dstW;
		innerH = dstW / frameAspect;
		innerX = dstX;
		innerY = dstY + (dstH - innerH) / 2;
	} else {
		// Source is taller per unit width — fit to box height, pillarbox
		// left + right.
		innerW = dstH * frameAspect;
		innerH = dstH;
		innerX = dstX + (dstW - innerW) / 2;
		innerY = dstY;
	}
	// Mask the placeholder with a black fill only when there's actual
	// letterboxing (epsilon = 0.5 px to absorb fp rounding when the
	// aspects effectively match — saves a fill in the common case where
	// width/height attributes were authored to match the source).
	if (innerW < dstW - 0.5 || innerH < dstH - 0.5) {
		ctx.save();
		ctx.fillStyle = 'black';
		ctx.fillRect(dstX, dstY, dstW, dstH);
		ctx.restore();
	}
	// Primary: drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh).
	if (useBitmap) {
		try {
			ctx.drawImage(
				useBitmap,
				0, 0, st.frameW, st.frameH,
				innerX, innerY, innerW, innerH,
			);
			return true;
		} catch {
			// Fall through to putImageData attempt.
		}
	}
	// Fallback: raw putImageData (no scaling — paints at native size at
	// the inner-rect's top-left). Only fires when the bitmap bridge is
	// missing on the runtime; acceptable visual regression there.
	if (!st.frameBytes) return false;
	try {
		const img = new ImageData(st.frameBytes, st.frameW, st.frameH);
		ctx.putImageData(img, innerX, innerY);
		return true;
	} catch {
		return false;
	}
}

// =========================================================================
// Per-tick frame pump
// =========================================================================

/** Called from the shell rAF tick alongside tickAnimationFrames(). For
 * every active VIDEO element, polls the native decoder for a frame and
 * blits it into the per-element OffscreenCanvas. Returns true if any
 * frame was advanced — the shell uses that to trigger a repaint. */
export function tickVideo(): boolean {
	let anyAdvanced = false;
	// Collected during the loop; processed after iteration to avoid
	// mutating activeVideos (closeDecoder/openDecoder mutate the set)
	// while we're iterating it.
	let hwFallback: LiveElement[] | null = null;
	for (const el of activeVideos) {
		const st = videoStateMap.get(el);
		if (!st || !st.decoder) continue;
		// NVTEGRA hw-accel fallback — two trigger paths:
		// (1) `decoder.error` non-null: native surfaced a runtime decode
		//     error (e.g. avcodec_send_packet failed). One-shot per
		//     element via hwFallbackAttempted.
		// (2) Stall watchdog: play() was called >HW_STALL_TIMEOUT_MS ago
		//     and no first frame has arrived. Catches Citron's silent
		//     NVTEGRA stall where the decoder opens cleanly but never
		//     produces a frame. Trips the session-wide gHwStallDetected
		//     latch so all subsequent opens force sw.
		const hwError = !st.hwFallbackAttempted && st.decoder.error != null;
		let hwStall = false;
		let hwFrameStall = false;
		try {
			hwStall = !st.hwFallbackAttempted
				&& !st.hasFirstFrame
				&& st.playRequestedAt != null
				&& st.decoder.usedHw === true
				&& (performance.now() - st.playRequestedAt) > HW_STALL_TIMEOUT_MS;
			// Post-first-frame watchdog (Citron NVTEGRA failure mode #2).
			// Use audioTime as the "is wall-clock advancing" proxy —
			// independent of the video pipeline. If audio has advanced
			// past HW_FRAME_STALL_AFTER_FIRST_MS since the first frame
			// but our video PTS hasn't moved, hw decoder silently froze.
			if (!hwStall && !st.hwFallbackAttempted
			    && st.hasFirstFrame
			    && st.firstFrameAtMs != null
			    && st.decoder.usedHw === true
			    && st.decoder.usedAudio === true
			    && st.currentPts === st.firstFramePts
			    && (performance.now() - st.firstFrameAtMs)
			        > HW_FRAME_STALL_AFTER_FIRST_MS) {
				hwFrameStall = true;
			}
		} catch { /* decoder closed; treat as not stalled */ }
		if (hwError || hwStall || hwFrameStall) {
			if (hwStall || hwFrameStall) gHwStallDetected = true;
			if (!hwFallback) hwFallback = [];
			hwFallback.push(el);
			continue;
		}
		try {
			const f = st.decoder.nextFrame();
			if (!f) {
				// No frame this tick. If the decoder has reached the
				// end-of-stream state but the EOS sentinel was never
				// delivered (e.g. ring still has stalled late frames
				// that the native drain-mode bypass cleared just now —
				// next tick will get them — OR a bug elsewhere kept
				// the sentinel from making it through), snap the
				// counter to duration so the bar shows correctly.
				try {
					if (st.decoder.ended) {
						const target = st.decoder.duration;
						if (target > 0 && st.currentPts !== target) {
							st.currentPts = target;
							anyAdvanced = true;
						}
					}
				} catch { /* ignore */ }
				continue;
			}
			if (f.ended) {
				// One-shot end-of-stream. Slice 2a doesn't loop yet.
				st.currentPts = st.decoder.duration;
				anyAdvanced = true;
				continue;
			}
			if (!f.data || f.width <= 0 || f.height <= 0) continue;
			// Primary delivery path (2026-05-26+): copy+swizzle RGBA into
			// an ImageBitmap. By default we RECREATE the bitmap each frame
			// (see VIDEO_BITMAP_REUSE_BETWEEN_FRAMES note above) — the
			// reuse path hangs in cairo on the 2nd writeRGBA into a
			// surface that was previously a drawImage source.
			const bridge = getBitmapBridge();
			if (bridge?.createBitmapFromRGBA && bridge.writeRGBAToBitmap) {
				const dimsChanged = !st.frameBitmap ||
					st.frameW !== f.width || st.frameH !== f.height;
				const recreateThisFrame =
					!VIDEO_BITMAP_REUSE_BETWEEN_FRAMES || dimsChanged;
				if (recreateThisFrame) {
					// Eagerly close the previous bitmap so its cairo
					// surface + backing buffer are freed this tick rather
					// than waiting for GC. Without this the heap balloons
					// at 24 fps × ~300KB/frame. Gated by
					// VIDEO_BITMAP_EXPLICIT_CLOSE so we can A/B-test
					// whether close-then-realloc is what stalls playback.
					if (st.frameBitmap) {
						if (VIDEO_BITMAP_EXPLICIT_CLOSE) {
							const old = st.frameBitmap as unknown as { close?: () => void };
							try { old.close?.(); } catch { /* ignore */ }
						}
						st.frameBitmap = null;
					}
					try {
						st.frameBitmap = bridge.createBitmapFromRGBA(
							f.data, f.width, f.height);
					} catch {
						st.frameBitmap = null;
					}
				} else {
					try {
						bridge.writeRGBAToBitmap(st.frameBitmap, f.data);
					} catch {
						// Drop the bitmap so paintVideoFrameAt falls through
						// to the putImageData fallback.
						st.frameBitmap = null;
					}
				}
			}
			// frameBytes is only used by the putImageData fallback in
			// paintVideoFrameAt, which only runs when the bitmap bridge
			// is missing (older nxjs build) or its drawImage throws.
			// Skip the per-frame typed-array allocation in the happy
			// path. Null it explicitly so a stale frame's bytes can't
			// leak into a future fallback paint.
			if (!st.frameBitmap) {
				st.frameBytes = new Uint8ClampedArray(f.data);
			} else {
				st.frameBytes = null;
			}
			st.frameW = f.width;
			st.frameH = f.height;
			st.currentPts = f.pts;
			if (!st.hasFirstFrame) {
				st.firstFrameAtMs = performance.now();
				st.firstFramePts = f.pts;
			}
			st.hasFirstFrame = true;
			st.playRequestedAt = null;
			anyAdvanced = true;
			// Poster-preview transition: the decoder was opened in
			// noAudio mode purely to capture the first frame. Transfer
			// ownership of the bitmap to st.posterBitmap and close the
			// decoder — its native threads + ffmpeg ctxs go away. The
			// posterBitmap survives the close (see closeDecoder).
			if (st.needsPosterPause) {
				st.needsPosterPause = false;
				if (st.frameBitmap) {
					st.posterBitmap = st.frameBitmap;
					st.frameBitmap = null;
					elementsWithPosters.add(el);
				}
				closeDecoder(el, st);
			} else if (st.posterBitmap) {
				// A live frame arrived from a normal (audio-bearing)
				// decoder open — the poster is now superseded. Close
				// it so we don't leak ~300 KB per element.
				const bmp = st.posterBitmap as unknown as { close?: () => void };
				try { bmp.close?.(); } catch { /* ignore */ }
				st.posterBitmap = null;
				elementsWithPosters.delete(el);
			}
			// NOTE: deliberately NOT calling bumpLiveTreeVersion() here.
			// Triggering a full cache rebuild on every video frame would
			// chunk-build for many ticks and starve subsequent frames.
			// Instead, `overlayLiveAnimatedCanvases` draws the frame
			// directly onto the screen each tick, bypassing the cache
			// entirely — same pattern as animated <canvas> elements.
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			st.loadError = `decode tick failed: ${msg}`;
			closeDecoder(el, st);
		}
	}
	// Apply hw→sw fallback for any decoder that errored this tick. Done
	// out-of-band to avoid touching `activeVideos` mid-iteration. The
	// new decoder will deliver its first frame on the next tickVideo.
	if (hwFallback) {
		for (const el of hwFallback) {
			const st = videoStateMap.get(el);
			if (!st) continue;
			st.hwFallbackAttempted = true;
			closeDecoder(el, st);
			openDecoder(el, st, false);
			if (st.decoder) {
				try { st.decoder.play(); }
				catch { /* ignore */ }
				// Re-arm the watchdog. If the sw retry ALSO stalls
				// hwFallbackAttempted is already true, so the next
				// tick's hw-stall check skips this element entirely
				// — no infinite oscillation.
				st.playRequestedAt = performance.now();
			}
		}
		// Cascade: if the global latch fired this tick, re-open every
		// *other* currently-active hw decoder in sw too. The user's
		// "MP4 destabilizes other players" report points at a shared
		// resource (the NVTEGRA hw_device_ctx) — once it's known bad,
		// no point letting other videos keep trying it. Done out-of-
		// band so we don't mutate activeVideos mid-iteration.
		if (gHwStallDetected) {
			const cascade: LiveElement[] = [];
			for (const el of activeVideos) {
				if (hwFallback.includes(el)) continue;
				const st = videoStateMap.get(el);
				if (!st || !st.decoder || st.hwFallbackAttempted) continue;
				let usedHw = false;
				try { usedHw = st.decoder.usedHw === true; } catch { /* ignore */ }
				if (usedHw) cascade.push(el);
			}
			for (const el of cascade) {
				const st = videoStateMap.get(el);
				if (!st) continue;
				st.hwFallbackAttempted = true;
				const wasPlaying = !videoIsPaused(el);
				closeDecoder(el, st);
				openDecoder(el, st, false);
				if (st.decoder && wasPlaying) {
					try { st.decoder.play(); }
					catch { /* ignore */ }
					st.playRequestedAt = performance.now();
				}
			}
		}
	}
	// Return true ONLY when an actual new frame was decoded this tick.
	// Earlier iteration of slice 2a returned `anyAdvanced ||
	// activeVideos.size > 0` to force a repaint every tick — that
	// starved the chunked live-DOM cache builder (page text stopped
	// rendering) and probably also exhausted some paint budget.
	// With our switch to putImageData-direct in the overlay walker,
	// the screen retains the last-painted frame between repaints
	// automatically, so we only need to trigger a repaint when there's
	// genuinely new pixel data to deliver.
	return anyAdvanced;
}

/** True if any video element on the page is currently active. Used by
 * pageHasAnimationActivity() so the shell knows to keep its tick loop
 * running even when the page script doesn't call requestAnimationFrame. */
export function pageHasActiveVideo(): boolean {
	return activeVideos.size > 0;
}

/** True if any video element holds a posterBitmap from the preview
 * pass — i.e. a static first-frame that needs to be repainted by the
 * overlay walker whenever the screen is redrawn. Used by the shell's
 * walker-gate so posters survive cache reblits (scrolls, repaints)
 * even after the preview decoder has been closed. */
export function pageHasAnyPoster(): boolean {
	return elementsWithPosters.size > 0;
}

/** Walk the freshly-populated live tree and lazy-open any `<video
 * autoplay>` elements (which start playing immediately) or `<video
 * controls>` elements (which open paused at the first frame so the
 * user sees a static preview instead of the placeholder). Called by
 * the shell after handleHtmlResponseLive. This is what populates
 * `activeVideos` so pageHasActiveVideo() returns true and the overlay
 * walker starts blitting frames.
 *
 * Audio-only sources opened for poster-preview-only are closed
 * immediately after open — there's no first frame to capture and
 * keeping the decoder open would needlessly run the audio decode
 * pipeline for every audio-only block on the page. */
export function scanForAutoplayVideos(root: LiveElement): void {
	const visit = (el: LiveElement) => {
		if (el.tagName === 'VIDEO') {
			const wantAutoplay = el.hasAttribute('autoplay');
			const wantPoster = !wantAutoplay && el.hasAttribute('controls');
			if (wantAutoplay) {
				const st = ensureState(el);
				if (!st.decoder && !st.loadError) {
					openDecoder(el, st, videoTryHwAccel);
					const dec = st.decoder as VideoDecoderHandle | null;
					if (dec && !st.autoplayApplied) {
						st.autoplayApplied = true;
						try { dec.play(); } catch { /* ignore */ }
						if (!st.hasFirstFrame) {
							st.playRequestedAt = performance.now();
						}
					}
				}
			} else if (wantPoster) {
				const st = ensureState(el);
				if (!st.decoder && !st.loadError && !st.posterBitmap) {
					// Force SW (wantHw=false) for the poster decode.
					// NVTEGRA on Citron can deliver corrupt/incomplete
					// "first" frames — they pass through avcodec_receive_frame
					// as valid frames (so the stall watchdog doesn't fire)
					// but the pixel data is uninitialized memory or partial
					// motion compensation residuals (the green-screen + RGB
					// stripe artifacts the user reported). SW decode is
					// deterministic for the first frame; perf cost is
					// irrelevant since we only need one. Subsequent
					// user-initiated playback still tries HW first.
					// Also noAudio:true so the audrv voice is NEVER
					// initialized — no startup pop. silentOnError so
					// audio-only files (which can't open without their
					// audio stream when noAudio is set) don't set a fake
					// "no playable stream" loadError; they just skip the
					// poster pass and stay in the placeholder state.
					openDecoder(el, st, /* wantHw */ false,
						{ noAudio: true, silentOnError: true });
					const dec = st.decoder as VideoDecoderHandle | null;
					if (!dec) {
						// Silent failure: audio-only or otherwise non-
						// previewable. Leave the element clean for a
						// future user-initiated play.
					} else if (dec.usedVideo === false) {
						// Defensive — the noAudio+usedVideo=false case
						// should already have been rejected by native
						// open ("no playable video or audio stream"),
						// but if we ever change that, fall back here.
						closeDecoder(el, st);
					} else {
						st.needsPosterPause = true;
						try { dec.play(); } catch { /* ignore */ }
						if (!st.hasFirstFrame) {
							st.playRequestedAt = performance.now();
						}
					}
				}
			}
		}
		for (const c of el.children) visit(c);
	};
	visit(root);
}

/** Close all decoders. Called by the shell on navigation. */
export function clearAllVideos(): void {
	for (const el of [...activeVideos]) {
		const st = videoStateMap.get(el);
		if (st) closeDecoder(el, st);
	}
	activeVideos.clear();
	// Also free any poster bitmaps from elements whose preview decoder
	// already closed — they'd outlive the page otherwise.
	for (const el of elementsWithPosters) {
		const st = videoStateMap.get(el);
		if (st && st.posterBitmap) {
			const bmp = st.posterBitmap as unknown as { close?: () => void };
			try { bmp.close?.(); } catch { /* ignore */ }
			st.posterBitmap = null;
		}
	}
	elementsWithPosters.clear();
}

// =========================================================================
// HTMLMediaElement-shaped API for LiveElement getters/setters
// =========================================================================

export function videoIsPaused(el: LiveElement): boolean {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return true;
	try { return st.decoder.paused; } catch { return true; }
}

export function videoIsEnded(el: LiveElement): boolean {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return false;
	try { return st.decoder.ended; } catch { return false; }
}

export function videoCurrentTime(el: LiveElement): number {
	const st = videoStateMap.get(el);
	if (!st) return 0;
	// Audio-only sources have no video-frame PTS to advance `currentPts`,
	// so read the native audio playback clock (audrv played samples) — that
	// is what lets the seek bar track audio playback. Video sources keep
	// using the frame PTS that drives the displayed frame.
	if (st.decoder) {
		try {
			if (st.decoder.usedAudio && !st.decoder.usedVideo) {
				const t = st.decoder.audioTime;
				if (Number.isFinite(t) && t >= 0) return t;
			}
		} catch { /* fall through to currentPts */ }
	}
	return st.currentPts;
}

/** Audio-reactive per-band levels at the play head (low→high, ~0..1).
 * Returns `[]` when no decoder / no audio / before playback anchors. Backs
 * `HTMLMediaElement`-style `getAudioLevels()` for the music visualizer. */
export function videoGetAudioLevels(el: LiveElement): number[] {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return [];
	try {
		const levels = st.decoder.getAudioLevels();
		return Array.isArray(levels) ? levels : [];
	} catch { return []; }
}

/** Fill `out` with the frequency spectrum at the play head (low→high,
 * ~0..1). Returns false (and leaves `out` untouched) when no decoder / no
 * audio / before playback anchors. Backs `getFrequencyData()` for the
 * music visualizer. */
export function videoGetFrequencyData(el: LiveElement, out: Float32Array): boolean {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return false;
	try { return st.decoder.getFrequencyData(out) === true; } catch { return false; }
}

/** Fill `out` with the time-domain waveform at the play head (-1..1).
 * Returns false when no decoder / no audio / before playback anchors. */
export function videoGetWaveform(el: LiveElement, out: Float32Array): boolean {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return false;
	try { return st.decoder.getWaveform(out) === true; } catch { return false; }
}

/** Remembered audio gain (0..1) for this element — survives decoder
 * re-opens. */
export function videoGetVolume(el: LiveElement): number {
	const st = videoStateMap.get(el);
	return st ? st.volume : 1;
}

export function videoSetVolume(el: LiveElement, v: number): void {
	const st = ensureState(el);
	st.volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
	if (st.decoder) {
		try { st.decoder.setVolume(st.volume); } catch { /* ignore */ }
	}
}

export function videoIsMuted(el: LiveElement): boolean {
	const st = videoStateMap.get(el);
	return st ? st.muted : false;
}

export function videoSetMuted(el: LiveElement, m: boolean): void {
	const st = ensureState(el);
	st.muted = !!m;
	if (st.decoder) {
		try { st.decoder.setMuted(st.muted); } catch { /* ignore */ }
	}
}

export function videoDuration(el: LiveElement): number {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return 0;
	try { return st.decoder.duration; } catch { return 0; }
}

export function videoPlay(el: LiveElement): void {
	const st = ensureState(el);
	// If a noAudio preview decoder is still mid-decode when the user
	// taps play, kill it and start a fresh decoder with audio. Try to
	// salvage the latest frame as a poster first so the screen doesn't
	// flicker back to the placeholder during the reopen.
	if (st.decoder && st.needsPosterPause) {
		if (st.frameBitmap) {
			st.posterBitmap = st.frameBitmap;
			st.frameBitmap = null;
			elementsWithPosters.add(el);
		}
		st.needsPosterPause = false;
		closeDecoder(el, st);
	}
	// If the decoder is in the ended state, all three worker threads
	// have already exited (demuxer hit EOF, video thread reached
	// codec EOF, audio thread drained). seek+play on a dead decoder
	// just sets native flags that nothing reads — there's no thread
	// to process them. Close the dead decoder and open a fresh one
	// that starts from t=0 with full audio. Salvage the last live
	// frame as a poster so the screen doesn't flicker back to the
	// placeholder during the reopen.
	let endedRestart = false;
	if (st.decoder) {
		let ended = false;
		try { ended = st.decoder.ended; } catch { /* ignore */ }
		if (ended) {
			endedRestart = true;
			if (st.frameBitmap) {
				if (st.posterBitmap) {
					const old = st.posterBitmap as unknown as { close?: () => void };
					try { old.close?.(); } catch { /* ignore */ }
				}
				st.posterBitmap = st.frameBitmap;
				st.frameBitmap = null;
				elementsWithPosters.add(el);
			}
			closeDecoder(el, st);
			st.currentPts = 0;
		}
	}
	if (!st.decoder && !st.loadError) {
		// Force SW for ended-restart on Citron: after the first
		// decoder's clean shutdown the shared NVTEGRA hw_device_ctx
		// can be left in a state where the next decoder's video
		// thread hits avcodec_send_packet failure on the first
		// packet (see [[nvtegra-unreliable-on-citron]]). Restart
		// reliability matters more than restart perf — SW H.264
		// decode is plenty fast for replay. First-time opens keep
		// trying HW; this only forces SW when the user explicitly
		// taps play on an ended decoder.
		const wantHw = endedRestart ? false : videoTryHwAccel;
		openDecoder(el, st, wantHw);
	}
	const dec = st.decoder as VideoDecoderHandle | null;
	if (dec) {
		// Apply the remembered audio state before starting, so volume/mute
		// set before playback — or carried over from a previous track /
		// re-open — take effect on this (possibly fresh) decoder.
		try { dec.setVolume(st.volume); } catch { /* ignore */ }
		try { dec.setMuted(st.muted); } catch { /* ignore */ }
		try { dec.play(); } catch { /* ignore */ }
		// Arm the stall watchdog only if we haven't received any frame
		// yet. Once hasFirstFrame is true we know the decoder is alive,
		// so re-arming on resume-from-pause would be a false-alarm
		// source.
		if (!st.hasFirstFrame) {
			st.playRequestedAt = performance.now();
		}
	}
}

export function videoPause(el: LiveElement): void {
	const st = videoStateMap.get(el);
	if (st && st.decoder) {
		try { st.decoder.pause(); } catch {}
		// Wall-clock elapsed while paused isn't decode time — clear both
		// watchdogs so a paused-for-2s video doesn't trip the hw-stall
		// fallback on resume.
		st.playRequestedAt = null;
		st.firstFrameAtMs = null;
	}
}

export function videoSeek(el: LiveElement, t: number): void {
	const st = videoStateMap.get(el);
	if (st && st.decoder) {
		try { st.decoder.seek(t); } catch {}
	}
}

/** Stop = seek to 0 then pause. Returns the decoder to a known "ready
 * to play from the start" state. Keeps the decoder open. */
export function videoStop(el: LiveElement): void {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return;
	try {
		st.decoder.seek(0);
		st.decoder.pause();
	} catch { /* ignore */ }
	st.currentPts = 0;
	st.playRequestedAt = null;
}

/** Reset a media element's decoder + playback cursor so the NEXT
 * `play()` opens a FRESH decoder for the element's CURRENT `src`. Backs
 * `HTMLMediaElement.load()` — needed when a page swaps the source (e.g.
 * an audio player advancing to the next track): without this, `videoPlay`
 * sees the existing decoder and just resumes the OLD source. Keeps the
 * per-element state object; only drops the decoder + cursor. */
export function videoResetSource(el: LiveElement): void {
	const st = videoStateMap.get(el);
	if (!st) return;
	closeDecoder(el, st);
	st.url = null;
	st.currentPts = 0;
	st.loadError = null;
	st.hasFirstFrame = false;
	st.playRequestedAt = null;
	st.firstFrameAtMs = null;
	st.firstFramePts = 0;
}

/** Toggle muted state on the decoder. */
export function videoToggleMute(el: LiveElement): void {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return;
	try {
		const cur = st.decoder.muted;
		st.decoder.setMuted(!cur);
	} catch { /* ignore */ }
}

/** Seek the decoder to `ratio * duration` (0..1). No-op if no decoder. */
export function videoSeekRatio(el: LiveElement, ratio: number): void {
	const st = videoStateMap.get(el);
	if (!st || !st.decoder) return;
	const clamped = Math.max(0, Math.min(1, ratio));
	let dur = 0;
	try { dur = st.decoder.duration; } catch { dur = 0; }
	if (dur <= 0) return;
	const target = clamped * dur;
	try { st.decoder.seek(target); } catch { /* ignore */ }
	st.currentPts = target;
}

// =========================================================================
// On-screen tap controls (no autoplay path, 2026-05-27): every <video>
// element gets a 32-px bar at the bottom of its layout box with three
// tappable buttons (play / pause / stop) and a "M:SS / M:SS" time
// display. The bar is painted both from the placeholder cache (so it
// shows up even before any decoder is open) and from the per-tick
// overlay walker (so the time display updates live during playback).
// Hit-testing runs in findTapIntent for inline videos and in
// browser-shell for the video-fullscreen mode.
// =========================================================================

// Bar geometry (slice-2b followup #5):
//   ┌─────────────────────────────────────────────────────┐
//   │ [▶/⏸] 0:03 / 0:10              [🔊] [⛶]            │ 32 px content
//   │ ███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  4 px progress
//   └─────────────────────────────────────────────────────┘ total 36 px
export const VIDEO_CONTROLS_BAR_H = 36;
const VIDEO_CONTROLS_CONTENT_H = 32;
const VIDEO_CONTROLS_PROGRESS_H = 4;
const VIDEO_CONTROLS_BTN_W = 32;
export type VideoControlHit =
	| { kind: 'play' }
	| { kind: 'pause' }
	| { kind: 'mute-toggle' }
	| { kind: 'unmute-toggle' }
	| { kind: 'fullscreen-enter' }
	| { kind: 'seek'; ratio: number };

/** Returns the control button hit by a tap at the given screen coords,
 * or null if the tap missed all buttons. `(boxX, boxY, boxW, boxH)` is
 * the video element's bounding rect on screen. */
export function hitTestVideoControls(
	boxX: number, boxY: number, boxW: number, boxH: number,
	tapX: number, tapY: number,
	el?: LiveElement,
): VideoControlHit | null {
	if (boxW <= 0 || boxH <= 0) return null;
	// Honour the HTML5 `controls` attribute: only opt-in videos get a
	// tappable bar. Pass `el` to enforce; omit to skip (back-compat).
	if (el && !el.hasAttribute('controls')) return null;
	// During active playback the bar is hidden (see paintVideoControls).
	// Return null so taps on the bar's would-be area fall through to
	// findTapIntent's `video-frame-tap`, which toggles play/pause.
	if (el) {
		const st = videoStateMap.get(el);
		if (st && st.decoder) {
			let paused = true;
			let ended = false;
			try { paused = st.decoder.paused; } catch { /* ignore */ }
			try { ended = st.decoder.ended; } catch { /* ignore */ }
			if (!paused && !ended) return null;
		}
	}
	const barH = Math.min(VIDEO_CONTROLS_BAR_H, boxH);
	const barY = boxY + boxH - barH;
	if (tapY < barY || tapY >= barY + barH) return null;
	const contentBottomY = barY + Math.min(VIDEO_CONTROLS_CONTENT_H, boxH);
	// Progress strip occupies the bottom 4 px of the bar; taps there
	// scrub. Compute ratio from the full bar width.
	if (tapY >= contentBottomY) {
		const ratio = Math.max(0, Math.min(1, (tapX - boxX) / boxW));
		return { kind: 'seek', ratio };
	}
	// Left slot: play/pause toggle at x=[0, 32].
	const localX = tapX - boxX;
	if (localX >= 0 && localX < VIDEO_CONTROLS_BTN_W) {
		// Resolve toggle to play / pause from live decoder state.
		// Treat ended as paused — tapping play on an ended decoder
		// should restart from the beginning (videoPlay seeks to 0 on
		// the ended case).
		let paused = true;
		let ended = false;
		if (el) {
			const st = videoStateMap.get(el);
			if (st && st.decoder) {
				try { paused = st.decoder.paused; } catch { /* ignore */ }
				try { ended = st.decoder.ended; } catch { /* ignore */ }
			}
		}
		return { kind: (paused || ended) ? 'play' : 'pause' };
	}
	// Right slots: mute then fullscreen, anchored to the right edge.
	// Fullscreen is hidden for audio-only sources (no frame to show).
	let audioOnly = false;
	if (el) {
		const st = videoStateMap.get(el);
		if (st && st.decoder) {
			try { audioOnly = st.decoder.usedVideo === false; } catch { /* ignore */ }
		}
	}
	const rightEdge = boxX + boxW;
	const fsLeft = audioOnly ? -1 : rightEdge - VIDEO_CONTROLS_BTN_W;
	const muteLeft = audioOnly
		? rightEdge - VIDEO_CONTROLS_BTN_W
		: rightEdge - 2 * VIDEO_CONTROLS_BTN_W;
	if (!audioOnly && tapX >= fsLeft && tapX < rightEdge) {
		return { kind: 'fullscreen-enter' };
	}
	if (tapX >= muteLeft && tapX < muteLeft + VIDEO_CONTROLS_BTN_W) {
		// Resolve mute toggle: muted → unmute; unmuted → mute.
		let muted = false;
		if (el) {
			const st = videoStateMap.get(el);
			if (st && st.decoder) {
				try { muted = st.decoder.muted; } catch { /* ignore */ }
			}
		}
		return { kind: muted ? 'unmute-toggle' : 'mute-toggle' };
	}
	return null;
}

/** Format `t` seconds as `M:SS`. Returns `--:--` for non-finite input. */
function formatTime(t: number): string {
	if (!Number.isFinite(t) || t < 0) return '--:--';
	const total = Math.floor(t);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Paint the controls bar at the bottom of the video's box. Buttons
 * drawn with canvas primitives (no font glyph dependence) so the bar
 * is identical on devkitPro shared-font + on dev hosts. */
export function paintVideoControls(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	el: LiveElement,
	boxX: number, boxY: number, boxW: number, boxH: number,
): void {
	if (boxW <= 0 || boxH <= 0) return;
	if (!el.hasAttribute('controls')) return;
	const barH = Math.min(VIDEO_CONTROLS_BAR_H, boxH);
	const barY = boxY + boxH - barH;
	const contentH = Math.min(VIDEO_CONTROLS_CONTENT_H, barH);
	const contentY = barY;
	const progressY = barY + contentH;
	const progressH = Math.max(0, barH - contentH);
	// Resolve current decoder state once.
	const st = videoStateMap.get(el);
	let isPaused = true;
	let isEnded = false;
	let muted = false;
	let audioOnly = false;
	let cur = st ? st.currentPts : 0;
	let dur = 0;
	let err: string | null = null;
	if (st && st.decoder) {
		try { isPaused = st.decoder.paused; } catch { /* ignore */ }
		try { isEnded = st.decoder.ended; } catch { /* ignore */ }
		try { muted = st.decoder.muted; } catch { /* ignore */ }
		try { audioOnly = st.decoder.usedVideo === false; } catch { /* ignore */ }
		try { dur = st.decoder.duration; } catch { /* ignore */ }
		try { err = st.decoder.error; } catch { /* ignore */ }
	}
	if (st && st.loadError) err = st.loadError;
	// "ended" reads as paused for UI purposes: icon is play, bar
	// visible, tap restarts. Also snap the counter to duration so the
	// bar shows "0:30 / 0:30" instead of getting stuck at the last
	// frame's PTS ("0:29 / 0:30") when the EOS sentinel doesn't
	// propagate currentPts in time.
	const showAsPaused = isPaused || isEnded;
	if (isEnded && dur > 0) cur = dur;
	// Hide the bar entirely during active playback — only show when
	// paused or ended. Hit-test mirrors this so taps on the would-be
	// bar area fall through to the frame-tap (play/pause toggle).
	if (!showAsPaused) return;
	ctx.save();
	try {
		// Translucent bar. Caller wipes the region first for audio-only
		// pages so this fill doesn't compound across paint passes.
		ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
		ctx.fillRect(boxX, barY, boxW, barH);
		const iconColor = '#ffffff';
		const r = Math.min(8, Math.floor(contentH / 3));
		// --- left: play/pause toggle ---
		{
			const bx = boxX;
			const cx = bx + VIDEO_CONTROLS_BTN_W / 2;
			const cy = contentY + contentH / 2;
			ctx.fillStyle = iconColor;
			if (showAsPaused) {
				ctx.beginPath();
				ctx.moveTo(cx - r * 0.7, cy - r);
				ctx.lineTo(cx + r * 0.9, cy);
				ctx.lineTo(cx - r * 0.7, cy + r);
				ctx.closePath();
				ctx.fill();
			} else {
				const bw = Math.max(2, Math.floor(r * 0.6));
				const gap = Math.max(2, Math.floor(r * 0.5));
				ctx.fillRect(cx - gap / 2 - bw, cy - r, bw, r * 2);
				ctx.fillRect(cx + gap / 2, cy - r, bw, r * 2);
			}
		}
		// --- time / error label, immediately right of toggle ---
		const labelX = boxX + VIDEO_CONTROLS_BTN_W + 6;
		const labelY = contentY + contentH / 2;
		const rightEdge = boxX + boxW;
		const rightIconsW = audioOnly ? VIDEO_CONTROLS_BTN_W : 2 * VIDEO_CONTROLS_BTN_W;
		const labelMaxX = rightEdge - rightIconsW - 6;
		if (err && labelMaxX - labelX > 30) {
			ctx.fillStyle = '#ff8a8a';
			ctx.font = '11px sans-serif';
			ctx.textAlign = 'left';
			ctx.textBaseline = 'middle';
			const maxLen = Math.max(16, Math.floor((labelMaxX - labelX) / 6));
			const shown = err.length > maxLen ? '…' + err.slice(-(maxLen - 1)) : err;
			ctx.fillText(shown, labelX, labelY);
		} else if (labelMaxX - labelX > 30) {
			const label = `${formatTime(cur)} / ${dur > 0 ? formatTime(dur) : '--:--'}`;
			ctx.fillStyle = '#e6ecf5';
			ctx.font = '13px sans-serif';
			ctx.textAlign = 'left';
			ctx.textBaseline = 'middle';
			ctx.fillText(label, labelX, labelY);
		}
		// --- right slots: mute, then fullscreen (skip fullscreen if audio-only) ---
		const fsLeft = rightEdge - VIDEO_CONTROLS_BTN_W;
		const muteLeft = audioOnly
			? rightEdge - VIDEO_CONTROLS_BTN_W
			: rightEdge - 2 * VIDEO_CONTROLS_BTN_W;
		// Mute / speaker icon.
		{
			const cx = muteLeft + VIDEO_CONTROLS_BTN_W / 2;
			const cy = contentY + contentH / 2;
			ctx.fillStyle = iconColor;
			// Speaker body: small left rect + trapezoid cone pointing right.
			ctx.beginPath();
			ctx.moveTo(cx - r, cy - r * 0.4);
			ctx.lineTo(cx - r * 0.2, cy - r * 0.4);
			ctx.lineTo(cx + r * 0.5, cy - r);
			ctx.lineTo(cx + r * 0.5, cy + r);
			ctx.lineTo(cx - r * 0.2, cy + r * 0.4);
			ctx.lineTo(cx - r, cy + r * 0.4);
			ctx.closePath();
			ctx.fill();
			if (muted) {
				// Diagonal slash through speaker = muted.
				ctx.strokeStyle = '#ff7676';
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.moveTo(cx - r * 1.1, cy - r * 1.1);
				ctx.lineTo(cx + r * 1.1, cy + r * 1.1);
				ctx.stroke();
			} else {
				// Two arc lines = sound waves.
				ctx.strokeStyle = iconColor;
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(cx + r * 0.8, cy, r * 0.4, -Math.PI / 4, Math.PI / 4);
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(cx + r * 0.8, cy, r * 0.8, -Math.PI / 4, Math.PI / 4);
				ctx.stroke();
			}
		}
		// Fullscreen icon (corner brackets).
		if (!audioOnly) {
			const cx = fsLeft + VIDEO_CONTROLS_BTN_W / 2;
			const cy = contentY + contentH / 2;
			ctx.strokeStyle = iconColor;
			ctx.lineWidth = 1.8;
			const off = r * 0.9;
			const len = r * 0.55;
			// Top-left bracket.
			ctx.beginPath();
			ctx.moveTo(cx - off, cy - off + len);
			ctx.lineTo(cx - off, cy - off);
			ctx.lineTo(cx - off + len, cy - off);
			ctx.stroke();
			// Top-right bracket.
			ctx.beginPath();
			ctx.moveTo(cx + off - len, cy - off);
			ctx.lineTo(cx + off, cy - off);
			ctx.lineTo(cx + off, cy - off + len);
			ctx.stroke();
			// Bottom-left.
			ctx.beginPath();
			ctx.moveTo(cx - off, cy + off - len);
			ctx.lineTo(cx - off, cy + off);
			ctx.lineTo(cx - off + len, cy + off);
			ctx.stroke();
			// Bottom-right.
			ctx.beginPath();
			ctx.moveTo(cx + off - len, cy + off);
			ctx.lineTo(cx + off, cy + off);
			ctx.lineTo(cx + off, cy + off - len);
			ctx.stroke();
		}
		// --- progress bar at bottom of the bar ---
		if (progressH > 0) {
			ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
			ctx.fillRect(boxX, progressY, boxW, progressH);
			if (dur > 0 && cur > 0) {
				const filled = Math.min(1, Math.max(0, cur / dur)) * boxW;
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(boxX, progressY, filled, progressH);
			}
		}
	} finally { ctx.restore(); }
}

export function videoErrorMessage(el: LiveElement): string | null {
	const st = videoStateMap.get(el);
	if (!st) return null;
	if (st.loadError) return st.loadError;
	if (st.decoder) {
		try { return st.decoder.error; } catch { return null; }
	}
	return null;
}
