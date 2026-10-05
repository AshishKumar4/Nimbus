#!/usr/bin/env bun
// The Dynamic Worker ledger's deadlock protocol over every interleaving
// (lib/ledger-protocol-model.mjs, wired to production), for families whose
// children are shells beyond `sh -c 'node x'`: a builtin first
// (`sh -c 'sleep 1; node x'`), npm's script wrapper
// (`sh -c 'npm run build'`, build `node x && true`: a shell awaiting a shell
// awaiting the program), a background job beside a builtin
// (`sh -c 'node x & sleep 1; wait'`), and a pipeline whose second element
// ends the program after a builtin (`sh -c 'node x | (sleep 1; kill x)'`,
// the `kill` begun in the turn `sleep` ends in, or a later one), alone,
// beside queued children and other shells, and under another holder.
//
// The same two properties: never a refusal while a holder can progress, and
// always one when all are stuck, except where a background job is awaited
// by `wait`: by the session's account that is never the shell's only work,
// so such a family, truly stuck, waits (a known limit), and only safety is
// checked there.
//
// And mutants, each caught: the process table counting an await as a
// process's only work while it has other work (the background job's shell,
// its `sleep` running) refuses the job while the shell would go on. Between
// `sleep` and `kill`, the shell counting only its commands (no WorkThread)
// is wait-only for an instant: with the ledger deciding on that change's own
// path (both, as before) the program is refused in the turn `sleep` ends in;
// with the ledger deciding on a later turn, only when the `kill` begins on a
// later turn still. The shell's threads alone keep both.

import assert from 'node:assert/strict';
import { CommandsOnly, PRODUCTION, checkFamilies, describe, explore } from './lib/ledger-protocol-model.mjs';

const families = [
  [{ parent: 'R', children: ['f'] }],
  [{ parent: 'R', children: ['f', 'q'] }],
  [{ parent: 'R', children: ['f', 'b'] }],
  [{ parent: 'R', children: ['f'] }, { parent: 'R', children: ['s'] }],
  [{ parent: 'R', children: ['f'] }, { parent: 0, children: ['q'] }],
  [{ parent: 'R', children: ['n'] }],
  [{ parent: 'R', children: ['n', 'q'] }],
  [{ parent: 'R', children: ['n', 'b'] }],
  [{ parent: 'R', children: ['n'] }, { parent: 'R', children: ['n'] }],
  [{ parent: 'R', children: ['n'] }, { parent: 0, children: ['n'] }],
  [{ parent: 'R', children: ['n'] }, { parent: 'R', children: ['f'] }],
  [{ parent: 'R', children: ['g'] }],
  [{ parent: 'R', children: ['g', 'q'] }],
  [{ parent: 'R', children: ['g'] }, { parent: 'R', children: ['q'] }],
  [{ parent: 'R', children: ['g'] }, { parent: 0, children: ['s'] }],
  [{ parent: 'R', children: ['k'] }],
  [{ parent: 'R', children: ['k', 'q'] }],
  [{ parent: 'R', children: ['k'] }, { parent: 0, children: ['q'] }],
  [{ parent: 'R', children: ['K'] }],
  [{ parent: 'R', children: ['K', 'q'] }],
  [{ parent: 'R', children: ['K'] }, { parent: 0, children: ['q'] }],
  [{ parent: 'R', children: ['k'] }, { parent: 'R', children: ['K'] }],
];

await checkFamilies(families);

// An await counted as the only work of a process that has other work.
const mutant = {
  ...PRODUCTION,
  patchProcesses(processes) {
    processes.awaitsOnly = function awaitsOnly(pid) {
      const children = this.awaiting.get(pid);
      return children && children.size > 0 ? [...children.keys()] : null;
    };
  },
};
const { found } = await explore(mutant, [{ parent: 'R', children: ['g'] }], { maxStates: 500_000 });
assert.ok(found.length > 0, 'the model catches a mutant that counts an await as the only work of a busy shell');
assert.match(found[0].violation, /refused .* while a holder could still make progress/);
console.log(`  caught: an await counted as a busy shell's only work (${found[0].violation}; ${describe(found[0].path)})`);

// The gap between two steps of a line, against each half of what closes it.
const halves = [
  ['commands only, deciding on the change\'s path (before)', { WorkThread: CommandsOnly, decideLater: false }, { k: true, K: true }],
  ['commands only, deciding on a later turn', { WorkThread: CommandsOnly }, { k: false, K: true }],
  ['threads, deciding on the change\'s path', { decideLater: false }, { k: false, K: false }],
];
for (const [name, pieces, caught] of halves) {
  for (const kind of ['k', 'K']) {
    const result = await explore({ ...PRODUCTION, ...pieces }, [{ parent: 'R', children: [kind] }, { parent: 0, children: ['q'] }], { maxStates: 500_000 });
    if (!caught[kind]) {
      assert.deepEqual(result.found, [], `${name}, ${kind}: safe`);
      continue;
    }
    assert.ok(result.found.length > 0, `${name}, ${kind}: the model catches the refusal between \`sleep\` and \`kill\``);
    assert.match(result.found[0].violation, /refused .* while a holder could still make progress/);
    console.log(`  caught: ${name}, ${kind} (${result.found[0].violation}; ${describe(result.found[0].path)})`);
  }
}

console.log('ok - dynamic-worker-protocol-model-shells (a builtin first, npm script wrappers, background jobs, a pipeline that kills its program: safe, and live where the session can tell)');
