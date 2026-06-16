import { installFileReader } from './polyfills/file-reader.js';
import { installGetComputedStyle } from './polyfills/css-computed.js';
import { installMessageChannel } from './polyfills/message-channel.js';
import { installMutationObserver } from './polyfills/mutation-observer.js';
import { installPointerLock } from './polyfills/pointer-lock.js';
import { installSafeConsoleRedirect } from './polyfills/safe-console.js';
import { installWebAudioStubs } from './polyfills/web-audio-stubs.js';
import { installXMLHttpRequest } from './polyfills/xhr.js';
import { installIndexedDB } from './storage/indexed-db.js';
import { installLocalStorage } from './storage/local-storage.js';
import { LiveElement } from './scripts/live-dom.js';
/**
 * Install every Web Platform polyfill the runtime ships, in the order
 * the brewser shell expects. Centralizes the install sequence so
 * embedded NRO apps don't have to replicate `main.ts`'s install block.
 *
 * Order is load-bearing:
 *  - `installSafeConsoleRedirect` runs FIRST — before any other code
 *    can trigger a global `console.log`, which nx.js would route to
 *    `$.print` and flip the runtime from canvas-render mode into
 *    text-render mode (see the safe-console memory). Subsequent
 *    installs are write-once; their order among each other is mostly
 *    cosmetic.
 *  - Storage installs (`installLocalStorage` / `installIndexedDB`)
 *    receive the {@link StorageProfileLike} + URL getter so namespace
 *    dispatch works on first access.
 *  - `installPointerLock(LiveElement)` mounts the spec method on the
 *    LiveElement prototype that page scripts see as `Element`.
 *
 * Each installer is idempotent — calling `installPolyfills` twice is
 * harmless (subsequent calls are no-ops). The shell still inlines its
 * install block to keep the comments visible for archaeology; new
 * embedders should call this helper instead.
 */
export function installPolyfills(opts = {}) {
    if (!opts.skipSafeConsole)
        installSafeConsoleRedirect();
    installLocalStorage({ profile: opts.profile, getCurrentUrl: opts.getCurrentUrl });
    installIndexedDB({ profile: opts.profile, getCurrentUrl: opts.getCurrentUrl });
    installMessageChannel();
    installFileReader();
    installXMLHttpRequest();
    installMutationObserver();
    installGetComputedStyle();
    installWebAudioStubs();
    installPointerLock(LiveElement);
}
//# sourceMappingURL=install-polyfills.js.map