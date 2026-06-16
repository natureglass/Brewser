const WEBGL_CONTEXT_IDS = new Set(['webgl', 'experimental-webgl', 'webgl2']);
const globalKey = '__switchWebRuntime';
// Diagnostic Proxy wrap of the native WebGL/WebGL2 context. Activated
// by setting `globalThis.__brewserGLProxyDebug = true` BEFORE the page
// calls `canvas.getContext('webgl' | 'webgl2')`. When active, every
// property access on the returned context goes through a logging Proxy:
// undefined accesses are flagged loudly (`UNDEFINED gl.<name>`), method
// calls are logged once per name up to a per-name cap, and thrown
// errors inside methods are tagged with `THREW gl.<name>`.
//
// Returned objects from create* methods are NOT wrapped — they are
// opaque GPU handles the engine passes back to other GL calls, and a
// Proxy around them would break the native (C-side) JS_GetOpaque
// extraction used by the WebGL binding.
const GL_PROXY_FLAG = '__brewserGLProxyDebug';
// Optional companion flag: setting `__brewserGLProxySampleEvery = N` (a positive
// integer) makes the proxy log every Nth call/access AFTER the initial per-name
// cap is reached, instead of going completely silent. Useful for seeing
// steady-state render-loop behavior (draw calls, uniform updates, etc.) without
// the boot-time spam dominating the log. Set to 0/undefined to keep the
// original "silent after cap" behavior.
const GL_PROXY_SAMPLE_FLAG = '__brewserGLProxySampleEvery';
const GL_PROXY_PER_NAME_LIMIT = 10;
const glProxyLogCounts = new Map();
function isGlProxyEnabled() {
    return Boolean(globalThis[GL_PROXY_FLAG]);
}
function glProxySampleEvery() {
    const raw = globalThis[GL_PROXY_SAMPLE_FLAG];
    const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.floor(raw)
        : 0;
    return n;
}
function glProxyLog(label, ...rest) {
    const count = glProxyLogCounts.get(label) ?? 0;
    glProxyLogCounts.set(label, count + 1);
    if (count < GL_PROXY_PER_NAME_LIMIT) {
        console.debug('[glproxy]', label, ...rest);
        if (count + 1 === GL_PROXY_PER_NAME_LIMIT && glProxySampleEvery() === 0) {
            console.debug('[glproxy]', label, '— further occurrences silent');
        }
        return;
    }
    const sample = glProxySampleEvery();
    if (sample > 0 && (count + 1 - GL_PROXY_PER_NAME_LIMIT) % sample === 0) {
        console.debug('[glproxy]', label, '#' + (count + 1), ...rest);
    }
}
function wrapGlContextWithProxy(ctx, kind) {
    const label = kind;
    return new Proxy(ctx, {
        get(target, prop) {
            const value = Reflect.get(target, prop);
            // Non-string keys (Symbol.toPrimitive etc.): silent passthrough,
            // bound for `this` correctness.
            if (typeof prop !== 'string') {
                return typeof value === 'function' ? value.bind(target) : value;
            }
            // Preserve constructor identity — Three.js + Cocos detect WebGL2
            // via `gl.constructor.name === 'WebGL2RenderingContext'`. Binding
            // would change `.name` to "bound WebGL2RenderingContext".
            if (prop === 'constructor')
                return value;
            if (value === undefined) {
                console.debug('[glproxy] UNDEFINED', label + '.' + prop);
                return value;
            }
            if (typeof value === 'function') {
                // Return a wrapper that logs the call + tags exceptions.
                return function callWrapper(...args) {
                    const callLabel = 'call ' + label + '.' + prop;
                    const argTypes = args.slice(0, 6).map((a) => typeof a).join(',');
                    glProxyLog(callLabel, 'argc=', args.length, 'types=', argTypes || '∅');
                    try {
                        return value.apply(target, args);
                    }
                    catch (error) {
                        console.debug('[glproxy] THREW', label + '.' + prop, errorMessage(error));
                        throw error;
                    }
                };
            }
            // Non-function property — log once per name then go silent.
            glProxyLog('get ' + label + '.' + prop, '=', typeof value);
            return value;
        },
    });
}
let diagnostics = {
    available: false,
    contextId: null,
    status: 'not requested',
    lastError: null,
};
// Separate caches for WebGL 1 vs WebGL 2. The shim used to keep a single
// `cachedContext` keyed implicitly by "whichever kind asked first", which
// silently returned the WebGL 1 context to a `getContext('webgl2')` caller
// once a WebGL 1 context was already in hand. With WebGL 2 now wired
// through nx.js (separate JS class wrapping the SAME native EGL context),
// the caller needs to receive a v2 instance — Three.js detects WebGL 2 via
// `gl.constructor.name === 'WebGL2RenderingContext'`, so handing back a v1
// instance silently downgrades the renderer.
let cachedContext1 = null;
let cachedContext2 = null;
function normalizeKind(contextId) {
    return contextId === 'webgl2' ? 'webgl2' : 'webgl';
}
function defineValue(target, name, value) {
    Object.defineProperty(target, name, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function publishDiagnostics() {
    const global = globalThis;
    const current = typeof global[globalKey] === 'object' && global[globalKey] !== null
        ? global[globalKey]
        : {};
    current.webgl = { ...diagnostics };
    defineValue(global, globalKey, current);
}
function setDiagnostics(next) {
    diagnostics = { ...diagnostics, ...next };
    publishDiagnostics();
}
function requestFutureSwitchWebGLContext(request) {
    const switchGlobal = Switch;
    const webgl = switchGlobal.WebGL;
    if (typeof webgl?.createContext === 'function') {
        return webgl.createContext(request.canvas, request.contextId, request.attributes[0]);
    }
    const createWebGLContext = switchGlobal.createWebGLContext;
    if (typeof createWebGLContext === 'function') {
        return createWebGLContext(request.canvas, request.contextId, request.attributes[0]);
    }
    return null;
}
function exposeWebGLConstructors(context) {
    if (typeof context !== 'object' || context === null) {
        return;
    }
    const constructor = context.constructor;
    if (typeof constructor !== 'function') {
        return;
    }
    const name = constructor.name;
    // Expose both class globals when first seen — Three.js's WebGL 2
    // detection at `three.module.js:15764` is
    // `typeof WebGL2RenderingContext !== 'undefined' && ...`, so the global
    // must exist for the v1-vs-v2 capability split to work even when only
    // a v1 context has been acquired.
    if (name === 'WebGL2RenderingContext' &&
        !('WebGL2RenderingContext' in globalThis)) {
        defineValue(globalThis, 'WebGL2RenderingContext', constructor);
    }
    if (!('WebGLRenderingContext' in globalThis)) {
        // For a v1 context, this is the v1 class; for a v2 context, the
        // prototype chain is wired so the parent constructor is the v1
        // class (see [[quickjs-derived-ctor-returns-null]] for the
        // architectural reason it's wired manually).
        const parent = name === 'WebGL2RenderingContext'
            ? Object.getPrototypeOf(constructor)
            : constructor;
        if (typeof parent === 'function') {
            defineValue(globalThis, 'WebGLRenderingContext', parent);
        }
    }
}
export function isWebGLContextId(contextId) {
    return WEBGL_CONTEXT_IDS.has(contextId);
}
export function getWebGLContext(request) {
    const kind = normalizeKind(request.contextId);
    const cached = kind === 'webgl2' ? cachedContext2 : cachedContext1;
    if (cached) {
        return cached;
    }
    try {
        const nativeContext = request.nativeGetContext(request.contextId, ...request.attributes);
        if (nativeContext) {
            // Expose constructors BEFORE wrapping — Proxy preserves
            // constructor identity but reading it goes through our get trap.
            // Better to register the raw constructor on globalThis to avoid
            // any future surprises.
            exposeWebGLConstructors(nativeContext);
            const finalContext = isGlProxyEnabled()
                ? wrapGlContextWithProxy(nativeContext, kind)
                : nativeContext;
            if (isGlProxyEnabled()) {
                console.debug('[glproxy] wrapped', kind, 'context (debug flag set)');
            }
            if (kind === 'webgl2')
                cachedContext2 = finalContext;
            else
                cachedContext1 = finalContext;
            setDiagnostics({
                available: true,
                contextId: request.contextId,
                status: 'native screen.getContext webgl context available',
                lastError: null,
            });
            return finalContext;
        }
    }
    catch (error) {
        setDiagnostics({
            available: false,
            contextId: request.contextId,
            status: 'native screen.getContext webgl probe failed',
            lastError: errorMessage(error),
        });
    }
    try {
        const futureContext = requestFutureSwitchWebGLContext(request);
        if (futureContext) {
            exposeWebGLConstructors(futureContext);
            const finalContext = isGlProxyEnabled()
                ? wrapGlContextWithProxy(futureContext, kind)
                : futureContext;
            if (isGlProxyEnabled()) {
                console.debug('[glproxy] wrapped', kind, 'context (debug flag set, future path)');
            }
            if (kind === 'webgl2')
                cachedContext2 = finalContext;
            else
                cachedContext1 = finalContext;
            setDiagnostics({
                available: true,
                contextId: request.contextId,
                status: 'native Switch WebGL context available',
                lastError: null,
            });
            return finalContext;
        }
    }
    catch (error) {
        setDiagnostics({
            available: false,
            contextId: request.contextId,
            status: 'native Switch WebGL context probe failed',
            lastError: errorMessage(error),
        });
        return null;
    }
    setDiagnostics({
        available: false,
        contextId: request.contextId,
        status: 'native WebGL context is not exposed by this nx.js runtime',
        lastError: null,
    });
    return null;
}
export function resetWebGLContext() {
    for (const ctx of [cachedContext1, cachedContext2]) {
        const context = ctx;
        try {
            if (typeof context?.destroy === 'function') {
                context.destroy();
            }
            else if (typeof context?.loseContext === 'function') {
                context.loseContext();
            }
        }
        catch {
            // Native context shutdown is best-effort while the WebGL binding is experimental.
        }
    }
    cachedContext1 = null;
    cachedContext2 = null;
    setDiagnostics({
        available: false,
        contextId: null,
        status: 'not requested',
        lastError: null,
    });
}
publishDiagnostics();
//# sourceMappingURL=webgl-shim.js.map