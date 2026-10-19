#!/usr/bin/env bun
// A resident's holder over a session double: independent measured modules,
// a fresh session per sample, and CPU before its final settle.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from '../unit/lib/sqlite-vfs-test-harness.mjs';
import { cpuMs } from './lib/paired-cpu.mjs';
import { HOLDER_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const TEN = new TextEncoder().encode('0123456789');
const KB = new Uint8Array(1024);
let checksum = 0;

function session(factory) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/proj', { recursive: true });
  kernel.chown('home/user', USER.uid, USER.gid);
  kernel.chown('home/user/proj', USER.uid, USER.gid);
  for (let i = 0; i < 4; i++) {
    kernel.mkdir(`home/user/proj/d${i}`);
    kernel.chown(`home/user/proj/d${i}`, USER.uid, USER.gid);
  }
  for (let i = 0; i < 50; i++) {
    kernel.writeFile(`home/user/proj/d3/f${i}.txt`, 'x'.repeat(100));
    kernel.chown(`home/user/proj/d3/f${i}.txt`, USER.uid, USER.gid);
  }
  const filesystem = new ProcessFiles(engine);
  const bridge = filesystem.bind({ pid: 7, cred: USER });
  const entryOf = (stat) => ({
    type: stat.type, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size,
    atime: stat.atime, mtime: stat.mtime, ctime: stat.ctime, mode: stat.mode,
    uid: stat.uid, gid: stat.gid, revision: stat.revision ?? 0, target: null,
  });
  const seen = new Map();
  const viewed = (key) => {
    if (!seen.has(key)) {
      let entry = null;
      let content;
      try { const stat = bridge.stat('/' + key, { followSymlinks: false }); entry = stat === null ? null : entryOf(stat); } catch {}
      try { content = bridge.readFile('/' + key) ?? undefined; } catch {}
      seen.set(key, { entry, content });
    }
    return seen.get(key);
  };
  const store = {
    device: bridge.stat('/').dev, cred: USER, ready: () => true,
    entry: (key) => viewed(key).entry,
    children: (key) => { try { return bridge.readdir('/' + key); } catch { return undefined; } },
    list: async () => true, lookup: async () => true, listTree: async () => false,
    content: (key) => viewed(key).content,
    fill: async (key) => bridge.readFile('/' + key),
    cursor: () => ({ epoch: engine.epoch, rev: engine.revision() }),
    barrier: async () => { seen.clear(); return true; },
    reserve: () => true, release: () => {},
  };
  const processSession = {
    openWriter: async () => null,
    writeBatchStream: async (stream, _fence, owner) => bridge.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner }),
    retireWriter: async () => {},
    published: async () => {},
    grants: {
      acquire: async (path, delegate) => bridge.acquireExclusiveMutation(path, { delegate }),
      release: async (owner) => { bridge.releaseExclusiveMutation(owner); },
      awaitRecall: (owner, waitMs) => bridge.awaitRecall(owner, waitMs),
      recalled: async (owner, kind) => { bridge.recalled(owner, kind); },
    },
  };
  const fs = factory(bridge, store, {
    session: processSession, grantAfter: 1,
    isHomeRoot: (key) => key.startsWith('home/') && !key.slice(5).includes('/'),
  });
  return { fs, dispose: () => harness.db.close() };
}

