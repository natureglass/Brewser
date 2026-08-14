// Round-trip test for the vendored pack library: assemble a forwarder NRO the
// same way the on-device generator does (real stub code segment + new icon +
// new NACP + a RomFS holding forwarder.json + bundle/...), then parse it back
// and assert every section matches. Runs on the dev machine (Node 18+).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPack } from './tools/load-pack.mjs';

const { NRO, RomFS, NACP } = await loadPack();

const enc = new TextEncoder();
const u8 = (s) => enc.encode(s);
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

let pass = 0, fail = 0;
const check = (name, cond) => {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name); }
};

// --- Decode the real stub NRO (the generator's starting point) ---
const stubPath = fileURLToPath(new URL('../romfs/forwarder-stub.nro', import.meta.url));
const stubBlob = new Blob([readFileSync(stubPath)]);
check('stub is an NRO0', await NRO.isNRO(stubBlob));
const stub = await NRO.decode(stubBlob);
check('stub has code data', stub.data.size > 0);
check('stub has a NACP', !!stub.nacp);

// --- Build the forwarder RomFS (embed variant) ---
const htmlBytes = u8('<!doctype html><title>Test</title><h1>hi</h1>');
const dataBytes = Uint8Array.from({ length: 1234 }, (_, i) => i & 0xff);
const files = [
	{ path: 'index.html', size: htmlBytes.length },
	{ path: 'Build/data.bin', size: dataBytes.length },
];
const fwd = {
	contract: 1,
	appId: 'com.test.app',
	title: 'Test App',
	entry: 'index.html',
	files,
};
const romfsTree = {
	'forwarder.json': new Blob([u8(JSON.stringify(fwd))]),
	bundle: {
		'index.html': new Blob([htmlBytes]),
		Build: { 'data.bin': new Blob([dataBytes]) },
	},
};
const romfs = await RomFS.encode(romfsTree);

// --- NACP (start from the stub's; set forwarder fields) ---
const nacp = new NACP(await stub.nacp.arrayBuffer());
nacp.title = 'Test App';
nacp.author = 'Test Dev';
nacp.version = '1.2.3';
nacp.id = '0111111111120000';

const iconBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]); // fake JPEG
const icon = new Blob([iconBytes]);

// --- Encode -> the forwarder NRO ---
const out = await NRO.encode({
	data: stub.data,
	icon,
	nacp: new Blob([new Uint8Array(nacp.buffer)]),
	romfs,
});
check('output is an NRO0', await NRO.isNRO(out));

// --- Parse back + verify every section ---
const dec = await NRO.decode(out);
check('code segment size preserved', dec.data.size === stub.data.size);
check('icon bytes match', eq(await bytes(dec.icon), iconBytes));

const decNacp = new NACP(await dec.nacp.arrayBuffer());
check('nacp title', decNacp.title === 'Test App');
check('nacp author', decNacp.author === 'Test Dev');
check('nacp version', decNacp.version === '1.2.3');
check('nacp id', decNacp.id === 0x0111111111120000n);

const tree = await RomFS.decode(dec.romfs);
check('forwarder.json present', tree['forwarder.json'] instanceof Blob);
const decFwd = JSON.parse(await tree['forwarder.json'].text());
check('forwarder.json contract', decFwd.contract === 1);
check('forwarder.json appId', decFwd.appId === 'com.test.app');
check('forwarder.json entry', decFwd.entry === 'index.html');
check('forwarder.json files count', decFwd.files.length === 2);
check('bundle dir present', tree.bundle && !(tree.bundle instanceof Blob));
check('bundle/index.html bytes', eq(await bytes(tree.bundle['index.html']), htmlBytes));
check('bundle/Build/data.bin bytes', eq(await bytes(tree.bundle.Build['data.bin']), dataBytes));

assert.equal(fail, 0, `${fail} round-trip checks failed`);
console.log(`\nround-trip: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
