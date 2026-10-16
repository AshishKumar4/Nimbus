#!/usr/bin/env bun
// Paired in-process CPU comparison, one run of it. remote-vfs-lookup-cpu supplies the baseline
// sources and judges the runs together: a process's own state (where its heap and databases
// landed) moves a whole run, which an interval over one run's pairs cannot show.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { hostSqlite } from '../unit/lib/host-sqlite.mjs';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `${name} is required`);
  return args[at + 1];
};
const baseline = resolve(option('--baseline'));
const output = option('--out');
const source = new URL('../../packages/core/src/', import.meta.url).pathname;
const MEASURED = { vfs: ['sqlite-vfs.ts', 'path.ts', 'composite.ts', 'sqlite-files.ts'], runtime: ['process-files.ts', 'sqlite-runtime-fs-bridge.ts'] };
const fixtures = [];
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const ITERATIONS = 24_000;
const PAIRS = 36;
let checksum = 0;
const results = [];

try {
  // Both arms load the measured files from a copy of their own, beside the
  // same links to everything else: an arm that ran src's copies would share
  // them with every other module that imports them, and an A/A comparison
  // then favored it by 5-9%.
  const load = async (from) => {
    const fixture = mkdtempSync(join(source, '.vfs-cpu-'));
    fixtures.push(fixture);
    for (const entry of readdirSync(source)) {
      if (entry.startsWith('.vfs-cpu-')) continue;
      if (!Object.hasOwn(MEASURED, entry)) { symlinkSync(join(source, entry), join(fixture, entry)); continue; }
      mkdirSync(join(fixture, entry));
      for (const file of readdirSync(join(source, entry))) {
        const target = join(fixture, entry, file);
        if (MEASURED[entry].includes(file)) writeFileSync(target, readFileSync(join(from, entry, file)));
        else symlinkSync(join(source, entry, file), target);
      }
    }
    const at = (path) => import(pathToFileURL(join(fixture, path)).href);
    const [{ SqliteVFS }, { CompositeVFS }, { sqliteFiles, SqliteFiles }, { ProcessFiles }] = await Promise.all(
      ['vfs/sqlite-vfs.ts', 'vfs/composite.ts', 'vfs/sqlite-files.ts', 'runtime/process-files.ts'].map(at));
    return [SqliteVFS, CompositeVFS, sqliteFiles, SqliteFiles, ProcessFiles];
  };
  const make = async (Store, Namespace, files, FilesClass, Processes) => {
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
      for (let at = 0; at < 2000; at += 64) root.writeBatch({ inodes: Array.from({ length: Math.min(64, 2000 - at) }, (_, i) => ({ path: `home/user/tree/f${at + i}`, parentPath: 'home/user/tree', isDir: false, size: 0, mtime: 1, mode: 0o644, chunkCount: 0, uid: USER.uid, gid: USER.gid })), chunks: [] });
    };
    return { engine, root, store, namespace, process, paths, packagePaths, chainPaths, removal, seedRemoval };
  };
  // A, the baseline; null, a second copy of the baseline, the A/A reference
  // the branch's delta is judged against; real, the branch. Made in a random
  // order and run in one each pair: where an arm's heap and database landed
  // moves it by as much as many deltas, which is then noise across runs
  // rather than a bias of every run.
  const sources = { A: baseline, null: baseline, real: source };
  const arms = {};
  for (const name of shuffled(Object.keys(sources))) arms[name] = await make(...await load(sources[name]));
  const run = async ({ store, namespace, process, paths, packagePaths, chainPaths, removal }, kind) => {
    if (kind === 'walked-removal') {
      const report = removal.removeRecursive('/home/user/tree');
      assert.equal(report.failures.length, 0);
      checksum += report.removed.length;
      return;
    }
    for (let i = 0; i < ITERATIONS; i++) {
      const path = paths[(i * 17) % paths.length];
      if (kind === 'namespace') checksum += namespace.stat(path).size;
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
  };
  const cpu = async (arm, kind) => {
    if (kind === 'walked-removal') arm.seedRemoval();
    return cpuMs(() => run(arm, kind));
  };
  for (const kind of ['store', 'namespace', 'namespace-walk', 'store-linked', 'store-pnpm-chain', 'store-dot', 'store-link-parent', 'store-dot-lease', 'process-view', 'process-linked', 'walked-removal']) {
    const leases = kind === 'store-dot-lease' ? Object.values(arms).map((arm) => [arm, arm.engine.acquireExclusiveMutation('lease')]) : [];
    const walked = kind === 'walked-removal';
    const result = await pairedKind(kind, arms, cpu, { pairs: PAIRS, warm: walked ? 2 : 12, iterations: walked ? 2000 : ITERATIONS });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
    for (const [arm, lease] of leases) arm.engine.releaseExclusiveMutation(lease.owner);
  }
  assert.ok(checksum > 0);
} finally {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
}

function lookupPath(kind, index, plain, packagePaths, chainPaths) {
  if (kind === 'store-linked') return packagePaths[(index * 17) % packagePaths.length];
  if (kind === 'store-pnpm-chain') return chainPaths[(index * 17) % chainPaths.length];
  if (kind === 'store-dot' || kind === 'store-dot-lease') return index % 2 ? './home/user/a/b/c/d/f0' : 'home/user/a/b/c/d/./f0';
  if (kind === 'store-link-parent') return '/home/user/link/../f';
  return plain;
}
