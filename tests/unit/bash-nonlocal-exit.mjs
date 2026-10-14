#!/usr/bin/env bun
// Behavior test: a non-local jump in the wasm bash lands where bash meant it
// to, however many copies of its jmp_buf bash made on the way.
//
// bash saves a jmp_buf by value before it nests (unwind_protect_jmp_buf in
// eval and source; COPY_PROCENV around traps and sourced files), sets it
// again, and on the way out restores the saved copy and longjmps through it.
// The runner used to take a re-setjmp of the same address as the end of the
// previous capture and reuse its storage, so the restored copy rewound into
// another capture: eval 'exit 7' ended 0, an EXIT trap's exit was lost, and
// code after a non-local transfer ran. Driven through REAL bash on the REAL
// staged wasm; every expectation is native bash's.

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';

const fs = { dirs: ['tmp'], modes: { tmp: 7 } };
const recurse = 'f(){ if [ "$1" -gt 0 ]; then f $(( $1 - 1 )); return $(( $? + 1 )); fi; return 0; }';
const cases = [
  { script: 'exit 7', exitCode: 7 },
  { script: "eval 'exit 7'", exitCode: 7 },
  { script: 'f(){ exit 5; }; f', exitCode: 5 },
  { script: '(exit 6)', exitCode: 6 },
  { script: 'trap "exit 4" EXIT; true', exitCode: 4 },
  { script: 'source <(echo "exit 3")', exitCode: 3 },
  { script: "printf 'exit 3\\n' > /tmp/x.sh; source /tmp/x.sh", exitCode: 3 },
  { script: 'eval "eval \\"exit 9\\""', exitCode: 9 },
  { script: "f(){ eval 'exit 8'; }; f", exitCode: 8 },
  { script: "set -e; eval 'false'; printf 'UNREACHABLE\\n'", exitCode: 1 },
  { script: "f(){ eval 'return 12'; printf 'UNREACHABLE\\n'; }; f", exitCode: 12 },
  { script: "eval 'false'", exitCode: 1 },
  // Each level's `return` longjmps through the return_catch its caller saved.
  // Deeper, the host engine's native stack overflows first (12 is the deepest
  // in-process bun takes).
  { script: `${recurse}; f 12; echo "depth $?"`, stdout: 'depth 12\n', exitCode: 0 },
  // Many captures in one shell, the old ones dead: each still lands right.
  { script: `g(){ return 3; }; n=0; for i in $(seq 1500); do eval 'n=$((n+1))'; g; s=$?; done; echo "$n $s"; eval 'exit 5'`, stdout: '1500 3\n', exitCode: 5 },
  // A capture taken before a fork is rewound in the child.
  { script: "( eval 'exit 11' ); echo \"sub $?\"; x=$(eval 'echo in; exit 2'); echo \"$x $?\"", stdout: 'sub 11\nin 2\n', exitCode: 0 },
];

const failures = [];
for (const c of cases) {
  const r = await runScript(c.script, fs);
  const got = { exitCode: r.exitCode, stdout: r.stdout, state: r.state };
  const want = { exitCode: c.exitCode, stdout: c.stdout ?? '', state: 'exited' };
  try { assert.deepEqual(got, want); console.log(`  ✓ ${c.script.slice(0, 90)}`); }
  catch { failures.push(`${c.script}: got ${JSON.stringify({ ...got, stderr: r.stderr.slice(-300), error: r.error })}, want ${JSON.stringify(want)}`); console.log(`  ✗ ${c.script.slice(0, 90)}`); }
}
assert.deepEqual(failures, []);
console.log(`bash-nonlocal-exit: ${cases.length} cases land where native bash lands`);
