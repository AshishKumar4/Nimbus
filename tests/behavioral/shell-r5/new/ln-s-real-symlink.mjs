#!/usr/bin/env bun
// shell-r5/new/ln-s-real-symlink — SHELL-FOLLOWUPS-4.
//
// Pre-fix: `ln -s target link` performed a file COPY. Mutations to target
// did not appear via link; deleting target left the "link" intact with
// stale content. Broken for scripts that depend on symlink semantics
// (e.g. node_modules/.bin shims, /usr/lib alternatives).
//
// Post-fix: SymlinkRegistry stores (link → target) pairs; reads through
// the link resolve to the target's current content; deleting the target
// causes reads through the link to fail (ENOENT-style).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/new/ln-s-real-symlink');
console.log(`shell-r5/new/ln-s-real-symlink — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function body(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

// Setup: create a target file with known content.
await t.run('mkdir -p /tmp/lnst && cd /tmp/lnst', 5_000);
await t.run('echo "v1-content" > target.txt', 5_000);

// Probe 1: ln -s creates link; cat link returns target content.
const r1create = await t.run('ln -s target.txt link.txt', 5_000);
a.check('ln -s exits clean (no error output)',
  body(r1create.output) === '',
  `body=${JSON.stringify(body(r1create.output))}`);

const r1read = await t.run('cat link.txt', 5_000);
a.check('cat link → "v1-content"',
  body(r1read.output) === 'v1-content',
  `body=${JSON.stringify(body(r1read.output))}`);

// Probe 2: mutate target; reads through link see new content (proves
// link is not a copy).
await t.run('echo "v2-content" > target.txt', 5_000);
const r2 = await t.run('cat link.txt', 5_000);
a.check('cat link after target rewrite → "v2-content" (NOT stale "v1-content")',
  body(r2.output) === 'v2-content',
  `body=${JSON.stringify(body(r2.output))}`);

// Probe 3: deleting target makes link reads fail.
await t.run('rm target.txt', 5_000);
const r3 = await t.run('cat link.txt 2>&1; echo EXIT:$?', 5_000);
const r3body = body(r3.output);
a.check('cat dangling-link → non-zero exit',
  /EXIT:[1-9]/.test(r3body),
  `body=${JSON.stringify(r3body)}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
