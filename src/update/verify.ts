/**
 * src/update/verify.ts — manifest signature verification (ECDSA P-256 via
 * native crypto.subtle) and chunked SHA-256 payload verification.
 *
 * ADAPTED from the brewser-updater-test rig's verify.ts, with two production
 * improvements: (1) the trusted keyring is passed in as a PARAMETER rather than
 * imported from a build-time constant, so this module is pure and directly
 * host-testable with no esbuild --define; (2) no internal logging — the caller
 * (flow.ts) logs the verify result. Envelope format is the fresh production
 * "brewser-update/1" (schema 1).
 *
 * crypto.subtle.digest is non-streaming in this runtime, so payload hashing is
 * chunked: one CHUNK_SIZE buffer is resident at a time, each chunk is digested
 * independently, and the manifest's rootHash is SHA-256 over the concatenated
 * raw chunk digests.
 */
import type { JournalManifest } from './journal';

/** Must equal scripts/update/manifest-lib.mjs CHUNK_SIZE. */
export const CHUNK_SIZE = 4 * 1024 * 1024;

/** Production envelope format. FORWARD-COMPAT: ship read-support for
 * "brewser-update/2" in a release BEFORE anything emits it, or a format bump is
 * a one-way channel-brick. */
export const ENVELOPE_FORMAT = 'brewser-update/1';

