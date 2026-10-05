#!/usr/bin/env bun
// git-clone-scale — invariant: a depth-1 clone of a mid-size repository
// (next.js: ~34,000 files, ~210 MB) completes in bounded time, leaves the
// worktree git's (the commit GitHub served, files byte-equal to GitHub's at
// that commit, every indexed path present), and `git status` reports it
// clean, in bounded time, with the session still up afterwards.
//
// Before the streaming pack layer: next.js took 147 s, TypeScript failed
// (CPU limit, then a session reset), Linux failed (memory limit). The first
// status after a large clone reset the session (out of memory).

import { execFileSync } from 'node:child_process';

import { mintSession, Terminal, makeAsserter, stripAnsi } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('git-clone-scale');
console.log(`git-clone-scale — ${process.env.BASE}`);

const REPO = 'https://github.com/vercel/next.js';
const CLONE_BOUND_MS = 240_000;
const STATUS_BOUND_MS = 120_000;
/** Files compared byte for byte with GitHub's copy at the cloned commit. */
const SAMPLES = ['package.json', 'packages/next/package.json', 'turbopack/crates/turbopack/Cargo.toml'];

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. The clone, bounded.
const started = Date.now();
const clone = stripAnsi((await t.run(`git clone --depth 1 ${REPO} repo; echo CLONE_RC=$?`, CLONE_BOUND_MS + 60_000)).output);
const cloneMs = Date.now() - started;
a.check('git clone --depth 1 exits 0', /CLONE_RC=0/.test(clone), JSON.stringify(clone.slice(-500)));
a.check(`the clone finishes within ${CLONE_BOUND_MS / 1000} s`, cloneMs < CLONE_BOUND_MS, `${cloneMs} ms`);

// 2. It holds the commit GitHub serves (the branch moves: either side of the clone).
const head = (stripAnsi((await t.run('cd repo && git rev-parse HEAD', 30_000)).output).match(/\b[0-9a-f]{40}\b/) ?? [''])[0];
const remote = () => execFileSync('git', ['ls-remote', REPO, 'HEAD'], { encoding: 'utf8' }).split(/\s/)[0];
const before = remote();
a.check('HEAD is the commit GitHub serves for HEAD', head !== '' && (head === before || head === remote()), `head=${head} remote=${before}`);

// 3. Files byte-equal to GitHub's at that commit.
for (const path of SAMPLES) {
  const expected = await (await fetch(`https://raw.githubusercontent.com/vercel/next.js/${head}/${path}`)).text();
  const got = stripAnsi((await t.run(`wc -c < ${path}; cksum < ${path}`, 30_000)).output);
  const local = execFileSync('cksum', { input: expected, encoding: 'utf8' }).trim().split(/\s+/);
  a.check(`${path} matches GitHub's at ${head.slice(0, 7)}`,
    got.includes(`${local[0]} ${local[1]}`),
    `ours ${JSON.stringify(got.slice(-120))}, github cksum ${local.join(' ')}`);
}

// 4. Every indexed path is in the worktree.
{
  const out = stripAnsi((await t.run(
    `echo INDEXED=$(git ls-files | wc -l) PRESENT=$(git ls-files | while read -r p; do [ -e "$p" ] || [ -L "$p" ] || echo missing; done | wc -l)`,
    STATUS_BOUND_MS)).output);
  const indexed = Number((out.match(/INDEXED=(\d+)/) ?? [])[1]);
  const missing = Number((out.match(/PRESENT=(\d+)/) ?? [])[1]);
  a.check('the index lists the tree (over 20,000 paths)', indexed > 20_000, out.slice(-200));
  a.check('every indexed path exists', missing === 0, `${missing} missing`);
}

// 5. git status is clean, bounded, and the session survives it.
{
  const statusStarted = Date.now();
  const out = stripAnsi((await t.run('git status; echo STATUS_RC=$?', STATUS_BOUND_MS + 30_000)).output);
  const statusMs = Date.now() - statusStarted;
  a.check('git status: nothing to commit, working tree clean', /nothing to commit, working tree clean/.test(out) && /STATUS_RC=0/.test(out),
    JSON.stringify(out.slice(-400)));
  a.check(`git status finishes within ${STATUS_BOUND_MS / 1000} s`, statusMs < STATUS_BOUND_MS, `${statusMs} ms`);
  const alive = stripAnsi((await t.run('echo STILL_HERE', 30_000)).output);
  a.check('the session is still up after status', /STILL_HERE/.test(alive), JSON.stringify(alive.slice(-200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
