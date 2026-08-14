// Deliverable-3 correctness: the embedded snapshot is EXACTLY the app's
// allowlist (its install inventory) and never a directory walk — so app-written
// files (saves/caches inside apps/<id>/) can never be captured and later
// restored after a delete. Two parts: source guardrails + the real
// bundleTreeFromAllowlist mapping.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadForwarderGen } from './tools/load-forwarder-gen.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name); }
};

// --- Source guardrails: the generator must never enumerate the app dir ---
const genPath = fileURLToPath(new URL('../src/forwarder/generate.ts', import.meta.url));
const genSrc = readFileSync(genPath, 'utf8');
check('generator never walks the app dir (no readDir*)', !/readdir/i.test(genSrc));
check('embed is driven by the resolved allowlist', /bundleTreeFromAllowlist\(embedFiles/.test(genSrc));
check('embed files come only from resolveAllowlist', /embedFiles = await resolveAllowlist/.test(genSrc));

// The install-time inventory sidecar must live OUTSIDE apps/<id>/ (so the
// snapshot never has to exclude it, and the app dir stays == bundle).
const dlPath = fileURLToPath(new URL('../romfs/shell/scripts/download-modal.js', import.meta.url));
const dlSrc = readFileSync(dlPath, 'utf8');
check('inventory sidecar persisted under configs/app-inventory', /configs\/app-inventory/.test(dlSrc));
check('sidecar is NOT written under apps/<id>/', !/apps\/'\s*\+\s*detail\.id\s*\+\s*'\/[^']*inventory/i.test(dlSrc));

// --- Functional: the real bundleTreeFromAllowlist embeds ONLY the allowlist ---
const { bundleTreeFromAllowlist } = await loadForwarderGen();
const enc = new TextEncoder();
const allow = ['index.html', 'app.js', 'Build/data.bin', 'assets/img/logo.png'];
// The on-disk app dir ALSO holds these app-written files. They are NOT in the
// allowlist, so they must never reach the snapshot:
const extras = ['save.dat', 'cache/state.bin', 'cookies.json'];

const bundle = bundleTreeFromAllowlist(allow, (rel) => new Blob([enc.encode('X:' + rel)]));

function flatten(tree, prefix = '') {
	const out = [];
	for (const k of Object.keys(tree)) {
		const v = tree[k];
		if (v instanceof Blob) out.push(prefix + k);
		else out.push(...flatten(v, prefix + k + '/'));
	}
	return out;
}
const keys = flatten(bundle).sort();
check('bundle == allowlist exactly', JSON.stringify(keys) === JSON.stringify([...allow].sort()));
for (const e of extras) check('excludes app-written ' + e, !keys.includes(e));

assert.equal(fail, 0, `${fail} exclusion checks failed`);
console.log(`\nexclusion: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
