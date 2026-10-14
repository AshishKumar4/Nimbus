#!/usr/bin/env bun
// What runs after an ERR or RETURN trap, differentially against the host's
// native bash 5.2: the same trap again, an eval, a command substitution, and
// set -E's ERR trap in a function and then at its caller. Each must print the
// same stdout and end with the same status. A trap saves the parser's state
// and restores it after; anything that writes past a small object on the
// stack in between (a signal set wider than its type) restores a corrupted
// state, and every later parse fails.
import { assertMatchesNativeBash } from './lib/native-bash.mjs';

const CASES = [
  // set -E: the ERR trap runs in the function, then at its caller.
  "set -E; trap 'echo \"err $? ${FUNCNAME[0]:-top}\"' ERR; f(){ false; }; f; echo \"f=$?\"",
  "set -E; trap 'echo \"err ${FUNCNAME[0]:-top}\"' ERR; g(){ false; }; f(){ g; }; f; echo end",
  // An ERR trap runs each time a command fails.
  "trap 'echo e' ERR; false; false; echo end",
  // What is parsed after an ERR trap: an eval and a command substitution.
  "trap ':' ERR; false; eval 'echo x'; echo \"$(echo z)\"",
  "trap ':' ERR; false; eval 'if true; then echo y; fi'",
  // A RETURN trap (set -T), twice, and what is parsed after it.
  "f(){ :; }; trap 'echo r' RETURN; set -T; f; f; echo \"$(echo z)\"",
];

const version = await assertMatchesNativeBash(CASES);
console.log(`bash-trap-repeat-differential: ok (${version})`);
