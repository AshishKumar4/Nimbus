#!/usr/bin/env bun
// binary-fs/writeFile-async-binary — async writeFile path must
// preserve binary bytes too. The async fs.writeFile shim is a thin
// wrapper around writeFileSync (node-shims.ts:432), so the same
// corruption affects it. Probe asserts byte-equality through async.
//
// Also exercises fs.promises.writeFile (the modern API) which uses
// a separate code path in the shim.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[binary-fs writeFile-async] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/bf-async', 10_000);
await t.run('cd /home/user/bf-async', 10_000);

// Test 1: callback-style fs.writeFile
const cbScript = `
const fs = require('fs');
fs.writeFile('cb.bin', Buffer.from([0xc0,0xa2,0x80,0xff,0x01]), (err) => {
  if (err) { console.log('ERR:', err.message); process.exit(1); }
  console.log('cb-write-ok');
  console.log('cb-hex:', fs.readFileSync('cb.bin').toString('hex'));
});
`;
const cbB64 = Buffer.from(cbScript, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('test-cb.js', Buffer.from('${cbB64}','base64').toString('utf8'))"`,
  15_000,
);
const r1 = await t.run('node test-cb.js', 20_000);
const out1 = stripAnsi(r1.output);
const cbHex = (out1.match(/cb-hex:\s*([0-9a-f]+)/) || [])[1];

// Test 2: fs.promises.writeFile (modern API, separate code path)
const promScript = `
const fs = require('fs').promises;
const fsSync = require('fs');
(async () => {
  await fs.writeFile('prom.bin', Buffer.from([0xff,0xfe,0xfd,0x80,0x7f,0x00]));
  console.log('prom-hex:', fsSync.readFileSync('prom.bin').toString('hex'));
})().catch(e => { console.log('ERR:', e.message); process.exit(1); });
`;
const promB64 = Buffer.from(promScript, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('test-prom.js', Buffer.from('${promB64}','base64').toString('utf8'))"`,
  15_000,
);
const r2 = await t.run('node test-prom.js', 20_000);
const out2 = stripAnsi(r2.output);
const promHex = (out2.match(/prom-hex:\s*([0-9a-f]+)/) || [])[1];

await t.close();

const cbExpected = 'c0a280ff01';
const promExpected = 'fffefd807f00';

const findings = {
  runtime: 'binary-fs/writeFile-async',
  sid,
  base: BASE,
  callback: { expected: cbExpected, observed: cbHex, matches: cbHex === cbExpected },
  promises: { expected: promExpected, observed: promHex, matches: promHex === promExpected },
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['callback fs.writeFile preserves bytes',         findings.callback.matches],
  ['fs.promises.writeFile preserves bytes',         findings.promises.matches],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[binary-fs writeFile-async] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
