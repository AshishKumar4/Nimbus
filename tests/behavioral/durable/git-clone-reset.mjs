#!/usr/bin/env bun
// durable/git-clone-reset — a clone cut short by a real isolate reset is
// cleaned up by the next generation of the session, and nothing the user
// writes after the reset is lost to it; probed live against a deployed
// target.
//
// WHAT IT PROVES
//   A clone records itself (git/clone-job.ts) before it writes, and marks
//   its .git (nimbus-clone-job) while it runs. `POST /api/_diag/abort`
//   resets the DO isolate mid-clone with its storage intact. The next
//   generation reserves the clone's destination before its filesystem
//   takes a write, then cleans it up in slices: the marker, the clone's
//   staging and temporary packs go (and, cut short while it fetched,
//   everything it wrote, the destination it made with it). The user's first
//   write there after the reset (the directory made again, as `mkdir -p`
//   would) is refused while the cleanup holds it, or lands after; either
//   way it is still there once the cleanup is done. A clone in the new
//   generation runs to the end.
//
// HOW IT'S DRIVEN
//   A background clone (`git clone --bg`) of a small public repository in
//   pieces of 5 blobs, one at a time, so it runs long enough to be reset;
//   its marker is polled through the SDK's file plane, the reset is a fetch
//   to the session's /api/_diag/abort with the probe token, and the cleanup
//   is polled through files again.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, requestHeaders, sleep } from '../_driver.mjs';
import { afterReset } from './_reset-window.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const REPO = 'https://github.com/expressjs/express';
const DEST = '/home/user/cut';
const MARKER = `${DEST}/.git/nimbus-clone-job`;

const a = makeAsserter('durable/git-clone-reset');
console.log(`durable/git-clone-reset — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const nimbus = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) });
const box = nimbus.sandbox(sid);

/** Poll `check` until it answers truthy, or the budget runs out; the last answer either way. */
async function poll(check, budgetMs, everyMs = 300) {
  const deadline = Date.now() + budgetMs;
  let last;
  for (;;) {
    try { last = await check(); } catch (error) { last = { error: String(error?.message ?? error) }; }
    if (last && !last.error) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(everyMs);
  }
}

try {
  // ── 1. a clone, running: its marker is there ──
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('export NIMBUS_GIT_BLOBS_PER_BATCH=5 NIMBUS_GIT_BATCH_CONCURRENCY=1', 15_000);
  const started = await t.run(`git clone --bg --depth 1 ${REPO} ${DEST}`, 60_000);
  a.check('the background clone starts', /clone running in background/.test(started.output), started.output.slice(-300));
  const marked = await poll(async () => (await box.files.exists(MARKER)) || null, 60_000);
  a.check('the clone marks its .git while it runs', marked.ok, JSON.stringify(marked.last));

  // ── 2. a real isolate reset, mid-clone ──
  const abort = await fetch(`${BASE}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders() });
  a.check('_diag/abort answers the reset', abort.status === 204, `status=${abort.status}`);
  const resetDeadline = Date.now() + 10_000;
  while (!t.closed && Date.now() < resetDeadline) await sleep(50);
  a.check('the reset ended the instance (its terminal socket dropped)', t.closed, `closed=${t.closed} detail=${t.closeDetail}`);

  // ── 3. the first write after the reset: refused while the cleanup holds the destination, then it lands ──
  let refusals = 0;
  const wrote = await poll(async () => {
    try {
      // The destination may be gone by now, cleaned up whole: it is made again, as `mkdir -p` would.
      await afterReset(async () => {
        if (!(await box.files.exists(DEST))) await box.files.mkdir(DEST);
        await box.files.write(`${DEST}/first.txt`, 'first\n');
      });
      return true;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/ENOENT|EEXIST/.test(message)) return null;
      if (!/EBUSY|exclusive mutation|locked/i.test(message)) throw error;
      refusals++;
      return null;
    }
  }, 120_000, 250);
  a.check('the first write after the reset lands once the destination is free', wrote.ok, JSON.stringify(wrote.last));
  console.log(`  (the first write was refused ${refusals} time(s) while the cleanup held the destination)`);

  // ── 4. the cleanup, through files ──
  const cleaned = await poll(async () => {
    if (await box.files.exists(MARKER)) return null;
    if (await box.files.exists(`${DEST}/.git/nimbus-clone`)) return null;
    const packs = (await box.files.exists(`${DEST}/.git/objects/pack`)) ? await box.files.list(`${DEST}/.git/objects/pack`) : [];
    if (packs.some(({ name }) => name.startsWith('tmp_pack_'))) return null;
    return { entries: (await box.files.exists(DEST)) ? (await box.files.list(DEST)).map(({ name }) => name).sort() : [] };
  }, 120_000, 500);
  a.check('the next generation cleaned the clone up: marker, staging and temporary packs gone', cleaned.ok, JSON.stringify(cleaned.last));
  if (cleaned.ok && !cleaned.last.entries.includes('.git')) {
    a.check('cut short while it fetched: nothing of the clone is left but the user\'s write',
      JSON.stringify(cleaned.last.entries) === JSON.stringify(['first.txt']), JSON.stringify(cleaned.last.entries));
  }
  // A while longer: nothing comes back for the user's file.
  await sleep(3_000);
  a.check('the user\'s first write is still there after the cleanup', (await box.files.read(`${DEST}/first.txt`)) === 'first\n');

  // ── 5. a clone in the new generation runs to the end ──
  const t2 = new Terminal(sid);
  await t2.connect();
  await t2.waitForPrompt(30_000);
  const fresh = await t2.run(`git clone --depth 1 ${REPO} /home/user/fresh; echo CLONE_RC=$?`, 300_000);
  a.check('a clone in the new generation succeeds', /CLONE_RC=0/.test(fresh.output), fresh.output.slice(-400));
  a.check('and checks out', await box.files.exists('/home/user/fresh/package.json'));
  a.check('and leaves no marker', !(await box.files.exists('/home/user/fresh/.git/nimbus-clone-job')));
  await t2.close().catch(() => {});
} finally {
  await deleteSession(sid, 'durable-git-clone-reset').catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
