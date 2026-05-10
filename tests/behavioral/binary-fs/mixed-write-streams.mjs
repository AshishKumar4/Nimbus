#!/usr/bin/env bun
// binary-fs/mixed-write-streams — interleaved string + binary writes
// in the same facet must each round-trip correctly.
//
// Catches a regression where a fix that "always treat as binary"
// inadvertently breaks string-utf8 writes (or vice versa). The
// canonical mix:
//   1. write 'hello\n' (string)               — ASCII
//   2. write Buffer([0xc3, 0xa9])             — UTF-8 'é'
//   3. write Buffer([0xff, 0xfe, 0xfd, 0xa2]) — invalid UTF-8 (raw)
//   4. write 'multi-line\nUTF-8 © text\n'     — multibyte string
// Then read each back as bytes (hex) AND as utf8 string where
// appropriate; assert round-trip preservation.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[binary-fs mixed] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/bf-mix', 10_000);
await t.run('cd /home/user/bf-mix', 10_000);

const script = `
const fs = require('fs');
fs.writeFileSync('a.txt',  'hello\\n');
fs.writeFileSync('b.bin',  Buffer.from([0xc3, 0xa9]));
fs.writeFileSync('c.bin',  Buffer.from([0xff, 0xfe, 0xfd, 0xa2]));
fs.writeFileSync('d.txt',  'multi-line\\nUTF-8 © text\\n');
console.log('a-utf8:',     fs.readFileSync('a.txt', 'utf8'));
console.log('a-hex:',      fs.readFileSync('a.txt').toString('hex'));
console.log('b-hex:',      fs.readFileSync('b.bin').toString('hex'));
console.log('b-utf8:',     fs.readFileSync('b.bin', 'utf8'));
console.log('c-hex:',      fs.readFileSync('c.bin').toString('hex'));
console.log('d-utf8:',     JSON.stringify(fs.readFileSync('d.txt', 'utf8')));
console.log('d-hex:',      fs.readFileSync('d.txt').toString('hex'));
`;
const b64 = Buffer.from(script, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('mix.js', Buffer.from('${b64}','base64').toString('utf8'))"`,
  15_000,
);
const r = await t.run('node mix.js', 30_000);
const out = stripAnsi(r.output);

function pick(re) {
  const m = out.match(re);
  return m ? m[1].trim() : null;
}

const aUtf8 = pick(/a-utf8:\s*(.*?)\r?\n/);
const aHex  = pick(/a-hex:\s*([0-9a-f]+)/);
const bHex  = pick(/b-hex:\s*([0-9a-f]+)/);
const bUtf8 = pick(/b-utf8:\s*(.*?)\r?\n/);
const cHex  = pick(/c-hex:\s*([0-9a-f]+)/);
const dUtf8 = pick(/d-utf8:\s*(.+?)\r?\n/);
const dHex  = pick(/d-hex:\s*([0-9a-f]+)/);

await t.close();

const expected = {
  aUtf8: 'hello',                        // trimmed
  aHex:  '68656c6c6f0a',                 // 'hello\n'
  bHex:  'c3a9',                         // raw bytes
  bUtf8: 'é',                            // valid UTF-8 decodes
  cHex:  'fffefda2',                     // invalid UTF-8 must stay as-is
  dUtf8: JSON.stringify('multi-line\nUTF-8 © text\n'),
  dHex:  '6d756c74692d6c696e650a5554462d3820c2a920746578740a',
};

const findings = {
  runtime: 'binary-fs/mixed',
  sid,
  base: BASE,
  expected,
  observed: { aUtf8, aHex, bHex, bUtf8, cHex, dUtf8, dHex },
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['ASCII string round-trips (hex)',           aHex === expected.aHex],
  ['Buffer with valid UTF-8 bytes (hex)',      bHex === expected.bHex],
  ['  same buffer reads back as UTF-8',        bUtf8 === expected.bUtf8],
  ['Buffer with INVALID UTF-8 (hex)',          cHex === expected.cHex],
  ['Multi-byte string round-trips (utf8)',     dUtf8 === expected.dUtf8],
  ['Multi-byte string round-trips (hex)',      dHex === expected.dHex],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[binary-fs mixed] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
