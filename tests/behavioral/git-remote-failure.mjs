#!/usr/bin/env bun
// git-remote-failure — a git server that cannot be reached, or refuses, on
// the platform's own network, probed live against a deployed target.
//
// WHAT IT PROVES
//   What the Workers runtime answers for a host that does not resolve, and
//   for a repository GitHub will not show without credentials, reaches git
//   as git's own message and exit code: clone and fetch of
//   https://example.invalid/r.git exit 128 with "fatal: unable to access
//   'https://example.invalid/r.git/': …"; a clone of a repository that does
//   not exist on GitHub (GitHub answers 401 to anyone without credentials)
//   exits 128 with git's prompt failure, "fatal: could not read Username for
//   'https://github.com': terminal prompts disabled"; a pull, 1. Nothing is
//   left where a clone failed.

import { BASE, makeAsserter, mintSession, deleteSession, Terminal, stripAnsi } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('git-remote-failure');
console.log(`git-remote-failure — BASE=${BASE}`);
const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

/** A command's output and its exit code (the last RC=), timed. */
async function step(label, command, timeoutMs = 120_000) {
  const started = Date.now();
  const r = await t.run(`${command}; echo RC=$?`, timeoutMs);
  const out = stripAnsi(r.output);
  console.log(`  [${((Date.now() - started) / 1000).toFixed(2)}s] ${label}`);
  return { out, code: Number([...out.matchAll(/RC=(\d+)/g)].pop()?.[1]) };
}

try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const unresolved = await step('clone of a host that does not resolve', 'cd /home/user && git clone https://example.invalid/r.git');
  a.check('exits 128', unresolved.code === 128, unresolved.out.slice(-400));
  a.check('with git\'s "unable to access"', unresolved.out.includes("fatal: unable to access 'https://example.invalid/r.git/': "), unresolved.out.slice(-400));
  const left = await step('nothing left of it', 'test ! -e /home/user/r && echo GONE');
  a.check('nothing is left where it failed', /GONE/.test(left.out), left.out.slice(-200));

  const missing = await step('clone of a GitHub repository that does not exist', 'git clone https://github.com/nimbus-probe-no-such-owner/no-such-repo.git');
  a.check('exits 128', missing.code === 128, missing.out.slice(-400));
  a.check('with git\'s prompt failure', missing.out.includes("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), missing.out.slice(-400));

  await step('a repository whose origin does not resolve', 'mkdir -p /home/user/lr && cd /home/user/lr && git init -q && echo a > a && git add a && git -c user.name=a -c user.email=a@b commit -q -m one && git remote add origin https://example.invalid/r.git');
  const fetched = await step('fetch from it', 'git fetch');
  a.check('fetch exits 128 with "unable to access"', fetched.code === 128 && fetched.out.includes("fatal: unable to access 'https://example.invalid/r.git/': "), fetched.out.slice(-400));
  const pulled = await step('pull from it', 'git -c user.name=a -c user.email=a@b pull origin main');
  a.check('pull exits 1 with "unable to access"', pulled.code === 1 && pulled.out.includes("fatal: unable to access 'https://example.invalid/r.git/': "), pulled.out.slice(-400));
  const pushed = await step('push to it', 'git push origin main');
  a.check('push exits 128 with "unable to access"', pushed.code === 128 && pushed.out.includes("fatal: unable to access 'https://example.invalid/r.git/': "), pushed.out.slice(-400));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid, 'git-remote-failure').catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
