#!/usr/bin/env bun
// One process's paired VFS workloads; the remote client grades independent runs.
import assert from 'node:assert/strict';
import { hostSqlite } from '../unit/lib/host-sqlite.mjs';
import { cpuMs } from './lib/paired-cpu.mjs';
import { CORE_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
let checksum = 0;

async function make({
  'vfs/sqlite-vfs.ts': { SqliteVFS: Store },
  'vfs/composite.ts': { CompositeVFS: Namespace },
  'vfs/sqlite-files.ts': { sqliteFiles: files, SqliteFiles: FilesClass },
  'runtime/process-files.ts': { ProcessFiles: Processes },
  'vfs/path.ts': { normalizeVfsPath: normalize },
  'runtime/os-contracts.ts': { CRED_KERNEL },
}, removedFiles) {
  const host = await hostSqlite();
  const engine = new Store(host.sql, host.transactions);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('home/user/a/b/c/d', { recursive: true });
  root.chown('home/user', USER.uid, USER.gid);
  root.symlink('a/b/c/d', 'home/user/link');
  const paths = Array.from({ length: 96 }, (_, i) => `/home/user/a/b/c/d/f${i}`);
  for (const path of paths) root.writeFile(path, `file-${path}`);
  root.mkdir('home/user/node_modules/.pnpm/x@1/node_modules/x/lib', { recursive: true });
  root.symlink('.pnpm/x@1/node_modules/x', 'home/user/node_modules/x');
  root.symlink('x', 'home/user/node_modules/chain');
  const packagePaths = Array.from({ length: 96 }, (_, i) => `/home/user/node_modules/x/lib/f${i}`);
  const chainPaths = Array.from({ length: 96 }, (_, i) => `/home/user/node_modules/chain/lib/f${i}`);
  for (let i = 0; i < packagePaths.length; i++) root.writeFile(`home/user/node_modules/.pnpm/x@1/node_modules/x/lib/f${i}`, `pkg-${i}`);
  root.writeFile('home/user/f', 'same');
  root.writeFile('home/user/a/b/c/f', 'same');
  root.mkdir('lease');
  const store = engine.as(USER);
  const namespace = new Namespace(files(engine, CRED_KERNEL)).as(USER).sync;
  const authority = new Processes(engine);
  const process = authority.view({ pid: 71, cred: USER });
  class Walked extends FilesClass {
    removeRecursive = undefined;
    as(cred, actor, options) { return new Walked(engine, engine.as(cred, { ...options, actor })); }
  }
  const removal = new Namespace(new Walked(engine, engine.as(USER))).as(USER).sync;
  const seedRemoval = () => {
    root.mkdir('home/user/tree');
    root.chown('home/user/tree', USER.uid, USER.gid);
    for (let at = 0; at < removedFiles; at += 64) root.writeBatch({ inodes: Array.from({ length: Math.min(64, removedFiles - at) }, (_, i) => ({ path: `home/user/tree/f${at + i}`, parentPath: 'home/user/tree', isDir: false, size: 0, mtime: 1, mode: 0o644, chunkCount: 0, uid: USER.uid, gid: USER.gid })), chunks: [] });
  };
  return { engine, root, store, namespace, process, paths, packagePaths, chainPaths, removal, seedRemoval, normalize };
}

// Spellings normalizeVfsPath reduces by its names, not by its plain-key fast path.
const SPELLED = ['/home/user/a/./b/../b/c/d/f1', 'home//user/a/b/c/d/', '/../home/user/a/b/c/d/../d/./f2', './home/user/node_modules/x/lib/../lib/f3'];

async function runWork({ store, namespace, process, paths, packagePaths, chainPaths, removal, normalize }, kind, iterations) {
  if (kind === 'walked-removal') {
    const report = removal.removeRecursive('/home/user/tree');
    assert.equal(report.failures.length, 0);
    checksum += report.removed.length;
    return;
  }
  for (let i = 0; i < iterations; i++) {
    const path = paths[(i * 17) % paths.length];
    if (kind === 'normalize-spelled') checksum += normalize(SPELLED[i % SPELLED.length]).length;
    else if (kind === 'namespace') checksum += namespace.stat(path).size;
    else if (kind === 'namespace-walk') checksum += namespace.stat(`/home/user/link/../d/f${(i * 17) % paths.length}`).size;
    else if (kind === 'process-view') checksum += (await process.stat(path)).size;
    else if (kind === 'process-linked') checksum += (await process.stat(chainPaths[(i * 17) % chainPaths.length])).size;
    else switch (i % 4) {
      case 0: checksum += store.stat(lookupPath(kind, i, path, packagePaths, chainPaths)).size; break;
      case 1: checksum += store.readFile(lookupPath(kind, i, path, packagePaths, chainPaths)).byteLength; break;
      case 2: checksum += store.exists(lookupPath(kind, i, path, packagePaths, chainPaths)) ? 1 : 0; break;
      default: checksum += store.statIfPresent(lookupPath(kind, i, path, packagePaths, chainPaths), false).size; break;
    }
  }
}

await runPairedBenchmark({
  async run({ short, cleanup, withArms, sample }) {
    const iterations = short ? 120 : 24_000;
    const removedFiles = short ? 64 : 2000;
    await withArms(async (from) => make(await loadIsolatedCore(from, cleanup, {
      sources: CORE_CPU_SOURCES,
      modules: ['vfs/sqlite-vfs.ts', 'vfs/composite.ts', 'vfs/sqlite-files.ts', 'runtime/process-files.ts', 'vfs/path.ts', 'runtime/os-contracts.ts'],
    }), removedFiles), async (arms) => {
      for (const kind of ['normalize-spelled', 'store', 'namespace', 'namespace-walk', 'store-linked', 'store-pnpm-chain', 'store-dot', 'store-link-parent', 'store-dot-lease', 'process-view', 'process-linked', 'walked-removal']) {
        const leases = kind === 'store-dot-lease' ? Object.values(arms).map((arm) => [arm, arm.engine.acquireExclusiveMutation('lease')]) : [];
        const walked = kind === 'walked-removal';
        try {
          await sample(kind, arms, (arm) => {
            if (walked) arm.seedRemoval();
            return cpuMs(() => runWork(arm, kind, iterations));
          }, { pairs: 36, warm: walked ? 2 : 12, iterations: walked ? removedFiles : iterations });
        } finally {
          for (const [arm, lease] of leases) arm.engine.releaseExclusiveMutation(lease.owner);
        }
      }
    });
    assert.ok(checksum > 0);
  },
});

function lookupPath(kind, index, plain, packagePaths, chainPaths) {
  if (kind === 'store-linked') return packagePaths[(index * 17) % packagePaths.length];
  if (kind === 'store-pnpm-chain') return chainPaths[(index * 17) % chainPaths.length];
  if (kind === 'store-dot' || kind === 'store-dot-lease') return index % 2 ? './home/user/a/b/c/d/f0' : 'home/user/a/b/c/d/./f0';
  if (kind === 'store-link-parent') return '/home/user/link/../f';
  return plain;
}
