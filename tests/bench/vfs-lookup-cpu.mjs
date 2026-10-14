#!/usr/bin/env bun
// Paired in-process CPU comparison. remote-vfs-lookup-cpu supplies the baseline sources.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { hostSqlite } from '../unit/lib/host-sqlite.mjs';

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
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor(fraction * (values.length - 1))];
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const ITERATIONS = 24_000;
const PAIRS = 36;
let checksum = 0;
const results = [];
const failures = [];

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
  // Made in a random order, and run in one each pair: where an arm's heap and
  // database landed moves it by as much as many deltas, which is then noise
  // across runs rather than a bias of every run.
  const sources = [baseline, source];
  const arms = [];
  for (const at of Math.random() < 0.5 ? [0, 1] : [1, 0]) arms[at] = await make(...await load(sources[at]));
  const shuffled = (items) => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  };
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
    const before = process.cpuUsage();
    await run(arm, kind);
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  };
  for (const kind of ['store', 'namespace', 'namespace-walk', 'store-linked', 'store-pnpm-chain', 'store-dot', 'store-link-parent', 'store-dot-lease', 'process-view', 'process-linked', 'walked-removal']) {
    const leases = kind === 'store-dot-lease' ? arms.map((arm) => arm.engine.acquireExclusiveMutation('lease')) : [];
    for (let warm = 0; warm < (kind === 'walked-removal' ? 2 : 12); warm++) for (const arm of arms) {
      if (kind === 'walked-removal') arm.seedRemoval();
      await run(arm, kind);
    }
    const pairs = [];
    for (let pair = 0; pair < PAIRS; pair++) {
      const samples = {};
      // A1 and A2 run one copy of the code twice a pair, so B's runs twice
      // too (W, untimed): a copy that ran half as often would sit at a colder
      // JIT tier, and that bias is larger than many deltas.
      for (const label of shuffled(['A1', 'B', 'A2', 'W'])) {
        const used = await cpu(arms[label === 'B' || label === 'W' ? 1 : 0], kind);
        if (label !== 'W') samples[label] = used;
      }
      pairs.push({ ...samples, delta: samples.B - (samples.A1 + samples.A2) / 2 });
    }
    const deltas = pairs.map((pair) => pair.delta);
    const aa = pairs.map((pair) => pair.A2 - pair.A1);
    const boot = [];
    let state = 0x51_53;
    for (let sample = 0; sample < 3000; sample++) {
      const draw = [];
      for (let i = 0; i < PAIRS; i++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        draw.push(deltas[(state >>> 0) % PAIRS]);
      }
      boot.push(median(draw));
    }
    const interval = [quantile(boot, 0.025), quantile(boot, 0.975)];
    const spread = [Math.min(...aa), Math.max(...aa)];
    const result = { kind, iterations: kind === 'walked-removal' ? 2000 : ITERATIONS, pairs: PAIRS, medianA: median(pairs.map(({ A1, A2 }) => (A1 + A2) / 2)), medianB: median(pairs.map(({ B }) => B)), medianDelta: median(deltas), ci95: interval, aaSpread: spread, samples: pairs };
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
    if (result.medianDelta > 0) failures.push(`${kind}: median paired CPU delta ${result.medianDelta} ms is positive`);
    if (interval[1] >= 0 && (interval[0] < spread[0] || interval[1] > spread[1])) failures.push(`${kind}: confidence interval is outside A/A spread`);
    for (let i = 0; i < leases.length; i++) arms[i].engine.releaseExclusiveMutation(leases[i].owner);
  }
  assert.ok(checksum > 0);
  assert.deepEqual(failures, [], failures.join('\n'));
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
