#!/usr/bin/env bun
// binary-fs/writeFileSync-binary — invariant: a Uint8Array passed to
// node fs.writeFileSync from inside the node-runtime facet must be
// preserved byte-for-byte through the round-trip
// write → vfs.writeFile → vfs.readFile → fs.readFileSync.
//
// Pre-fix: node-shims.ts:221 calls TextDecoder.decode(data) on the
// Uint8Array, producing U+FFFD where invalid UTF-8 sequences appear,
// then enc.encode() expands back to UTF-8 multi-byte sequences. A
// single 0xa2 byte is mangled to EF BF BD (3 bytes).
//
// Probe writes 4 bytes [0xa2, 0xff, 0x00, 0x80] (all ≥0x80 except the
// null) and reads back hex. Expected: "a2ff0080". Pre-fix observed:
// "efbfbdefbfbd00efbfbd" or similar replacement-char mush.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[binary-fs writeFileSync] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/bf-sync', 10_000);
await t.run('cd /home/user/bf-sync', 10_000);

// Write + read in ONE node invocation. Cross-facet reads exercise the
// supervisor-flush + next-facet-bundle path, which is a separate
// concern — this probe is scoped to in-facet round-trip integrity.
// Cross-facet bytes flow is implicitly verified by wasm-runner probes
// (which write via node fs in one shell command + read via wasm-runner
// in the next).
const script = `
const fs = require('fs');
fs.writeFileSync('blob.bin', Buffer.from([0xa2, 0xff, 0x00, 0x80]));
console.log('hex:' + fs.readFileSync('blob.bin').toString('hex'));
console.log('size:' + fs.statSync('blob.bin').size);
`;
const scriptB64 = Buffer.from(script, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('blob.js', Buffer.from('${scriptB64}','base64').toString('utf8'))"`,
  15_000,
);
const r = await t.run('node blob.js', 15_000);
const out = stripAnsi(r.output);
const readHex = (out.match(/hex:([0-9a-f]*)/) || [])[1];
const sizeMatch = out.match(/size:(\d+)/);
const observedBytes = sizeMatch ? Number(sizeMatch[1]) : null;

await t.close();

const expectedHex = 'a2ff0080';
const expectedBytes = 4;

const findings = {
  runtime: 'binary-fs/writeFileSync',
  sid,
  base: BASE,
  expectedHex,
  observedHex: readHex,
  hexMatches: readHex === expectedHex,
  expectedBytes,
  observedBytes,
  bytesMatches: observedBytes === expectedBytes,
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['readFileSync hex equals a2ff0080',     findings.hexMatches],
  ['fs.statSync size equals 4',            findings.bytesMatches],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[binary-fs writeFileSync] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
