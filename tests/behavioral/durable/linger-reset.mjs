#!/usr/bin/env bun
// durable/linger-reset — what a node process answered in a subtree it holds
// and has not sent yet (it lingers, process-fs-client LINGER_MS) survives a
// real isolate reset exactly as a logged writeFileSync does: from the
// process's own journal, drained by the next generation.
//
// HOW IT'S DRIVEN
//   A resident takes /home/user/lr (it writes there often enough), says so,
//   then makes three changes it answers at once (an awaited chmod and an
//   awaited writeFile decided there, a writeFileSync) and holds its isolate
//   in a synchronous loop, so the linger's timer cannot fire and nothing
//   else sends them. `POST /api/_diag/abort` resets the session meanwhile.
//   After it, the session's files have all three.

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
const dir = '/home/user/lr';
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 16; i++) await fsp.writeFile(dir + '/warm' + i, 'w');
  for (let i = 0; i < 200 && !globalThis.__nimbusProcessFs?.held('home/user/lr/x'); i++) await new Promise((r) => setTimeout(r, 10));
  console.log('LR' + '_READY held=' + !!globalThis.__nimbusProcessFs?.held('home/user/lr/x'));
  await fsp.chmod(dir + '/warm0', 0o600);
  await fsp.writeFile(dir + '/async.txt', 'ASYNC');
  fs.writeFileSync(dir + '/sync.txt', 'SYNC');
  const until = Date.now() + 6000;
  while (Date.now() < until) {}
})();
`;

/** Poll `check` until it answers truthy, or the budget runs out; the last answer either way. */
async function poll(check, budgetMs, everyMs = 500) {
  const deadline = Date.now() + budgetMs;
  let last;
  for (;;) {
    try { last = await afterReset(check); } catch (error) { last = { error: String(error?.message ?? error) }; }
    if (last && !last.error) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(everyMs);
  }
}

try {
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run(heredocCommand('lr.js', PROGRAM), 20_000);
  t.reset();
  t.cmd('node lr.js');
  await t.waitFor((buf) => /LR_READY held=\w+/.test(buf), 60_000, 'LR_READY');
  a.check('the process holds the subtree before it lingers', /LR_READY held=true/.test(t.buf), t.buf.slice(-200));

  // The reset, while the three changes linger in a held isolate.
  const abort = await fetch(`${BASE}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders({}, sid) });
  a.check('_diag/abort answers the reset', abort.status === 204, `status=${abort.status}`);
  const resetDeadline = Date.now() + 15_000;
  while (!t.closed && Date.now() < resetDeadline) await sleep(50);
  a.check('the reset ended the instance (its terminal socket dropped)', t.closed, `closed=${t.closed} detail=${t.closeDetail}`);

  const landed = await poll(async () => {
    const sync = await box.files.read('/home/user/lr/sync.txt').catch(() => null);
    const written = await box.files.read('/home/user/lr/async.txt').catch(() => null);
    const stat = await box.files.stat('/home/user/lr/warm0').catch(() => null);
    const mode = stat ? (Number(stat.mode) & 0o777).toString(8) : null;
    return sync === 'SYNC' && written === 'ASYNC' && mode === '600' ? { sync, written, mode } : { error: JSON.stringify({ sync, written, mode }) };
  }, 90_000);
  a.check('after the reset the session has every change the process answered and never sent', landed.ok, JSON.stringify(landed.last));
} finally {
  await deleteSession(sid, 'durable-linger-reset').catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
