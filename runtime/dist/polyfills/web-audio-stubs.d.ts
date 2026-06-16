/**
 * Patch the runtime's `AudioContext` to add stubs for Web Audio methods
 * NOT implemented by [[project-swb-web-audio-tier1]] (web-audio.ts in
 * nxjs-source). Without these, page scripts that legitimately query
 * Web Audio capability — like the mediaplayer's bootAudioGraph calling
 * `audioContext.createMediaElementSource(audio)` — throw
 * `TypeError: not a function`. The caught error leaves the AudioContext
 * constructed-but-half-set-up, holding audrv resources and (the worst
 * symptom) breaking subsequent HTMLAudioElement playback platform-wide.
 *
 * Stubs return no-op AudioNode-shaped objects. Visualizers that depend
 * on `getByteFrequencyData` etc. see zeros — falling back to silence /
 * synthetic-waveform display. Playback paths that go through the
 * `<audio>` element (not via Web Audio's source-node connect) are
 * untouched and continue to work normally.
 *
 * Diagnosed 2026-06-03: mediaplayer audio + video element advance +
 * Web Audio-Tone game all silently broke because mediaplayer's
 * `bootAudioGraph` would throw — the un-cleaned-up AudioContext then
 * held the audrv driver in a state that interfered with the
 * HTMLAudioElement path.
 */
export declare function installWebAudioStubs(): void;
//# sourceMappingURL=web-audio-stubs.d.ts.map