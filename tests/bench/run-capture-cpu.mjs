#!/usr/bin/env bun
// A process's waves, CPU per arm: files made, and files rewritten, by a
// process whose run is captured (SqliteVFS.captureRun: a promotable
// one-shot's, whose first change of each key keeps the row it found) and by
// one whose run is not. A baseline without captureRun writes the same waves
// uncaptured. Independent module copies and databases for main, main's null
// arm, and head.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { hostSqlite } from '../unit/lib/host-sqlite.mjs';
import { cpuMs } from './lib/paired-cpu.mjs';
import { CORE_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const PID = 7;
const BODY = new TextEncoder().encode('0123456789abcdef'.repeat(4));
const NEW_BODY = new TextEncoder().encode('fedcba9876543210'.repeat(4));
let committed = 0;

/** A fresh database for each sample, with `rewrite` files there before the run. */
async function session({ 'vfs/sqlite-vfs.ts': { SqliteVFS }, 'runtime/process-files.ts': { ProcessFiles } }, rewrite) {
  const host = await hostSqlite();
  const engine = new SqliteVFS(host.sql, host.transactions);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/proj/old', { recursive: true });
  for (let i = 0; i < rewrite; i++) kernel.writeFile(`home/user/proj/old/${i}`, BODY);
  kernel.chown('home/user', USER.uid, USER.gid);
  kernel.chown('home/user/proj', USER.uid, USER.gid);
  kernel.chown('home/user/proj/old', USER.uid, USER.gid);
  for (let i = 0; i < rewrite; i++) kernel.chown(`home/user/proj/old/${i}`, USER.uid, USER.gid);
  return { engine, files: new ProcessFiles(engine), user: engine.as(USER) };
}

/** Waves of 100 writeFile ops by process PID: `made` new files, then each of `rewrite` old ones with other bytes. */
async function waves({ files, user }, made, rewrite) {
  const ops = [
    ...Array.from({ length: made }, (_, i) => `home/user/proj/new${i}`),
    ...Array.from({ length: rewrite }, (_, i) => `home/user/proj/old/${i}`),
  ].map((path) => ({ type: 'call', call: { call: 'writeFile', path, mode: 0o644, data: path.includes('/old/') ? NEW_BODY : BODY } }));
  for (let at = 0; at < ops.length; at += 100) {
    const group = ops.slice(at, at + 100);
    const answer = await files.waves.writeStream(user, encodeWriteBatchStream({ inodes: [], chunks: [], ops: group }), {
      sequence: { writer: 'w', first: at + 1, ack: at, pid: PID },
    });
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    committed += answer.committedOps;
  }
}

const WORK = {
  'made-captured': { capture: true, made: 1000, rewrite: 0 },
  'made-uncaptured': { capture: false, made: 1000, rewrite: 0 },
  'rewritten-captured': { capture: true, made: 0, rewrite: 400 },
  'rewritten-uncaptured': { capture: false, made: 0, rewrite: 400 },
};

await runPairedBenchmark({
  source: CORE_CPU_SOURCES.source,
  async run({ short, cleanup, withArms, sample }) {
    const scale = short ? 0.05 : 1;
    await withArms((from) => loadIsolatedCore(from, cleanup, {
      sources: CORE_CPU_SOURCES, modules: ['vfs/sqlite-vfs.ts', 'runtime/process-files.ts'],
    }), async (arms) => {
      for (const [kind, { capture, made, rewrite }] of Object.entries(WORK)) {
        await sample(kind, arms, async (modules) => {
          const s = await session(modules, Math.ceil(rewrite * scale));
          // A baseline has no capture: it writes the same waves as they were.
          if (capture && typeof s.engine.captureRun === 'function') s.engine.captureRun(PID);
          return cpuMs(() => waves(s, Math.ceil(made * scale), Math.ceil(rewrite * scale)));
        }, { pairs: 30, warm: 4, iterations: 1 });
      }
    });
    assert.ok(committed > 0);
  },
});
