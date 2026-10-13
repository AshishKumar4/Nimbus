#!/usr/bin/env bun
// Behavior test: a bash whose non-local jump lost its target says so; it
// never reports an exit status bash did not choose.
//
// bash saves jmp_bufs by value around eval, source and traps, and longjmps
// through the saved copies. Under the bash-runner@3 guest, the runner reuses a
// capture's storage when the same jmp_buf is set again, so such a jump can
// rewind into a stack that is not its own: the rewind never reaches a landing
// and _start returns mid-rewind. The runner took that return for exit 0, so
// eval 'exit 7' "exited 0". Each case below ends with the status native bash
// gives, or with the run named as having lost its rewind; never another
// status, silently. Driven through REAL bash on the REAL staged wasm.

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';

const fs = { dirs: ['tmp'], modes: { tmp: 7 } };
const cases = [
  { script: 'exit 7', exitCode: 7 },
  { script: "eval 'exit 7'", exitCode: 7 },
  { script: 'trap "exit 4" EXIT; true', exitCode: 4 },
  { script: "printf 'exit 3\\n' > /tmp/x.sh; source /tmp/x.sh", exitCode: 3 },
  { script: 'eval "eval \\"exit 9\\""', exitCode: 9 },
  { script: "f(){ eval 'exit 8'; }; f", exitCode: 8 },
  { script: "f(){ eval 'return 12'; printf 'UNREACHABLE\\n'; }; f", exitCode: 12 },
];
const LOST = /bash-runner: pid \d+ returned from _start mid-rewind, its longjmp or resume target lost/;

const failures = [];
let named = 0;
for (const c of cases) {
  const r = await runScript(c.script, fs);
  const right = r.state === 'exited' && r.exitCode === c.exitCode && !r.stdout.includes('UNREACHABLE');
  const refused = r.state === 'error' && LOST.test(r.error ?? '');
  if (refused) named++;
  if (right || refused) console.log(`  ✓ ${c.script} (${right ? `exit ${r.exitCode}` : 'named: lost rewind'})`);
  else { failures.push(`${c.script}: ${JSON.stringify({ state: r.state, exitCode: r.exitCode, stdout: r.stdout, error: r.error?.slice(0, 200) })}, want exit ${c.exitCode} or the lost rewind named`); console.log(`  ✗ ${c.script}`); }
}
assert.deepEqual(failures, []);
// The one this guards: eval 'exit 7' loses its rewind under @3.
assert.ok(named > 0, 'a lost rewind was named');
console.log(`bash-lost-rewind: ${cases.length} cases exit as bash chose or name the lost rewind (${named} named)`);
