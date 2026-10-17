#!/usr/bin/env bun
// An alias is not expanded again within its own expansion (bash's rule): an
// alias that names itself (`alias ls='ls -l'`), two that name each other, one
// whose value runs its own name again later in a list, in a group, a
// subshell or a function it defines; and each expansion of a pipeline's
// commands is its own. Before, an alias naming itself expanded without end,
// and the session ran out of memory. Host bash is the oracle (stdout, status,
// stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const CASES = [
  "alias echo='echo X'\necho hi",
  "alias ls='ls -1'\nls; echo \"st=$?\"",
  "alias q='q'\nq; echo \"st=$?\"",
  "alias a=b b=a\na; echo \"st=$?\"",
  "alias x='echo 1; x'\nx; echo \"st=$?\"",
  "alias x='(x)'\nx; echo \"st=$?\"",
  "alias x='{ x; }'\nx; echo \"st=$?\"",
  "alias x='f() { x; }; f'\nx; echo \"st=$?\"",
  "alias p='printf [%s]'\np a | p b; echo",
  "alias p='printf [%s]'\np a; p b; echo",
  "alias l='echo L'\nalias m='l; l'\nm",
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `. */
const plainStderr = (text) => text.replace(/^bash: (?:-c: )?(?:line \d+: )?/gm, '');
const FILES = ['a.txt', 'b.txt'];
const bash = new Map();
for (const line of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-alias-recursion-'));
  try {
    for (const file of FILES) writeFileSync(join(dir, file), '');
    const r = spawnSync('bash', ['--norc', '--noprofile', '-O', 'expand_aliases', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    bash.set(line, { stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  let n = 0;
  for (const line of CASES) {
    const dir = `/home/user/al${n++}`;
    await ws.exec(`mkdir -p ${dir} && cd ${dir} && touch ${FILES.join(' ')}`, { cwd: '/home/user' });
    let ours;
    try {
      const r = await ws.exec(line, { cwd: dir, signal: AbortSignal.timeout(10_000) });
      ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    } catch (error) {
      ours = { error: String(error?.message ?? error) };
    }
    const theirs = bash.get(line);
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(theirs)}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-alias-recursion-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
