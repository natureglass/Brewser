// NACP field limit edge cases (title < 0x200 B/lang, author < 0x100 B, version
// < 0x10 B; UTF-8 counted; id = 16 hex). Guards the vendored pack/nacp.ts.
import assert from 'node:assert/strict';
import { loadPack } from './tools/load-pack.mjs';

const { NACP } = await loadPack();

let pass = 0, fail = 0;
const check = (name, cond) => {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name); }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const n = new NACP();

// title: 0x1FF bytes ok, 0x200 throws (byte 0x200 reserved for NUL)
n.title = 'A'.repeat(0x1ff);
check('title 0x1FF ok', n.title === 'A'.repeat(0x1ff));
check('title 0x200 throws', throws(() => { n.title = 'A'.repeat(0x200); }));

// author: 0xFF ok, 0x100 throws
n.author = 'B'.repeat(0xff);
check('author 0xFF ok', n.author === 'B'.repeat(0xff));
check('author 0x100 throws', throws(() => { n.author = 'B'.repeat(0x100); }));

// version: 0xF ok, 0x10 throws
n.version = '1'.repeat(0xf);
check('version 0xF ok', n.version === '1'.repeat(0xf));
check('version 0x10 throws', throws(() => { n.version = '1'.repeat(0x10); }));

// UTF-8 is counted by BYTES not chars: '€' = 3 bytes
check('multibyte title round-trips', (() => { n.title = 'Café €'; return n.title === 'Café €'; })());
const euros171 = '€'.repeat(171); // 513 bytes > 0x1FF
check('171 euros (513 B) title throws', throws(() => { n.title = euros171; }));

// id: 16 hex string set/get; >16 throws
n.id = '0100abcdef120000';
check('id set/get', n.id === 0x0100abcdef120000n);
check('id 17 hex throws', throws(() => { n.id = '0100abcdef1200000'; }));

assert.equal(fail, 0, `${fail} nacp-limit checks failed`);
console.log(`\nnacp-limits: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
