#!/usr/bin/env bun
// A Worker's deploy bundle as one CI task: what `wrangler deploy` would
// upload for an app of the commit checked out here, built here so the
// machine that deploys only uploads it (tests/behavioral/_throwaway-target.mjs
// up --bundle). Any runner that hands it a clean checkout with `bun install
// --frozen-lockfile` done runs it the same way; scripts/ci/remote-probes.mjs
// --deploy runs it on armada.
//
//   bun scripts/ci/bundle.mjs --out <file> [--app apps/probe]
//
// First the dist gate (scripts/dist-integrity.mjs): the bundle is built from
// dist, so a commit whose dist is not the fixpoint of its src gets no bundle
// (run scripts/ci/remote-build.mjs, commit its patch). Then `wrangler deploy
// --dry-run --outdir` in the app. No credential is needed or used.
//
// <file> is JSON: { head, app, rows, bundle }. rows: dist-gate, bundle, each
// { name, exitCode, seconds, output }. bundle: { main, sha256, base64 } (the
// app's one module, as wrangler would upload it), or null.
// Exit: 0, a bundle; 1, a red row; 2, not graded (no clean checkout here).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUTPUT_CAP = 256 * 1024;

const argv = process.argv.slice(2);
const flags = { app: 'apps/probe' };
for (let i = 0; i < argv.length; i += 2) {
  if (!['--out', '--app'].includes(argv[i]) || argv[i + 1] === undefined) {
    console.error('usage: bun scripts/ci/bundle.mjs --out <file> [--app apps/probe]');
    process.exit(2);
  }
  flags[argv[i].slice(2)] = argv[i + 1];
}
if (!flags.out) {
  console.error('usage: bun scripts/ci/bundle.mjs --out <file> [--app apps/probe]');
  process.exit(2);
}

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });

function finish(head, rows, bundle, status) {
  writeFileSync(flags.out, `${JSON.stringify({ head, app: flags.app, rows, bundle })}\n`);
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
  finish(head || null, [{ name: 'checkout', exitCode: 2, seconds: 0, output: top.status !== 0 ? `not a git checkout: ${top.stderr.trim()}` : `the checkout is not clean:\n${dirty()}` }], null, 2);
}

const gate = await step('dist-gate', root, 'bun', ['scripts/dist-integrity.mjs']);
const moved = dirty();
if (gate.exitCode === 0 && moved) {
  // The gate rebuilt and recorded: this commit's record is not the fixpoint's.
  gate.exitCode = 1;
  gate.output += `\nthe gate changed the tree, so this commit's dist-fixpoint.json is stale: run scripts/ci/remote-build.mjs and commit its patch\n${moved}`;
}
if (gate.exitCode !== 0) finish(head, [gate], null, 1);

const outdir = mkdtempSync(join(tmpdir(), 'ci-bundle-'));
let built;
let bundle = null;
try {
  built = await step('bundle', join(root, flags.app), join(root, 'node_modules', '.bin', 'wrangler'), ['deploy', '--dry-run', '--outdir', outdir]);
  // One module is what an upload without bundling carries: anything more is a change to this tool.
  const modules = readdirSync(outdir).filter((name) => !name.endsWith('.map') && name !== 'README.md');
  if (built.exitCode === 0 && modules.length !== 1) {
    built.exitCode = 1;
    built.output += `\nwrangler wrote ${modules.length} modules (${modules.join(', ')}), not one\n`;
  }
  if (built.exitCode === 0) {
    const bytes = readFileSync(join(outdir, modules[0]));
    bundle = { main: modules[0], sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
  }
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
finish(head, [gate, built], bundle, bundle ? 0 : 1);
