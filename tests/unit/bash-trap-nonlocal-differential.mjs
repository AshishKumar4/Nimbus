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
import { assertMatchesNativeBash } from './lib/native-bash.mjs';

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
  // RETURN: a trap that reports, and one that exits the shell.
  "f(){ trap 'echo \"r $?\"' RETURN; return 3; }; f; echo \"f=$?\"",
  "f(){ trap 'exit 6' RETURN; return 3; }; f; echo after",
  "f(){ trap 'exit' RETURN; return 3; }; f; echo after",
  // RETURN after a sourced file returns.
  "printf 'return 2\\n' > /tmp/s.sh; trap 'echo \"R $?\"' RETURN; . /tmp/s.sh; echo \"s=$?\"",
];

const version = await assertMatchesNativeBash(CASES);
console.log(`bash-trap-nonlocal-differential: ok (${version})`);
