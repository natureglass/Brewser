// Copy `build/main.js` + `build/main.js.map` into `romfs/` so `nxjs-nro`
// can bundle them. esbuild outputs to `build/` (outside romfs/) to keep
// the runtime bundle out of the on-device deploy — Citron reads main.js
// from inside the NRO, not from sdmc. `unstage-main.mjs` clears the
// staged copies after `nxjs-nro` packages.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(root, 'build');
const romfsDir = join(root, 'romfs');

const entry = join(buildDir, 'main.js');
if (!existsSync(entry)) {
	console.error(`[stage-main] missing ${entry}. Run \`npm run build\` first.`);
	process.exit(1);
}

mkdirSync(romfsDir, { recursive: true });

for (const name of ['main.js', 'main.js.map']) {
	const src = join(buildDir, name);
	const dst = join(romfsDir, name);
	if (existsSync(src)) {
		copyFileSync(src, dst);
		console.log(`[stage-main] ${name} → romfs/`);
	}
}
