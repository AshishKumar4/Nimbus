#!/usr/bin/env node
// lifo's node end to end, CPU per arm under V8 as workerd runs it: a
// core-only workspace (NimbusWorkspace over SQLite, the built package as an
// embedder loads it) runs a program that requires express's whole package
// tree, then makes some hundreds of fs calls, sync and promised, over it.
// Each arm is its side's built core (packages/core/dist, its realm included),
// on a workspace of its own holding the same tree; the program's process CPU
// is what is measured, its realm's thread included. remote-node-workspace-fs-cpu
// supplies the baseline's tree and judges the runs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { armImports, armTree, assertArmsInside, repository } from './lib/isolated-core.mjs';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';
import { hostSqlite } from '../unit/lib/host-sqlite.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `${name} is required`);
  return args[at + 1];
};
const short = args.includes('--short');
const baseline = resolve(option('--baseline'));
const output = option('--out');
const PAIRS = short ? 3 : 30;
const disposals = [];
const results = [];

// express and everything it requires, from the install's package store: each
// package under the app's node_modules by name, a second version of a name
// under the node_modules of the package that requires it.
const STORE = join(repository, 'node_modules/.bun');
const tree = new Map();
function collect(dir, into) {
  const real = realpathSync(dir);
  const { name, version, dependencies = {} } = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
  const placed = tree.get(`${into}/${name}`);
  if (placed !== undefined) {
    if (placed !== version) collect(dir, `${into}/${name}/node_modules`);
    return;
  }
  tree.set(`${into}/${name}`, version);
  const walk = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(from, entry.name);
      if (entry.isDirectory()) walk(path, `${to}/${entry.name}`);
      else if (entry.isFile()) files.set(`${to}/${entry.name}`, readFileSync(path));
    }
  };
  walk(real, `${into}/${name}`);
  // Its dependencies sit beside it in the store.
  const siblings = join(real, '..');
  for (const dependency of Object.keys(dependencies)) collect(join(siblings, dependency), '/app/node_modules');
}
const files = new Map();
collect(join(STORE, 'express@5.2.1/node_modules/express'), '/app/node_modules');
const PROGRAM = `
const fs = require('fs');
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('ok'));
let n = typeof app === 'function' ? 1 : 0;
const names = fs.readdirSync('node_modules');
for (let round = 0; round < 3; round++) {
  for (const name of names) {
    const manifest = 'node_modules/' + name + '/package.json';
    if (fs.existsSync(manifest)) n += JSON.parse(fs.readFileSync(manifest, 'utf8')).name.length;
    try { fs.statSync('node_modules/' + name + '/index.mjs'); } catch (error) { if (error.code === 'ENOENT') n++; }
    if (fs.statSync('node_modules/' + name).isDirectory()) n++;
  }
}
(async () => {
  for (const name of names) n += (await fs.promises.stat('node_modules/' + name + '/package.json')).size;
  n += (await fs.promises.readdir('node_modules/express/lib')).length;
  console.log(n);
})();
`;
files.set('/app/main.js', Buffer.from(PROGRAM));

/** An arm: its side's built core, on a workspace of its own holding the tree. */
async function arm(from) {
  const at = armTree(from, (dispose) => disposals.push(dispose));
  const [{ NimbusWorkspace }] = await armImports(at, ['packages/core/dist/workspace/nimbus-workspace.js']);
  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
  disposals.push(() => { void ws.close(); });
  for (const [path, bytes] of files) {
    await ws.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await ws.fs.writeFile(path, new Uint8Array(bytes));
  }
  return ws;
}

try {
  const sources = { A: baseline, null: baseline, real: repository };
  const arms = {};
  for (const name of shuffled(Object.keys(sources))) arms[name] = await arm(sources[name]);
  const run = async (ws) => {
    const result = await ws.exec('cd /app && node main.js');
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  };
  // Each arm answers as the others do: the comparison is of the same work.
  assert.equal(await run(arms.real), await run(arms.A), 'the head\'s node answers as the baseline\'s');
  const cpu = (ws) => cpuMs(() => run(ws));
  const result = await pairedKind('express', arms, cpu, { pairs: PAIRS, warm: 2, iterations: 1 });
  results.push(result);
  writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
  const { samples, ...summary } = result;
  console.log(JSON.stringify({ ...summary, files: files.size, packages: tree.size }));
  assertArmsInside();
} finally {
  for (const dispose of disposals) dispose();
}
