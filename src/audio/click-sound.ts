// Click-sound playback for interactive feedback. Plays a short
// `click.wav` (seeded from `romfs:/shell/assets/click.wav`
// into `<storageRoot>assets/click.wav` by the profile seeder) whenever
// the user activates a link, button, chrome-strip control, or other
// interactive target.
//
// Boot wiring (browser-shell.ts):
//   1. `setClickSoundEnabled(config.clickSounds)` — config gate
//   2. `setClickSoundPath(profile.assetPath('click.wav'))` — file path
//   3. `void preloadClickSound()` — decode the wav up front so the
//      first press doesn't audibly stutter while the loader runs
//
// Use `playClick()` at every dispatch site. Cheap when sound is
// disabled or load failed (early-return on a flag).

// Minimal Web-Audio shape used by this module — written in `unknown`
// terms so we don't depend on DOM `lib` typings the rest of swb avoids.
// The real `globalThis.AudioContext` returned by `nxjs-source/packages
// /runtime/src/web-audio.ts` matches this shape on the methods we use.
interface NxAudioBuffer { readonly duration: number }
interface NxBufferSource {
	buffer: NxAudioBuffer | null;
	connect(destination: unknown): unknown;
	start(when?: number): void;
}
interface NxAudioContext {
	readonly destination: unknown;
	createBufferSource(): NxBufferSource;
	decodeAudioData(data: ArrayBuffer): Promise<NxAudioBuffer>;
}
type NxAudioContextCtor = new () => NxAudioContext;

const enableCache = { enabled: true };
let clickPath: string | null = null;

let audioCtx: NxAudioContext | null = null;
let clickBuffer: NxAudioBuffer | null = null;
let loadAttempted = false;
let loadFailed = false;
let loadInFlight: Promise<void> | null = null;

/**
 * Toggle the click-sound feature at runtime. Driven by the
 * `clickSounds` boolean in `config.json`. When disabled,
 * `playClick()` is a no-op (no fetch, no decode, no audio voice).
 */
export function setClickSoundEnabled(on: boolean): void {
	enableCache.enabled = !!on;
}

/**
 * Configure the path to the click.wav asset. Called at boot with
 * `profile.assetPath('click.wav')` so the path tracks the active
 * profile's storage root. Setting a new path (e.g. on profile switch)
 * invalidates any previously decoded buffer so the next play re-loads
 * from the new location.
 */
export function setClickSoundPath(path: string | null): void {
	if (path === clickPath) return;
	clickPath = path;
	clickBuffer = null;
	loadAttempted = false;
	loadFailed = false;
	loadInFlight = null;
}

/**
 * Begin loading + decoding the click sound. Safe to call multiple
 * times — subsequent calls are no-ops while a load is in flight or a
 * decoded buffer is already cached. Returns the in-flight promise so
 * callers can `await` it for tests; production paths fire-and-forget.
 */
export function preloadClickSound(): Promise<void> {
	if (clickBuffer || loadFailed) return Promise.resolve();
	if (loadInFlight) return loadInFlight;
	loadInFlight = doLoad();
	return loadInFlight;
}

async function doLoad(): Promise<void> {
	if (!clickPath) return;
	loadAttempted = true;
	try {
		if (!audioCtx) {
			const AC = (globalThis as { AudioContext?: NxAudioContextCtor }).AudioContext;
			if (!AC) {
				console.debug('[click-sound] AudioContext unavailable; click sounds disabled');
				loadFailed = true;
				return;
			}
			audioCtx = new AC();
		}
		const resp = await fetch(clickPath);
		if (!resp.ok) throw new Error('fetch ' + clickPath + ' status=' + resp.status);
		const arr = await resp.arrayBuffer();
		clickBuffer = await audioCtx.decodeAudioData(arr);
		console.debug('[click-sound] decoded click.wav (' + clickBuffer.duration.toFixed(3) + 's)');
	} catch (e) {
		loadFailed = true;
		console.debug('[click-sound] load failed: ' + String(e));
	} finally {
		loadInFlight = null;
	}
}

/**
 * Trigger one click sound. Multiple invocations within a short window
 * overlap (each plays through a fresh `AudioBufferSourceNode`) so a
 * rapid double-tap audibly fires twice rather than restarting a
 * single voice. No-op when:
 *   - `clickSounds` is off in config
 *   - the click.wav couldn't be loaded
 *   - no AudioContext is available
 *
 * Lazy-load: the first call kicks off the fetch + decode if
 * `preloadClickSound` wasn't called at boot; that first call won't
 * make a sound (the buffer isn't ready yet) but subsequent calls
 * will. The boot path always preloads, so this lazy branch is the
 * safety net for unexpected reset paths.
 */
export function playClick(): void {
	if (!enableCache.enabled) return;
	if (loadFailed) return;
	if (!clickBuffer || !audioCtx) {
		if (!loadAttempted && !loadInFlight) {
			void preloadClickSound();
		}
		return;
	}
	try {
		const source = audioCtx.createBufferSource();
		source.buffer = clickBuffer;
		source.connect(audioCtx.destination);
		source.start();
	} catch (e) {
		console.debug('[click-sound] start failed: ' + String(e));
	}
}
