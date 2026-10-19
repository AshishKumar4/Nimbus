#!/usr/bin/env bun
// The resident store's read path, CPU per arm: what module loading asks of
// a process's namespace and cells (namespace-lookup.ts, tables.ts, cells.ts):
// a key's row, a walk of a deep path with symlinks in the table (the walk
// proper, not the one-lookup shortcut), a walk through a link, and a file's
// bytes. A heap store per arm for main, main's null arm, and head, each over
// independent copies of the store's sources.
import assert from 'node:assert/strict';
import { cpuMs } from './lib/paired-cpu.mjs';
import { RESIDENT_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

const CURSOR = { poison: false, paths: [], epoch: 'e1', rev: 7 };
const STAT = (type, size = 0) => ({ type, size, mode: type === 'directory' ? 0o40755 : type === 'symlink' ? 0o120777 : 0o100644, uid: 1000, gid: 1000, atime: 0, mtime: 0, ctime: 0, ino: 1 });
let seen = 0;

/** A store holding a pnpm-like tree: 96 packages, each `node_modules/.pnpm/p<i>/node_modules/p<i>/lib/index.js`, linked from `node_modules/p<i>`. */
function storeOf({ 'vfs/resident/index.ts': { createResidentStore } }) {
  const store = createResidentStore();
  store.bindInMemory(64 * 1024 * 1024);
  store.cells.admit(CURSOR);
  const entries = [];
  const dir = (path) => entries.push({ path, kind: 'directory', size: 0, rev: 7, stat: STAT('directory') });
  for (const path of ['home', 'home/user', 'home/user/app', 'home/user/app/node_modules', 'home/user/app/node_modules/.pnpm']) dir(path);
  for (let i = 0; i < 96; i++) {
    const base = `home/user/app/node_modules/.pnpm/p${i}`;
    for (const path of [base, `${base}/node_modules`, `${base}/node_modules/p${i}`, `${base}/node_modules/p${i}/lib`]) dir(path);
    entries.push({ path: `${base}/node_modules/p${i}/lib/index.js`, kind: 'file', size: 24, rev: 7, stat: STAT('file', 24) });
    entries.push({ path: `home/user/app/node_modules/p${i}`, kind: 'symlink', size: 0, rev: 7, stat: STAT('symlink'), linkTarget: `.pnpm/p${i}/node_modules/p${i}` });
  }
  const t = store.coherence.require();
  store.namespace.replace(t, entries);
  store.namespace.markReady(t, true);
  for (let i = 0; i < 96; i++) store.cells.fill(`home/user/app/node_modules/.pnpm/p${i}/node_modules/p${i}/lib/index.js`, `module.exports = ${i};\n`, 7);
  return store;
}

const WORK = {
  row: (store, n) => { for (let i = 0; i < n; i++) seen += store.namespace.rowAt(`home/user/app/node_modules/.pnpm/p${i % 96}/node_modules/p${i % 96}/lib/index.js`) === undefined ? 0 : 1; },
  walk: (store, n) => { for (let i = 0; i < n; i++) { const found = store.namespace.lookup(`home/user/app/node_modules/.pnpm/p${i % 96}/node_modules/p${i % 96}/lib/index.js`, true); seen += found === 'ELOOP' ? 0 : 1; } },
  linked: (store, n) => { for (let i = 0; i < n; i++) { const found = store.namespace.lookup(`home/user/app/node_modules/p${i % 96}/lib/index.js`, true); seen += found === 'ELOOP' || found.row === undefined ? 0 : 1; } },
  bytes: (store, n) => { for (let i = 0; i < n; i++) seen += String(store.bundle[`home/user/app/node_modules/.pnpm/p${i % 96}/node_modules/p${i % 96}/lib/index.js`]).length; },
};

await runPairedBenchmark({
  source: RESIDENT_CPU_SOURCES.source,
  async run({ short, cleanup, withArms, sample }) {
    const n = short ? 200 : 20_000;
    await withArms((from) => loadIsolatedCore(from, cleanup, {
      sources: RESIDENT_CPU_SOURCES, modules: ['vfs/resident/index.ts'],
    }), async (arms) => {
      for (const [kind, work] of Object.entries(WORK)) {
        await sample(kind, arms, async (modules) => {
          const store = storeOf(modules);
          return cpuMs(() => work(store, n));
        }, { pairs: 30, warm: 4, iterations: 1 });
      }
    });
    assert.ok(seen > 0);
  },
});
