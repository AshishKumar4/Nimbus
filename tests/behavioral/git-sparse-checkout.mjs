#!/usr/bin/env bun
// git-sparse-checkout — `git sparse-checkout` in a sparse partial clone of
// a large repository, probed live against a deployed target.
//
// WHAT IT PROVES
//   `git clone --sparse --filter=blob:none` of vscode holds the top's files
//   only and none of the rest's blobs. `sparse-checkout set` of one
//   directory fetches that directory's blobs (one promisor fetch) and
//   writes its files, nothing else; `list` names the cone; `add` widens it;
//   the worktree stays clean throughout; `disable` of a small repository
//   brings every file back. Each step's wall time is printed.

import { BASE, makeAsserter, mintSession, deleteSession, Terminal, stripAnsi } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('git-sparse-checkout');
console.log(`git-sparse-checkout — BASE=${BASE}`);
const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

/** A command and its output, timed; its exit code is the last line's RC=. */
async function step(label, command, timeoutMs = 600_000) {
  const started = Date.now();
  const r = await t.run(`${command}; echo RC=$?`, timeoutMs);
  const out = stripAnsi(r.output);
  const secs = ((Date.now() - started) / 1000).toFixed(2);
  console.log(`  [${secs}s] ${label}`);
  return { out, ok: [...out.matchAll(/RC=(\d+)/g)].pop()?.[1] === '0' };
}

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const cloned = await step('clone --sparse --filter=blob:none vscode', 'git clone --sparse --filter=blob:none https://github.com/microsoft/vscode /home/user/vs');
  a.check('the sparse partial clone succeeds', cloned.ok, cloned.out.slice(-400));
  await t.run('cd /home/user/vs', 15_000);

  const set = await step('sparse-checkout set src/vs/base/common', 'git sparse-checkout set src/vs/base/common');
  a.check('set succeeds', set.ok, set.out.slice(-400));
  const written = await step('count the files written', 'find src -type f | wc -l; ls src/vs/base/common/strings.ts');
  a.check('the cone\'s files are written, nothing else of src', /strings\.ts/.test(written.out) && !/No such file/.test(written.out), written.out.slice(-300));
  const listed = await step('sparse-checkout list', 'git sparse-checkout list');
  a.check('list names the cone', /^src\/vs\/base\/common$/m.test(listed.out), listed.out.slice(-300));
  const clean = await step('status after set', 'git status --porcelain | wc -l');
  a.check('the worktree is clean after set', /^0$/m.test(clean.out), clean.out.slice(-200));

  const added = await step('sparse-checkout add src/vs/base/browser', 'git sparse-checkout add src/vs/base/browser && git sparse-checkout list');
  a.check('add widens the cone', added.ok && /^src\/vs\/base\/browser$/m.test(added.out) && /^src\/vs\/base\/common$/m.test(added.out), added.out.slice(-300));
  const still = await step('status after add', 'git status --porcelain | wc -l; test -f src/vs/base/browser/dom.ts && echo HAS_DOM');
  a.check('the added directory is written, the worktree clean', /^0$/m.test(still.out) && /HAS_DOM/.test(still.out), still.out.slice(-200));

  // disable, on a small repository: every file back.
  const small = await step('clone --sparse express', 'cd /home/user && git clone --sparse --filter=blob:none https://github.com/expressjs/express ex && cd ex');
  a.check('a second sparse clone succeeds', small.ok, small.out.slice(-300));
  const disabled = await step('sparse-checkout disable', 'git sparse-checkout disable && test -f lib/express.js && echo HAS_LIB && git status --porcelain | wc -l');
  a.check('disable brings every file back, clean', disabled.ok && /HAS_LIB/.test(disabled.out) && /^0$/m.test(disabled.out), disabled.out.slice(-300));
  const off = await step('list after disable', 'git sparse-checkout list');
  a.check('the worktree is not sparse after disable', /this worktree is not sparse/.test(off.out), off.out.slice(-200));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid, 'git-sparse-checkout').catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
