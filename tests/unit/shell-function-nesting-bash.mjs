#!/usr/bin/env bun
// Shell function nesting is bounded. Where FUNCNEST is set, as bash bounds
// it: the call past it is refused with "maximum function nesting level
// exceeded (N)" on that call's stderr, and the rest of the line it is in is
// discarded (neither `||`, `if` nor a loop goes on): the shell goes on with
// the next line it reads (its own, a sourced file's) with $? 1, and a trap's
// action ends; a child shell (a subshell, a substitution, a pipeline's
// element, a background job) ends with 1. FUNCNEST is read at each call
// (`local`, a command's own assignment), and one that is not a number above
// 0 sets no bound. Each line runs as a session's line, and as host bash's
// `bash -c`, the oracle (stdout, status, stderr without bash's line prefix);
// an EXIT trap is a subshell's, which ends where a session's line does not.
//
// Where bash has no bound (FUNCNEST unset, or not a number above 0), bash
// recurses until its stack is gone and segfaults (status 139); the session
// refuses the 1001st nested call instead, as it would with FUNCNEST=1000,
// and a FUNCNEST above that is held to it. Before, a function that called
// itself ran until the session's heap was gone. The session's cases run in
// a child process bounded at 60 s: a runaway fills the heap in-process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const recurse = 'f() { echo "in $1"; f $(( $1 + 1 )); echo "back $1 st=$?"; }';
const runaway = 'f() { f; }';

/** Lines host bash answers. */
const BASH_CASES = [
  `FUNCNEST=3; ${recurse}; f 1; echo "end st=$?"`,
  `FUNCNEST=2; f() { echo "in $1"; (f $(( $1 + 1 )); echo "sub st=$?"); echo "after sub st=$?"; }; f 1; echo "end st=$?"`,
  `FUNCNEST=2; f() { echo "in $1"; x=$(f $(( $1 + 1 ))); echo "cs st=$? [$x]"; }; f 1`,
  'FUNCNEST=2; f() { g; echo "f st=$?"; }; g() { h; echo "g st=$?"; }; h() { echo h; }; f',
  'FUNCNEST=2; f() { local FUNCNEST=5; g; }; g() { h; }; h() { i; }; i() { echo i; }; f; echo "st=$?"',
  // FUNCNEST lowered below the depth reached: the refusal names the depth.
  'FUNCNEST=10; f() { g; }; g() { local FUNCNEST=1; h; }; h() { echo reached; }; f; echo "st=$?"',
  // A discarded line's status is PIPESTATUS's too, at the next line and in a subshell's EXIT trap.
  `FUNCNEST=1\n${runaway}\nfalse | true\nf\necho "$? \${PIPESTATUS[*]}"`,
  `( FUNCNEST=1; ${runaway}; trap 'echo "trap $? \${PIPESTATUS[*]}"' EXIT; false | true; f ); echo "st=$?"`,
  'FUNCNEST=1; f() { echo f; }; g() { f; }; g; echo "st=$?"',
  'f() { echo f; }; g() { f; }; FUNCNEST=1 g; echo "st=$?"',
  `( FUNCNEST=2; trap 'echo trapped' EXIT; ${runaway}; f; echo after ); echo "st=$?"`,
  `FUNCNEST=2; ${runaway}; f & wait $!; echo "bg st=$?"`,
  `FUNCNEST=2; ${runaway}; f | cat; echo "pipe st=\${PIPESTATUS[*]}"`,
  `FUNCNEST=2; ${runaway}; ( f ); echo "sub st=$?"`,
  `FUNCNEST=2; ${runaway}; { f; echo in-group; }; echo after`,
  `FUNCNEST=2\n${runaway}\nf\necho "next st=$?"`,
  `FUNCNEST=2\n${runaway}\nf || echo caught\necho "next st=$?"`,
  `FUNCNEST=2\n${runaway}\nif f; then echo t; else echo e; fi\necho "next st=$?"`,
  `FUNCNEST=2\n${runaway}\nfor i in 1 2; do f; echo "loop $i"; done\necho "next st=$?"`,
  `FUNCNEST=2\n${runaway}\nf; echo same-line\necho "next st=$?"\nf`,
  `FUNCNEST=2\n${runaway}\nif true; then\n f\n echo in-if\nfi\necho "next st=$?"`,
  `FUNCNEST=2\n${runaway}\nf &\nwait $!; echo "bg st=$?"`,
  `FUNCNEST=2\n${runaway}\ncat <<EOF\nhere\nEOF\nf; echo same-line\necho "next st=$?"`,
  `FUNCNEST=2; ${runaway}; source ./callf.sh; echo "after st=$?"`,
  `FUNCNEST=2; ${runaway}; g() { source ./callf.sh; echo "g after st=$?"; }; g; echo "end st=$?"`,
  `FUNCNEST=2; ${runaway}; ( source ./callf.sh; echo "sub after" ); echo "st=$?"`,
  `( FUNCNEST=2; ${runaway}; trap 'f; echo in-trap' EXIT; echo body ); echo "st=$?"`,
  `set -e; FUNCNEST=2; ${runaway}; f; echo after`,
  `FUNCNEST=1; ${runaway}; f 2>/dev/null; echo "st=$?"`,
  `FUNCNEST=1; f() { f 2>/dev/null; }; f; echo "st=$?"`,
  `FUNCNEST=2; ${runaway}; ( f ) 2>/dev/null; echo "st=$?"`,
  'FUNCNEST=0; f() { [ "$1" -lt 5 ] && f $(( $1 + 1 )) || echo "deep $1"; }; f 1',
  'FUNCNEST=abc; f() { [ "$1" -lt 5 ] && f $(( $1 + 1 )) || echo "deep $1"; }; f 1',
  'FUNCNEST=2x; f() { [ "$1" -lt 5 ] && f $(( $1 + 1 )) || echo "deep $1"; }; f 1',
  `FUNCNEST=' 2 '; ${recurse}; f 1`,
  `FUNCNEST=+2; ${recurse}; f 1`,
  `FUNCNEST=-2; f() { [ "$1" -lt 5 ] && f $(( $1 + 1 )) || echo "deep $1"; }; f 1`,
];

