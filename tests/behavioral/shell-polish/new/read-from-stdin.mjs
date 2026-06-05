#!/usr/bin/env bun
// shell-polish/new/read-from-stdin — `read VAR < file` MUST set VAR
// to the first line of `file`. Pre-fix `read` was a no-op stub that
// always set VAR="" regardless of stdin:
//
//   $ echo hello > /tmp/r.txt
//   $ read x < /tmp/r.txt
//   $ echo "got=$x"
//   got=                 <-- expected "got=hello"
//
// Common bash idiom — `read -r VAR < /tmp/file` to load a single
// config line into a variable.
//
// Category: R (runtime-behavioral)

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-polish/read-from-stdin');
console.log(`shell-polish/read-from-stdin — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function hasOutputLine(stripped, marker) {
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  return lines.some((l) => l === marker);
}

// 1. read VAR < file — single-line file.
{
  await t.run('echo "hello-read-line" > /tmp/sp-read.txt', 5_000);
  const r = await t.run('read x < /tmp/sp-read.txt; echo "got=$x"', 10_000);
  const out = stripAnsi(r.output);
  const has = hasOutputLine(out, 'got=hello-read-line');
  a.check('read VAR < file sets VAR to first line', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

// 2. read VAR < file — multi-line file, only first line consumed.
{
  await t.run(`printf 'first-line\\nsecond-line\\n' > /tmp/sp-multi.txt`, 5_000);
  const r = await t.run('read x < /tmp/sp-multi.txt; echo "first=$x"', 10_000);
  const out = stripAnsi(r.output);
  const has = hasOutputLine(out, 'first=first-line');
  a.check('read VAR < multi-line-file consumes ONLY the first line', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

// 3. read with -r flag (raw — same observable behaviour as no flag
//    in our impl; verifies the flag is accepted, not rejected as a
//    bad arg).
{
  await t.run('echo "raw-line" > /tmp/sp-raw.txt', 5_000);
  const r = await t.run('read -r x < /tmp/sp-raw.txt; echo "raw=$x"', 10_000);
  const out = stripAnsi(r.output);
  const has = hasOutputLine(out, 'raw=raw-line');
  a.check('read -r VAR < file works (flag tolerated)', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

// 4. read VAR with no stdin → VAR stays empty and exit code is non-zero.
//    Matches bash: `read x < /dev/null; echo $?` prints "1".
{
  const r = await t.run('read x < /dev/null; echo "exit=$? var=[$x]"', 10_000);
  const out = stripAnsi(r.output);
  const has = hasOutputLine(out, 'exit=1 var=[]');
  a.check('read VAR < /dev/null sets var=[] and exit=1 (EOF)', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
