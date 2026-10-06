#!/usr/bin/env bun
// The shell's builtins (declare, read, export) and its assignments write
// variables through one store (shell/variables.ts), so they agree, as bash
// does: a readonly name refuses every writer; a plain assignment to an
// array lands on element 0, `+=` appends to it; a subscripted one promotes a
// scalar; `(…)` replaces the name's value, `+=(…)` appends elements; `local`
// and a prefix assignment put the whole binding back. Main passes this too:
// it guards the refactor that moved these rules into one module. Expected
// output is bash 5.2's.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const r = await ws.exec([
    'a=(x y z); a=Q; echo "${a[@]}"',
    'declare b=(1 2); b+=3; echo "${b[@]}"',
    's=one; s[2]=three; echo "${s[@]}" "${#s[@]}"',
    'readonly r=1', 'r=2', 'echo "r=$?"', 'declare r=3; echo "d=$?"', 'echo x | { read r; echo "read=$?"; }',
    'f() { local a=L; echo "$a"; }; f; echo "${a[@]}"',
    'v=1 env | grep -c "^v=1$"; echo "${v-unset}"',
    'c=(p q); c+=(r); echo "${c[@]}"',
  ].join('\n'));
  assert.equal(r.stdout, 'Q y z\n13 2\none three 2\nr=1\nd=1\nread=1\nL\nQ y z\n1\nunset\np q r\n');
  assert.equal(r.stderr, 'r: readonly variable\n'.repeat(3));
} finally {
  await ws.close();
}
console.log('shell-variable-store: ok');
