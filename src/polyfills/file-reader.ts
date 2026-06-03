/**
 * Tier-1 `FileReader` polyfill for switch-web-browser.
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

declare const Blob: {
	new (parts?: unknown[], options?: { type?: string }): Blob;
	prototype: Blob;
};
interface Blob {
	readonly size: number;
	readonly type: string;
	arrayBuffer?(): Promise<ArrayBuffer>;
	text?(): Promise<string>;
	slice?(start?: number, end?: number, contentType?: string): Blob;
}

type ReaderResult = string | ArrayBuffer | null;
type ReaderEvent = { type: string; target: FileReader; loaded?: number; total?: number };
type ReaderListener = (ev: ReaderEvent) => void;

function schedule(fn: () => void): void {
	if (typeof queueMicrotask === 'function') queueMicrotask(fn);
	else Promise.resolve().then(fn);
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
	if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
	// Fallback if arrayBuffer() isn't on Blob.prototype yet.
	return Promise.reject(new Error('FileReader: Blob.arrayBuffer not supported'));
}

const BASE64_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
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
		} else {
			out += '==';
		}
	}
	return out;
}

function bytesToBinaryString(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
	return out;
}

function bytesToText(bytes: Uint8Array, encoding = 'utf-8'): string {
	if (typeof TextDecoder !== 'undefined') {
		try { return new TextDecoder(encoding).decode(bytes); }
		catch { return new TextDecoder().decode(bytes); }
	}
	return bytesToBinaryString(bytes);
}

export class FileReader {
	static readonly EMPTY = 0;
	static readonly LOADING = 1;
	static readonly DONE = 2;

	readonly EMPTY = 0;
	readonly LOADING = 1;
	readonly DONE = 2;

	readyState: 0 | 1 | 2 = 0;
	result: ReaderResult = null;
	error: Error | null = null;

	onload: ReaderListener | null = null;
	onerror: ReaderListener | null = null;
	onloadend: ReaderListener | null = null;
	onloadstart: ReaderListener | null = null;
	onprogress: ReaderListener | null = null;
	onabort: ReaderListener | null = null;

	private _listeners = new Map<string, ReaderListener[]>();
	private _aborted = false;

	addEventListener(type: string, listener: ReaderListener): void {
		let arr = this._listeners.get(type);
		if (!arr) { arr = []; this._listeners.set(type, arr); }
		if (arr.indexOf(listener) < 0) arr.push(listener);
	}
	removeEventListener(type: string, listener: ReaderListener): void {
		const arr = this._listeners.get(type);
		if (!arr) return;
		const i = arr.indexOf(listener);
		if (i >= 0) arr.splice(i, 1);
	}
	dispatchEvent(ev: ReaderEvent): boolean {
		const arr = this._listeners.get(ev.type);
		if (arr) for (const l of arr.slice()) { try { l(ev); } catch { /* ignore */ } }
		const onHandler = (this as unknown as Record<string, ReaderListener | null>)['on' + ev.type];
		if (typeof onHandler === 'function') { try { onHandler(ev); } catch { /* ignore */ } }
		return true;
	}

	abort(): void {
		if (this.readyState !== this.LOADING) return;
		this._aborted = true;
		this.readyState = this.DONE;
		this.result = null;
		schedule(() => {
			this.dispatchEvent({ type: 'abort', target: this });
			this.dispatchEvent({ type: 'loadend', target: this });
		});
	}

	private _begin(): boolean {
		if (this.readyState === this.LOADING) {
			throw new Error('FileReader: read already in progress');
		}
		this._aborted = false;
		this.readyState = this.LOADING;
		this.result = null;
		this.error = null;
		schedule(() => { if (!this._aborted) this.dispatchEvent({ type: 'loadstart', target: this }); });
		return true;
	}

	private _finishWith(result: ReaderResult, loaded: number): void {
		if (this._aborted) return;
		this.result = result;
		this.readyState = this.DONE;
		schedule(() => {
			if (this._aborted) return;
			this.dispatchEvent({ type: 'progress', target: this, loaded, total: loaded });
			this.dispatchEvent({ type: 'load', target: this, loaded, total: loaded });
			this.dispatchEvent({ type: 'loadend', target: this, loaded, total: loaded });
		});
	}

	private _failWith(err: Error): void {
		if (this._aborted) return;
		this.error = err;
		this.readyState = this.DONE;
		schedule(() => {
			if (this._aborted) return;
			this.dispatchEvent({ type: 'error', target: this });
			this.dispatchEvent({ type: 'loadend', target: this });
		});
	}

	readAsArrayBuffer(blob: Blob): void {
		this._begin();
		blobToArrayBuffer(blob).then(
			(ab) => this._finishWith(ab, ab.byteLength),
			(err) => this._failWith(err instanceof Error ? err : new Error(String(err))),
		);
	}

	readAsText(blob: Blob, encoding?: string): void {
		this._begin();
		blobToArrayBuffer(blob).then(
			(ab) => {
				const bytes = new Uint8Array(ab);
				this._finishWith(bytesToText(bytes, encoding), bytes.length);
			},
			(err) => this._failWith(err instanceof Error ? err : new Error(String(err))),
		);
	}

	readAsDataURL(blob: Blob): void {
		this._begin();
		blobToArrayBuffer(blob).then(
			(ab) => {
				const bytes = new Uint8Array(ab);
				const mime = (blob && blob.type) || 'application/octet-stream';
				const url = 'data:' + mime + ';base64,' + bytesToBase64(bytes);
				this._finishWith(url, bytes.length);
			},
			(err) => this._failWith(err instanceof Error ? err : new Error(String(err))),
		);
	}

	readAsBinaryString(blob: Blob): void {
		this._begin();
		blobToArrayBuffer(blob).then(
			(ab) => {
				const bytes = new Uint8Array(ab);
				this._finishWith(bytesToBinaryString(bytes), bytes.length);
			},
			(err) => this._failWith(err instanceof Error ? err : new Error(String(err))),
		);
	}
}

let installed = false;

export function installFileReader(): void {
	if (installed) return;
	installed = true;
	Object.defineProperty(globalThis, 'FileReader', {
		value: FileReader, writable: true, configurable: true,
	});
}
