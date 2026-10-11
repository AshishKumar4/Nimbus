#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPackages } from './lib/publish-packages.mjs';
import { step } from './lib/step.mjs';
import { prepareTarball } from './lib/publish-tarballs.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : null;
if (!out || args.length !== 2) {
  console.error('usage: bun scripts/ci/publish-pack.mjs --out <file>');
  process.exit(2);
}
const git = (argv) => spawnSync('git', argv, { encoding: 'utf8' });
const top = git(['rev-parse', '--show-toplevel']);
const root = top.stdout.trim();
const head = top.status === 0 ? git(['rev-parse', 'HEAD']).stdout.trim() : null;
const work = mkdtempSync(join(tmpdir(), 'nimbus-publish-pack-'));
const rows = [];
const tarballs = [];
let exitCode = 1;
try {
  if (!head || git(['status', '--porcelain', '--untracked-files=all']).stdout.trim()) throw new Error('publish packing requires a clean committed checkout');
  const dist = await step('dist-publish', root, 'bun', ['scripts/dist-integrity.mjs', '--publish']);
  rows.push(dist);
  if (dist.exitCode !== 0) throw new Error('dist publish gate failed; no tarballs were packed');
  const prepared = publishPackages(root).map(pkg => prepareTarball(pkg.dir, work));
  const manifest = join(work, 'prepared.json');
  writeFileSync(manifest, JSON.stringify(prepared.map(({ base64, ...receipt }) => receipt)));
  const published = await step('published-versions', root, 'bun', ['scripts/check-published.mjs', '--prepared', manifest]);
  rows.push(published);
  if (published.exitCode !== 0) throw new Error('published version integrity check failed; no signing artifacts will be returned');
  const dir = join(work, 'runtime-cpython');
  const runtimeBuild = await step('runtime-cpython-build', join(root, 'packages/worker'), 'node', ['scripts/bundle-runtime.mjs', 'cpython', '3.13.14-1', '--npm-package', dir]);
  rows.push(runtimeBuild);
  if (runtimeBuild.exitCode !== 0) throw new Error('CPython package build failed');
  const runtime = prepareTarball(dir, work);
  const runtimeGate = await step('runtime-packages', root, 'node', ['packages/core/scripts/check-runtime-packages.mjs', '--runtime-tarball', runtime.path]);
  rows.push(runtimeGate);
  if (runtimeGate.exitCode !== 0) throw new Error('runtime gate failed; no signing artifacts will be returned');
  tarballs.push(...[runtime, ...prepared].map(({ path, ...artifact }) => artifact));
  exitCode = 0;
} catch (error) {
  rows.push({ name: 'publish-pack', exitCode: 1, seconds: 0, output: error.message });
  console.error(error.message);
} finally {
  writeFileSync(out, JSON.stringify({ head, rows, tarballs: exitCode === 0 ? tarballs : [] }) + '\n');
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
