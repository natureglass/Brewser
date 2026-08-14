// Bundles the platform-agnostic pack library (brewser-runtime/src/pack) to an
// ESM module and imports it, so the Node round-trip tests can exercise the exact
// vendored NRO/RomFS/NACP code the on-device generator uses. Node 18+ provides
// global Blob/TextEncoder/TextDecoder/DataView, which is all the pack lib needs.
import esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function loadPack() {
	const entry = fileURLToPath(
		new URL('../../../brewser-runtime/src/pack/index.ts', import.meta.url),
	);
	const result = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2022',
		write: false,
	});
	const dir = mkdtempSync(join(tmpdir(), 'brewser-pack-'));
	const out = join(dir, 'pack.mjs');
	writeFileSync(out, result.outputFiles[0].text);
	return import(pathToFileURL(out).href);
}
