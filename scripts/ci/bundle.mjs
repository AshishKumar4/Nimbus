#!/usr/bin/env bun
// Workers' deploy bundles as one CI task: what `wrangler deploy` would
// upload for each target of the commit checked out here, built here so the
// machine that deploys only uploads them (scripts/ci/lib/release.mjs). Any
// runner that hands it a clean checkout with `bun install --frozen-lockfile`
// done runs it the same way; scripts/ci/release.mjs and remote-probes.mjs
// --deploy run it on armada.
//
//   bun scripts/ci/bundle.mjs --out <file> --target <app>[:<env>] [--target …]
//
// First the dist gate (scripts/dist-integrity.mjs): the bundles are built
// from dist, so a commit whose dist is not the fixpoint of its src gets none
// (run scripts/ci/remote-build.mjs, commit its patch). Then, for an app with
// a `build:assets` script (apps/hosted-demo), its assets, once; then
// `wrangler deploy --dry-run --outdir` per target, with `-e <env>` when one
// is named. The env blocks of one app may differ only in what wrangler
// resolves at upload (bindings, vars, routes), never in the module: targets
// of one app whose modules differ are a red row. No credential is needed or
// used.
//
// <file> is JSON: { head, rows, bundles, assets }.
//   rows: dist-gate, then assets per app that builds them, then bundle per
//     target, each { name, exitCode, seconds, output }.
//   bundles: { "<app>[:<env>]": { main, sha256, base64 } }, each target's
//     one module, or {} when a row is red.
//   assets: { "<app>": { manifest, docs } } for an app that builds them:
//     manifest maps each file of its assets directory to its sha256; docs is
//     { sha256, base64 }, a tar of the part this commit's tree does not hold
//     (apps/docs/dist/docs), which build-assets.mjs --docs assembles with
//     the rest.
// Exit: 0, every bundle; 1, a red row; 2, not graded (no clean checkout here).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesUnder } from '../lib/fs-walk.mjs';

const OUTPUT_CAP = 256 * 1024;
const USAGE = 'usage: bun scripts/ci/bundle.mjs --out <file> --target <app>[:<env>] [--target …]';

const argv = process.argv.slice(2);
let out;
const targets = [];
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i] === '--out' && argv[i + 1]) out = argv[i + 1];
  else if (argv[i] === '--target' && /^apps\/[\w-]+(:[\w-]+)?$/.test(argv[i + 1] ?? '')) targets.push(argv[i + 1]);
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
if (!out || targets.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function finish(head, rows, bundles, assets, status) {
  writeFileSync(out, `${JSON.stringify({ head, rows, bundles, assets })}\n`);
  for (const row of rows) console.error(`bundle: ${row.name} exit ${row.exitCode} in ${row.seconds.toFixed(1)} s`);
  process.exit(status);
}

/** Run a command, its output passed through and its tail kept. */
function step(name, cwd, command, args) {
  const began = Date.now();
  return new Promise((resolve) => {
    let output = '';
    const keep = (chunk) => {
      process.stderr.write(chunk);
      output = (output + chunk.toString()).slice(-OUTPUT_CAP);
    };
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => keep(`\n${command} could not start: ${error.message}\n`));
    child.on('close', (code, signal) => {
      if (signal) keep(`\n${command} was killed by ${signal}\n`);
      resolve({ name, exitCode: code ?? 128, seconds: (Date.now() - began) / 1000, output });
    });
  });
}

const top = git(['rev-parse', '--show-toplevel']);
const root = top.stdout.trim();
const head = top.status === 0 ? git(['rev-parse', 'HEAD'], root).stdout.trim() : '';
const dirty = () => git(['status', '--porcelain', '--untracked-files=all'], root).stdout;
if (top.status !== 0 || !head || dirty()) {
  finish(head || null, [{ name: 'checkout', exitCode: 2, seconds: 0, output: top.status !== 0 ? `not a git checkout: ${top.stderr.trim()}` : `the checkout is not clean:\n${dirty()}` }], {}, {}, 2);
}

const rows = [];
const gate = await step('dist-gate', root, 'bun', ['scripts/dist-integrity.mjs']);
const moved = dirty();
if (gate.exitCode === 0 && moved) {
  // The gate rebuilt and recorded: this commit's record is not the fixpoint's.
  gate.exitCode = 1;
  gate.output += `\nthe gate changed the tree, so this commit's dist-fixpoint.json is stale: run scripts/ci/remote-build.mjs and commit its patch\n${moved}`;
}
rows.push(gate);
if (gate.exitCode !== 0) finish(head, rows, {}, {}, 1);

// Assets, once per app that builds them.
const assets = {};
for (const app of new Set(targets.map((target) => target.split(':')[0]))) {
  const scripts = JSON.parse(readFileSync(join(root, app, 'package.json'), 'utf8')).scripts ?? {};
  if (!scripts['build:assets']) continue;
  const built = await step(`assets ${app}`, root, 'bun', ['run', '--cwd', app, 'build:assets']);
  rows.push(built);
  if (built.exitCode !== 0) finish(head, rows, {}, {}, 1);
  const directory = join(root, app, 'dist', 'assets');
  const docs = join(root, 'apps', 'docs', 'dist', 'docs');
  if (!existsSync(directory) || !existsSync(docs)) {
    built.exitCode = 1;
    built.output += `\nbuild:assets left no ${existsSync(directory) ? docs : directory}\n`;
    finish(head, rows, {}, {}, 1);
  }
  const manifest = Object.fromEntries(filesUnder(directory).sort().map((path) => [path, sha256(readFileSync(join(directory, path)))]));
  const tar = spawnSync('tar', ['-C', docs, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '.'], { maxBuffer: 1 << 30 });
  if (tar.status !== 0) {
    built.exitCode = 1;
    built.output += `\ntar of ${docs} failed: ${tar.stderr}\n`;
    finish(head, rows, {}, {}, 1);
  }
  assets[app] = { manifest, docs: { sha256: sha256(tar.stdout), base64: tar.stdout.toString('base64') } };
}

const bundles = {};
for (const target of targets) {
  const [app, env] = target.split(':');
  const outdir = mkdtempSync(join(tmpdir(), 'ci-bundle-'));
  try {
    const built = await step(`bundle ${target}`, join(root, app), join(root, 'node_modules', '.bin', 'wrangler'),
      ['deploy', '--dry-run', '--outdir', outdir, ...(env ? ['-e', env] : [])]);
    rows.push(built);
    // One module is what an upload without bundling carries: anything more is a change to this tool.
    const modules = readdirSync(outdir).filter((name) => !name.endsWith('.map') && name !== 'README.md');
    if (built.exitCode === 0 && modules.length !== 1) {
      built.exitCode = 1;
      built.output += `\nwrangler wrote ${modules.length} modules (${modules.join(', ')}), not one\n`;
    }
    if (built.exitCode !== 0) finish(head, rows, {}, {}, 1);
    const bytes = readFileSync(join(outdir, modules[0]));
    bundles[target] = { main: modules[0], sha256: sha256(bytes), base64: bytes.toString('base64') };
    // Every env of one app ships the same module: the env decides bindings, not code.
    const sibling = Object.entries(bundles).find(([other, bundle]) => other !== target && other.split(':')[0] === app && bundle.sha256 !== bundles[target].sha256);
    if (sibling) {
      built.exitCode = 1;
      built.output += `\n${target}'s module (sha256 ${bundles[target].sha256}) differs from ${sibling[0]}'s (${sibling[1].sha256}): an env block changes the code, not only what is bound\n`;
      finish(head, rows, {}, {}, 1);
    }
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}
finish(head, rows, bundles, assets, 0);
