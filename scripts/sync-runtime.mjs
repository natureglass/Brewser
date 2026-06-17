// Vendor the built @switch-web/runtime into brewser/runtime/ so the
// public brewser repo can ship a self-contained "npm install" without
// pulling brewser-runtime source. After each runtime change:
//   1. cd ../brewser-runtime && pnpm build
//   2. cd ../brewser && node scripts/sync-runtime.mjs
//   3. commit brewser/runtime/ alongside the corresponding brewser
//      change.
//
// During development you can temporarily flip package.json's
// "@switch-web/runtime" back to "file:../brewser-runtime" for instant
// feedback. Commits land with "file:./runtime" + the latest synced
// dist + .d.ts artifacts.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeSrc = join(root, '..', 'brewser-runtime');
const runtimeDst = join(root, 'runtime');

// When invoked as the `postinstall` npm lifecycle hook (added so fresh
// clones get a populated `runtime/` automatically now that the dir is
// .gitignored), missing source must NOT abort `npm install` — a consumer
// who doesn't have the brewser-runtime sibling checkout still needs the
// install to succeed. When invoked directly via `npm run sync-runtime`,
// keep the hard failure so the dev sees the real error.
const isPostinstall = process.env.npm_lifecycle_event === 'postinstall';
function softExit(msg) {
	if (isPostinstall) { console.warn(msg + ' (postinstall — continuing)'); process.exit(0); }
	console.error(msg);
	process.exit(1);
}

if (!existsSync(runtimeSrc)) {
	softExit(`[sync-runtime] missing source: ${runtimeSrc}`);
}

const distSrc = join(runtimeSrc, 'dist');
if (!existsSync(distSrc)) {
	softExit(`[sync-runtime] missing brewser-runtime/dist/ — run \`pnpm build\` in brewser-runtime first.`);
}

mkdirSync(runtimeDst, { recursive: true });

// Wipe the existing runtime/ folder so removed files don't linger.
for (const entry of readdirSync(runtimeDst)) {
	rmSync(join(runtimeDst, entry), { recursive: true, force: true });
}

// Copy the compiled dist tree.
cpSync(distSrc, join(runtimeDst, 'dist'), { recursive: true });

// Rewrite package.json with the local paths (no devDependencies, no scripts).
const srcPkg = JSON.parse(readFileSync(join(runtimeSrc, 'package.json'), 'utf8'));
const vendoredPkg = {
	name: srcPkg.name,
	version: srcPkg.version,
	private: true,
	description: srcPkg.description,
	type: srcPkg.type,
	main: srcPkg.main,
	types: srcPkg.types,
	exports: srcPkg.exports,
	license: srcPkg.license,
	author: srcPkg.author,
};
writeFileSync(
	join(runtimeDst, 'package.json'),
	JSON.stringify(vendoredPkg, null, 2) + '\n',
);

// Tally the vendored payload for the log line.
let fileCount = 0;
let byteCount = 0;
function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) walk(p);
		else { fileCount++; byteCount += st.size; }
	}
}
walk(runtimeDst);

console.log(`[sync-runtime] vendored ${fileCount} files (${(byteCount / 1024).toFixed(1)} KB) → brewser/runtime/`);
