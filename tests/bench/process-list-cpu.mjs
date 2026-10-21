#!/usr/bin/env bun
// Independent module copies and databases for main, main's null arm, and head.
import assert from 'node:assert/strict';
import { hostSqlite } from '../unit/lib/host-sqlite.mjs';
import { cpuMs } from './lib/paired-cpu.mjs';
import { CORE_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

let checksum = 0;

async function make({ 'vfs/sqlite-vfs.ts': { SqliteVFS }, 'runtime/process-files.ts': { ProcessFiles }, 'runtime/os-contracts.ts': { CRED_KERNEL } }, size) {
  const host = await hostSqlite();
  const engine = new SqliteVFS(host.sql, host.transactions);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('tree');
  for (let offset = 0; offset < size; offset += 64) {
    root.writeBatch({ inodes: Array.from({ length: Math.min(64, size - offset) }, (_, i) => ({
      path: `tree/f${String(offset + i).padStart(6, '0')}`, parentPath: 'tree', isDir: false,
      size: 0, mtime: 1, mode: 0o644, chunkCount: 0, uid: 0, gid: 0,
    })), chunks: [] });
  }
  root.writeFile('tree/mutated', 'initial');
  const files = new ProcessFiles(engine);
  const bridge = files.bind({ pid: 71, cred: CRED_KERNEL });
  const page = await bridge.list(null, 256);
  return { engine, root, files, bridge, kernel: CRED_KERNEL, writes: 0, nextPid: 72 };
}

async function cpu(arm, kind, iterations) {
  const cursor = arm.bridge.acquire(null).position;
  if (kind === 'acquire-one') arm.root.writeFile('tree/mutated', `write-${++arm.writes}`);
  return cpuMs(async () => {
    for (let i = 0; i < iterations; i++) {
      if (kind === 'cold-first-list') {
        const pid = arm.nextPid++;
        const bridge = arm.files.bind({ pid, cred: arm.kernel });
        const page = await bridge.list(null, 256);
        checksum += page.entries.length;
        await arm.files.releaseProcess(pid);
      } else if (kind === 'first-list') {
        const page = await arm.bridge.list(null, 256);
        checksum += page.entries.length;
      } else {
        const answer = arm.bridge.acquire(cursor, { namespace: true });
        assert.equal(answer.poison, false);
        assert.equal(answer.paths.length > 0, kind === 'acquire-one');
        checksum += answer.position.feeds['/'].cursor + answer.paths.length;
      }
    }
  });
}

await runPairedBenchmark({
  async run({ short, cleanup, withArms, sample }) {
    const count = (kind) => kind === 'cold-first-list' ? (short ? 2 : 20) : kind === 'first-list' ? (short ? 4 : 80) : (short ? 64 : 2000);
    await withArms((from) => loadIsolatedCore(from, cleanup, {
      sources: CORE_CPU_SOURCES, modules: ['vfs/sqlite-vfs.ts', 'runtime/process-files.ts', 'runtime/os-contracts.ts'],
    }), async (modules) => {
      for (const [label, size] of [['small', 64], ['large', 8192]]) {
        await withArms((loaded) => make(loaded, size), async (arms) => {
          for (const kind of ['acquire-none', 'acquire-one', 'first-list', 'cold-first-list']) {
            await sample(`${label}/${kind}`, arms, (arm) => cpu(arm, kind, count(kind)), { pairs: 30, warm: 8, iterations: count(kind) });
          }
        }, { from: modules, dispose: (arm) => arm.files.releaseProcess(71) });
      }
    });
    assert.ok(checksum > 0);
  }
});
