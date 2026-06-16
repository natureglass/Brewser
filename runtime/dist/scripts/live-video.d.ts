/// <reference types="@nx.js/runtime" />
import { type LiveElement } from './live-dom.js';
export declare function setVideoTryHwAccel(enabled: boolean): void;
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
export declare function paintVideoFrameAt(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, el: LiveElement, dstX: number, dstY: number, dstW: number, dstH: number): boolean;
/** Called from the shell rAF tick alongside tickAnimationFrames(). For
 * every active VIDEO element, polls the native decoder for a frame and
 * blits it into the per-element OffscreenCanvas. Returns true if any
 * frame was advanced — the shell uses that to trigger a repaint. */
export declare function tickVideo(): boolean;
/** True if any video element on the page is currently active. Used by
 * pageHasAnimationActivity() so the shell knows to keep its tick loop
 * running even when the page script doesn't call requestAnimationFrame. */
export declare function pageHasActiveVideo(): boolean;
/** True if any video element holds a posterBitmap from the preview
 * pass — i.e. a static first-frame that needs to be repainted by the
 * overlay walker whenever the screen is redrawn. Used by the shell's
 * walker-gate so posters survive cache reblits (scrolls, repaints)
 * even after the preview decoder has been closed. */
export declare function pageHasAnyPoster(): boolean;
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
export declare function scanForAutoplayVideos(root: LiveElement): void;
/** Close all decoders. Called by the shell on navigation. */
export declare function clearAllVideos(): void;
export declare function videoIsPaused(el: LiveElement): boolean;
export declare function videoIsEnded(el: LiveElement): boolean;
export declare function videoCurrentTime(el: LiveElement): number;
/** Audio-reactive per-band levels at the play head (low→high, ~0..1).
 * Returns `[]` when no decoder / no audio / before playback anchors. Backs
 * `HTMLMediaElement`-style `getAudioLevels()` for the music visualizer. */
export declare function videoGetAudioLevels(el: LiveElement): number[];
/** Fill `out` with the frequency spectrum at the play head (low→high,
 * ~0..1). Returns false (and leaves `out` untouched) when no decoder / no
 * audio / before playback anchors. Backs `getFrequencyData()` for the
 * music visualizer. */
export declare function videoGetFrequencyData(el: LiveElement, out: Float32Array): boolean;
/** Fill `out` with the time-domain waveform at the play head (-1..1).
 * Returns false when no decoder / no audio / before playback anchors. */
export declare function videoGetWaveform(el: LiveElement, out: Float32Array): boolean;
/** Remembered audio gain (0..1) for this element — survives decoder
 * re-opens. */
export declare function videoGetVolume(el: LiveElement): number;
export declare function videoSetVolume(el: LiveElement, v: number): void;
export declare function videoIsMuted(el: LiveElement): boolean;
export declare function videoSetMuted(el: LiveElement, m: boolean): void;
export declare function videoDuration(el: LiveElement): number;
export declare function videoPlay(el: LiveElement): void;
export declare function videoPause(el: LiveElement): void;
export declare function videoSeek(el: LiveElement, t: number): void;
/** Stop = seek to 0 then pause. Returns the decoder to a known "ready
 * to play from the start" state. Keeps the decoder open. */
export declare function videoStop(el: LiveElement): void;
/** Reset a media element's decoder + playback cursor so the NEXT
 * `play()` opens a FRESH decoder for the element's CURRENT `src`. Backs
 * `HTMLMediaElement.load()` — needed when a page swaps the source (e.g.
 * an audio player advancing to the next track): without this, `videoPlay`
 * sees the existing decoder and just resumes the OLD source. Keeps the
 * per-element state object; only drops the decoder + cursor. */
export declare function videoResetSource(el: LiveElement): void;
/** Toggle muted state on the decoder. */
export declare function videoToggleMute(el: LiveElement): void;
/** Seek the decoder to `ratio * duration` (0..1). No-op if no decoder. */
export declare function videoSeekRatio(el: LiveElement, ratio: number): void;
export declare const VIDEO_CONTROLS_BAR_H = 36;
export type VideoControlHit = {
    kind: 'play';
} | {
    kind: 'pause';
} | {
    kind: 'mute-toggle';
} | {
    kind: 'unmute-toggle';
} | {
    kind: 'fullscreen-enter';
} | {
    kind: 'seek';
    ratio: number;
};
/** Returns the control button hit by a tap at the given screen coords,
 * or null if the tap missed all buttons. `(boxX, boxY, boxW, boxH)` is
 * the video element's bounding rect on screen. */
export declare function hitTestVideoControls(boxX: number, boxY: number, boxW: number, boxH: number, tapX: number, tapY: number, el?: LiveElement): VideoControlHit | null;
/** Paint the controls bar at the bottom of the video's box. Buttons
 * drawn with canvas primitives (no font glyph dependence) so the bar
 * is identical on devkitPro shared-font + on dev hosts. */
export declare function paintVideoControls(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, el: LiveElement, boxX: number, boxY: number, boxW: number, boxH: number): void;
export declare function videoErrorMessage(el: LiveElement): string | null;
//# sourceMappingURL=live-video.d.ts.map