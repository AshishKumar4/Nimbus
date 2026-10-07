#!/usr/bin/env bun
// The build as one CI task: the dist fixpoint and the typecheck of the
// commit checked out here, as a verdict plus the patch that brings dist to
// the fixpoint. Any runner that hands it a clean checkout of the commit,
// with `bun install --frozen-lockfile` done, runs it the same way; the
// workstation never builds (scripts/ci/remote-build.mjs runs it on armada).
//
//   bun scripts/ci/build.mjs --out <file> [--no-cache]
//
// <file> is JSON: { head, rows, patch }.
//   rows: dist-fixpoint, then typecheck, each { name, exitCode, seconds, output }.
//     dist-fixpoint runs scripts/dist-integrity.mjs. When that rebuild moves
//     the tree, it runs again on the rebuilt tree, which must move nothing
//     and records the fixpoint (dist-fixpoint.json). exitCode: 0, this
//     commit's dist is the fixpoint; 1, it needs the patch, or the gate
//     refused (output says why); 2, the build failed or could not run.
//     typecheck runs `bun run typecheck` on the tree the fixpoint left,
//     which is the tree the patch makes.
//   patch: what the build changed under its outputs, as `git diff --binary`
//     against head, or null when it changed nothing.
//   blobs: each path the patch touches, with the git mode and blob id the
//     build left it with ({ mode, blob }), or null where it removed it: what
//     a lane's applied patch is checked against, apart from the patch.
// Exit: 0, both rows green and no patch; 1, otherwise; 2, not graded (no
// clean git checkout here).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Each row's output keeps its last 256 KiB. */
const OUTPUT_CAP = 256 * 1024;

const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const out = outAt < 0 ? undefined : argv[outAt + 1];
if (!out || argv.some((arg, i) => arg !== '--no-cache' && i !== outAt && i !== outAt + 1)) {
  console.error('usage: bun scripts/ci/build.mjs --out <file> [--no-cache]');
  process.exit(2);
}
const cache = argv.includes('--no-cache') ? ['--no-cache'] : [];

const git = (args, options = {}) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, ...options });

/** Write the verdict and exit with its status. */
function finish(head, rows, patch, status, blobs = {}) {
  writeFileSync(out, `${JSON.stringify({ head, rows, patch, blobs })}\n`);
  for (const row of rows) console.error(`build: ${row.name} exit ${row.exitCode} in ${row.seconds.toFixed(1)} s`);
  process.exit(status);
}

