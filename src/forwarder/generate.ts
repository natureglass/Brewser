/**
 * src/forwarder/generate.ts — on-device forwarder NRO generation (lazy-loaded by
 * the seam). Decodes the embedded generic stub, builds a NACP + 256×256 JPEG icon
 * + a RomFS (forwarder.json [+ bundle/... for the embed variant]), splices them
 * with the platform-agnostic pack library, and streams the result to SD.
 *
 * Memory stays flat regardless of app size: the RomFS bundle leaves are
 * `Switch.file()` (FsFile) objects, which the pack library keeps lazy and the
 * final NRO Blob streams from SD at write time (PLAN.md §0.1). Only the small
 * tables + icon + NACP are ever materialized.
 */
import { pack } from '@switch-web/runtime';
import type { ForwarderProbe, ForwarderResult, ForwarderUi } from './seam.js';

const APP_ROOT = 'sdmc:/switch/brewser/'; // BREWSER_APP_ROOT (browser-config.ts)
const SWITCH_DIR = 'sdmc:/switch/';
const BREWSER_NRO = 'sdmc:/switch/brewser.nro'; // loose in /switch/, not under APP_ROOT
const STUB_ROMFS = 'romfs:/forwarder-stub.nro';
const INV_DIR = APP_ROOT + 'configs/app-inventory/';
const FREE_MARGIN = 32 * 1024 * 1024; // 32 MiB headroom over the output size

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// small fs helpers
// ---------------------------------------------------------------------------

function fileExists(path: string): boolean {
	return !!Switch.statSync(path);
}

function fileSize(path: string): number {
	const st = Switch.statSync(path);
	return st ? st.size : 0;
}

// readFileSync returns null for a missing file; callers here are all guarded by
// fileExists + try/catch, so surface the absence as a throw.
function readBytes(path: string): ArrayBuffer {
	const ab = Switch.readFileSync(path);
	if (!ab) throw new Error(`File not found: ${path}`);
	return ab;
}

function readManifest(appId: string): Record<string, unknown> | null {
	try {
		const p = `${APP_ROOT}apps/${appId}/manifest.json`;
		if (!fileExists(p)) return null;
		return JSON.parse(decoder.decode(readBytes(p)));
	} catch {
		return null;
	}
}

function mib(n: number): string {
	return `${(n / 1048576).toFixed(1)} MiB`;
}

function clampBytes(s: string, maxBytes: number): string {
	if (encoder.encode(s).length <= maxBytes) return s;
	let out = s;
	while (out.length > 0 && encoder.encode(out).length > maxBytes) {
		out = out.slice(0, -1);
	}
	return out;
}

// FAT-safe, collision-free filename stem from the appId (never the title — two
// apps with the same sanitized title would overwrite each other; correction 2).
function sanitizeAppId(appId: string): string {
	const s = appId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
	return s || 'app';
}

// FAT-safe filename stem from the app's display NAME (spaces allowed) — what the
// user sees in hbmenu / on the SD card.
function sanitizeName(name: string): string {
	return name
		.replace(/[^A-Za-z0-9 ._-]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100);
}

