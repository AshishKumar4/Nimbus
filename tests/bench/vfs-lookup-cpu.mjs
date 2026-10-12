#!/usr/bin/env bun
// Paired in-process CPU comparison. remote-vfs-lookup-cpu supplies the baseline sources.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
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
const fixture = mkdtempSync(join(source, '.vfs-cpu-'));
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

try {
  mkdirSync(join(fixture, 'vfs'));
  for (const entry of readdirSync(source)) {
    if (entry === 'vfs' || entry.startsWith('.vfs-cpu-')) continue;
    symlinkSync(join(source, entry), join(fixture, entry));
  }
  for (const entry of readdirSync(join(source, 'vfs'))) {
    const target = join(fixture, 'vfs', entry);
    if (['sqlite-vfs.ts', 'path.ts', 'composite.ts'].includes(entry)) {
      writeFileSync(target, readFileSync(join(baseline, entry)));
    } else symlinkSync(join(source, 'vfs', entry), target);
  }
  const { SqliteVFS: Before } = await import(pathToFileURL(join(fixture, 'vfs', 'sqlite-vfs.ts')).href);
  const { CompositeVFS: NamespaceBefore } = await import(pathToFileURL(join(fixture, 'vfs', 'composite.ts')).href);
  const make = async (Store, Namespace) => {
    const host = await hostSqlite();
    const engine = new Store(host.sql, host.transactions);
    const root = engine.as(CRED_KERNEL);
    root.mkdir('home/user/a/b/c/d', { recursive: true });
    root.symlink('a/b/c/d', 'home/user/link');
    const paths = Array.from({ length: 96 }, (_, i) => `/home/user/a/b/c/d/f${i}`);
    for (const path of paths) root.writeFile(path, `file-${path}`);
    const store = engine.as(USER);
    const namespace = new Namespace(sqliteFiles(engine, USER)).sync;
    return { store, namespace, paths };
  };
  const arms = [await make(Before, NamespaceBefore), await make(SqliteVFS, CompositeVFS)];
  const run = ({ store, namespace, paths }, kind) => {
    for (let i = 0; i < ITERATIONS; i++) {
      const path = paths[(i * 17) % paths.length];
      if (kind === 'namespace') checksum += namespace.stat(path).size;
      else if (kind === 'namespace-walk') checksum += namespace.stat(`/home/user/link/../d/f${(i * 17) % paths.length}`).size;
      else switch (i % 4) {
        case 0: checksum += store.stat(path).size; break;
        case 1: checksum += store.readFile(path).byteLength; break;
        case 2: checksum += store.exists(path) ? 1 : 0; break;
        default: checksum += store.statIfPresent(path, false).size; break;
      }
    }
  };
  const cpu = (arm, kind) => {
    const before = process.cpuUsage();
    run(arm, kind);
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  };
  for (const kind of ['store', 'namespace', 'namespace-walk']) {
    for (let warm = 0; warm < 12; warm++) for (const arm of arms) run(arm, kind);
    const pairs = [];
    for (let pair = 0; pair < PAIRS; pair++) {
      const samples = {};
      const order = pair % 3 === 0 ? ['A1', 'B', 'A2'] : pair % 3 === 1 ? ['B', 'A2', 'A1'] : ['A2', 'A1', 'B'];
      for (const label of order) samples[label] = cpu(arms[label === 'B' ? 1 : 0], kind);
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
    const result = { kind, iterations: ITERATIONS, pairs: PAIRS, medianA: median(pairs.map(({ A1, A2 }) => (A1 + A2) / 2)), medianB: median(pairs.map(({ B }) => B)), medianDelta: median(deltas), ci95: interval, aaSpread: spread, samples: pairs };
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
    assert.ok(result.medianDelta <= 0, `${kind}: median paired CPU delta ${result.medianDelta} ms is positive`);
    assert.ok(interval[0] >= spread[0] && interval[1] <= spread[1], `${kind}: confidence interval is outside A/A spread`);
  }
  assert.ok(checksum > 0);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
