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
declare const Blob: {
    new (parts?: unknown[], options?: {
        type?: string;
    }): Blob;
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
type ReaderEvent = {
    type: string;
    target: FileReader;
    loaded?: number;
    total?: number;
};
type ReaderListener = (ev: ReaderEvent) => void;
export declare class FileReader {
    static readonly EMPTY = 0;
    static readonly LOADING = 1;
    static readonly DONE = 2;
    readonly EMPTY = 0;
    readonly LOADING = 1;
    readonly DONE = 2;
    readyState: 0 | 1 | 2;
    result: ReaderResult;
    error: Error | null;
    onload: ReaderListener | null;
    onerror: ReaderListener | null;
    onloadend: ReaderListener | null;
    onloadstart: ReaderListener | null;
    onprogress: ReaderListener | null;
    onabort: ReaderListener | null;
    private _listeners;
    private _aborted;
    addEventListener(type: string, listener: ReaderListener): void;
    removeEventListener(type: string, listener: ReaderListener): void;
    dispatchEvent(ev: ReaderEvent): boolean;
    abort(): void;
    private _begin;
    private _finishWith;
    private _failWith;
    readAsArrayBuffer(blob: Blob): void;
    readAsText(blob: Blob, encoding?: string): void;
    readAsDataURL(blob: Blob): void;
    readAsBinaryString(blob: Blob): void;
}
export declare function installFileReader(): void;
export {};
//# sourceMappingURL=file-reader.d.ts.map