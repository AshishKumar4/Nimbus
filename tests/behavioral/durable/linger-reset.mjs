#!/usr/bin/env bun
// durable/linger-reset — what a node process answered in a subtree it holds
// and has not sent yet (it lingers, process-fs-client LINGER_MS) fares in a
// real isolate reset exactly as a logged writeFileSync outside any held
// subtree does: both are in the process's own journal, and nothing else.
//
// HOW IT'S DRIVEN
//   Twice, each with its own reset (`POST /api/_diag/abort`):
//   - held: a resident takes /home/user/lr (it writes there often enough)
//     and says so; once that line is out it makes three changes it answers
//     at once and lets linger (an awaited chmod and an awaited writeFile
//     decided there, a writeFileSync);
//   - unheld: a resident makes one writeFileSync in /home/user itself (a
//     home directory is never held), which goes the moment it is logged.
//   Each then holds its isolate in a loop (it counts: a facet's clock
//   stands still within a turn) while the session resets. After each reset
//   the session's files are read: the held run's three changes are all
//   there or none, and its writeFileSync fared as the unheld one did.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, requestHeaders, sleep } from '../_driver.mjs';
import { afterReset } from './_reset-window.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('durable/linger-reset');
console.log(`durable/linger-reset — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const nimbus = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) });
const box = nimbus.sandbox(sid);

const PROGRAM = `
const fs = require('fs'); const fsp = fs.promises;
const held = process.argv[2] === 'held';
const dir = '/home/user/lr';
(async () => {
  if (held) {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 16; i++) await fsp.writeFile(dir + '/warm' + i, 'w');
    for (let i = 0; i < 200 && !globalThis.__nimbusProcessFs?.held('home/user/lr/x'); i++) await new Promise((r) => setTimeout(r, 10));
  }
  console.log('LR' + '_READY held=' + !!globalThis.__nimbusProcessFs?.held('home/user/lr/x'));
  await new Promise((r) => setTimeout(r, 500));
  if (held) {
    await fsp.chmod(dir + '/warm0', 0o600);
    await fsp.writeFile(dir + '/async.txt', 'ASYNC');
    fs.writeFileSync(dir + '/sync.txt', 'SYNC');
  } else {
    fs.writeFileSync('/home/user/unheld.txt', 'SYNC');
  }
  let spun = 0;
  for (let i = 0; i < 4e9; i++) spun += i & 1;
  console.log('LR' + '_SPUN ' + spun);
})();
`;

/** Run `node lr.js <arm>`, reset the session while it holds its isolate, and answer what the session has after. */
async function resetDuring(arm, read) {
  const t = new Terminal(sid);
  await afterReset(() => t.connect());
  await t.waitForPrompt(60_000);
  if (arm === 'held') await t.run(heredocCommand('lr.js', PROGRAM), 20_000);
  t.reset();
  t.cmd(`node lr.js ${arm}`);
  await t.waitFor((buf) => /LR_READY held=\w+/.test(buf), 60_000, 'LR_READY');
  a.check(`${arm}: the process ${arm === 'held' ? 'holds' : 'does not hold'} the subtree`, new RegExp(`LR_READY held=${arm === 'held'}`).test(t.buf), t.buf.slice(-200));
  const abort = await fetch(`${BASE}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders({}, sid) });
  a.check(`${arm}: _diag/abort answers the reset`, abort.status === 204, `status=${abort.status}`);
  const deadline = Date.now() + 15_000;
  while (!t.closed && Date.now() < deadline) await sleep(50);
  a.check(`${arm}: the reset ended the instance`, t.closed, `closed=${t.closed} detail=${t.closeDetail}`);
  // The next generation drains what the process's journal holds before any process runs: settled once a read answers twice alike.
  let last = null;
  for (const end = Date.now() + 60_000; Date.now() < end; await sleep(1_000)) {
    const now = await afterReset(read).catch((error) => ({ error: String(error?.message ?? error) }));
    if (!now.error && JSON.stringify(now) === JSON.stringify(last)) break;
    last = now;
  }
  console.log(`  ${arm}: ${JSON.stringify(last)}`);
  return last;
}

const text = (path) => box.files.read(path).catch(() => null);

try {
  const held = await resetDuring('held', async () => {
    const stat = await box.files.stat('/home/user/lr/warm0').catch(() => null);
    return { sync: await text('/home/user/lr/sync.txt'), written: await text('/home/user/lr/async.txt'), mode: stat ? (Number(stat.mode) & 0o777).toString(8) : null };
  });
  const unheld = await resetDuring('unheld', async () => ({ sync: await text('/home/user/unheld.txt') }));
  const all = held.sync === 'SYNC' && held.written === 'ASYNC' && held.mode === '600';
  const none = held.sync === null && held.written === null && held.mode === '644';
  a.check('the held run\'s lingering changes are all in the session after its reset, or none', all || none, JSON.stringify(held));
  a.check('a lingering writeFileSync fares in a reset as one outside any held subtree does', held.sync === unheld.sync, JSON.stringify({ held, unheld }));
} finally {
  await deleteSession(sid, 'durable-linger-reset').catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