/** Lines bash has no answer for (it segfaults): the session's bound, as FUNCNEST=1000 would give it. */
const BOUND_CASES = [
  [`${runaway}; f; echo after`, { stdout: '', stderr: 'f: maximum function nesting level exceeded (1000)\n', status: 1 }],
  ['f() { if [ "$1" -lt 1000 ]; then f $(( $1 + 1 )); else echo "deep $1"; fi; }; f 1; echo "st=$?"', { stdout: 'deep 1000\nst=0\n', stderr: '', status: 0 }],
  [`FUNCNEST=100000; ${runaway}; f`, { stdout: '', stderr: 'f: maximum function nesting level exceeded (1000)\n', status: 1 }],
  [`FUNCNEST=0; ${runaway}; f`, { stdout: '', stderr: 'f: maximum function nesting level exceeded (1000)\n', status: 1 }],
  ["alias a=b\nb() { a; }\na; echo after", { stdout: '', stderr: 'b: maximum function nesting level exceeded (1000)\n', status: 1 }],
  [`${runaway}; ( f ); echo "sub st=$?"`, { stdout: 'sub st=1\n', stderr: 'f: maximum function nesting level exceeded (1000)\n', status: 0 }],
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, and a function's `environment: line 2: ` (the armada image's bash). */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const LINES = [...BASH_CASES, ...BOUND_CASES.map(([line]) => line)];
/** A file some lines source: a call, then a line after it. */
const CALLF = 'f\necho "in-source after f"\n';
const HEREDOC_END = 'NIMBUS_CASE_END';

if (process.argv[2] === '--session') {
  // The child: each line run in the session, answered as JSON on stdout.
  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
  const answers = [];
  try {
    let n = 0;
    for (const line of LINES) {
      const dir = `/home/user/fn${n++}`;
      await ws.exec(`mkdir -p ${dir} && cat > ${dir}/callf.sh <<'${HEREDOC_END}'\n${CALLF}${HEREDOC_END}`, { cwd: '/home/user' });
      const r = await ws.exec(line, { cwd: dir });
      answers.push({ stdout: r.stdout, stderr: r.stderr, status: r.exitCode });
    }
  } finally {
    await ws.close();
  }
  process.stdout.write(JSON.stringify(answers));
  process.exit(0);
}

const want = [];
for (const line of BASH_CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-function-nesting-'));
  try {
    writeFileSync(join(dir, 'callf.sh'), CALLF);
    const r = spawnSync('bash', ['--norc', '--noprofile', '-O', 'expand_aliases', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const [, answer] of BOUND_CASES) want.push(answer);

const child = await runBoundedProcess(process.execPath, [new URL(import.meta.url).pathname, '--session'], { timeoutMs: 60_000, maxOutputBytes: 1 << 20 });
assert.ok(child.ok, `the session's lines finished (${child.reason}): ${child.stderr.slice(-2000)}`);
const ours = JSON.parse(child.stdout);
const failed = [];
LINES.forEach((line, i) => {
  if (JSON.stringify(ours[i]) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  want: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours[i])}`);
});
console.log(`shell-function-nesting-bash: ${LINES.length - failed.length} of ${LINES.length} lines as bash's, or the bound's`);
assert.deepEqual(failed, [], `as bash, or the bound:\n${failed.join('\n')}`);
