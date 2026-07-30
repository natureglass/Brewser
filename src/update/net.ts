/**
 * src/update/net.ts — manifest fetch, manual redirect walk, streaming download.
 *
 * ADAPTED from the brewser-updater-test rig's net.ts, hardened for production:
 * the dev-mode insecure escape hatch is removed — every hop MUST be https: with
 * an allowlisted host, always.
 *
 * The runtime's fetch supports redirect:'manual' (a 3xx Response is returned
 * as-is), so this walks every hop itself: each hop's URL + status is logged and
 * each hop must be https: + allowlisted. abort does NOT reliably interrupt a
 * stuck connect (HW finding), so every blocking await (connect, each body read,
 * the manifest fetch) is raced against an INDEPENDENT timer via `withDeadline`:
 * when the timer wins the race rejects on its own even if the underlying read
 * never settles. AbortController is still wired (caller-cancel + best-effort
 * socket release) but is never the sole timeout.
 */
import {
	CONNECT_TIMEOUT_MS,
	DOWNLOAD_STALL_MS,
	HOST_ALLOWLIST,
	IDENTITY_HEADERS,
	MANIFEST_TIMEOUT_MS,
	MAX_REDIRECT_HOPS,
} from './config';
import * as gfs from './guarded-fs';
import { log, status } from './log';

export class NetError extends Error {
	constructor(
		public reason: string,
		message: string,
	) {
		super(message);
		this.name = 'NetError';
	}
}

export interface Hop {
	url: string;
	httpStatus: number;
	location?: string;
	ms?: number;
}

export interface HopCheck {
	ok: boolean;
	reason?: string;
}

/**
 * Race a promise against an INDEPENDENT deadline timer. If the timer wins it
 * rejects with `new NetError(code, reason)` regardless of whether `p` ever
 * settles. The caller abandons/cleans up `p` on rejection.
 */
