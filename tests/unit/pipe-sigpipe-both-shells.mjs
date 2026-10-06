#!/usr/bin/env bun
// @tier slow — long; CI median 66 s wall, 66 s CPU, 1.0 GiB peak (6 runs, 2026-10-06)
// SIGPIPE ends only the command that writes to a pipe nobody reads, in both
// shells (the JS workspace shell and the wasm bash): a brace group or loop
// goes on after it, with that command's status 141; a builtin writing there
// ends its own element (bash runs each element in a subshell). A writer that
// exits with more than a pipe's capacity unread is killed writing (141);
// one whose bytes all fit is not. PIPESTATUS holds every element's status.
// Each case's answer is what bash 5.3 prints on Linux (the same scripts,
// /tmp/big standing for any input larger than a pipe).
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { runScript } from './lib/bash-preamble.mjs';

const BIG = 'x'.repeat(76) + '\n';
const big = BIG.repeat(13_158); // ~1 MB of lines
const CASES = [
  ['{ cat /tmp/big; touch /tmp/mark; } | head -1 >/dev/null; test -f /tmp/mark && echo marked', 'marked\n'],
  ['for i in 1 2; do cat /tmp/big; echo i=$i >&2; done 2>/tmp/err | head -1 >/dev/null; cat /tmp/err', 'i=1\ni=2\n'],
  ['cat /tmp/big | head -1 >/dev/null; echo ${PIPESTATUS[*]}', '141 0\n'],
  ['head -c 100000 /tmp/big | head -c 1 >/dev/null; echo ${PIPESTATUS[*]}', '141 0\n'],
  ['head -c 1000 /tmp/big | head -c 1 >/dev/null; echo ${PIPESTATUS[*]}', '0 0\n'],
  ['while true; do echo y; done | head -2; echo ${PIPESTATUS[*]}', 'y\ny\n141 0\n'],
  ['true | false; echo ${PIPESTATUS[@]} $?', '0 1 1\n'],
  ['false; echo ${PIPESTATUS[0]} ${#PIPESTATUS[@]}', '1 1\n'],
  ['! true | false; echo ${PIPESTATUS[*]} $?', '0 1 0\n'],
  ['{ echo a; cat /tmp/big; echo z; } | head -1; echo ${PIPESTATUS[*]}', 'a\n141 0\n'],
  // Silently, whatever the writer (Main's review of 26c62866).
  ['yes | head -2; echo ${PIPESTATUS[*]}', 'y\ny\n141 0\n'],
  ['seq 100000 | head -1; echo ${PIPESTATUS[*]}', '1\n141 0\n'],
  ['seq 100000 | cat | head -1; echo ${PIPESTATUS[*]}', '1\n141 141 0\n'],
  // printf is a bash builtin: its write ends the loop's element.
  ['while :; do printf "y\\n"; done | head -1; echo ${PIPESTATUS[*]}', 'y\n141 0\n'],
  // A job waited for is reaped, so the next job takes its number (and kill hits it).
  ['sleep 1 & wait %1; sleep 5 & kill %1; wait %1; echo w=$?; sleep 1 & p=$!; wait $p; sleep 5 & kill %1; wait; echo end', 'w=143\nend\n'],
];

const failures = [];

// ── the JS workspace shell ──
{
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  await ws.fs.writeFile('/tmp/big', big);
  for (const [script, want] of CASES) {
    await ws.exec('rm -f /tmp/mark /tmp/err');
    const r = await ws.exec(script, { timeout: 20_000 });
    if (r.stdout !== want || r.stderr !== '') failures.push(`js shell: ${script}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`);
  }

  // An endless element still ends on Ctrl-C (the caller's signal), whether it
  // writes nothing or its writes keep dying (each `cat` gets SIGPIPE). The
  // pipeline's status is its last element's, which may already be 0.
  for (const script of ['while true; do :; done | head -1', 'while true; do cat /tmp/big; done | head -1 >/dev/null']) {
    const controller = new AbortController();
    const started = Date.now();
    const pending = ws.exec(script, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const r = await pending;
    if (Date.now() - started > 10_000) failures.push(`js shell: Ctrl-C did not end: ${script} (${r.exitCode})`);
  }
  // And `kill` of its job, the job numbers reused as bash reuses them.
  for (let round = 0; round < 2; round++) {
    const started = Date.now();
    const r = await ws.exec('(while true; do cat /tmp/big; done | head -1 >/dev/null) & sleep 0.2; kill %1; wait; echo waited');
    if (Date.now() - started > 10_000 || r.stdout !== 'waited\n') failures.push(`js shell: kill did not end the job: ${JSON.stringify(r)}`);
  }
  await ws.close();
}

// ── the wasm bash, over RPC with JSPI and in-process ──
// The in-process harness has no JSPI parking, like a Node 22 host: a WASI
// writer cannot wait on a full pipe, so seq reports 0 instead of GNU's 141.
// docs/architecture/nimbus-os-runtime-spec.md (runtime rules) states this
// host boundary. The RPC arm, which parks, asserts GNU's statuses.
const NEEDS_PARKING = new Set(['seq 100000 | cat | head -1; echo ${PIPESTATUS[*]}']);
for (const remote of [true, false]) {
  for (const [script, want] of CASES) {
    if (!remote && NEEDS_PARKING.has(script)) continue;
    const r = await runScript(script, { remote, files: { 'tmp/big': big } });
    if (r.stdout !== want || (r.stderr ?? '') !== '') failures.push(`wasm bash (${remote ? 'RPC' : 'in-process'}): ${script}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr ?? '').slice(0, 160)}`);
  }
}

for (const failure of failures) console.log(`FAIL ${failure}`);
assert.equal(failures.length, 0, `${failures.length} cases differ from bash`);
console.log('pipe-sigpipe-both-shells: ok');
