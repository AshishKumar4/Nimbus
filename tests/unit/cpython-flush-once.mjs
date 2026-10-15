#!/usr/bin/env bun
// @tier slow — boots real CPython off local disk.
// `python -c`'s sys.stdout is flushed once as the program ends, as by the
// host's python3 -c: the interpreter flushes before each entry returns
// (nimbus_py_run), and the host does not flush again. A program whose
// stdout's flush writes a mark shows how many flushes it got, returning,
// raising and exiting with a status. Checked against the host's python3.
//
// Red before: every entry that returned was flushed again by the host, so
// each case printed the mark twice.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`cpython-flush-once: SKIPPED (${missing} not built)`);
  process.exit(0);
}

const MARKED = 'import os, sys\nclass Marked:\n    def write(self, s): return len(s)\n    def flush(self): os.write(1, b"F")\nsys.stdout = Marked()\nprint("x")\n';
const CASES = [
  ['returns', ''],
  ['raises', 'raise RuntimeError("x")\n'],
  ['exits with a status', 'raise SystemExit(7)\n'],
];

const host = {};
for (const [what, tail] of CASES) {
  const r = spawnSync('python3', ['-c', MARKED + tail], { encoding: 'utf8' });
  host[what] = { stdout: r.stdout, exitCode: r.status };
}

const { sql, transactions } = await hostSqlite();
const open = (options) => NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', ...options });
const seeded = await open({});
seedRuntime(seeded.vfs, RUNTIMES.find((r) => r.name === 'cpython'));
const ws = await open({ facets: localFacetHost(ISOLATE_NETWORK) });
const failed = [];
try {
  const user = ws.vfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 });
  for (const [what, tail] of CASES) {
    user.writeFile('home/user/p.py', MARKED + tail);
    const r = await ws.exec('python3 -c "$(cat p.py)"');
    const ours = { stdout: r.stdout, exitCode: r.exitCode };
    try {
      assert.deepEqual(ours, host[what]);
      console.log(`  ✓ ${what}: flushed as host python3 -c flushes`);
    } catch {
      failed.push(`${what}: host ${JSON.stringify(host[what])}, ours ${JSON.stringify(ours)} (stderr ${r.stderr.slice(-200)})`);
      console.log(`  ✗ ${what}`);
    }
  }
} finally {
  await ws.close();
  await seeded.close();
}
assert.deepEqual(failed, [], failed.join('\n'));
console.log('cpython-flush-once: ok');
