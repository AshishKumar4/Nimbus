#!/usr/bin/env bun
// durable/linger-reset — what a node process answered in a subtree it holds
// and has not sent yet (it lingers, process-fs-client LINGER_MS) fares in a
// real isolate reset exactly as a logged writeFileSync does: each is in the
// process's own journal from the moment it is made, and nowhere else.
//
// HOW IT'S DRIVEN
//   A resident takes /home/user/lr (it writes there often enough) and says
//   so; once that line is out it makes three changes it answers at once and
//   lets linger (an awaited chmod and an awaited writeFile decided there, a
//   writeFileSync), then holds its isolate in a loop (it counts: a facet's
//   clock stands still within a turn) while the session resets
//   (`POST /api/_diag/abort`). After the reset the session's files are
//   read: the decided changes are there exactly when the writeFileSync is.
//   Which way it goes is the platform's (whether the turn that logged them
//   ended before the facet did); the unit test process-fs-journal drains a
//   process that died mid-linger.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, sleep } from '../_driver.mjs';
import { afterReset, resetInstance } from './_reset-window.mjs';

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
const dir = '/home/user/lr';
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 16; i++) await fsp.writeFile(dir + '/warm' + i, 'w');
  for (let i = 0; i < 200 && !globalThis.__nimbusProcessFs?.client?.held('home/user/lr/x'); i++) await new Promise((r) => setTimeout(r, 10));
  console.log('LR' + '_READY held=' + !!globalThis.__nimbusProcessFs?.client?.held('home/user/lr/x'));
  await new Promise((r) => setTimeout(r, 500));
  await fsp.chmod(dir + '/warm0', 0o600);
  await fsp.writeFile(dir + '/async.txt', 'ASYNC');
  fs.writeFileSync(dir + '/sync.txt', 'SYNC');
  let spun = 0;
  for (let i = 0; i < 4e9; i++) spun += i & 1;
  console.log('LR' + '_SPUN ' + spun);
})();
`;

/** Run `node lr.js`, reset the session while it holds its isolate, and answer what the session has after. */
async function resetDuring(read) {
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run(heredocCommand('lr.js', PROGRAM), 20_000);
  t.reset();
  t.cmd('node lr.js');
  await t.waitFor((buf) => /LR_READY held=\w+/.test(buf), 60_000, 'LR_READY');
  a.check('the process holds the subtree', /LR_READY held=true/.test(t.buf), t.buf.slice(-200));
  const reset = await resetInstance(sid);
  a.check('the abort reset the instance: the session answers from a new incarnation', reset.ok, reset.detail);
  const deadline = Date.now() + 15_000;
  while (!t.closed && Date.now() < deadline) await sleep(50);
  a.check('the reset ended the instance', t.closed, `closed=${t.closed} detail=${t.closeDetail}`);
  // The next generation drains what the process's journal holds before any process runs: settled once a read answers twice alike.
  let last = null;
  for (const end = Date.now() + 60_000; Date.now() < end; await sleep(1_000)) {
    const now = await afterReset(read).catch((error) => ({ error: String(error?.message ?? error) }));
    if (!now.error && JSON.stringify(now) === JSON.stringify(last)) break;
    last = now;
  }
  console.log(`  after the reset: ${JSON.stringify(last)}`);
  return last;
}

const text = (path) => box.files.read(path).catch(() => null);

try {
  const held = await resetDuring(async () => {
    const stat = await box.files.stat('/home/user/lr/warm0').catch(() => null);
    return { sync: await text('/home/user/lr/sync.txt'), written: await text('/home/user/lr/async.txt'), mode: stat ? (Number(stat.mode) & 0o777).toString(8) : null };
  });
  const all = held.sync === 'SYNC' && held.written === 'ASYNC' && held.mode === '600';
  const none = held.sync === null && held.written === null && held.mode === '644';
  a.check('the decided changes fared in the reset as the writeFileSync did: all there, or none', all || none, JSON.stringify(held));
} finally {
  await deleteSession(sid, 'durable-linger-reset').catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
