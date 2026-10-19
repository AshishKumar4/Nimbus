#!/usr/bin/env bun
// The npm release of the commit checked out here, packed and gated: the one
// pack implementation. scripts/ci/release.mjs runs it on CI before staging,
// so a release npm would refuse never reaches production; the publish
// workflow (.github/workflows/publish.yml) runs it again and publishes what
// it packed (npm-publish.mjs). `npm publish <tarball>` runs no lifecycle
// script, so every package's publish gate runs here.
//
//   bun scripts/ci/publish-pack.mjs --out <file> [--tarballs <dir>]
//
// The gates, in order: the dist gate (dist-integrity --publish); every
// package packed, and each version npm already has packing to what it holds
// (check-published); every npm runtime built (bundle-runtime --npm-package)
// and packed; the runtime gate over those builds (check-runtime-packages).
// <file> is JSON { head, rows, tarballs }: rows each { name, exitCode,
// seconds, output }; tarballs the receipts in publish order (the runtimes,
// then the packages in dependency order), each { name, version, file,
// bytes, sha256, shasum, integrity }, or [] when a row is red. --tarballs
// keeps the archives there; without it they are packed, gated and removed.
// Exit: 0, every gate; 1, a red row; 2, usage.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmRuntimeSpecs } from '../../packages/worker/scripts/runtime-specs.mjs';
import { publishPackages } from './lib/publish-packages.mjs';
import { step } from './lib/step.mjs';
import { prepareTarball } from './lib/publish-tarballs.mjs';

const USAGE = 'usage: bun scripts/ci/publish-pack.mjs --out <file> [--tarballs <dir>]';
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--out', '--tarballs'].includes(args[i]) || args[i + 1] === undefined) usage();
  flags[args[i].slice(2)] = args[i + 1];
}
if (!flags.out) usage();
function usage() {
  console.error(USAGE);
  process.exit(2);
}
const git = (argv) => spawnSync('git', argv, { encoding: 'utf8' });
const top = git(['rev-parse', '--show-toplevel']);
const root = top.stdout.trim();
const head = top.status === 0 ? git(['rev-parse', 'HEAD']).stdout.trim() : null;
const work = mkdtempSync(join(tmpdir(), 'nimbus-publish-pack-'));
const into = flags.tarballs ?? join(work, 'tarballs');
mkdirSync(into, { recursive: true });
const rows = [];
let tarballs = [];
let exitCode = 1;
/** `row`, recorded; it must be green for the pack to go on. */
const gate = (row, refusal) => {
  rows.push(row);
  if (row.exitCode !== 0) throw new Error(refusal);
};
try {
  if (!head || git(['status', '--porcelain', '--untracked-files=all']).stdout.trim()) throw new Error('publish packing requires a clean committed checkout');
  gate(await step('dist-publish', root, 'bun', ['scripts/dist-integrity.mjs', '--publish']), 'the dist publish gate failed; nothing was packed');
  const packages = publishPackages(root).map((pkg) => prepareTarball(pkg.dir, into));
  const packed = join(work, 'packed.json');
  writeFileSync(packed, JSON.stringify(packages));
  gate(await step('published-versions', root, 'bun', ['scripts/check-published.mjs', '--prepared', packed]), 'a version npm already has packs to other bytes');
  const runtimes = [];
  for (const { runtime, version } of npmRuntimeSpecs()) {
    const dir = join(work, `runtime-${runtime}`);
    gate(await step(`runtime-${runtime}`, join(root, 'packages/worker'), 'node', ['scripts/bundle-runtime.mjs', runtime, version, '--npm-package', dir]), `the ${runtime} runtime package did not build`);
    runtimes.push({ runtime, dir, ...prepareTarball(dir, into) });
  }
  const prepared = join(work, 'runtimes.json');
  writeFileSync(prepared, JSON.stringify(runtimes.map(({ runtime, dir, path }) => ({ runtime, dir, tarball: path }))));
  gate(await step('runtime-packages', root, 'node', ['packages/core/scripts/check-runtime-packages.mjs', '--prepared', prepared]), 'the runtime gate failed');
  tarballs = [...runtimes, ...packages].map(({ name, version, file, bytes, sha256, shasum, integrity }) => ({ name, version, file, bytes, sha256, shasum, integrity }));
  exitCode = 0;
} catch (error) {
  rows.push({ name: 'publish-pack', exitCode: 1, seconds: 0, output: error.message });
  console.error(error.message);
} finally {
  writeFileSync(flags.out, `${JSON.stringify({ head, rows, tarballs })}\n`);
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