/** A baked trusted key: fingerprint id + base64 SPKI DER + informational role. */
export interface TrustedKey {
	id: string; // "k_<16 hex>" fingerprint of the SPKI DER
	spki: string; // base64 SPKI DER
	role: string; // 'active' | 'backup' (informational only)
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Pure base64 decode (no atob dependency). */
export function b64decode(s: string): Uint8Array {
	const clean = s.replace(/[\r\n\s]/g, '');
	let body = clean;
	while (body.endsWith('=')) body = body.slice(0, -1);
	const out = new Uint8Array(Math.floor((body.length * 6) / 8));
	let acc = 0;
	let bits = 0;
	let o = 0;
	for (const ch of body) {
		const v = B64_CHARS.indexOf(ch);
		if (v < 0) throw new Error(`invalid base64 character "${ch}"`);
		acc = (acc << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (acc >> bits) & 0xff;
		}
	}
	return out.subarray(0, o);
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
	const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = '';
	for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
	return s;
}

// The runtime's Web Crypto types are narrowly generic and don't include an
// ECDSA import-params overload, but the native crypto verify path DOES support
// ECDSA P-256. `any` bridges that typing gap.
const keyCache = new Map<string, any>();

/** Find a trusted key by its keyId (fingerprint) in `keyring`. null if unknown. */
export function findTrustedKey(keyId: string, keyring: TrustedKey[]): TrustedKey | null {
	for (const k of keyring) if (k.id === keyId) return k;
	return null;
}

/**
 * Import ONE trusted SPKI public key, selected by keyId. There is deliberately
 * no try-both-keys fallback: the manifest names which key signed it and the
 * client verifies against that key only (a fallback would turn a signature
 * failure under a revoked key into a silent success under the other).
 */
export async function importKeyById(keyId: string, keyring: TrustedKey[]): Promise<any> {
	const cached = keyCache.get(keyId);
	if (cached) return cached;
	const trusted = findTrustedKey(keyId, keyring);
	if (!trusted) throw new VerifyError('KEY_UNKNOWN', `no baked key with id ${keyId}`);
	const der = b64decode(trusted.spki);
	const key = await crypto.subtle.importKey(
		'spki',
		der.buffer as ArrayBuffer,
		{ name: 'ECDSA', namedCurve: 'P-256' } as any,
		false,
		['verify'],
	);
	keyCache.set(keyId, key);
	return key;
}

export class VerifyError extends Error {
	constructor(
		public reason: string,
		message: string,
	) {
		super(message);
		this.name = 'VerifyError';
	}
}

/**
 * Envelope format v1:
 *   { format:"brewser-update/1", keyId, payload: b64(manifest JSON bytes),
 *     signature: b64(P1363 r||s over the raw payload bytes) }
 *
 * The `keyId` on the ENVELOPE selects which trusted key to verify against; the
 * signature is verified over the exact payload BYTES with THAT key only, before
 * any manifest field is parsed as trusted; then the SIGNED payload.keyId must
 * equal the envelope keyId (binding the selector to signed content).
 */
export async function verifyManifestEnvelope(
	envelopeText: string,
	keyring: TrustedKey[],
): Promise<JournalManifest> {
	let env: any;
	try {
		env = JSON.parse(envelopeText);
	} catch (err) {
		throw new VerifyError('ENVELOPE_PARSE', `manifest envelope is not JSON: ${err}`);
	}
	if (env?.format !== ENVELOPE_FORMAT) {
		throw new VerifyError('ENVELOPE_FORMAT', `unknown envelope format: ${env?.format}`);
	}
	if (typeof env.keyId !== 'string' || !env.keyId) {
		throw new VerifyError('ENVELOPE_FIELDS', 'envelope missing keyId');
	}
	if (typeof env.payload !== 'string' || typeof env.signature !== 'string') {
		throw new VerifyError('ENVELOPE_FIELDS', 'envelope missing payload/signature');
	}
	const payloadBytes = b64decode(env.payload);
	const sigBytes = b64decode(env.signature);
	if (sigBytes.length !== 64) {
		throw new VerifyError('SIG_FORMAT', `signature must be 64-byte P1363 r||s, got ${sigBytes.length}`);
	}
	const key = await importKeyById(env.keyId, keyring); // throws KEY_UNKNOWN
	const ok = await crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' } as any,
		key,
		sigBytes.buffer as ArrayBuffer,
		payloadBytes.buffer as ArrayBuffer,
	);
	if (!ok) {
		throw new VerifyError('SIG_INVALID', `manifest signature verification FAILED under key ${env.keyId}`);
	}
	// Only now is the payload trusted enough to parse.
	let m: any;
	try {
		m = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch (err) {
		throw new VerifyError('MANIFEST_PARSE', `signed payload is not JSON: ${err}`);
	}
	if (m?.keyId !== env.keyId) {
		throw new VerifyError('KEY_ID_MISMATCH', `payload.keyId ${m?.keyId} != envelope.keyId ${env.keyId}`);
	}
	return validateManifestShape(m);
}

const HEX64 = /^[0-9a-f]{64}$/;
const KEYID_RE = /^k_[0-9a-f]{16}$/;

export function validateManifestShape(m: any): JournalManifest {
	if (m?.schema !== 1) {
		throw new VerifyError('MANIFEST_SHAPE', `manifest.schema must be 1, got ${m?.schema}`);
	}
	if (typeof m.keyId !== 'string' || !KEYID_RE.test(m.keyId)) {
		throw new VerifyError('MANIFEST_SHAPE', 'manifest.keyId is not a k_<16hex> fingerprint');
	}
	if (typeof m.version !== 'string' || !m.version) {
		throw new VerifyError('MANIFEST_SHAPE', 'manifest.version missing');
	}
	if (!Number.isInteger(m.counter) || m.counter <= 0) {
		throw new VerifyError('MANIFEST_SHAPE', 'manifest.counter must be a positive integer');
	}
	if (!Number.isInteger(m.nroSize) || m.nroSize <= 0) {
		throw new VerifyError('MANIFEST_SHAPE', 'manifest.nroSize invalid');
	}
	if (typeof m.url !== 'string' || !m.url) {
		throw new VerifyError('MANIFEST_SHAPE', 'manifest.url missing');
	}
	if (m.chunkSize !== CHUNK_SIZE) {
		throw new VerifyError('MANIFEST_SHAPE', `manifest.chunkSize ${m.chunkSize} != CHUNK_SIZE ${CHUNK_SIZE}`);
	}
	if (!Array.isArray(m.chunks) || m.chunks.length === 0) {
		throw new VerifyError('MANIFEST_SHAPE', 'manifest.chunks missing');
	}
	const expected = Math.ceil(m.nroSize / m.chunkSize);
	if (m.chunks.length !== expected) {
		throw new VerifyError('MANIFEST_SHAPE', `manifest.chunks length ${m.chunks.length} != ceil(size/chunk) ${expected}`);
	}
	for (const c of m.chunks) {
		if (typeof c !== 'string' || !HEX64.test(c)) {
			throw new VerifyError('MANIFEST_SHAPE', 'manifest.chunks entry is not hex SHA-256');
		}
	}
	if (typeof m.rootHash !== 'string' || !HEX64.test(m.rootHash)) {
		throw new VerifyError('MANIFEST_SHAPE', 'manifest.rootHash is not hex SHA-256');
	}
	const components =
		m.components && typeof m.components === 'object' && !Array.isArray(m.components) ? m.components : undefined;
	return {
		schema: 1,
		keyId: m.keyId,
		version: m.version,
		counter: m.counter,
		nroSize: m.nroSize,
		url: m.url,
		chunkSize: m.chunkSize,
		chunks: m.chunks,
		rootHash: m.rootHash,
		components,
	};
}

export interface ChunkedHashResult {
	chunks: string[];
	rootHash: string;
	totalBytes: number;
}

/**
 * Chunked SHA-256 over a file on disk, never holding more than one chunk (plus
 * one stream read buffer) in memory. onProgress(bytes, chunkIndex).
 */
export async function chunkedHashFile(
	path: string,
	chunkSize: number = CHUNK_SIZE,
	onProgress?: (bytes: number, chunkIndex: number) => void,
): Promise<ChunkedHashResult> {
	const f = Switch.file(path);
	const reader = f.stream().getReader();
	const chunkBuf = new Uint8Array(chunkSize);
	let fill = 0;
	let total = 0;
	const digests: Uint8Array[] = [];
	const hexes: string[] = [];

	async function flushChunk(len: number) {
		const d = await crypto.subtle.digest('SHA-256', chunkBuf.subarray(0, len));
		const u8 = new Uint8Array(d);
		digests.push(u8);
		hexes.push(toHex(u8));
	}

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		let src = value as Uint8Array;
		total += src.length;
		while (src.length > 0) {
			const space = chunkSize - fill;
			const take = Math.min(space, src.length);
			chunkBuf.set(src.subarray(0, take), fill);
			fill += take;
			src = src.subarray(take);
			if (fill === chunkSize) {
				await flushChunk(fill);
				fill = 0;
				onProgress?.(total, hexes.length);
			}
		}
	}
	if (fill > 0) {
		await flushChunk(fill);
		fill = 0;
		onProgress?.(total, hexes.length);
	}

