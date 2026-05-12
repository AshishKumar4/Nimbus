#!/usr/bin/env bun
// git-clone-absolute-path — invariant: `git clone <url> /abs/path`
// MUST clone into /abs/path, not <cwd>//abs/path. Pre-fix `git clone
// <url> /tmp/x` clobbered the absolute target with cwd-prefix:
//
//   const dest = subArgs[1] ? getDir(ctx) + '/' + subArgs[1] : ...
//
// Result: the clone "succeeded" into /home/user//tmp/x (double slash),
// the user's later `cd /tmp/x` hit ENOENT, and the repo was orphaned.
//
// hardening-r5 — see /workspace/.seal-internal/2026-05-12-hardening-r5/.

import { mintSession, Terminal, makeAsserter, stripAnsi } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('git-clone-absolute-path');
console.log(`git-clone-absolute-path — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Use a tiny public repo so the test stays fast (under 2s for the
// clone itself).
const REPO = 'https://github.com/sindresorhus/is-plain-obj';
const ABS_TARGET = '/tmp/gcap-target';

// 1. Clone with absolute target path.
{
  const { output } = await t.run(`git clone ${REPO} ${ABS_TARGET} 2>&1 | tail -5`, 120_000);
  const stripped = stripAnsi(output);
  // Sanity: clone printed Cloning into '<dest>' line.
  const cloningInto = stripped.match(/Cloning into '([^']+)'/);
  const dest = cloningInto ? cloningInto[1] : '';
  a.check('Cloning destination is /tmp/gcap-target (no cwd prefix)',
    dest === ABS_TARGET,
    `dest=${JSON.stringify(dest)}`);
}

// 2. The repo MUST exist at the absolute path.
{
  const { output } = await t.run(`ls ${ABS_TARGET}/.git/HEAD 2>&1`, 10_000);
  const stripped = stripAnsi(output);
  const ok = /\.git\/HEAD/.test(stripped) && !/No such|ENOENT|cannot access/i.test(stripped);
  a.check('repo .git/HEAD exists at the absolute target', ok,
    ok ? '' : JSON.stringify(stripped.slice(-300)));
}

// 3. cd into the absolute path + git status MUST succeed.
{
  const { output } = await t.run(`cd ${ABS_TARGET} && git status 2>&1 | head -3`, 30_000);
  const stripped = stripAnsi(output);
  const ok = !/ENOENT/.test(stripped) && /branch|HEAD/i.test(stripped);
  a.check('cd <abs> && git status works (no ENOENT)', ok,
    ok ? '' : JSON.stringify(stripped.slice(-300)));
}

// 4. Negative-side: confirm the clone did NOT land at <cwd>/<abs>.
//    Pre-fix the "real" location was /home/user//tmp/gcap-target —
//    stat THAT and assert non-existence.
{
  const { output } = await t.run(`ls /home/user/tmp/gcap-target 2>&1`, 10_000);
  const stripped = stripAnsi(output);
  // Either ENOENT or just empty (the dir might not exist at all). Both
  // are fine — what we DON'T want is to find a .git there.
  const noLeak = !/HEAD/.test(stripped);
  a.check('repo did NOT leak into <cwd>//<abs>', noLeak,
    noLeak ? '' : JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
