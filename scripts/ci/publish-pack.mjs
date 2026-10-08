#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPackages } from './lib/publish-packages.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const phaseAt = args.indexOf('--phase');
const out = outAt >= 0 ? args[outAt + 1] : null;
const phase = phaseAt >= 0 ? args[phaseAt + 1] : null;
if (!out || !['runtime', 'packages'].includes(phase) || args.length !== 4) {
  console.error('usage: bun scripts/ci/publish-pack.mjs --out <file> --phase runtime|packages');
  process.exit(2);
}
const git = (argv) => spawnSync('git', argv, { encoding: 'utf8' });
const top = git(['rev-parse', '--show-toplevel']);
const root = top.stdout.trim();
const head = top.status === 0 ? git(['rev-parse', 'HEAD']).stdout.trim() : null;
const work = mkdtempSync(join(tmpdir(), 'nimbus-publish-pack-'));
const rows = [];
const tarballs = [];
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');

async function step(name, cwd, command, argv) {
  const begin = Date.now();
  const result = await new Promise((resolve) => {
    let output = '';
    const child = spawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (bytes) => { process.stderr.write(bytes); output = (output + String(bytes)).slice(-256 * 1024); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => keep(Buffer.from(error.message)));
    child.on('close', (code) => resolve({ name, exitCode: code ?? 128, seconds: (Date.now() - begin) / 1000, output }));
  });
  rows.push(result);
  return result.exitCode === 0;
}

async function pack(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (packed.status !== 0) throw new Error(`npm pack ${pkg.name}: ${packed.stderr || packed.stdout}`);
  const [receipt] = JSON.parse(packed.stdout);
  const bytes = readFileSync(join(work, receipt.filename));
  tarballs.push({ name: pkg.name, version: pkg.version, file: receipt.filename, sha256: digest('sha256', bytes), shasum: digest('sha1', bytes), integrity: 'sha512-' + digest('sha512', bytes), bytes: bytes.length, base64: bytes.toString('base64') });
}

let exitCode = 1;
try {
  if (!head || git(['status', '--porcelain', '--untracked-files=all']).stdout.trim()) throw new Error('publish packing requires a clean committed checkout');
  if (!await step('dist-publish', root, 'bun', ['scripts/dist-integrity.mjs', '--publish'])) throw new Error('dist publish gate failed; no tarballs were packed');
  if (!await step('published-versions', root, 'bun', ['scripts/check-published.mjs'])) throw new Error('published version integrity check failed; no tarballs were packed');
  if (phase === 'runtime') {
    const dir = join(work, 'runtime-cpython');
    if (!await step('runtime-cpython-build', join(root, 'packages/worker'), 'node', ['scripts/bundle-runtime.mjs', 'cpython', '3.13.14-1', '--npm-package', dir])) throw new Error('CPython package build failed');
    if (!await step('runtime-core-install', root, 'node', ['--input-type=module', '-e', `import {runThroughCore} from './packages/core/scripts/check-runtime-packages.mjs'; await runThroughCore(${JSON.stringify(dir)});`])) throw new Error('the core being published refuses the runtime artifact');
    await pack(dir);
  } else {
    if (!await step('public-runtime-packages', root, 'node', ['packages/core/scripts/check-runtime-packages.mjs'])) throw new Error('public runtime gate failed; publish the verified CPython runtime first, then rerun');
    for (const pkg of publishPackages(root)) await pack(pkg.dir);
  }
  exitCode = 0;
} catch (error) {
  rows.push({ name: 'publish-pack', exitCode: 1, seconds: 0, output: error.message });
  console.error(error.message);
} finally {
  writeFileSync(out, JSON.stringify({ head, phase, rows, tarballs: exitCode === 0 ? tarballs : [] }) + '\n');
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
