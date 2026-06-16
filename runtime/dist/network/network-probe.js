// HTTPS first, plain HTTP next (isolates TLS from socket layer), then a
// `romfs:` read that bypasses sockets entirely and goes through `fetchFile`.
// If the romfs probe also fails the problem is not the socket layer.
//
// Targets are hostnames, not raw IPs: nxjs uses mbedtls's hostname-string
// match for cert verification, which doesn't accept iPAddress-typed SANs
// — so an IP target like https://1.1.1.1/ guarantee-fails verification
// even when the CA bundle is fine and the server cert lists the IP. The
// indicator's job is "does the *real-world* HTTPS path work", so probe
// the real-world path.
const PROBE_URLS = [
    'https://one.one.one.one/',
    'http://example.com/',
    'romfs:/main.js',
];
const TIMEOUT_MS = 5000;
/**
 * Boot-time probe to surface whether the runtime fetch can actually reach
 * the internet on this device. Bypasses `BrowserPermissionPolicy` because
 * it runs before any app session is started; the result is purely
 * diagnostic and never executed as a page bundle.
 *
 * Probes HTTPS first, then plain HTTP, so we can isolate TLS-specific
 * failures from general "no network" failures.
 */
export async function probeNetwork() {
    const attempts = [];
    for (const url of PROBE_URLS) {
        const attempt = await probeOnce(url);
        attempts.push(attempt);
        if (attempt.reachable)
            break;
    }
    return {
        overallReachable: attempts.some((a) => a.reachable),
        attempts,
    };
}
async function probeOnce(url) {
    const start = performance.now();
    const timeoutMarker = Symbol('timeout');
    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(timeoutMarker), TIMEOUT_MS);
    });
    try {
        const raced = await Promise.race([fetch(url), timeoutPromise]);
        if (raced === timeoutMarker) {
            return {
                url,
                reachable: false,
                httpStatus: null,
                bytes: null,
                message: `Timeout after ${TIMEOUT_MS}ms`,
                latencyMs: TIMEOUT_MS,
            };
        }
        const response = raced;
        let bytes = null;
        try {
            bytes = (await response.text()).length;
        }
        catch (_) {
            // Body read failed but the status line is still informative.
        }
        return {
            url,
            reachable: response.ok,
            httpStatus: response.status,
            bytes,
            message: `HTTP ${response.status} ${response.statusText || ''}`.trim(),
            latencyMs: Math.round(performance.now() - start),
        };
    }
    catch (error) {
        return {
            url,
            reachable: false,
            httpStatus: null,
            bytes: null,
            ...describeError(error),
            latencyMs: Math.round(performance.now() - start),
        };
    }
    finally {
        if (timeoutId !== undefined)
            clearTimeout(timeoutId);
    }
}
function describeError(error) {
    const errorType = error === null
        ? 'null'
        : error === undefined
            ? 'undefined'
            : typeof error;
    if (error instanceof Error) {
        let errorJson;
        try {
            const own = {};
            for (const key of Object.getOwnPropertyNames(error)) {
                if (key === 'stack')
                    continue;
                own[key] = error[key];
            }
            const text = JSON.stringify(own);
            if (text && text !== '{}')
                errorJson = text;
        }
        catch (_) {
            // JSON.stringify can throw on cyclic graphs; just omit.
        }
        const message = error.message || error.name || error.toString() || 'Error (empty)';
        return {
            message,
            errorName: error.name || 'Error',
            errorType,
            errorStack: error.stack,
            errorJson,
        };
    }
    let message;
    try {
        message = String(error);
    }
    catch (_) {
        message = '(unprintable error value)';
    }
    if (!message)
        message = `(${errorType} thrown with no message)`;
    return {
        message,
        errorName: '(non-Error throw)',
        errorType,
    };
}
//# sourceMappingURL=network-probe.js.map