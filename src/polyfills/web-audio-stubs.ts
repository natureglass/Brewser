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

type AudioContextLike = {
	prototype: {
		createMediaElementSource?: (el: unknown) => unknown;
		createAnalyser?: () => unknown;
		createMediaStreamSource?: (stream: unknown) => unknown;
		createMediaStreamDestination?: () => unknown;
		createConvolver?: () => unknown;
		createBiquadFilter?: () => unknown;
		createPanner?: () => unknown;
		createStereoPanner?: () => unknown;
		createDynamicsCompressor?: () => unknown;
		createWaveShaper?: () => unknown;
		createDelay?: (maxDelay?: number) => unknown;
		createScriptProcessor?: (bufferSize?: number, inputs?: number, outputs?: number) => unknown;
		createIIRFilter?: (ff: unknown, fb: unknown) => unknown;
	};
};

function fakeNode(): Record<string, unknown> {
	return {
		connect(_dest: unknown) { return _dest; },
		disconnect() { /* no-op */ },
		channelCount: 2,
		channelCountMode: 'max',
		channelInterpretation: 'speakers',
		numberOfInputs: 1,
		numberOfOutputs: 1,
		addEventListener() { /* no-op */ },
		removeEventListener() { /* no-op */ },
		dispatchEvent() { return false; },
	};
}

function fakeAnalyser(): Record<string, unknown> {
	const node = fakeNode();
	return {
		...node,
		fftSize: 2048,
		frequencyBinCount: 1024,
		minDecibels: -100,
		maxDecibels: -30,
		smoothingTimeConstant: 0.8,
		getByteFrequencyData(arr: { fill(v: number): void }) { try { arr.fill(0); } catch (_) {} },
		getByteTimeDomainData(arr: { fill(v: number): void }) { try { arr.fill(128); } catch (_) {} },
		getFloatFrequencyData(arr: { fill(v: number): void }) { try { arr.fill(-100); } catch (_) {} },
		getFloatTimeDomainData(arr: { fill(v: number): void }) { try { arr.fill(0); } catch (_) {} },
	};
}

let installed = false;

function diag(msg: string): void {
	// Route to nxjs-debug.log via console.debug — Switch.appendFileSync to
	// our usual logs/ dir silently fails because main.ts runs BEFORE
	// BrowserProfile.ensure() creates the logs/ directory. console.debug
	// is the safest channel available at this point in startup.
	try { console.debug('[stubs]', msg); } catch { /* ignore */ }
}

// Build marker — bumped manually so demo pages can detect when the
// polyfill ran with the latest code vs an old in-memory copy.
const STUBS_BUILD_TAG = 'v7-defineProperty-everywhere';

// Page-script context doesn't see direct assignments to globalThis from
// main.ts — only `Object.defineProperty(globalThis, …)` propagates. Same
// rule appears to apply to prototype patches: `p.foo = fn` is invisible
// to page-script, but `Object.defineProperty(p, 'foo', {value: fn, …})`
// reaches it. Diagnosed 2026-06-03 via __stubsInstallReached sentinel.
function setGlobal(key: string, value: unknown): void {
	try {
		Object.defineProperty(globalThis, key, {
			value, writable: true, configurable: true, enumerable: false,
		});
	} catch { /* ignore */ }
}
function definePrototypeMethod(proto: Record<string, unknown>, name: string, fn: (...args: unknown[]) => unknown): void {
	if (typeof proto[name] === 'function') return;
	try {
		Object.defineProperty(proto, name, {
			value: fn, writable: true, configurable: true, enumerable: false,
		});
	} catch { /* ignore */ }
}

export function installWebAudioStubs(): void {
	// Set sentinels via defineProperty so page-script context sees them.
	setGlobal('__stubsInstallReached', true);
	setGlobal('__stubsBuildTag', STUBS_BUILD_TAG);
	if (installed) { diag('already installed, skip'); return; }
	installed = true;
	const AC = (globalThis as unknown as { AudioContext?: AudioContextLike }).AudioContext;
	diag('install called; typeof AudioContext=' + typeof AC);
	setGlobal('__stubsACType', typeof AC);
	setGlobal('__stubsACHasProto', !!(AC && AC.prototype));
	if (!AC || !AC.prototype) { diag('ABORT — no AudioContext or no prototype'); return; }
	const p = AC.prototype as Record<string, unknown>;
	setGlobal('__stubsBeforeMediaSource', typeof p.createMediaElementSource);
	setGlobal('__stubsBeforeAnalyser', typeof p.createAnalyser);
	diag('BEFORE: createMediaElementSource=' + typeof p.createMediaElementSource
		+ ' createAnalyser=' + typeof p.createAnalyser);
	definePrototypeMethod(p, 'createMediaElementSource', function (_el: unknown) { return fakeNode(); });
	definePrototypeMethod(p, 'createAnalyser', function () { return fakeAnalyser(); });
	definePrototypeMethod(p, 'createMediaStreamSource', function (_stream: unknown) { return fakeNode(); });
	definePrototypeMethod(p, 'createMediaStreamDestination', function () { return { ...fakeNode(), stream: null }; });
	definePrototypeMethod(p, 'createConvolver', function () { return { ...fakeNode(), buffer: null, normalize: true }; });
	definePrototypeMethod(p, 'createBiquadFilter', function () {
		return { ...fakeNode(), type: 'lowpass',
			frequency: { value: 350 }, Q: { value: 1 }, gain: { value: 0 }, detune: { value: 0 } };
	});
	definePrototypeMethod(p, 'createPanner', function () { return { ...fakeNode(), panningModel: 'equalpower', distanceModel: 'inverse' }; });
	definePrototypeMethod(p, 'createStereoPanner', function () { return { ...fakeNode(), pan: { value: 0 } }; });
	definePrototypeMethod(p, 'createDynamicsCompressor', function () {
		return { ...fakeNode(),
			threshold: { value: -24 }, knee: { value: 30 }, ratio: { value: 12 },
			reduction: 0, attack: { value: 0.003 }, release: { value: 0.25 } };
	});
	definePrototypeMethod(p, 'createWaveShaper', function () { return { ...fakeNode(), curve: null, oversample: 'none' }; });
	definePrototypeMethod(p, 'createDelay', function (..._args: unknown[]) { return { ...fakeNode(), delayTime: { value: 0 } }; });
	definePrototypeMethod(p, 'createScriptProcessor', function (...args: unknown[]) {
		const bufferSize = typeof args[0] === 'number' ? args[0] : 4096;
		return { ...fakeNode(), bufferSize, onaudioprocess: null };
	});
	definePrototypeMethod(p, 'createIIRFilter', function (..._args: unknown[]) { return fakeNode(); });
	diag('AFTER: createMediaElementSource=' + typeof p.createMediaElementSource
		+ ' createAnalyser=' + typeof p.createAnalyser);
	setGlobal('__webAudioStubsApplied', true);
	setGlobal('__stubsAfterMediaSource', typeof p.createMediaElementSource);
	setGlobal('__stubsAfterAnalyser', typeof p.createAnalyser);
}
