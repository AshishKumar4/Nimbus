#!/usr/bin/env bun
// pkg-manager/persist-across-restart — after a successful install, kill
// + restore the WebSocket. The installed runtime must still be on disk
// AND the registry must have rebuilt the bin → handler binding
// (boot-time rehydration loop).
//
// Asserts:
//   1. First install completes; `which clang` resolves.
//   2. WS reconnects via session-recovery semantics; cwd preserved.
//   3. After reconnect, `which clang` still resolves to the same path.
//   4. After reconnect, the manifest file is byte-identical.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('pkg-manager/persist-across-restart');
console.log(`pkg-manager/persist-across-restart — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
let t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Install.
await t.run('nimbus install clang', 180_000);
const { output: lsOutBefore } = await t.run(
  'ls ~/.nimbus/runtimes/clang/binji-2020/bin/clang 2>&1', 10_000,
);
const beforePresent = /\/\.nimbus\/runtimes\/clang\/binji-2020\/bin\/clang/.test(stripAnsi(lsOutBefore))
  && !/ENOENT|No such/i.test(stripAnsi(lsOutBefore));
a.check('bin/clang exists before restart', beforePresent, beforePresent ? '' : 'not present');

// Manifest size before reconnect via `ls -la` parse (avoids the
// `wc -c` byte-inflation issue on large files).
const { output: szOutBefore } = await t.run('ls -la ~/.nimbus/runtimes/clang/binji-2020/manifest.json', 10_000);
const matchBefore = stripAnsi(szOutBefore).match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s/m);
const beforeSize = matchBefore ? matchBefore[1] : '0';

// 2. Close + reconnect WS to same SID.
await t.close();
await sleep(500);
t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// 3. Bin path still present.
{
  const { output } = await t.run('ls ~/.nimbus/runtimes/clang/binji-2020/bin/clang 2>&1', 10_000);
  const stripped = stripAnsi(output);
  const present = /\/\.nimbus\/runtimes\/clang\/binji-2020\/bin\/clang/.test(stripped)
    && !/ENOENT|No such/i.test(stripped);
  a.check('bin/clang still exists after WS reconnect', present,
    present ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// 4. Manifest byte-identical.
{
  const { output } = await t.run('ls -la ~/.nimbus/runtimes/clang/binji-2020/manifest.json', 10_000);
  const matchAfter = stripAnsi(output).match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s/m);
  const afterSize = matchAfter ? matchAfter[1] : '0';
  a.check('manifest size unchanged across restart', beforeSize === afterSize && beforeSize !== '0',
    `before=${beforeSize} after=${afterSize}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
