#!/usr/bin/env bun
// A `#` begins a comment only where a word begins (at a line's start, or
// after a blank or an operator), as bash's reader has it; inside a word it is
// the word's own character: `z=2#11` assigns 2#11, `echo a#b` prints a#b,
// and the commands after them on the line run. The reader that says whether
// an interactive line goes on (continuationState) reads comments the same
// way: a quote after a `#` inside a word is still open. Before
// (ticket-lifo-hash-inside-word), a `#` anywhere ended its word and took the
// rest of the line as a comment, so `x=2#11; echo after` assigned 2 and
// printed nothing. Host bash is the oracle (stdout, status, stderr without
// bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { continuationState } from '../../packages/core/src/substrate/lifo/shell/lexer.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LINES = [
  'echo a#b c#; echo after',
  'x=2#11; echo "$x" $((x)); echo after',
  'echo #c\necho next',
  'echo a #c; echo hidden\necho next',
  'echo a;#c\necho next',
  'v=abc; set -- p q; echo ${#v} $# x#$#',
  '[[ a#b == a#b ]] && echo match; [[ a#b =~ ^a#b$ ]] && echo regex',
  'case a#b in a#b) echo case;; esac',
  'echo $((2#101))#x x#$((8#17))',
  'f() { echo in#f; }; f; echo after',
  'a=(x#1 y#); echo "${a[@]}" ${#a[@]}',
  "echo 'q#'\"r#\"s\\#t#",
  'for i in 1#2 3#; do echo $i; done',
  'echo x#$(echo y)#z',
  'echo a|#c\ncat </dev/null; echo next',
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const want = [];
for (const line of LINES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-hash-'));
  try {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [i, line] of LINES.entries()) {
    const r = await ws.exec(line, { cwd: '/home/user' });
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}

// An interactive line goes on where a quote is still open, a `#` inside a word no comment.
const continued = [
  ["echo a#'b", 'single'],
  ['echo a#"b', 'double'],
  ["echo a #'b", null],
  ["#'a", null],
  ["echo x;#'a", null],
  // A substitution's quotes are its own, after a `$#` or a `${#x}` too.
  ["echo $# \"$(printf '\"')\"", null],
  ["echo ${#x} \"${y:-\"a'b\"}\" `echo '\"'`", null],
  ["echo $# \"$(printf '\"')", 'double'],
];
for (const [line, state] of continued) {
  if (continuationState(line) !== state) failed.push(`continuationState(${JSON.stringify(line)}): ${continuationState(line)}, not ${state}`);
}

console.log(`shell-hash-in-word-bash: ${LINES.length + continued.length - failed.length} of ${LINES.length + continued.length} as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
