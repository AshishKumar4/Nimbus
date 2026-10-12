#!/usr/bin/env bun
// @tier slow — boots real CPython off local disk.
// Behavior test: a WASI program on the shared WASI layer (the CPython runner's
// wasi-instance, which also runs any `\0asm` file) opens /dev/stdin,
// /dev/stdout, /dev/stderr, /dev/fd/N and /proc/self/fd/N as its own
// descriptors, as on Linux. bash's WASI processes are covered by
// bash-dev-fd.mjs; this is the same rule for every other WASI guest. Reading
// /dev/stdin is the probe's (runtime-primitives/new/wasi-dev-fd): under this
// local host a piped `python3 -c` reads no stdin at all, by sys.stdin either.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`wasi-dev-fd-bun: SKIPPED (${missing} not built)`);
  process.exit(0);
}

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const open = (options) => NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, cwd: '/home/user', ...options });
const seeded = await open({});
seedRuntime(seeded.vfs, RUNTIMES.find((r) => r.name === 'cpython'));
const ws = await open({ facets: localFacetHost(ISOLATE_NETWORK) });

ws.vfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }).writeFile('home/user/f.txt', 'in a file\n');
const py = (program) => `python3 -c ${JSON.stringify(program)}`;
const cases = [
  { command: py("import os; fd = os.open('f.txt', os.O_RDONLY); print(open('/dev/fd/%d' % fd).read().strip())"), stdout: 'in a file\n' },
  { command: py("import os; fd = os.open('f.txt', os.O_RDONLY); print(open('/proc/self/fd/%d' % fd).read().strip())"), stdout: 'in a file\n' },
  { command: py("f = open('/dev/stdout', 'w'); f.write('out\\n'); f.flush()"), stdout: 'out\n' },
  { command: `${py("f = open('/dev/stderr', 'w'); f.write('err\\n'); f.flush()")} 2>&1`, stdout: 'err\n' },
  { command: py("import os; print(os.path.exists('/dev/fd/1'), os.path.exists('/dev/fd/9'))"), stdout: 'True False\n' },
];

const failures = [];
for (const c of cases) {
  const r = await ws.exec(c.command);
  try { assert.deepEqual({ stdout: r.stdout, exitCode: r.exitCode }, { stdout: c.stdout, exitCode: 0 }); console.log(`  ✓ ${c.command}`); }
  catch { failures.push(`${c.command}: got ${JSON.stringify({ stdout: r.stdout, stderr: r.stderr.slice(-400), exitCode: r.exitCode })}`); console.log(`  ✗ ${c.command}`); }
}
assert.deepEqual(failures, []);
console.log(`wasi-dev-fd-bun: ${cases.length} cases answer as Linux does`);