async function held(fs) {
  for (let i = 0; i < 20; i++) {
    const h = await fs.open(`/home/user/proj/d0/warm${i}`, { write: true, create: true, truncate: true, mode: 0o644 });
    await fs.write(h.id, null, TEN.subarray(0, 1));
    await fs.close(h.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(fs.stats().client.grants > 0, 'the warm-up did not take a grant');
}

const settled = async (value) => (value instanceof Promise ? await value : value);
const open = (fs, path) => fs.open(path, { write: true, create: true, truncate: true, mode: 0o644 });

const WORK = {
  async small(fs, short) {
    const h = await open(fs, '/home/user/proj/d0/small');
    return cpuMs(async () => {
      for (let i = 0; i < (short ? 500 : 20_000); i++) checksum += await settled(fs.write(h.id, null, TEN));
      await settled(fs.close(h.id));
    });
  },
  files: (fs, short) => cpuMs(async () => {
    for (let i = 0; i < (short ? 50 : 1000); i++) {
      const h = await settled(open(fs, `/home/user/proj/d0/f${i}`));
      checksum += await settled(fs.write(h.id, null, KB));
      await settled(fs.close(h.id));
    }
  }),
  async fresh(fs, short) {
    const h = await open(fs, '/home/user/proj/d1/log');
    return cpuMs(async () => {
      for (let i = 0; i < (short ? 200 : 5000); i++) checksum += await settled(fs.write(h.id, null, TEN));
      await settled(fs.close(h.id));
    });
  },
  async stats(fs, short) {
    for (let i = 0; i < 50; i++) await fs.stat(`/home/user/proj/d3/f${i}.txt`);
    return cpuMs(async () => {
      for (let n = 0; n < (short ? 4 : 200); n++) for (let i = 0; i < 50; i++) checksum += (await settled(fs.stat(`/home/user/proj/d3/f${i}.txt`))).size;
    });
  },
  // tar xf: each directory made, each member made, written, closed and given its time.
  async tar(fs, short) {
    const member = KB.subarray(0, 700);
    return cpuMs(async () => {
      for (let d = 0; d < (short ? 4 : 40); d++) {
        const dir = `/home/user/proj/x/d${d}`;
        await settled(fs.mkdir(dir, { recursive: true }));
        for (let f = 0; f < (short ? 5 : 50); f++) {
          const path = `${dir}/m${f}.txt`;
          const h = await open(fs, path);
          checksum += await settled(fs.write(h.id, null, member));
          await settled(fs.close(h.id));
          await settled(fs.utimes(path, 1_600_000_000_000, 1_600_000_000_000));
        }
      }
    });
  },
  // git checkout: each path looked up, its parents made, its file made exclusively, written, closed, and stat'd for the index.
  async checkout(fs, short) {
    const blob = KB.subarray(0, 500);
    const made = new Set();
    return cpuMs(async () => {
      for (let a = 0; a < (short ? 2 : 10); a++) {
        for (let b = 0; b < (short ? 2 : 10); b++) {
          for (let f = 0; f < (short ? 3 : 30); f++) {
            const dir = `/home/user/proj/w/a${a}/b${b}`;
            const path = `${dir}/f${f}.c`;
            checksum += (await settled(fs.stat(path, { followSymlinks: false }))) === null ? 1 : 0;
            if (!made.has(dir)) {
              await settled(fs.mkdir(dir, { recursive: true }));
              made.add(dir);
            }
            const h = await settled(fs.open(path, { write: true, create: true, exclusive: true, mode: 0o644 }));
            checksum += await settled(fs.write(h.id, null, blob));
            await settled(fs.close(h.id));
            checksum += (await settled(fs.stat(path, { followSymlinks: false }))).size;
          }
        }
      }
    });
  },
  async reads(fs, short) {
    for (let i = 0; i < 50; i++) await fs.readFile(`/home/user/proj/d3/f${i}.txt`);
    return cpuMs(async () => {
      for (let n = 0; n < (short ? 4 : 200); n++) for (let i = 0; i < 50; i++) checksum += (await settled(fs.readFile(`/home/user/proj/d3/f${i}.txt`))).byteLength;
    });
  },
};

await runPairedBenchmark({
  source: HOLDER_CPU_SOURCES.source,
  async run({ short, cleanup, withArms, sample }) {
    await withArms((from) => loadIsolatedCore(from, cleanup, {
      sources: HOLDER_CPU_SOURCES, modules: ['runtime/wasi/resident-filesystem.ts'],
    }), async (arms) => {
      for (const [kind, work] of Object.entries(WORK)) {
        await sample(kind, arms, async ({ 'runtime/wasi/resident-filesystem.ts': { residentFilesystem } }) => {
          const s = session(residentFilesystem);
          try {
            await held(s.fs);
            return await work(s.fs, short);
          } finally {
            try { assert.deepEqual(await s.fs.settle(), []); } finally { s.dispose(); }
          }
        }, { pairs: 30, warm: 4, iterations: 1 });
      }
    });
    assert.ok(checksum > 0);
  },
});