function withDeadline<T>(p: Promise<T>, ms: number, code: string, reason: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new NetError(code, reason)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** An AbortController that also fires when `caller` aborts (caller-cancel). */
function linkedController(caller?: AbortSignal): AbortController {
	const ac = new AbortController();
	if (caller) {
		if (caller.aborted) ac.abort((caller as any).reason);
		else caller.addEventListener('abort', () => ac.abort((caller as any).reason), { once: true });
	}
	return ac;
}

/** Pure hop policy — always strict: https: + allowlisted host. */
export function checkHopUrl(urlStr: string): HopCheck {
	let u: URL;
	try {
		u = new URL(urlStr);
	} catch {
		return { ok: false, reason: `unparseable URL: ${urlStr}` };
	}
	if (u.protocol !== 'https:') {
		return { ok: false, reason: `non-HTTPS scheme "${u.protocol}" refused` };
	}
	const host = u.hostname.toLowerCase();
	if (!HOST_ALLOWLIST.includes(host)) {
		return { ok: false, reason: `host "${host}" not in allowlist` };
	}
	return { ok: true };
}

export interface WalkResult {
	response: Response;
	finalUrl: string;
	hops: Hop[];
	/** The controller whose signal the winning fetch used — abort it to attempt
	 * best-effort release of the body's socket during streaming. */
	controller: AbortController;
}

/**
 * Fetch with a manual redirect walk. Every hop (including the first URL) is
 * policy-checked BEFORE any request is sent, and each hop's fetch is raced
 * against an INDEPENDENT per-hop connect deadline so a stuck connect is
 * abandonable even when abort cannot cancel it.
 */
export async function walkRedirects(
	startUrl: string,
	opts?: { signal?: AbortSignal; perHopMs?: number; controller?: AbortController },
): Promise<WalkResult> {
	let url = startUrl;
	const hops: Hop[] = [];
	const perHopMs = opts?.perHopMs ?? CONNECT_TIMEOUT_MS;
	const ac = opts?.controller ?? linkedController(opts?.signal);
	for (let i = 0; i <= MAX_REDIRECT_HOPS; i++) {
		const check = checkHopUrl(url);
		if (!check.ok) {
			log('hop-refused', { url, reason: check.reason });
			throw new NetError('HOP_POLICY', `redirect hop refused: ${check.reason}`);
		}
		const host = (() => {
			try {
				return new URL(url).host;
			} catch {
				return '(unparseable)';
			}
		})();
		status(`fetch hop ${i} -> ${host}`);
		log('hop-fetch-start', { i, host, url });
		const t0 = performance.now();
		let res: Response;
		const fetchP = fetch(url, { redirect: 'manual', signal: ac.signal, headers: IDENTITY_HEADERS });
		try {
			res = await withDeadline(fetchP, perHopMs, 'TIMEOUT', `hop ${i} (${host}) connect stalled >${perHopMs}ms`);
		} catch (err) {
			const ms = Math.round(performance.now() - t0);
			fetchP.then((r) => r.body?.cancel()).catch(() => {});
			try {
				ac.abort(err as any);
			} catch {
				/* ignore */
			}
			log('hop-fetch-error', { i, host, ms, err: String(err), abandoned: true });
			throw err instanceof NetError
				? err
				: new NetError('FETCH_FAILED', `hop ${i} (${host}) failed after ${ms}ms: ${err}`);
		}
		const ms = Math.round(performance.now() - t0);
		const isRedirect = res.status >= 300 && res.status < 400;
		const location = res.headers.get('location') ?? undefined;
		hops.push({ url, httpStatus: res.status, location, ms });
		log('hop-fetch-done', { i, host, httpStatus: res.status, ms, redirect: isRedirect });
		if (!isRedirect) {
			return { response: res, finalUrl: url, hops, controller: ac };
		}
		try {
			await res.body?.cancel();
		} catch {
			/* ignore */
		}
		if (!location) {
			throw new NetError('REDIRECT_NO_LOCATION', `HTTP ${res.status} with no Location header`);
		}
		url = new URL(location, url).href;
	}
	throw new NetError('TOO_MANY_HOPS', `more than ${MAX_REDIRECT_HOPS} redirect hops`);
}

/** Fetch a small text resource (the manifest) through the hop walk. Both the
 * connect (per hop) and the body read are bounded by independent deadlines. */
export async function fetchText(
	url: string,
	opts?: { signal?: AbortSignal },
): Promise<{ text: string; hops: Hop[] }> {
	const { response, hops, controller } = await walkRedirects(url, {
		signal: opts?.signal,
		perHopMs: MANIFEST_TIMEOUT_MS,
	});
	if (!response.ok) {
		try {
			response.body?.cancel();
		} catch {
			/* ignore */
		}
		throw new NetError('HTTP_STATUS', `HTTP ${response.status} for ${url}`);
	}
	log('manifest-body-read-start', {});
	const textP = response.text();
	let text: string;
	try {
		text = await withDeadline(textP, MANIFEST_TIMEOUT_MS, 'TIMEOUT', `manifest body read stalled >${MANIFEST_TIMEOUT_MS}ms`);
	} catch (err) {
		textP.catch(() => {}); // abandon leaked read
		try {
			controller.abort(err as any);
		} catch {
			/* ignore */
		}
		log('manifest-body-stall', { err: String(err) });
		throw err;
	}
	log('manifest-body-read-done', { bytes: text.length });
	return { text, hops };
}

export interface DownloadResult {
	bytes: number;
	ms: number;
	hops: Hop[];
}

/** Raised by the stall watchdog. Carries how far the download got. */
export class StallError extends NetError {
	constructor(
		message: string,
		public bytesReceived: number,
		public sinceLastMs: number,
	) {
		super('DOWNLOAD_STALL', message);
		this.name = 'StallError';
	}
}

/**
 * Stream a payload to disk. NEVER buffers the body: reads the body stream
 * chunk-by-chunk and appends each chunk through the guarded WritableStream.
 *
 * Once the body starts, EACH `reader.read()` is raced against an INDEPENDENT
 * DOWNLOAD_STALL_MS timer — so if bytes stop arriving mid-stream (wifi drop) the
 * race rejects on its own even if the read never settles and abort cannot
 * cancel it. A slow-but-progressing transfer is never killed (the timer resets
 * each read). On a stall the leaked read is abandoned (not awaited), the
 * controller is aborted + the reader cancelled best-effort, the writer is
 * closed, and the flow gets control back.
 */
export async function streamDownload(
	url: string,
	destPath: string,
	expectedSize: number,
	onProgress?: (bytes: number, total: number) => void,
	opts?: { signal?: AbortSignal; stallMs?: number },
): Promise<DownloadResult> {
	const t0 = performance.now();
	const stallMs = opts?.stallMs ?? DOWNLOAD_STALL_MS;
	const { response, hops, finalUrl, controller } = await walkRedirects(url, {
		signal: opts?.signal,
		perHopMs: CONNECT_TIMEOUT_MS,
	});
	if (!response.ok) {
		try {
			response.body?.cancel();
		} catch {
			/* ignore */
		}
		throw new NetError('HTTP_STATUS', `HTTP ${response.status} for ${finalUrl}`);
	}
	const len = response.headers.get('content-length');
	log('download-start', { url, finalUrl, contentLength: len, expectedSize, stallMs });
	if (!response.body) {
		throw new NetError('NO_BODY', 'response has no body stream');
	}

	const reader = response.body.getReader();
	const writer = gfs.writableFor(destPath).getWriter();
	let bytes = 0;
	let lastPct = -1;
	try {
		for (;;) {
			const readP = reader.read();
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await withDeadline(
					readP,
					stallMs,
					'DOWNLOAD_STALL',
					`download stalled: no bytes for ${stallMs}ms at ${bytes}/${expectedSize}`,
				);
			} catch (err) {
				readP.catch(() => {}); // abandon the (possibly permanently) pending read
				const sinceLastMs = stallMs;
				log('download-stall', { bytes, expectedSize, sinceLastMs, err: String(err) });
				try {
					controller.abort(err as any);
				} catch {
					/* ignore */
				}
				reader
					.cancel(String(err))
					.then(() => log('download-stall-reader-cancel', { resolved: true }))
					.catch((e) => log('download-stall-reader-cancel', { rejected: String(e) }));
				throw new StallError(String((err as any)?.message ?? err), bytes, sinceLastMs);
			}
			const { done, value } = chunk;
			if (done) break;
			await writer.write(value);
			bytes += value.byteLength;
			const pct = Math.floor((bytes / expectedSize) * 20) * 5;
			if (pct !== lastPct) {
				lastPct = pct;
				log('download-progress', { bytes, expectedSize, pct });
			}
			onProgress?.(bytes, expectedSize);
		}
	} finally {
		try {
			await writer.close();
		} catch (err) {
			log('download-writer-close-error', { err: String(err) });
		}
	}
	const ms = performance.now() - t0;
	log('download-done', { bytes, expectedSize, ms: Math.round(ms) });
	return { bytes, ms, hops };
}
