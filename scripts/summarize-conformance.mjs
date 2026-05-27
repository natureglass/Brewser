// Post-process the full-webgl1-conformance summary log into a tidy
// breakdown by status + assertion-level pass rate.
//
// Usage:
//   node scripts/summarize-conformance.mjs
// Optional explicit path:
//   node scripts/summarize-conformance.mjs path/to/full-webgl1-conformance.log

import { readFileSync } from 'node:fs';

const DEFAULT_PATH =
	'C:/Users/NatureGlass/AppData/Roaming/citron/sdmc/switch/webprofiles/default/khronos-logs/full-webgl1-conformance.log';
const path = process.argv[2] || DEFAULT_PATH;

const text = readFileSync(path, 'utf8');
const lines = text.split('\n').filter(
	(l) => l && !l.startsWith('#') && !l.startsWith('name\t'),
);

let totalP = 0, totalF = 0, total = 0;
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, ERROR: 0, SKIP: 0 };
const passedTests = [];
const slowest = [];

for (const line of lines) {
	const parts = line.split('\t');
	if (parts.length < 5) continue;
	const [name, status, pass, fail, ms] = parts;
	total++;
	counts[status] = (counts[status] || 0) + 1;
	const p = parseInt(pass, 10) || 0;
	const f = parseInt(fail, 10) || 0;
	const t = parseInt(ms, 10) || 0;
	totalP += p;
	totalF += f;
	if (status === 'PASS') passedTests.push({ name, p, ms: t });
	slowest.push({ name, ms: t, status });
}

slowest.sort((a, b) => b.ms - a.ms);

console.log('=== Full WebGL 1 Conformance — Final Tally ===\n');
console.log('Total tests processed:', total);
console.log('Status breakdown:');
for (const k of ['PASS', 'FAIL', 'TIMEOUT', 'ERROR', 'SKIP']) {
	const pct = ((counts[k] || 0) / total * 100).toFixed(1);
	console.log('  ' + k.padEnd(8), String(counts[k] || 0).padStart(4),
		'(' + pct + '%)');
}

console.log('\nAssertion-level pass rate:');
console.log('  Passed assertions:', totalP);
console.log('  Failed assertions:', totalF);
console.log('  Total assertions: ', totalP + totalF);
console.log('  Pass rate:        ',
	((totalP / (totalP + totalF)) * 100).toFixed(2) + '%');

console.log('\nTests that PASSed cleanly (whole test green):');
for (const t of passedTests) {
	console.log('  ' + t.name + ' (' + t.p + ' assertions, ' + t.ms + 'ms)');
}

console.log('\nSlowest 10 tests (by elapsed ms):');
for (const t of slowest.slice(0, 10)) {
	console.log('  ' + String(t.ms).padStart(6) + 'ms  ' + t.status.padEnd(8) +
		'  ' + t.name);
}