/** Run a command at the root, its output passed through and its tail kept. */
function step(name, root, command, args) {
  const began = Date.now();
  return new Promise((resolve) => {
    let output = '';
    const keep = (chunk) => {
      process.stderr.write(chunk);
      output = (output + chunk.toString()).slice(-OUTPUT_CAP);
    };
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
const head = top.status === 0 ? git(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim() : '';
const dirty = top.status === 0 ? git(['status', '--porcelain', '--untracked-files=all'], { cwd: root }).stdout : '';
if (top.status !== 0 || !head || dirty) {
  const why = top.status !== 0 ? `not a git checkout: ${top.stderr.trim()}` : `the checkout is not clean, so a patch would carry more than the build:\n${dirty}`;
  finish(head || null, [{ name: 'checkout', exitCode: 2, seconds: 0, output: why }], null, 2);
}

// The gate's own list of what it writes: the patch carries those paths only.
const { OUTPUT_ROOTS, FIXPOINT_RECORD } = await import(pathToFileURL(join(root, 'scripts', 'dist-integrity.mjs')).href);
const outputs = [...OUTPUT_ROOTS, FIXPOINT_RECORD];
/** The outputs as they stand, as a git tree id (through a scratch index). */
function outputsTree() {
  const scratch = mkdtempSync(join(tmpdir(), 'ci-build-outputs-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    git(['read-tree', 'HEAD'], { cwd: root, env });
    const present = outputs.filter((path) => existsSync(join(root, path)) || git(['cat-file', '-e', `HEAD:${path}`], { cwd: root }).status === 0);
    git(['add', '--all', '--', ...present], { cwd: root, env });
    return git(['write-tree'], { cwd: root, env }).stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Gate passes until one leaves the outputs as it found them. A pass whose
 * rebuild moved dist records nothing, by design; the pass after it proves the
 * rebuilt tree is the fixpoint and records it, so the patch carries the
 * record and the gate accepts the patched commit. The gate's build plan
 * should reach the fixpoint in one rebuild (two passes); a third is said, by
 * name, as the plan's bug it is, and more than MAX_PASSES is red.
 */
const MAX_PASSES = 4;
const fixpoint = { name: 'dist-fixpoint', exitCode: 1, seconds: 0, output: '' };
for (let pass = 1; ; pass++) {
  const before = outputsTree();
  const run = await step('dist-fixpoint', root, 'bun', ['scripts/dist-integrity.mjs', ...(pass === 1 ? cache : ['--no-cache'])]);
  fixpoint.seconds += run.seconds;
  fixpoint.output = `${fixpoint.output}${pass > 1 ? `\n── rebuilt; the gate again (pass ${pass}), on the rebuilt tree ──\n` : ''}${run.output}`.slice(-OUTPUT_CAP);
  const rebuilt = outputsTree() !== before;
  if (run.exitCode !== 1 || !rebuilt) {
    // 0 on the first pass: this commit's dist is the fixpoint. 0 later: the patch makes it so.
    fixpoint.exitCode = run.exitCode === 0 && pass > 1 ? 1 : run.exitCode;
    if (pass > 2) fixpoint.output += `\nthe build reached its fixpoint only on rebuild ${pass - 1}: dist-integrity's BUILD_FIXPOINT should reach it in one\n`;
    break;
  }
  if (pass === MAX_PASSES) {
    fixpoint.output += `\nthe build did not reach a fixpoint in ${MAX_PASSES} passes: each rebuild moved dist again\n`;
    break;
  }
}

// What the build wrote outside its outputs would not be in the patch: the
// gate's roots must cover everything its steps write.
const stray = git(['status', '--porcelain', '--untracked-files=all'], { cwd: root }).stdout
  .split('\n').filter((line) => line && !outputs.some((path) => line.slice(3) === path || line.slice(3).startsWith(`${path}/`)));
if (stray.length > 0) {
  fixpoint.output += `\nthe build wrote outside its outputs (not in the patch):\n${stray.join('\n')}\n`;
  if (fixpoint.exitCode === 0) fixpoint.exitCode = 1;
}

// The patch, through a scratch index so the checkout's own is untouched.
const scratch = mkdtempSync(join(tmpdir(), 'ci-build-index-'));
let patch = null;
/** Why the patch could not be made, if it could not. @type {string | null} */
let unmade = null;
/** @type {Record<string, { mode: string, blob: string } | null>} */
const blobs = {};
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  // An output neither on disk nor at HEAD (a record never written) is no pathspec git can add.
  const present = outputs.filter((path) => existsSync(join(root, path)) || git(['cat-file', '-e', `HEAD:${path}`], { cwd: root }).status === 0);
  for (const args of [['read-tree', 'HEAD'], ['add', '--all', '--', ...present]]) {
    const done = git(args, { cwd: root, env });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
  }
  const diff = git(['diff', '--cached', '--binary', 'HEAD', '--', ...outputs], { cwd: root, env });
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  patch = diff.stdout || null;
  // `:<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0` per path.
  const raw = git(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD', '--', ...outputs], { cwd: root, env });
  if (raw.status !== 0) throw new Error(`git diff --raw failed: ${raw.stderr}`);
  const fields = raw.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , blob, status] = fields[i].slice(1).split(' ');
    blobs[fields[i + 1]] = status === 'D' ? null : { mode, blob };
  }
} catch (error) {
  unmade = error.message;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// No patch can be trusted: not graded, with what failed.
if (unmade !== null) finish(head, [fixpoint, { name: 'patch', exitCode: 2, seconds: 0, output: unmade }], null, 2);
if (patch !== null && fixpoint.exitCode === 0) fixpoint.exitCode = 1;

const typecheck = await step('typecheck', root, 'bun', ['run', 'typecheck']);
const rows = [fixpoint, typecheck];
finish(head, rows, patch, rows.every((row) => row.exitCode === 0) && patch === null ? 0 : 1, blobs);
