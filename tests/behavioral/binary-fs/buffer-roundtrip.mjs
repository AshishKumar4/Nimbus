#!/usr/bin/env bun
// binary-fs/buffer-roundtrip — full-spectrum byte fidelity probe.
//
// Generates 4 KiB of pseudo-random bytes (deterministic seed for
// reproducibility), writes via fs.writeFileSync, reads back via
// fs.readFileSync, asserts SHA-256 equality. This covers ALL 256
// byte values across long runs, exposing UTF-8 boundary bugs that
// the small fixed-byte probes might miss (e.g. valid 2/3/4-byte
// UTF-8 sequences that survive but aren't bit-equal).

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { createHash } from 'node:crypto';

const sid = await mintSession();
console.log(`[binary-fs buffer-roundtrip] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/bf-rt', 10_000);
await t.run('cd /home/user/bf-rt', 10_000);

// Deterministic 4 KiB pseudo-random buffer (LCG, fixed seed).
// Self-contained — no external test fixtures.
function makeBuf(len, seed) {
  const out = new Uint8Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

const SEED = 0xdeadbeef;
const LEN = 4096;
const buf = makeBuf(LEN, SEED);
const hostHash = createHash('sha256').update(buf).digest('hex');
const hostB64 = Buffer.from(buf).toString('base64');

// Inside the facet: regenerate the same buffer (cheaper than shipping
// 4 KiB through the WS payload), write it, read it, hash it.
const script = `
const fs = require('fs');
const crypto = require('crypto');
function makeBuf(len, seed) {
  const out = new Uint8Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}
const buf = Buffer.from(makeBuf(${LEN}, ${SEED}));
fs.writeFileSync('rt.bin', buf);
const back = fs.readFileSync('rt.bin');
console.log('len:', back.length);
console.log('hash:', crypto.createHash('sha256').update(back).digest('hex'));
`;
const scriptB64 = Buffer.from(script, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('rt.js', Buffer.from('${scriptB64}','base64').toString('utf8'))"`,
  15_000,
);
const r = await t.run('node rt.js', 30_000);
const out = stripAnsi(r.output);
const observedLen = Number((out.match(/len:\s*(\d+)/) || [])[1]);
const observedHash = (out.match(/hash:\s*([0-9a-f]+)/) || [])[1];

await t.close();

const findings = {
  runtime: 'binary-fs/buffer-roundtrip',
  sid,
  base: BASE,
  inputLen: LEN,
  observedLen,
  hostHash,
  observedHash,
  lenMatches: observedLen === LEN,
  hashMatches: observedHash === hostHash,
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['readback length equals input length',       findings.lenMatches],
  ['readback sha256 equals input sha256',       findings.hashMatches],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[binary-fs buffer-roundtrip] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
