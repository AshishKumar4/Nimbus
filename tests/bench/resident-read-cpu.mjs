#!/usr/bin/env node
// The resident store's read path, CPU per arm, under node (V8, as workerd
// runs it): what module loading asks of a process's namespace and cells
// (worker vfs/resident namespace-lookup.ts, tables.ts, cells.ts). A key's
// row; a walk of a deep path with symlinks in the table (the walk proper,
// not the one-lookup shortcut); a walk through a link; a file's bytes; an
// asynchronous read's write-through of bytes the store holds already. Each
// arm is the store bundled on its own from its tree (main, main's null arm,
// head), over a pnpm-like tree held in a heap store.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `${name} is required`);
  return args[at + 1];
};
const short = args.includes('--short');
const baseline = resolve(option('--baseline'));
const output = option('--out');
const worker = new URL('../../packages/worker/', import.meta.url).pathname;
const head = join(worker, 'src');
const PAIRS = short ? 3 : 30;
const N = short ? 200 : 20_000;
const scratch = mkdtempSync(join(worker, '.resident-read-cpu-'));
let seen = 0;
const results = [];

/** An arm: the store from `dir`, bundled on its own, so no arm shares a module, or its JIT state, with another. */
async function arm(name, dir) {
  const bundled = await build({
    entryPoints: [join(dir, 'vfs/resident/index.ts')],
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'esnext',
    nodePaths: [join(worker, 'node_modules')], mainFields: ['module', 'main'], absWorkingDir: worker,
  });
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const CURSOR = { poison: false, paths: [], epoch: 'e1', rev: 7 };
const STAT = (type, size = 0) => ({ type, size, mode: type === 'directory' ? 0o40755 : type === 'symlink' ? 0o120777 : 0o100644, uid: 1000, gid: 1000, atime: 0, mtime: 0, ctime: 0, ino: 1 });
const FILE = (i) => `home/user/app/node_modules/.pnpm/p${i}/node_modules/p${i}/lib/index.js`;
const TEXT = Array.from({ length: 96 }, (_, i) => `module.exports = ${i};\n`);

/** A store holding a pnpm-like tree: 96 packages, each `.pnpm/p<i>/node_modules/p<i>/lib/index.js`, linked from `node_modules/p<i>`. */
function storeOf({ createResidentStore }) {
  const store = createResidentStore();
  store.bindInMemory(64 * 1024 * 1024);
  store.cells.admit(CURSOR);
  const entries = [];
  const dir = (path) => entries.push({ path, kind: 'directory', size: 0, rev: 7, stat: STAT('directory') });
  for (const path of ['home', 'home/user', 'home/user/app', 'home/user/app/node_modules', 'home/user/app/node_modules/.pnpm']) dir(path);
  for (let i = 0; i < 96; i++) {
    const base = `home/user/app/node_modules/.pnpm/p${i}`;
    for (const path of [base, `${base}/node_modules`, `${base}/node_modules/p${i}`, `${base}/node_modules/p${i}/lib`]) dir(path);
    entries.push({ path: FILE(i), kind: 'file', size: 24, rev: 7, stat: STAT('file', 24) });
    entries.push({ path: `home/user/app/node_modules/p${i}`, kind: 'symlink', size: 0, rev: 7, stat: STAT('symlink'), linkTarget: `.pnpm/p${i}/node_modules/p${i}` });
  }
  const t = store.coherence.require();
  store.namespace.replace(t, entries);
  store.namespace.markReady(t, true);
  for (let i = 0; i < 96; i++) store.cells.fill(FILE(i), TEXT[i], 7);
  return store;
}

const work = {
  row: (store) => { for (let i = 0; i < N; i++) seen += store.namespace.rowAt(FILE(i % 96)) === undefined ? 0 : 1; },
  walk: (store) => { for (let i = 0; i < N; i++) { const found = store.namespace.lookup(FILE(i % 96), true); seen += found === 'ELOOP' ? 0 : 1; } },
  linked: (store) => {
    for (let i = 0; i < N; i++) {
      const found = store.namespace.lookup(`home/user/app/node_modules/p${i % 96}/lib/index.js`, true);
      seen += found === 'ELOOP' || found.row === undefined ? 0 : 1;
    }
  },
  bytes: (store) => { for (let i = 0; i < N; i++) seen += String(store.bundle[FILE(i % 96)]).length; },
  reread: (store) => { for (let i = 0; i < N; i++) seen += store.cells.fill(FILE(i % 96), TEXT[i % 96], 7) ? 1 : 0; },
};

try {
  const sources = { A: baseline, null: baseline, real: head };
  const arms = {};
  for (const name of shuffled(Object.keys(sources))) arms[name] = storeOf(await arm(name, sources[name]));
  // Each arm answers as the baseline's does.
  const linkedAt = (store) => { const found = store.namespace.lookup('home/user/app/node_modules/p3/lib/index.js', true); return found === 'ELOOP' ? found : found.table; };
  assert.equal(linkedAt(arms.real), linkedAt(arms.A));
  assert.equal(arms.real.bundle[FILE(5)], arms.A.bundle[FILE(5)]);
  const cpu = (store, kind) => cpuMs(() => work[kind](store));
  for (const kind of Object.keys(work)) {
    const result = await pairedKind(kind, arms, cpu, { pairs: PAIRS, warm: short ? 1 : 4, iterations: 1 });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
  }
  assert.ok(seen > 0);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