	const cat = new Uint8Array(digests.length * 32);
	for (let i = 0; i < digests.length; i++) cat.set(digests[i], i * 32);
	const root = toHex(await crypto.subtle.digest('SHA-256', cat.buffer as ArrayBuffer));
	return { chunks: hexes, rootHash: root, totalBytes: total };
}

/** Compare actual chunk hashes vs expected; returns first mismatch or -1. */
export function firstChunkMismatch(actual: string[], expected: string[]): number {
	const n = Math.max(actual.length, expected.length);
	for (let i = 0; i < n; i++) if (actual[i] !== expected[i]) return i;
	return -1;
}

export interface NroCheckResult {
	ok: boolean;
	magic: string;
	fileSize: number;
	hdrSize: number;
}

/** Assert `NRO0` magic at offset 0x10 and report the header size field at 0x18. */
export async function nroMagicCheck(path: string, expectedSize?: number): Promise<NroCheckResult> {
	const stat = Switch.statSync(path);
	const fileSize = stat ? stat.size : -1;
	const head = new Uint8Array(await Switch.file(path).slice(0, 0x20).arrayBuffer());
	if (head.length < 0x20) {
		return { ok: false, magic: '(short read)', fileSize, hdrSize: -1 };
	}
	const magic = String.fromCharCode(head[0x10], head[0x11], head[0x12], head[0x13]);
	const hdrSize = head[0x18] | (head[0x19] << 8) | (head[0x1a] << 16) | (head[0x1b] << 24);
	const ok = magic === 'NRO0' && (expectedSize === undefined || fileSize === expectedSize);
	return { ok, magic, fileSize, hdrSize };
}
