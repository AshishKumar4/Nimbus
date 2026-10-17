#!/usr/bin/env bun
// Writes through a process's descriptions, CPU per arm: many small appends to
// one file, the same in a subtree the process holds, and many files each
// opened, written once and closed. Independent module copies and databases
// for main, main's null arm, and head.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { hostSqlite } from '../unit/lib/host-sqlite.mjs';
import { cpuMs } from './lib/paired-cpu.mjs';
import { CORE_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const PIECE = new TextEncoder().encode('0123456789abcdef'.repeat(4));
let checksum = 0;

/** A fresh database for each sample: what a sample writes would otherwise grow the next one's tree. */
async function session({ SqliteVFS, ProcessFiles }) {
  const host = await hostSqlite();
  const engine = new SqliteVFS(host.sql, host.transactions);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/proj', { recursive: true });
  kernel.chown('home/user', USER.uid, USER.gid);
  kernel.chown('home/user/proj', USER.uid, USER.gid);
  return new ProcessFiles(engine).bind({ pid: 7, cred: USER });
}

async function appendTo(proc, path, count) {
  const handle = await proc.open(path, { write: true, create: true, truncate: true, mode: 0o644 });
  for (let i = 0; i < count; i++) checksum += await proc.write(handle.id, null, PIECE);
  await proc.close(handle.id);
}

const WORK = {
  appends: (proc, short) => appendTo(proc, '/home/user/proj/log', short ? 500 : 20_000),
  async held(proc, short) {
    const grant = proc.acquireExclusiveMutation('/home/user/proj', { delegate: { reads: true, inos: 64, bytes: 1 << 26 } });
    await appendTo(proc, '/home/user/proj/held', short ? 500 : 20_000);
    proc.releaseExclusiveMutation(grant.owner);
  },
  async files(proc, short) {
    for (let i = 0; i < (short ? 50 : 1000); i++) await appendTo(proc, `/home/user/proj/f${i}`, 1);
  },
};

await runPairedBenchmark({
  source: CORE_CPU_SOURCES.source,
  async run({ short, cleanup, withArms, sample }) {
    await withArms((from) => loadIsolatedCore(from, cleanup), async (arms) => {
      for (const [kind, work] of Object.entries(WORK)) {
        await sample(kind, arms, async (modules) => {
          const proc = await session(modules);
          return cpuMs(() => work(proc, short));
        }, { pairs: 30, warm: 4, iterations: 1 });
      }
    });
    assert.ok(checksum > 0);
  },
});
