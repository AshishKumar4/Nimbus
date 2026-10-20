#!/usr/bin/env bun
// `export` and `readonly` are declaration builtins, as bash 5.2 has them: an
// argument written `name=(…)` is an array assignment (its elements and
// subscripts as an array literal's), the attribute taken with it, and one
// written `name=value` (theirs and declare's, typeset's, local's) expands
// as an assignment's value: not split, no pathname expansion; an
// exported array is no child's environment; a readonly one refuses a later
// literal; `readonly -p` prints each readonly variable as `declare -p` does,
// a declaration bash reads back. Before
// (ticket-lifo-export-readonly-array-literals), `readonly r=(1 2)` made the
// string "(1 2)", and `readonly -p` printed `readonly name=value`. Host bash
// is the oracle (stdout, status, stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LINES = [
  'readonly r=(1 2); declare -p r',
  'export e=([1]=x); declare -p e',
  'readonly r=(1); r=([2]=x)\necho "st=$?"; declare -p r',
  "export e=(1); env | grep -c '^e='; echo done",
  'y="a b"; export x=$y; readonly z=$y; declare -p x z',
  "readonly r=1 s=(a b); readonly -p | grep -E ' (r|s)='",
  'readonly a=([2]=x y) b=1; declare -p a b',
  'export n=([-1]=x z)\necho "st=$?"; declare -p n',
  'y="1 2"; export q=($y); declare -p q',
  'export -n e2=(1); declare -p e2',
  'readonly r3; r3=(1)\necho "st=$?"; declare -p r3',
  // A declaration's assignment argument expands as an assignment does: not split, no pathname expansion.
  'touch g1 g2; y="p  q"; declare d=$y e=g* f="$y"; local 2>/dev/null; export h=~/x; declare -p d e f; echo "$h"',
  // Brace expansion comes first; a quote in the name makes no assignment, its value then split.
  'export x={a,b}; declare -p x; y="a b"; export w""=$y; printf "<%s>\\n" "$w"; declare -p b; x""=1; echo "st=$?"',
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const want = [];
for (const line of LINES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-export-readonly-'));
  try {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8', HOME: '/home/user' } });
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

console.log(`shell-export-readonly-arrays-bash: ${LINES.length - failed.length} of ${LINES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
