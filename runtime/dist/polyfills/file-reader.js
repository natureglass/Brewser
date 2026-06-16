/**
 * Tier-1 `FileReader` polyfill for brewser.
 *
 * Reads Blob / File / ArrayBufferView sources into a string or
 * ArrayBuffer asynchronously, fires the standard onload / onerror /
 * onloadend events via microtask. Pure JS, no engine deps.
 *
 * Tier-1 scope:
 * - `readAsArrayBuffer(blob)` → ArrayBuffer
 * - `readAsText(blob, encoding?)` → string (encoding defaults to UTF-8)
 * - `readAsDataURL(blob)` → "data:<mime>;base64,..." string
 * - `readAsBinaryString(blob)` → legacy binary-string (each byte = char)
 * - `abort()` — sets state to DONE, fires abort + loadend
 * - Read-once semantics (no concurrent reads on the same instance)
 *
 * Skipped (Tier-2):
 * - Real progress events with realistic chunked timing (single 100% event ok)
 * - `readyState` transitions exactly matching spec timing (we go EMPTY → DONE)
 * - Slicing blobs with non-default ranges (handled by Blob; if global Blob has `slice` we use it)
 */
function schedule(fn) {
    if (typeof queueMicrotask === 'function')
        queueMicrotask(fn);
    else
        Promise.resolve().then(fn);
}
function blobToArrayBuffer(blob) {
    if (blob && typeof blob.arrayBuffer === 'function')
        return blob.arrayBuffer();
    // Fallback if arrayBuffer() isn't on Blob.prototype yet.
    return Promise.reject(new Error('FileReader: Blob.arrayBuffer not supported'));
}
const BASE64_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes) {
    let out = '';
    let i = 0;
    const len = bytes.length;
    for (; i + 2 < len; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        out += BASE64_TABLE[b0 >> 2];
        out += BASE64_TABLE[((b0 & 0x03) << 4) | (b1 >> 4)];
        out += BASE64_TABLE[((b1 & 0x0f) << 2) | (b2 >> 6)];
        out += BASE64_TABLE[b2 & 0x3f];
    }
    if (i < len) {
        const b0 = bytes[i];
        const b1 = i + 1 < len ? bytes[i + 1] : 0;
        out += BASE64_TABLE[b0 >> 2];
        out += BASE64_TABLE[((b0 & 0x03) << 4) | (b1 >> 4)];
        if (i + 1 < len) {
            out += BASE64_TABLE[(b1 & 0x0f) << 2];
            out += '=';
        }
        else {
            out += '==';
        }
    }
    return out;
}
function bytesToBinaryString(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++)
        out += String.fromCharCode(bytes[i]);
    return out;
}
function bytesToText(bytes, encoding = 'utf-8') {
    if (typeof TextDecoder !== 'undefined') {
        try {
            return new TextDecoder(encoding).decode(bytes);
        }
        catch {
            return new TextDecoder().decode(bytes);
        }
    }
    return bytesToBinaryString(bytes);
}
export class FileReader {
    static EMPTY = 0;
    static LOADING = 1;
    static DONE = 2;
    EMPTY = 0;
    LOADING = 1;
    DONE = 2;
    readyState = 0;
    result = null;
    error = null;
    onload = null;
    onerror = null;
    onloadend = null;
    onloadstart = null;
    onprogress = null;
    onabort = null;
    _listeners = new Map();
    _aborted = false;
    addEventListener(type, listener) {
        let arr = this._listeners.get(type);
        if (!arr) {
            arr = [];
            this._listeners.set(type, arr);
        }
        if (arr.indexOf(listener) < 0)
            arr.push(listener);
    }
    removeEventListener(type, listener) {
        const arr = this._listeners.get(type);
        if (!arr)
            return;
        const i = arr.indexOf(listener);
        if (i >= 0)
            arr.splice(i, 1);
    }
    dispatchEvent(ev) {
        const arr = this._listeners.get(ev.type);
        if (arr)
            for (const l of arr.slice()) {
                try {
                    l(ev);
                }
                catch { /* ignore */ }
            }
        const onHandler = this['on' + ev.type];
        if (typeof onHandler === 'function') {
            try {
                onHandler(ev);
            }
            catch { /* ignore */ }
        }
        return true;
    }
    abort() {
        if (this.readyState !== this.LOADING)
            return;
        this._aborted = true;
        this.readyState = this.DONE;
        this.result = null;
        schedule(() => {
            this.dispatchEvent({ type: 'abort', target: this });
            this.dispatchEvent({ type: 'loadend', target: this });
        });
    }
    _begin() {
        if (this.readyState === this.LOADING) {
            throw new Error('FileReader: read already in progress');
        }
        this._aborted = false;
        this.readyState = this.LOADING;
        this.result = null;
        this.error = null;
        schedule(() => { if (!this._aborted)
            this.dispatchEvent({ type: 'loadstart', target: this }); });
        return true;
    }
    _finishWith(result, loaded) {
        if (this._aborted)
            return;
        this.result = result;
        this.readyState = this.DONE;
        schedule(() => {
            if (this._aborted)
                return;
            this.dispatchEvent({ type: 'progress', target: this, loaded, total: loaded });
            this.dispatchEvent({ type: 'load', target: this, loaded, total: loaded });
            this.dispatchEvent({ type: 'loadend', target: this, loaded, total: loaded });
        });
    }
    _failWith(err) {
        if (this._aborted)
            return;
        this.error = err;
        this.readyState = this.DONE;
        schedule(() => {
            if (this._aborted)
                return;
            this.dispatchEvent({ type: 'error', target: this });
            this.dispatchEvent({ type: 'loadend', target: this });
        });
    }
    readAsArrayBuffer(blob) {
        this._begin();
        blobToArrayBuffer(blob).then((ab) => this._finishWith(ab, ab.byteLength), (err) => this._failWith(err instanceof Error ? err : new Error(String(err))));
    }
    readAsText(blob, encoding) {
        this._begin();
        blobToArrayBuffer(blob).then((ab) => {
            const bytes = new Uint8Array(ab);
            this._finishWith(bytesToText(bytes, encoding), bytes.length);
        }, (err) => this._failWith(err instanceof Error ? err : new Error(String(err))));
    }
    readAsDataURL(blob) {
        this._begin();
        blobToArrayBuffer(blob).then((ab) => {
            const bytes = new Uint8Array(ab);
            const mime = (blob && blob.type) || 'application/octet-stream';
            const url = 'data:' + mime + ';base64,' + bytesToBase64(bytes);
            this._finishWith(url, bytes.length);
        }, (err) => this._failWith(err instanceof Error ? err : new Error(String(err))));
    }
    readAsBinaryString(blob) {
        this._begin();
        blobToArrayBuffer(blob).then((ab) => {
            const bytes = new Uint8Array(ab);
            this._finishWith(bytesToBinaryString(bytes), bytes.length);
        }, (err) => this._failWith(err instanceof Error ? err : new Error(String(err))));
    }
}
let installed = false;
export function installFileReader() {
    if (installed)
        return;
    installed = true;
    Object.defineProperty(globalThis, 'FileReader', {
        value: FileReader, writable: true, configurable: true,
    });
}
//# sourceMappingURL=file-reader.js.map