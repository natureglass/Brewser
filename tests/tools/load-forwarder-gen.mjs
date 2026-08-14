// Bundles src/forwarder/generate.ts for Node so the exclusion test can exercise
// the REAL bundleTreeFromAllowlist. `@switch-web/runtime` is aliased to a shim
// exporting only the pack namespace (see runtime-pack-shim.ts). generate.ts uses
// Switch/OffscreenCanvas only INSIDE functions, so the module loads fine here.
import esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function loadForwarderGen() {
	const entry = fileURLToPath(
		new URL('../../src/forwarder/generate.ts', import.meta.url),
	);
	const shim = fileURLToPath(new URL('./runtime-pack-shim.ts', import.meta.url));
	const result = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2022',
		alias: { '@switch-web/runtime': shim },
		write: false,
	});
	const dir = mkdtempSync(join(tmpdir(), 'brewser-gen-'));
	const out = join(dir, 'gen.mjs');
	writeFileSync(out, result.outputFiles[0].text);
	return import(pathToFileURL(out).href);
}
