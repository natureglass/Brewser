import { BrowserShell } from './browser-shell.js';
import { installFileReader } from './polyfills/file-reader.js';
import { installMessageChannel } from './polyfills/message-channel.js';
import { installPointerLock } from './polyfills/pointer-lock.js';
import { installWebAudioStubs } from './polyfills/web-audio-stubs.js';
import { LiveElement } from './scripts/live-dom.js';
import { installIndexedDB } from './storage/indexed-db.js';
import { installLocalStorage } from './storage/local-storage.js';

async function main() {
	// Install Web APIs that nxjs runtime doesn't ship (or ships in a
	// non-usable form for swb) BEFORE any page script can touch them.
	// See [[reference-swb-api-probe-results]] for the gap list.
	installLocalStorage();
	installIndexedDB();
	installMessageChannel();
	installFileReader();
	// Stub out Web Audio methods we didn't implement (createMediaElementSource,
	// createAnalyser, etc.) so mediaplayer's bootAudioGraph doesn't throw a
	// TypeError mid-init and leave AudioContext half-constructed, which
	// caused a system-wide audio break (mediaplayer + video + Web Audio).
	installWebAudioStubs();
	// Pointer Lock needs LiveElement.prototype to mount requestPointerLock
	// on — the page-script `typeof Element` check resolves to this class.
	installPointerLock(LiveElement);

	const shell = new BrowserShell();
	await shell.run();
}

main().catch((error) => {
	console.debug('[switch-web-browser] fatal error:', error);
});
