#!/usr/bin/env bun
// mounts/embedder-mount — the embedder-mount surface (apps/probe mounts a
// MemoryVFS at /mnt/data), probed live against a deployed target.
//
// WHAT IT PROVES
//   A filesystem an embedder mounts is the session's: /proc/mounts and df
//   name it; files written, listed, renamed and removed there through the
//   shell and the SDK's file plane are the mount's; a `git clone` onto it
//   (a small repository) checks out, its status clean, then fetch and pull
//   there work; a failed clone there leaves nothing. Each step's wall time
//   is printed.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('mounts/embedder-mount');
console.log(`mounts/embedder-mount — BASE=${BASE}`);
const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);
const t = new Terminal(sid);

/** A command, timed; its exit code from the last RC=. */
async function step(label, command, timeoutMs = 300_000) {
  const started = Date.now();
  const r = await t.run(`${command}; echo RC=$?`, timeoutMs);
  const out = stripAnsi(r.output);
  console.log(`  [${((Date.now() - started) / 1000).toFixed(2)}s] ${label}`);
  return { out, ok: [...out.matchAll(/RC=(\d+)/g)].pop()?.[1] === '0' };
}

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const listed = await step('/proc/mounts and df', 'grep " /mnt/data " /proc/mounts && df /mnt/data');
  a.check('/proc/mounts and df name the mount at /mnt/data', listed.ok && /\/mnt\/data/.test(listed.out), listed.out.slice(-300));

  const shell = await step('files through the shell', 'mkdir -p /mnt/data/d && echo hello > /mnt/data/d/a.txt && mv /mnt/data/d/a.txt /mnt/data/d/b.txt && cat /mnt/data/d/b.txt && ls /mnt/data/d');
  a.check('the shell writes, renames and reads there', shell.ok && /hello/.test(shell.out) && /b\.txt/.test(shell.out), shell.out.slice(-300));
  a.check('the SDK reads what the shell wrote there', (await box.files.read('/mnt/data/d/b.txt')) === 'hello\n');
  await box.files.write('/mnt/data/d/c.txt', 'from the sdk');
  const seen = await step('a file the SDK wrote, through the shell', 'cat /mnt/data/d/c.txt && rm /mnt/data/d/c.txt && ls /mnt/data/d');
  a.check('the shell reads and removes what the SDK wrote there', seen.ok && /from the sdk/.test(seen.out) && !/c\.txt\s*\n/.test(seen.out.split('from the sdk').pop()), seen.out.slice(-300));

  const cloned = await step('git clone express onto the mount', 'git clone --depth 1 https://github.com/expressjs/express /mnt/data/express');
  a.check('a clone onto the mount succeeds', cloned.ok, cloned.out.slice(-400));
  const status = await step('status, fetch and pull there', 'cd /mnt/data/express && test -f package.json && git status --porcelain | wc -l && git fetch -q && git pull -q && git log --oneline -1');
  a.check('it checks out clean, and fetch and pull work there', status.ok && /^0$/m.test(status.out), status.out.slice(-400));

  const failed = await step('a clone that fails onto the mount', 'cd /home/user && git clone https://github.com/expressjs/nonexistent-repository-for-nimbus-probe /mnt/data/failed; test ! -e /mnt/data/failed && echo GONE');
  a.check('a failed clone there leaves nothing', /GONE/.test(failed.out), failed.out.slice(-300));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid, 'mounts-embedder-mount').catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
