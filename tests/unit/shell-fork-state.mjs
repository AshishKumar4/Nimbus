#!/usr/bin/env bun
// A subshell, a pipeline element, $( ) and a background job each run in a
// child shell, as bash forks one: nothing the child changes (variables,
// arrays, cwd, options, traps, aliases, functions) reaches the parent, `exit`
// ends only the child, and the child runs its own EXIT trap. A background
// job's status survives the parent's later assignments, so `wait $p` returns
// it. Errexit is ignored in every command of an and-or list but the last.
// Each case's answer is what bash 5.3 prints on Linux.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const CASES = [
  ["(exit 4) & p=$!; sleep 0.2; wait $p; echo a=$?; wait $p; echo b=$?", "a=4\nb=4\n"],
  ["x=1; (sleep 0.1; x=2) & x=3; sleep 0.2; echo x=$x", "x=3\n"],
  ["cd /tmp; (cd /; sleep 0.1) & cd /home; sleep 0.2; pwd", "/home\n"],
  ["x=1; y=$(x=2; echo $x); echo x=$x y=$y", "x=1 y=2\n"],
  ["x=1; echo a | { read x; }; echo x=$x", "x=1\n"],
  ["f() { echo f; }; echo x | { g() { echo g; }; f; }; type g >/dev/null 2>&1 || echo no-g", "f\nno-g\n"],
  ["echo a | exit 3; echo after=$?", "after=3\n"],
  ["cd /tmp; (cd /; pwd); pwd", "/\n/tmp\n"],
  ["set -o pipefail; (set +o pipefail); false | true; echo pf=$?", "pf=1\n"],
  ["alias ll=ls; (unalias ll); alias", "alias ll='ls'\n"],
  ["(export Q=1); echo q=$Q", "q=\n"],
  ["x=1; (unset x); echo x=$x", "x=1\n"],
  ["a=(1 2); (a[5]=9); echo ${#a[@]}", "2\n"],
  ["(false; exit); echo e=$?", "e=1\n"],
  ["x=$(exit 5); echo s=$?", "s=5\n"],
  ["trap \"echo P\" EXIT; x=$(trap \"echo C\" EXIT; echo v); echo x=$x; { trap \"echo B\" EXIT; sleep 0.1; } & wait; echo a | { trap \"echo PL\" EXIT; cat; }; (trap \"echo S\" EXIT; exit 3); echo s=$?; trap - EXIT", "x=v C\nB\na\nPL\nS\ns=3\n"],
  ["trap \"echo P\" EXIT; (echo in); trap - EXIT", "in\n"],
  ["set -e; (false) || echo ok", "ok\n"],
  ["set -e; false && true; echo reached", "reached\n"],
  ["set -e; if (false; echo in); then echo t; fi", "in\nt\n"],
  ["set -e; (false; echo no); echo no2", ""],
];

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const failures = [];
for (const [script, want] of CASES) {
  const r = await ws.exec(script, { timeout: 20_000 });
  if (r.stdout !== want) failures.push(`${script}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`);
}
await ws.close();
for (const failure of failures) console.log(`FAIL ${failure}`);
assert.equal(failures.length, 0, `${failures.length} of ${CASES.length} cases differ from bash`);
console.log(`shell-fork-state: ${CASES.length} cases match bash`);
process.exit(0);
