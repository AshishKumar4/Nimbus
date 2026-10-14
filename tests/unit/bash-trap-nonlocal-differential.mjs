#!/usr/bin/env bun
// An ERR or RETURN trap that leaves its context (exit, return, a nonlocal
// status), differentially: each case runs under the host's native bash 5.2
// and under Nimbus's wasm bash, and must print the same stdout and end with
// the same status. These are the exits the runner's setjmp captures carry
// (bash-runner@5), across a trap's run_trap_cleanup and its unwind-protects.
//
// The native side runs in a child bounded in time and memory: a trap that
// starts itself again (a RETURN trap that runs `return`) grows without
// bound, so no such case is here, and any that slipped in ends at its cap.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runScript } from './lib/bash-preamble.mjs';

const NATIVE_TIMEOUT_MS = 5000;
const NATIVE_MEMORY_KIB = 256 * 1024;

const version = spawnSync('bash', ['--norc', '--noprofile', '-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8', timeout: NATIVE_TIMEOUT_MS });
assert.match(version.stdout ?? '', /^5\.2\./, `the reference is GNU bash 5.2 (found ${JSON.stringify(version.stdout)})`);

/** `script` under the host's bash, in a child capped at NATIVE_MEMORY_KIB of address space and NATIVE_TIMEOUT_MS. */
function native(script) {
  const run = spawnSync('bash', ['--norc', '--noprofile', '-c', `ulimit -v ${NATIVE_MEMORY_KIB} && exec bash --norc --noprofile -c "$1"`, 'native', script], {
    encoding: 'utf8', timeout: NATIVE_TIMEOUT_MS, killSignal: 'SIGKILL', cwd: '/tmp', env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LC_ALL: 'C' },
  });
  assert.equal(run.error, undefined, `native bash ran ${JSON.stringify(script)} within its bounds`);
  return { stdout: run.stdout, code: run.status };
}

async function wasm(script) {
  const r = await runScript(script, { dirs: ['tmp'], modes: { tmp: 7 } });
  assert.equal(r.state, 'exited', `${script}: ${r.error ?? r.stderr}`);
  return { stdout: r.stdout, code: r.exitCode };
}

const CASES = [
  // ERR: exit, with a status and without one (the failing command's).
  "trap 'exit 3' ERR; false; echo after",
  "trap exit ERR; false; echo after",
  "trap 'exit 7' ERR; eval false; echo after",
  // ERR in a function: return, with a status and without one.
  "f(){ trap 'return 4' ERR; false; echo after; }; f; echo \"f=$?\"",
  "f(){ trap return ERR; false; echo after; }; f; echo \"f=$?\"",
  "f(){ trap 'return 8' ERR; eval false; echo after; }; f; echo \"f=$?\"",
  // ERR inherited (set -E) into a function the trap leaves.
  "set -E; trap 'exit 5' ERR; g(){ false; echo in-g; }; f(){ g; echo in-f; }; f; echo after",
  "set -E; trap 'echo \"err $?\"' ERR; f(){ false; }; f; echo \"f=$?\"",
  // RETURN: a trap that reports, and one that exits the shell.
  "f(){ trap 'echo \"r $?\"' RETURN; return 3; }; f; echo \"f=$?\"",
  "f(){ trap 'exit 6' RETURN; return 3; }; f; echo after",
  "f(){ trap 'exit' RETURN; return 3; }; f; echo after",
  // RETURN after a sourced file returns.
  "printf 'return 2\\n' > /tmp/s.sh; trap 'echo \"R $?\"' RETURN; . /tmp/s.sh; echo \"s=$?\"",
];

const failures = [];
for (const script of CASES) {
  const expected = native(script);
  const actual = await wasm(script);
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ✓ ${script}`);
  } catch {
    failures.push(script);
    console.log(`  ✗ ${script}\n      native ${JSON.stringify(expected)}\n      wasm   ${JSON.stringify(actual)}`);
  }
}
assert.deepEqual(failures, []);
console.log(`bash-trap-nonlocal-differential: ok (${version.stdout.trim()})`);