// D5: deterministic per-app NACP title id. High byte 0x05 is outside Nintendo's
// application-id space (0x01…), so it can never collide with a retail title;
// stable across regenerations (pure function of appId). See FORWARDER_CONTRACT.md.
function deriveTitleId(appId: string): bigint {
	let h = 0xcbf29ce484222325n; // FNV-1a 64
	for (const b of encoder.encode('brewser-forwarder:' + appId)) {
		h ^= BigInt(b);
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return 0x0500000000000000n | (h & 0x0000fffffffff000n);
}

// ---------------------------------------------------------------------------
// allowlist resolution (D1)
// ---------------------------------------------------------------------------

// The offline-authoritative bundle allowlist for `appId`: the persisted install
// inventory. If it is absent (an app installed before this feature shipped) and
// the network is reachable, fetch artifacts/<id>.json once, persist the sidecar,
// and use it (D1 online enhancement — fully best-effort). Returns null when no
// authoritative list can be obtained (→ embed is refused, never a dir-walk).
async function resolveAllowlist(appId: string): Promise<string[] | null> {
	try {
		const invPath = `${INV_DIR}${appId}.json`;
		if (fileExists(invPath)) {
			const inv = JSON.parse(decoder.decode(readBytes(invPath)));
			if (inv && Array.isArray(inv.files)) {
				const files = inv.files.filter((f: unknown) => typeof f === 'string');
				if (files.length) return files as string[];
			}
		}
	} catch {
		/* fall through to the online attempt */
	}
	try {
		return await fetchAndPersistInventory(appId);
	} catch {
		return null;
	}
}

async function fetchAndPersistInventory(appId: string): Promise<string[] | null> {
	const client = (globalThis as Record<string, any>).__brewserPlatformClient;
	if (!client || typeof client.readCachedCatalogue !== 'function') return null;
	const cached = client.readCachedCatalogue();
	if (!cached || cached.kind !== 'Ok' || !cached.catalogue) return null;
	const apps = cached.catalogue.apps;
	if (!Array.isArray(apps)) return null;
	const app = apps.find((a: { id?: string }) => a && a.id === appId);
	if (!app || !app.artifactsUrl) return null;
	const resp = await fetch(app.artifactsUrl);
	if (!resp.ok) return null;
	const parsed = client.parseArtifacts(await resp.text());
	if (!parsed || parsed.kind !== 'Ok' || !parsed.artifacts) return null;
	const files = parsed.artifacts.files;
	if (!Array.isArray(files) || !files.length) return null;
	try {
		Switch.writeFileSync(
			`${INV_DIR}${appId}.json`,
			JSON.stringify({
				id: appId,
				entry: app.entryRel || 'index.html',
				version: app.version || '',
				files,
			}),
		);
	} catch {
		/* best-effort persist */
	}
	return files as string[];
}

// ---------------------------------------------------------------------------
// asset builders
// ---------------------------------------------------------------------------

// 256×256 JPEG icon from the app's cached logo. On any failure (SVG / missing /
// undecodable logo) falls back to Brewser's own icon read lazily from brewser.nro
// — never blocks generation (D6).
async function buildIcon(appId: string, logoRel: string): Promise<Blob> {
	try {
		if (logoRel && !/\.svgz?$/i.test(logoRel)) {
			const logoPath = `${APP_ROOT}apps/${appId}/${logoRel}`;
			if (fileExists(logoPath)) {
				const bmp = await createImageBitmap(
					new Blob([readBytes(logoPath)]),
				);
				const canvas = new OffscreenCanvas(256, 256);
				const ctx = canvas.getContext('2d');
				if (ctx) {
					// Cover: preserve aspect ratio, fill the 256×256 square, crop the
					// overflow (a 2:1 banner keeps its centre). No stretching.
					const scale = Math.max(256 / bmp.width, 256 / bmp.height);
					const dw = bmp.width * scale;
					const dh = bmp.height * scale;
					ctx.drawImage(bmp, (256 - dw) / 2, (256 - dh) / 2, dw, dh);
					return await canvas.convertToBlob({
						type: 'image/jpeg',
						quality: 0.9,
					});
				}
			}
		}
	} catch {
		/* fall through to the default (D6) */
	}
	// D6: Brewser's own icon (lazy FsFile slice of brewser.nro — no 69 MB read).
	try {
		const brewser = await pack.NRO.decode(Switch.file(BREWSER_NRO));
		if (brewser.icon) return brewser.icon;
	} catch {
		/* fall through to a generated placeholder */
	}
	const canvas = new OffscreenCanvas(256, 256);
	const ctx = canvas.getContext('2d');
	if (ctx) {
		ctx.fillStyle = '#2b6cb0';
		ctx.fillRect(0, 0, 256, 256);
	}
	return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

function placeLeaf(root: pack.RomFsEntry, rel: string, leaf: Blob): void {
	const parts = rel.split('/').filter(Boolean);
	let cur = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const seg = parts[i];
		let next = cur[seg];
		if (!next || next instanceof Blob) {
			next = Object.create(null);
			cur[seg] = next;
		}
		cur = next as pack.RomFsEntry;
	}
	cur[parts[parts.length - 1]] = leaf;
}

function buildForwarderJson(
	appId: string,
	title: string,
	entry: string,
	embedFiles: string[] | null,
): string {
	const obj: Record<string, unknown> = { contract: 1, appId };
	if (title) obj.title = title;
	if (embedFiles) {
		obj.entry = entry;
		// D2: sizes come from statSync of the actual installed bytes at gen time.
		obj.files = embedFiles.map((path) => ({
			path,
			size: fileSize(`${APP_ROOT}apps/${appId}/${path}`),
		}));
	}
	return JSON.stringify(obj);
}

// The RomFS `bundle/` sub-tree from the resolved allowlist. Snapshot == the
// allowlist, ALWAYS: this never enumerates the app directory, so app-written
// files (saves/caches) on disk are excluded by construction (deliverable 3).
// Exported + `leafFor`-injected so the exclusion test drives the real mapping
// without the Switch filesystem. Production passes `Switch.file` (lazy leaves).
export function bundleTreeFromAllowlist(
	files: string[],
	leafFor: (rel: string) => Blob,
): pack.RomFsEntry {
	const bundle: pack.RomFsEntry = Object.create(null);
	for (const rel of files) placeLeaf(bundle, rel, leafFor(rel));
	return bundle;
}

function buildRomfsTree(
	appId: string,
	forwarderJson: string,
	embedFiles: string[] | null,
): pack.RomFsEntry {
	const tree: pack.RomFsEntry = Object.create(null);
	tree['forwarder.json'] = new Blob([encoder.encode(forwarderJson)]);
	if (embedFiles) {
		// FsFile leaves → kept lazy by the pack lib, streamed from SD at write.
		tree['bundle'] = bundleTreeFromAllowlist(embedFiles, (rel) =>
			Switch.file(`${APP_ROOT}apps/${appId}/${rel}`),
		);
	}
	return tree;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export async function probeForwarder(appId: string): Promise<ForwarderProbe> {
	const manifest = readManifest(appId);
	const entry = manifest ? String(manifest.entry || 'index.html') : 'index.html';
	const installed =
		!!manifest && fileExists(`${APP_ROOT}apps/${appId}/${entry}`);
	const title = manifest ? String(manifest.name || appId) : appId;
	if (!installed) {
		return {
			installed: false,
			title,
			canEmbed: false,
			embedSizeBytes: 0,
			reason: 'not-installed',
		};
	}
	const files = await resolveAllowlist(appId);
	if (!files) {
		return {
			installed: true,
			title,
			canEmbed: false,
			embedSizeBytes: 0,
			reason: 'no-inventory',
		};
	}
	let total = 0;
	for (const rel of files) total += fileSize(`${APP_ROOT}apps/${appId}/${rel}`);
	return { installed: true, title, canEmbed: true, embedSizeBytes: total };
}

export async function createForwarder(
	opts: { appId: string; embed: boolean },
	ui: ForwarderUi,
): Promise<ForwarderResult> {
	const { appId, embed } = opts;
	let tmpPath = '';

	try {
		ui.status('Preparing…');
		ui.progress(-1);

		const manifest = readManifest(appId);
		if (!manifest) {
			return { outcome: 'error', reason: 'NOT_INSTALLED', message: 'App is not installed.' };
		}
		const title = String(manifest.name || appId);
		const author = String(manifest.developer || manifest.author || 'Brewser');
		const version = String(manifest.version || '1.0.0');
		const entry = String(manifest.entry || 'index.html');
		const logoRel = String(manifest.logo || '');

		// Output filename from the app NAME (what the user sees in hbmenu / on the
		// SD card), not the package id. Regeneration for the same app overwrites
		// cleanly. (Two distinct apps sharing a name would collide — rare.)
		const stem = sanitizeName(title) || sanitizeAppId(appId);
		tmpPath = `${SWITCH_DIR}${stem}.nro.tmp`;
		const finalPath = `${SWITCH_DIR}${stem}.nro`;

		// Resolve the embed allowlist (correct-by-construction; never a dir-walk).
		let embedFiles: string[] | null = null;
		if (embed) {
			embedFiles = await resolveAllowlist(appId);
			if (!embedFiles) {
				return {
					outcome: 'error',
					reason: 'NO_INVENTORY',
					message: 'Re-download this app in Brewser first to include a copy.',
				};
			}
			for (const rel of embedFiles) {
				if (!fileExists(`${APP_ROOT}apps/${appId}/${rel}`)) {
					return {
						outcome: 'error',
						reason: 'INCOMPLETE',
						message: 'Some app files are missing — re-download the app first.',
					};
				}
			}
		}

		// Stub + NACP.
		ui.status('Building…');
		const stub = await pack.NRO.decode(new Blob([readBytes(STUB_ROMFS)]));
		if (!stub.nacp) {
			return { outcome: 'error', reason: 'BAD_STUB', message: 'Forwarder stub is missing its metadata.' };
		}
		const nacp = new pack.NACP(await stub.nacp.arrayBuffer());
		nacp.title = clampBytes(title, 0x1ff);
		nacp.author = clampBytes(author, 0xff);
		nacp.version = clampBytes(version, 0xf);
		nacp.id = deriveTitleId(appId);

		// Icon.
		ui.status('Building icon…');
		const icon = await buildIcon(appId, logoRel);

		// RomFS + final NRO (lazy composite Blob).
		const forwarderJson = buildForwarderJson(appId, title, entry, embedFiles);
		const romfs = await pack.RomFS.encode(
			buildRomfsTree(appId, forwarderJson, embedFiles),
		);
		const out = await pack.NRO.encode({
			data: stub.data,
			icon,
			nacp: new Blob([new Uint8Array(nacp.buffer)]),
			romfs,
		});
		const outSize = out.size;

		// Preflight SD space against the computed output size + margin (corr. 4).
		let free = 0n;
		try {
			free = Switch.FileSystem.openSdmc().freeSpace();
		} catch {
			/* if we can't measure, don't block; the write will fail loudly */
		}
		if (free > 0n && free < BigInt(outSize + FREE_MARGIN)) {
			return { outcome: 'error', reason: 'NO_SPACE', message: 'Not enough space on the SD card.' };
		}

		// Fresh temp.
		try {
			Switch.removeSync(tmpPath);
		} catch {
			/* no prior temp */
		}

		// Stream the NRO to the temp file (app bytes stream from SD, never buffered).
		ui.status('Writing…');
		const reader = out.stream().getReader();
		const writer = Switch.file(tmpPath).writable.getWriter();
		let written = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await writer.write(value);
				written += value.byteLength;
				ui.progress(outSize ? written / outSize : -1, `${mib(written)} / ${mib(outSize)}`);
			}
			await writer.close();
		} catch (e) {
			try {
				await writer.abort();
			} catch {
				/* ignore */
			}
			throw e;
		}

		// Verify: exact-size equality (catches short writes / size drift — corr. 1)
		// + NRO0 magic re-read of the written file.
		ui.status('Verifying…');
		const st = Switch.statSync(tmpPath);
		if (!st || st.size !== outSize) {
			try {
				Switch.removeSync(tmpPath);
			} catch {
				/* ignore */
			}
			return { outcome: 'error', reason: 'WRITE_MISMATCH', message: 'Write verification failed.' };
		}
		const magic = decoder.decode(
			await Switch.file(tmpPath).slice(0x10, 0x14).arrayBuffer(),
		);
		if (magic !== 'NRO0') {
			try {
				Switch.removeSync(tmpPath);
			} catch {
				/* ignore */
			}
			return { outcome: 'error', reason: 'BAD_OUTPUT', message: 'Generated file is not a valid NRO.' };
		}

		// Reveal atomically: remove-then-rename (I4-P-proven idiom).
		try {
			Switch.removeSync(finalPath);
		} catch {
			/* no prior forwarder */
		}
		Switch.renameSync(tmpPath, finalPath);

		ui.status('Done');
		ui.progress(1);
		return { outcome: 'ok', path: finalPath };
	} catch (err) {
		if (tmpPath) {
			try {
				Switch.removeSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
		return {
			outcome: 'error',
			reason: 'ERROR',
			message: String((err as { message?: string })?.message ?? err),
		};
	}
}
