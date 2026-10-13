#!/usr/bin/env bun
// @tier slow — boots real CPython off local disk, under Bun and under Node.
// Behavior test: a WASI program on the shared WASI layer (the CPython runner's
// wasi-instance, which also runs any `\0asm` file) reads its stdin, and opens
// /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/N and /proc/self/fd/N as its
// own descriptors, as on Linux. bash's WASI processes are covered by
// bash-dev-fd.mjs; this is the same rule for every other WASI guest. The WASI
// layer reads every runtime's fd 0 from its process's input channel (it used
// to be wired for none but the generic wasm runner's, so CPython read an empty
// stdin). Run under Bun against the source and under Node against the built
// package (packages/core/dist), where localFacetHost answers stdin without
// parking.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`wasi-dev-fd-local: SKIPPED (${missing} not built)`);
  process.exit(0);
}

if (process.env.ENGINE_RUN === undefined) {
  const failed = [];
  for (const [engine, args] of [['bun', []], ['node', ['--no-warnings']]]) {
    const child = spawnSync(engine, [...args, fileURLToPath(import.meta.url)], { env: { ...process.env, ENGINE_RUN: engine }, encoding: 'utf8', timeout: 240_000 });
    process.stdout.write(child.stdout);
    if (child.status !== 0) { failed.push(engine); process.stdout.write(child.stderr.slice(-1500)); }
  }
  assert.deepEqual(failed, [], 'both engines');
  console.log('wasi-dev-fd-local: under Bun and Node');
  process.exit(0);
}

const underBun = typeof process.versions.bun === 'string';
const core = underBun ? '../../packages/core/src' : '../../packages/core/dist';
const ext = underBun ? 'ts' : 'js';
const { NimbusWorkspace } = await import(`${core}/workspace/nimbus-workspace.${ext}`);
const { localFacetHost } = await import(`${core}/runtime/local-facet-host.${ext}`);
const { ISOLATE_NETWORK } = await import(`${core}/_shared/workspace-network.${ext}`);

const { sql, transactions } = await hostSqlite();
const open = (options) => NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', ...options });
const seeded = await open({});
seedRuntime(seeded.vfs, RUNTIMES.find((r) => r.name === 'cpython'));
const ws = await open({ facets: localFacetHost(ISOLATE_NETWORK) });

ws.vfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }).writeFile('home/user/f.txt', 'in a file\n');
const py = (program) => `python3 -c ${JSON.stringify(program)}`;
const cases = [
  // Its stdin, read as fd 0 and by each name for it.
  { command: `printf 'line\\n' | ${py("import sys; print(sys.stdin.read().strip())")}`, stdout: 'line\n' },
  { command: `printf 'line\\n' | ${py("print(open('/dev/stdin').read().strip())")}`, stdout: 'line\n' },
  { command: `printf 'by-number\\n' | ${py("print(open('/dev/fd/0').read().strip())")}`, stdout: 'by-number\n' },
  { command: `printf 'proc\\n' | ${py("print(open('/proc/self/fd/0').read().strip())")}`, stdout: 'proc\n' },
  { command: py("import os; fd = os.open('f.txt', os.O_RDONLY); print(open('/dev/fd/%d' % fd).read().strip())"), stdout: 'in a file\n' },
  { command: py("import os; fd = os.open('f.txt', os.O_RDONLY); print(open('/proc/self/fd/%d' % fd).read().strip())"), stdout: 'in a file\n' },
  // Opened again, from its own start; the original reads on from where it was.
  { command: py("import os; fd = os.open('f.txt', os.O_RDONLY); os.read(fd, 3); print(open('/dev/fd/%d' % fd).read().strip()); print(os.read(fd, 100).decode().strip())"), stdout: 'in a file\na file\n' },
  { command: py("f = open('/dev/stdout', 'w'); f.write('out\\n'); f.flush()"), stdout: 'out\n' },
  { command: `${py("f = open('/dev/stderr', 'w'); f.write('err\\n'); f.flush()")} 2>&1`, stdout: 'err\n' },
  { command: py("import os; print(os.path.exists('/dev/fd/1'), os.path.exists('/dev/fd/9'))"), stdout: 'True False\n' },
];

const failures = [];
for (const c of cases) {
  const r = await ws.exec(c.command);
  try { assert.deepEqual({ stdout: r.stdout, exitCode: r.exitCode }, { stdout: c.stdout, exitCode: 0 }); console.log(`  ✓ ${process.env.ENGINE_RUN} ${c.command}`); }
  catch { failures.push(`${c.command}: got ${JSON.stringify({ stdout: r.stdout, stderr: r.stderr.slice(-400), exitCode: r.exitCode })}`); console.log(`  ✗ ${process.env.ENGINE_RUN} ${c.command}`); }
}
assert.deepEqual(failures, []);
console.log(`wasi-dev-fd-local: ${cases.length} cases answer as Linux does under ${process.env.ENGINE_RUN}`);
