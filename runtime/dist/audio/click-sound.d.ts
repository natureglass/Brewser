/**
 * Toggle the click-sound feature at runtime. Driven by the
 * `clickSounds` boolean in `config.json`. When disabled,
 * `playClick()` is a no-op (no fetch, no decode, no audio voice).
 */
export declare function setClickSoundEnabled(on: boolean): void;
/**
 * Configure the path to the click.wav asset. Called at boot with
 * `profile.assetPath('click.wav')` so the path tracks the active
 * profile's storage root. Setting a new path (e.g. on profile switch)
 * invalidates any previously decoded buffer so the next play re-loads
 * from the new location.
 */
export declare function setClickSoundPath(path: string | null): void;
/**
 * Begin loading + decoding the click sound. Safe to call multiple
 * times — subsequent calls are no-ops while a load is in flight or a
 * decoded buffer is already cached. Returns the in-flight promise so
 * callers can `await` it for tests; production paths fire-and-forget.
 */
export declare function preloadClickSound(): Promise<void>;
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
export declare function playClick(): void;
//# sourceMappingURL=click-sound.d.ts.map