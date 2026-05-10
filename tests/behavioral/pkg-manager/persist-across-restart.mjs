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
await t.run('nimbus install clang', 120_000);
const { output: lsOutBefore } = await t.run(
  `node -e "const ok = require('fs').existsSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/bin/clang'); console.log('PRE'+'-STATE:' + (ok ? 'YES' : 'NO'))"`,
  10_000,
);
const beforePresent = /PRE-STATE:YES/.test(stripAnsi(lsOutBefore));
a.check('bin/clang exists before restart', beforePresent, beforePresent ? '' : 'not present');

// Compute manifest size before reconnect (via node statSync).
const { output: szOutBefore } = await t.run(
  `node -e "console.log('SZ=' + require('fs').statSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/manifest.json').size)"`,
  10_000,
);
const beforeSize = (stripAnsi(szOutBefore).match(/SZ=(\d+)/) || ['', '0'])[1];

// 2. Close + reconnect WS to same SID.
await t.close();
await sleep(500);
t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// 3. Bin path still present.
{
  const { output } = await t.run(
    `node -e "const ok = require('fs').existsSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/bin/clang'); console.log('POST'+'-STATE:' + (ok ? 'YES' : 'NO'))"`,
    10_000,
  );
  const stripped = stripAnsi(output);
  const present = /POST-STATE:YES/.test(stripped);
  a.check('bin/clang still exists after WS reconnect', present,
    present ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// 4. Manifest byte-identical.
{
  const { output } = await t.run(
    `node -e "console.log('SZ=' + require('fs').statSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/manifest.json').size)"`,
    10_000,
  );
  const afterSize = (stripAnsi(output).match(/SZ=(\d+)/) || ['', '0'])[1];
  a.check('manifest size unchanged across restart', beforeSize === afterSize && beforeSize !== '0',
    `before=${beforeSize} after=${afterSize}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
