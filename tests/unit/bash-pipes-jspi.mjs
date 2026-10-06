// @serial
// @tier slow — drives a local workerd; CI median 42 s wall, 45 s CPU, 1.6 GiB peak (6 runs, 2026-10-06)
// The wasm bash's pipes on the production engine (workerd, JSPI) behave as in
// real bash: a pipe holds 64 KiB and a writer past that waits, a writer whose
// readers are gone gets SIGPIPE (141 in $? and PIPESTATUS), and a pipeline
// whose output outruns any buffer still delivers all of it. Expected output
// is real bash 5.2 with GNU coreutils, the same on every run. Without JSPI
// (bun, node) the rules differ where a writer cannot wait; those cases are
// in core-wasm-runtime-bun.mjs and the rules themselves in
// pipes-refinement.mjs.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const loop = (n) => `i=0; while [ $i -lt ${n} ]; do echo "$(printf %0200d $i)"; i=$((i+1)); done`;
const cases = [
  ['yes | head -2; echo "${PIPESTATUS[*]}"', 'y\ny\n141 0\n'],
  ['while :; do echo y; done | head -3; echo "${PIPESTATUS[*]}"', 'y\ny\ny\n141 0\n'],
  ['yes | cat | head -1; echo "${PIPESTATUS[*]}"', 'y\n141 141 0\n'],
  ['x=$(yes | head -c 5); echo "[$x]"', '[y\ny\ny]\n'],
  ['seq 100000 | head -1; echo "${PIPESTATUS[*]}"', '1\n141 0\n'],
  ['seq 1000 | head -1; echo "${PIPESTATUS[*]}"', '1\n0 0\n'],
  ['seq 200000 | cat | wc -l; echo "${PIPESTATUS[*]}"', '200000\n0 0 0\n'],
  ['seq 100000 | cat | while read x; do :; done; echo "${PIPESTATUS[*]}"', '0 0 0\n'],
  ['seq 20000 | uniq -c | wc -l', '20000\n'],
  // A bash process forking on every iteration, its output well past a pipe.
  [`${loop(2000)} | wc -c`, '402000\n'],
  // More than any pipe or spill could hold.
  ['yes | head -c 80000000 | wc -c', '80000000\n'],
];

console.log('bash-pipes-jspi: starting local workerd');
const probe = await startLocalProbe();
try {
  console.log('bash-pipes-jspi: installing runtime and opening terminal');
  const terminal = await localTerminal(probe);
  try {
    for (const [command, want] of cases) {
      console.log(`bash-pipes-jspi: ${command}`);
      const r = await terminal.run(`bash -c '${command.replaceAll("'", "'\\''")}'`, 90_000);
      assert.equal(r.stdout.replace(/^\s+/gm, ''), want, command);
      assert.equal(r.status, 0, command);
    }
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log(`bash-pipes-jspi: ${cases.length} pipelines match real bash under JSPI`);
