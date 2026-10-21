#!/usr/bin/env node
// lifo's Node `fs` (substrate/lifo/node-compat/fs.ts createFs), CPU per arm
// under V8 as workerd runs it, on the path a require-heavy program walks:
// existsSync and statSync of candidates found and not, readFileSync of
// package.json, readdirSync of node_modules, and the same through
// fs.promises, over one in-memory filesystem. Each arm is bundled from its
// side's tree (isolated-core.mjs), so the head's generator operations and
// drivers (node-compat/drive.ts) are measured against the calls they replaced.
// remote-node-fs-cpu supplies the baseline's tree and judges the runs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { armTree, assertArmsInside, importBundle, repository } from './lib/isolated-core.mjs';
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
const PAIRS = short ? 3 : 30;
const N = short ? 40 : 800;
const PACKAGES = 24;
const scratch = mkdtempSync(join(tmpdir(), 'node-fs-cpu-'));
const disposals = [];
const results = [];
let checksum = 0;

/** An arm: lifo's fs from its side's tree (`from`), bundled on its own. */
async function arm(name, from) {
  const tree = armTree(from, (dispose) => disposals.push(dispose));
  const dir = join(tree, 'packages/core/src');
  return importBundle(tree, {
    stdin: { contents: `export { createFs } from ${JSON.stringify(join(dir, 'substrate/lifo/node-compat/fs.ts'))};\n`, resolveDir: dir, loader: 'ts' },
    format: 'esm', platform: 'node', target: 'esnext', mainFields: ['module', 'main'],
  }, join(scratch, `${name}.mjs`));
}

// The filesystem every arm reads: node_modules of PACKAGES packages, as the
// in-process Node's synchronous filesystem (NodeFilesystem) answers.
const files = new Map();
const dirs = new Map([['/', []]]);
const add = (path, text) => {
  files.set(path, new TextEncoder().encode(text));
  let child = path;
  for (let at = path.lastIndexOf('/'); at >= 0; at = child.lastIndexOf('/')) {
    const parent = at === 0 ? '/' : child.slice(0, at);
    const entries = dirs.get(parent) ?? [];
    const name = child.slice(at + 1);
    if (!entries.includes(name)) entries.push(name);
    dirs.set(parent, entries);
    if (parent === '/') break;
    child = parent;
  }
};
for (let i = 0; i < PACKAGES; i++) {
  add(`/app/node_modules/pkg${i}/package.json`, JSON.stringify({ name: `pkg${i}`, main: 'lib/index.js' }));
  add(`/app/node_modules/pkg${i}/lib/index.js`, `module.exports = ${i};`);
}
const missing = (syscall, path) => Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: 'ENOENT', errno: -2, syscall, path });
const statOf = (path, syscall) => {
  const file = files.get(path);
  if (file !== undefined) return { dev: 1, ino: path.length, nlink: 1, type: 'file', size: file.byteLength, ctime: 1, atime: 1, mtime: 1, mode: 0o644, uid: 0, gid: 0, revision: 1 };
  if (dirs.has(path)) return { dev: 1, ino: path.length, nlink: 2, type: 'directory', size: 0, ctime: 1, atime: 1, mtime: 1, mode: 0o755, uid: 0, gid: 0, revision: 1 };
  throw missing(syscall, path);
};
const decoder = new TextDecoder();
const filesystem = {
  readFile(path) { const file = files.get(path); if (file === undefined) throw missing('open', path); return file; },
  readFileString(path) { return decoder.decode(this.readFile(path)); },
  exists: (path) => files.has(path) || dirs.has(path),
  isFile: (path) => files.has(path),
  isDirectory: (path) => dirs.has(path),
  stat: (path) => statOf(path, 'stat'),
  lstat: (path) => statOf(path, 'lstat'),
  readdir(path) {
    const entries = dirs.get(path);
    if (entries === undefined) throw missing('scandir', path);
    return entries.map((name) => ({ name, type: dirs.has(`${path}/${name}`) ? 'directory' : 'file' }));
  },
};

const work = {
  sync(fs) {
    for (let i = 0; i < N; i++) {
      const pkg = `node_modules/pkg${i % PACKAGES}`;
      if (!fs.existsSync(`${pkg}/package.json`)) throw new Error('missing package');
      checksum += JSON.parse(fs.readFileSync(`${pkg}/package.json`, 'utf8')).name.length;
      for (const candidate of ['lib/index.js.ts', 'lib/index.js.mjs', 'lib/index.js']) {
        try {
          if (fs.statSync(`${pkg}/${candidate}`).isFile()) break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (i % 8 === 0) checksum += fs.readdirSync('node_modules', { withFileTypes: true }).length;
    }
  },
  async promises(fs) {
    for (let i = 0; i < N; i++) {
      const pkg = `node_modules/pkg${i % PACKAGES}`;
      checksum += JSON.parse(await fs.promises.readFile(`${pkg}/package.json`, 'utf8')).name.length;
      checksum += (await fs.promises.stat(`${pkg}/lib/index.js`)).size;
      if (i % 8 === 0) checksum += (await fs.promises.readdir('node_modules')).length;
    }
  },
};

try {
  const sources = { A: baseline, null: baseline, real: repository };
  const arms = {};
  for (const name of shuffled(Object.keys(sources))) arms[name] = await arm(name, sources[name]);
  // Each arm answers as the others do: the comparison is of the same work.
  const answers = (exports) => {
    const fs = exports.createFs(filesystem, '/app');
    return JSON.stringify([fs.readdirSync('node_modules'), fs.statSync('node_modules/pkg1/package.json').size, fs.existsSync('nope')]);
  };
  assert.equal(answers(arms.real), answers(arms.A), 'the head\'s fs answers as the baseline\'s');
  const cpu = (exports, kind) => {
    const fs = exports.createFs(filesystem, '/app');
    return cpuMs(() => work[kind](fs));
  };
  for (const kind of Object.keys(work)) {
    const result = await pairedKind(kind, arms, cpu, { pairs: PAIRS, warm: 4, iterations: 1 });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
  }
  assert.ok(checksum > 0);
  assertArmsInside();
} finally {
  for (const dispose of disposals) dispose();
  rmSync(scratch, { recursive: true, force: true });
}
