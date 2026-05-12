#!/usr/bin/env bun
// shell-r6/new/ls-l-symlink-shows-arrow — SHELL-R6-B4.
//
// Pre-fix: `ls -l` after `ln -s t.txt l.txt` showed ONLY t.txt
// because lifo-sh's ls uses vfs.readdirStat which doesn't know about
// our SymlinkRegistry sidecar.
//
// Post-fix: our mkLs reads the dir AND merges SymlinkRegistry entries
// whose link path is in this dir; long format prints `lrwxrwxrwx ...
// link -> target`.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r6/new/ls-l-symlink-shows-arrow');
console.log(`shell-r6/new/ls-l-symlink-shows-arrow — ${process.env.BASE}`);

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

// Setup
await t.run('mkdir -p /tmp/r6ls && cd /tmp/r6ls', 5_000);
await t.run('echo data > t.txt', 5_000);
await t.run('ln -s t.txt l.txt', 5_000);

// Probe 1: `ls` shows BOTH t.txt AND l.txt.
const r1 = await t.run('ls', 5_000);
const r1body = body(r1.output);
a.check('ls — t.txt visible',
  /\bt\.txt\b/.test(r1body),
  `body=${JSON.stringify(r1body)}`);
a.check('ls — l.txt visible (symlink)',
  /\bl\.txt\b/.test(r1body),
  `body=${JSON.stringify(r1body)}`);

// Probe 2: `ls -l` shows symlink mode + arrow.
const r2 = await t.run('ls -l', 5_000);
const r2body = body(r2.output);
a.check('ls -l — symlink row has "lrwxrwxrwx"',
  /lrwxrwxrwx/.test(r2body),
  `body=${JSON.stringify(r2body)}`);
a.check('ls -l — symlink row has "l.txt -> t.txt"',
  /l\.txt\s*->\s*t\.txt/.test(r2body),
  `body=${JSON.stringify(r2body)}`);
a.check('ls -l — t.txt row has "-rw" prefix (regular file)',
  /^-rw[r-][w-][x-].* t\.txt/m.test(r2body),
  `body=${JSON.stringify(r2body)}`);

// Probe 3: targeting the symlink directly.
const r3 = await t.run('ls -l /tmp/r6ls/l.txt', 5_000);
const r3body = body(r3.output);
a.check('ls -l <symlink> — shows lrwxrwxrwx + arrow',
  /lrwxrwxrwx/.test(r3body) && /->/.test(r3body),
  `body=${JSON.stringify(r3body)}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
