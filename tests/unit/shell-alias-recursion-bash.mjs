#!/usr/bin/env bun
// An alias is not expanded again as a command word read from its own
// replacement text (bash's rule, a read-time one): an alias that names itself
// (`alias ls='ls -l'`), two that name each other, one whose text runs its own
// name later in a list, a group, a subshell or a function it defines (which
// keeps the rule when called later, the alias redefined since). A later
// parse starts afresh: a command substitution's, and a function defined
// before, which an alias's call may run into its own name again. Before, an
// alias naming itself expanded without end and the session ran out of
// memory. Host bash is the oracle (stdout, status, stderr without bash's
// line prefix).
//
// The session's cases run in a child process with a 60 s bound: a runaway
// expansion fills the heap without yielding to a timer in-process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';
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
  "alias x='f() { echo in-f; x; }; f'\nx; echo \"st=$?\"; alias x='echo redefined'; f; echo \"st=$?\"",
  "alias x='if test \"$guard\" = once; then echo end; else guard=once; echo \"$(x)\"; fi'\nx",
  "alias a=b\nb() { echo \"$1\"; if test \"$1\" = 1; then a 2; fi; }\na 1",
  "alias x='echo X'\nf() { x; }\nf",
  "alias p='printf [%s]'\np a | p b; echo",
  "alias p='printf [%s]'\np a; p b; echo",
  "alias l='echo L'\nalias m='l; l'\nm",
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, and a function's `environment: line 2: ` (the armada image's bash). */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');
const FILES = ['a.txt', 'b.txt'];

if (process.argv[2] === '--session') {
  // The child: each case in the session, answered as JSON on stdout.
  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
  const answers = [];
  try {
    let n = 0;
    for (const line of CASES) {
      const dir = `/home/user/al${n++}`;
      await ws.exec(`mkdir -p ${dir} && cd ${dir} && touch ${FILES.join(' ')}`, { cwd: '/home/user' });
      const r = await ws.exec(line, { cwd: dir });
      answers.push({ stdout: r.stdout, stderr: r.stderr, status: r.exitCode });
    }
  } finally {
    await ws.close();
  }
  process.stdout.write(JSON.stringify(answers));
  process.exit(0);
}

const bash = [];
for (const line of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-alias-recursion-'));
  try {
    for (const file of FILES) writeFileSync(join(dir, file), '');
    const r = spawnSync('bash', ['--norc', '--noprofile', '-O', 'expand_aliases', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    bash.push({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const child = await runBoundedProcess(process.execPath, [new URL(import.meta.url).pathname, '--session'], { timeoutMs: 60_000, maxOutputBytes: 1 << 20 });
assert.ok(child.ok, `the session's cases finished (${child.reason}): ${child.stderr.slice(-2000)}`);
const ours = JSON.parse(child.stdout);
const failed = [];
CASES.forEach((line, i) => {
  if (JSON.stringify(ours[i]) !== JSON.stringify(bash[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(bash[i])}\n  ours: ${JSON.stringify(ours[i])}`);
});
console.log(`shell-alias-recursion-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
