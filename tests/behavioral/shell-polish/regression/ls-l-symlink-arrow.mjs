#!/usr/bin/env bun
// shell-polish/regression/ls-l-symlink-arrow — `ls -l <symlink>` MUST
// emit a row in `lrwxrwxrwx ... <name> -> <target>` shape, matching
// real bash / GNU ls.
//
// Verified GREEN on prod 1914938 (pre-wave) — adding the probe
// formally protects the surface for future waves. The fix-layer was
// src/shell/unix-commands.ts:mkLs (already complete via SHELL-FOLLOWUPS-R5
// SymlinkRegistry integration).
//
// Category: R (runtime-behavioral)

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-polish/ls-l-symlink-arrow');
console.log(`shell-polish/ls-l-symlink-arrow — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('cd /home/user', 5_000);
await t.run('rm -f sp-target.txt sp-mylink', 5_000);
await t.run('echo "hello" > sp-target.txt', 5_000);
await t.run('ln -s sp-target.txt sp-mylink', 5_000);

// 1. ls -l sp-mylink — must show `l...` mode + ` -> sp-target.txt`.
{
  const r = await t.run('ls -l sp-mylink', 10_000);
  const out = stripAnsi(r.output);
  // Look for a line starting with `l` (link mode) ending with ` -> sp-target.txt`.
  const arrowLine = out.split(/\r?\n/).find((l) => /^l.*sp-mylink\s*->\s*sp-target\.txt\s*$/.test(l.trim()));
  a.check('ls -l <symlink> emits `lrwxrwxrwx ... mylink -> target` line', arrowLine !== undefined,
    arrowLine !== undefined ? `line="${arrowLine.trim()}"` : JSON.stringify(out.slice(-400)));
}

// 2. ls -la (dir listing) MUST include the symlink with arrow shape too.
{
  const r = await t.run('ls -la /home/user | grep sp-mylink', 10_000);
  const out = stripAnsi(r.output);
  const arrowLine = out.split(/\r?\n/).find((l) => /^l.*sp-mylink\s*->\s*sp-target\.txt\s*$/.test(l.trim()));
  a.check('ls -la includes symlink with arrow shape', arrowLine !== undefined,
    arrowLine !== undefined ? `line="${arrowLine.trim()}"` : JSON.stringify(out.slice(-400)));
}

// 3. The mode prefix is `lrwxrwxrwx` (POSIX symlink convention).
{
  const r = await t.run('ls -l sp-mylink', 10_000);
  const out = stripAnsi(r.output);
  const has = /^lrwxrwxrwx/m.test(out);
  a.check('symlink mode is `lrwxrwxrwx`', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

// 4. readlink unchanged path.
{
  const r = await t.run('readlink sp-mylink', 5_000);
  const out = stripAnsi(r.output);
  const has = out.split(/\r?\n/).some((l) => l.trim() === 'sp-target.txt');
  a.check('readlink emits target verbatim', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
