import { trackAppCleanup } from '../session/app-session.js';
import { fullscreenRect } from '../graphics/canvas.js';
import { getWebGLContext, isWebGLContextId, resetWebGLContext } from './webgl-shim.js';
const CSS_COLOR_NAMES = {
    black: '#000000',
    blue: '#0000ff',
    cyan: '#00ffff',
    fuchsia: '#ff00ff',
    gray: '#808080',
    green: '#008000',
    lime: '#00ff00',
    magenta: '#ff00ff',
    red: '#ff0000',
    transparent: 'rgba(0, 0, 0, 0)',
    white: '#ffffff',
    yellow: '#ffff00',
};
const nativeSetTimeout = setTimeout.bind(globalThis);
const nativeClearTimeout = clearTimeout.bind(globalThis);
const nativeSetInterval = setInterval.bind(globalThis);
const nativeClearInterval = clearInterval.bind(globalThis);
const nativeAddEventListener = addEventListener.bind(globalThis);
const nativeRemoveEventListener = removeEventListener.bind(globalThis);
const trackedEventTargets = new WeakSet();
let browserRuntimeInstalled = false;
function defineValue(target, name, value) {
    Object.defineProperty(target, name, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}
function normalizeCanvasValue(property, value) {
    if ((property === 'fillStyle' || property === 'strokeStyle') &&
        typeof value === 'string') {
        return CSS_COLOR_NAMES[value.toLowerCase()] || value;
    }
    return value;
}
function wrapCanvas2dContext(ctx) {
    return new Proxy(ctx, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, property, value) {
            return Reflect.set(target, property, normalizeCanvasValue(property, value), target);
        },
    });
}
function installTrackedEventTarget(target) {
    if (trackedEventTargets.has(target)) {
        return;
    }
    trackedEventTargets.add(target);
    const nativeAdd = target.addEventListener.bind(target);
    const nativeRemove = target.removeEventListener.bind(target);
    defineValue(target, 'addEventListener', (type, listener, options) => {
        nativeAdd(type, listener, options);
        if (listener) {
            trackAppCleanup(() => nativeRemove(type, listener, options));
        }
    });
    defineValue(target, 'removeEventListener', (type, listener, options) => {
        nativeRemove(type, listener, options);
    });
}
function configureFullscreenCanvas(canvas, width, height) {
    const canvasLike = canvas;
    defineValue(canvasLike, 'id', 'canvas');
    defineValue(canvasLike, 'tagName', 'CANVAS');
    defineValue(canvasLike, 'nodeName', 'CANVAS');
    defineValue(canvasLike, 'nodeType', 1);
    defineValue(canvasLike, 'width', width);
    defineValue(canvasLike, 'height', height);
    defineValue(canvasLike, 'clientWidth', width);
    defineValue(canvasLike, 'clientHeight', height);
    defineValue(canvasLike, 'style', {
        width: `${width}px`,
        height: `${height}px`,
        display: 'block',
    });
    defineValue(canvasLike, 'getBoundingClientRect', () => fullscreenRect(width, height));
    const nativeGetContext = canvasLike.getContext.bind(canvasLike);
    let context2d = null;
    defineValue(canvasLike, 'getContext', (contextId, ...args) => {
        if (contextId === '2d') {
            context2d ||= wrapCanvas2dContext(nativeGetContext('2d'));
            return context2d;
        }
        if (isWebGLContextId(contextId)) {
            return getWebGLContext({
                canvas,
                contextId,
                attributes: args,
                nativeGetContext,
            });
        }
        console.debug(`[switch-web/runtime] unsupported canvas context: ${contextId}`);
        return null;
    });
    installTrackedEventTarget(canvasLike);
    return canvasLike;
}
function createElementStub(tag) {
    const element = new EventTarget();
    const attributes = new Map();
    element.id = '';
    element.tagName = tag.toUpperCase();
    element.nodeName = element.tagName;
    element.nodeType = 1;
    element.style = {};
    element.children = [];
    element.appendChild = (child) => {
        element.children.push(child);
        return child;
    };
    element.removeChild = (child) => {
        const index = element.children.indexOf(child);
        if (index !== -1) {
            element.children.splice(index, 1);
        }
        return child;
    };
    element.getAttribute = (name) => attributes.get(name) || null;
    element.setAttribute = (name, value) => {
        const stringValue = String(value);
        attributes.set(name, stringValue);
        if (name === 'id') {
            element.id = stringValue;
        }
    };
    element.getBoundingClientRect = () => fullscreenRect(0, 0);
    return element;
}
// nx.js's `navigator.userAgent` getter calls `nacpGetLanguageEntry`, which
// throws on Citron and at least some real-hardware NACP configurations. Any
// code that touches `navigator.userAgent` (including nx.js's own fetchHttp
// while building the request) blows up before the request leaves the JS
// runtime. Redefine the property with a static string so the getter is never
// invoked. Writable+configurable so example bundles that supply their own
// safer navigator shim still win.
function installNavigatorUserAgentShim() {
    const nav = globalThis.navigator;
    if (!nav)
        return;
    try {
        Object.defineProperty(nav, 'userAgent', {
            value: '@switch-web/runtime',
            writable: true,
            configurable: true,
        });
    }
    catch (error) {
        console.debug(`[switch-web/runtime] could not shim navigator.userAgent: ${error}`);
    }
}
function installBrowserRuntimeTracking() {
    if (browserRuntimeInstalled) {
        return;
    }
    browserRuntimeInstalled = true;
    let nextFrameId = 1;
    const frameTimers = new Map();
    defineValue(globalThis, 'requestAnimationFrame', (callback) => {
        const id = nextFrameId++;
        const timer = nativeSetTimeout(() => {
            frameTimers.delete(id);
            try {
                callback(performance.now());
            }
            catch (error) {
                console.debug(`[switch-web/runtime] requestAnimationFrame callback failed: ${error}`);
                throw error;
            }
        }, 16);
        frameTimers.set(id, timer);
        trackAppCleanup(() => globalThis.cancelAnimationFrame(id));
        return id;
    });
    defineValue(globalThis, 'cancelAnimationFrame', (id) => {
        const timer = frameTimers.get(id);
        if (timer !== undefined) {
            nativeClearTimeout(timer);
            frameTimers.delete(id);
        }
    });
    defineValue(globalThis, 'setTimeout', (handler, timeout, ...args) => {
        const id = nativeSetTimeout(handler, timeout, ...args);
        trackAppCleanup(() => nativeClearTimeout(id));
        return id;
    });
    defineValue(globalThis, 'clearTimeout', (id) => nativeClearTimeout(id));
    defineValue(globalThis, 'setInterval', (handler, timeout, ...args) => {
        const id = nativeSetInterval(handler, timeout, ...args);
        trackAppCleanup(() => nativeClearInterval(id));
        return id;
    });
    defineValue(globalThis, 'clearInterval', (id) => nativeClearInterval(id));
    defineValue(globalThis, 'addEventListener', (type, listener, options) => {
        nativeAddEventListener(type, listener, options);
        if (listener) {
            trackAppCleanup(() => nativeRemoveEventListener(type, listener, options));
        }
    });
    defineValue(globalThis, 'removeEventListener', nativeRemoveEventListener);
    defineValue(window, 'requestAnimationFrame', globalThis.requestAnimationFrame);
    defineValue(window, 'cancelAnimationFrame', globalThis.cancelAnimationFrame);
    defineValue(window, 'setTimeout', globalThis.setTimeout);
    defineValue(window, 'clearTimeout', globalThis.clearTimeout);
    defineValue(window, 'setInterval', globalThis.setInterval);
    defineValue(window, 'clearInterval', globalThis.clearInterval);
}
export function installBrowserShim({ canvas, width, height }) {
    resetWebGLContext();
    installNavigatorUserAgentShim();
    const fullscreenCanvas = configureFullscreenCanvas(canvas, width, height);
    const body = createElementStub('body');
    const documentTarget = new EventTarget();
    body.appendChild = (child) => child;
    body.removeChild = (child) => child;
    const documentShim = Object.assign(documentTarget, {
        body,
        createElement(tag) {
            if (tag.toLowerCase() === 'canvas') {
                return fullscreenCanvas;
            }
            return createElementStub(tag);
        },
        createElementNS(_namespace, tag) {
            if (tag.toLowerCase() === 'canvas') {
                return fullscreenCanvas;
            }
            return createElementStub(tag);
        },
        getElementById(id) {
            return id === 'canvas' ? fullscreenCanvas : null;
        },
    });
    installTrackedEventTarget(documentShim);
    const global = globalThis;
    global.window = globalThis;
    global.self = globalThis;
    global.global = globalThis;
    global.document = documentShim;
    defineValue(window, 'innerWidth', width);
    defineValue(window, 'innerHeight', height);
    defineValue(window, 'devicePixelRatio', 1);
    installBrowserRuntimeTracking();
    // TODO: Add audio support once the runner starts exposing media APIs.
}
//# sourceMappingURL=browser-shim.js.map