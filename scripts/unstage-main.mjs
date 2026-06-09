// Remove `romfs/main.js` + `romfs/main.js.map` after `nxjs-nro` packages.
// Keeping them out of `romfs/` between builds means `robocopy romfs sdmc`
// never carries stale runtime bytes onto the device. Best-effort; missing
// files are not an error.
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const romfsDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'romfs');

for (const name of ['main.js', 'main.js.map']) {
	const path = join(romfsDir, name);
	if (existsSync(path)) {
		rmSync(path);
		console.log(`[unstage-main] removed romfs/${name}`);
	}
}
