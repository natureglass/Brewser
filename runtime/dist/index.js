export { WebView, setNavDebugEnabled, } from './web-view.js';
export { notFoundResponse, deniedResponse, } from './resources/resource-loader.js';
export { LocalResourceLoader, } from './resources/local-resource-loader.js';
export { NativeFetchLoader, } from './resources/native-fetch-loader.js';
export { installRuntimeFetch, captureNativeFetch, } from './resources/runtime-fetch.js';
export { resolveAppPath, isAppRootRelative, hasProtocol, getRequestUrl, } from './resources/path-utils.js';
export { contentTypeFor, DEFAULT_MIME_TYPES, } from './resources/mime-types.js';
export { NavigationController } from './navigation/navigation-controller.js';
export { DefaultPermissionPolicy } from './permissions/default-permission-policy.js';
export { beginAppSession, endAppSession, trackAppCleanup, isAppSessionActive, } from './session/app-session.js';
export { WebPageSession, } from './session/web-page-session.js';
export { installPolyfills, } from './install-polyfills.js';
export { installBrowserShim, } from './shims/browser-shim.js';
export { installTouchShim } from './shims/touch-shim.js';
export { installGamepadShim } from './shims/gamepad-shim.js';
export { getWebGLContext, isWebGLContextId, resetWebGLContext, } from './shims/webgl-shim.js';
export { nxScreen, } from './graphics/screen.js';
export { fullscreenRect, canvasSize, } from './graphics/canvas.js';
export { DEFAULT_PROFILE_ROOT, storagePathForOrigin, } from './profile/profile-paths.js';
export { DEFAULT_STORAGE_PROFILE, } from './profile/storage-profile.js';
export { RuntimeError, ResourceError, PermissionDeniedError, } from './errors.js';
export { RUNTIME_CONFIG_DEFAULTS, STRICT_PINNED_RUNTIME_KEYS, } from './runtime-defaults.js';
// ---------------------------------------------------------------------------
// Phase 1: leaf modules lifted from brewser/src into brewser-runtime/src.
// Polyfills (Web Platform APIs nxjs runtime doesn't ship), storage drivers,
// HTML parser, low-level paint helpers, in-browser fetch loaders + cookies,
// network probe, permission policy, click sound, and base browser config.
// ---------------------------------------------------------------------------
export { FileReader, installFileReader } from './polyfills/file-reader.js';
export { MessageChannel, MessagePort, installMessageChannel } from './polyfills/message-channel.js';
export { installMutationObserver, notifyAttribute, notifyCharacterData, notifyChildList, } from './polyfills/mutation-observer.js';
export { installPointerLock, installPointerLockOnDocumentShim, } from './polyfills/pointer-lock.js';
export { installSafeConsoleRedirect } from './polyfills/safe-console.js';
export { installWebAudioStubs } from './polyfills/web-audio-stubs.js';
export { installXMLHttpRequest } from './polyfills/xhr.js';
export { IDBDatabase, IDBFactory, IDBObjectStore, IDBOpenDBRequest, IDBRequest, IDBTransaction, installIndexedDB, } from './storage/indexed-db.js';
export { installLocalStorage } from './storage/local-storage.js';
export { countNodes, extractTitle, parseHtml, } from './html/html-parser.js';
export { paintSvgSubtree, } from './scripts/svg-painter.js';
export { applyDecl, cssToJsProp, getCssViewport, isBoldWeight, isItalicStyle, isPercent, jsToCssProp, parseCssText, parseLength, quoteFontFamily, resolveCanvasFont, resolveFontSizeKeyword, resolveLength, serializeStyle, setCssViewport, } from './scripts/inline-css.js';
export { CookieJar } from './resources/cookie-jar.js';
export { loadOptionalImage } from './resources/load-optional-image.js';
export { LocalSchemeFetchLoader } from './resources/local-scheme-fetch-loader.js';
export { SwitchUaFetchLoader, } from './resources/switch-ua-fetch-loader.js';
export { probeNetwork, } from './network/network-probe.js';
export { BrowserPermissionPolicy, } from './permissions/browser-permission-policy.js';
export { playClick, preloadClickSound, setClickSoundEnabled, setClickSoundPath, } from './audio/click-sound.js';
export { BREWSER_APP_ROOT, BROWSER_INTERNAL_ORIGIN, COMBO_BUTTONS, DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH, DEFAULT_HOME_URL, EXIT_COMBO_HOLD_MS, KEYBOARD_LAYOUT, } from './browser-config.js';
// DEFAULT_PROFILE_ROOT re-exported above via './profile/profile-paths.js'
// (which now imports it from './browser-config.js').
// ---------------------------------------------------------------------------
// Phase 2: DOM/CSS/layout/paint core + page input forwarders + the two
// deferred Phase-1 modules (css-computed, emoji-atlas). After this batch,
// the proprietary rendering engine no longer lives in the public brewser
// repo — the live-* cluster, canvas-runner, and page-side input forwarders
// all ship from @switch-web/runtime.
// ---------------------------------------------------------------------------
export * from './scripts/live-dom.js';
export * from './scripts/live-css.js';
export * from './scripts/live-layout.js';
export * from './scripts/live-overlay.js';
export * from './scripts/live-paint-control.js';
export * from './scripts/live-form.js';
export * from './scripts/live-video.js';
export * from './scripts/html-to-live.js';
export * from './scripts/canvas-runner.js';
export * from './scripts/emoji-atlas.js';
export * from './polyfills/css-computed.js';
export * from './input/live-input-dispatch.js';
export * from './input/page-mouse-forwarder.js';
export * from './input/page-touch-forwarder.js';
// ---------------------------------------------------------------------------
// Phase 3: input cluster — button-router, controller-shortcuts,
// keyboard-overlay — moved into the runtime alongside an action event
// bus. The shell extends the action space (see
// `brewser/src/input/shell-actions.ts`) and subscribes for its chrome
// actions; runtime actions (`leftClick`, `scrollUp`, ...) stay handled
// in the runtime. The buttonMapping config-schema is unchanged.
// ---------------------------------------------------------------------------
export * from './input/button-router.js';
export * from './input/controller-shortcuts.js';
export * from './input/keyboard-overlay.js';
export { clearActionHandlers, emitAction, hasActionHandler, subscribeAction, } from './input/action-bus.js';
//# sourceMappingURL=index.js.map