#!/usr/bin/env bun

// create-nimbus-app accepted any `--x` into a map only three keys were ever
// read from, so `--templete worker-only` scaffolded the DEFAULT template and
// said nothing. A scaffolder is the worst place for that: the wrong project
// is the one you keep working in. Single-dash flags were skipped outright, so
// `-f` neither forced nor complained, and `--name` with nothing after it
// stored '' and silently fell back to the directory name.

import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scaffold } from '../../packages/cli/src/commands/scaffold.ts';

async function run(args, { cwd } = {}) {
  const oldWrite = process.stdout.write;
  const oldErrWrite = process.stderr.write;
  const oldCwd = process.cwd();
  let stdout = '';
  let stderr = '';
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  if (cwd) process.chdir(cwd);
  try {
    const exitCode = await scaffold(args);
    return { exitCode, stdout, stderr };
  } finally {
    if (cwd) process.chdir(oldCwd);
    process.stdout.write = oldWrite;
    process.stderr.write = oldErrWrite;
  }
}

const workdir = await mkdtemp(join(tmpdir(), 'nimbus-scaffold-flags-'));

try {
  // ── a mistyped flag is refused, not silently ignored ────────────────────
  // This is the headline case: the old parser scaffolded a default-template
  // project and exited 0.
  const typo = await run(['proj-typo', '--templete', 'worker-only'], { cwd: workdir });
  assert.equal(typo.exitCode, 64, `--templete should be refused: ${typo.stderr}`);
  assert.match(typo.stderr, /unknown option "--templete"/);

  // Nothing was written, so the refusal happened before any scaffolding.
  await assert.rejects(
    () => readFile(join(workdir, 'proj-typo', 'package.json'), 'utf8'),
    'a refused invocation must not leave a project behind',
  );

  // ── single-dash flags were skipped by the `--` test entirely ────────────
  const shortFlag = await run(['proj-short', '-f'], { cwd: workdir });
  assert.equal(shortFlag.exitCode, 64);
  assert.match(shortFlag.stderr, /unknown option "-f"/);

  // ── a value-taking flag with no value is an error, not a fallback ───────
  const noValue = await run(['proj-noval', '--name'], { cwd: workdir });
  assert.equal(noValue.exitCode, 64);
  assert.match(noValue.stderr, /option "--name" requires a value/);

  // A following flag is not a value either.
  const flagAsValue = await run(['proj-flagval', '--name', '--force'], { cwd: workdir });
  assert.equal(flagAsValue.exitCode, 64);
  assert.match(flagAsValue.stderr, /option "--name" requires a value/);

  // ── a stray positional is refused rather than dropped ───────────────────
  const stray = await run(['proj-stray', 'extra-arg'], { cwd: workdir });
  assert.equal(stray.exitCode, 64);
  assert.match(stray.stderr, /unexpected argument "extra-arg"/);

  // ── the flags that DO exist still work ──────────────────────────────────
  const ok = await run(['proj-ok', '--name', 'my-worker'], { cwd: workdir });
  assert.equal(ok.exitCode, 0, ok.stderr);

  // --name reached wrangler.jsonc rather than defaulting to the directory.
  const wrangler = await readFile(join(workdir, 'proj-ok', 'wrangler.jsonc'), 'utf8');
  assert.match(wrangler, /"name":\s*"my-worker"/, 'the --name value must be used');

  // Without --name the worker takes the project name, so the flag is what
  // made the difference above.
  const defaulted = await run(['proj-default'], { cwd: workdir });
  assert.equal(defaulted.exitCode, 0, defaulted.stderr);
  const defaultWrangler = await readFile(join(workdir, 'proj-default', 'wrangler.jsonc'), 'utf8');
  assert.match(defaultWrangler, /"name":\s*"proj-default"/);

  // --template with its one supported value is accepted.
  const templated = await run(['proj-tpl', '--template', 'worker-only'], { cwd: workdir });
  assert.equal(templated.exitCode, 0, templated.stderr);

  // An unsupported template value was already refused; keep it that way.
  const badTemplate = await run(['proj-badtpl', '--template', 'nextjs'], { cwd: workdir });
  assert.notEqual(badTemplate.exitCode, 0);
  assert.match(badTemplate.stderr, /unknown template "nextjs"/);

  // --force takes no value, and the argument after it stays an argument.
  const forced = await run(['proj-ok', '--force'], { cwd: workdir });
  assert.equal(forced.exitCode, 0, `--force should overwrite: ${forced.stderr}`);

  // --help still short-circuits before any parsing.
  const help = await run(['--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /create-nimbus-app/);

  console.log('cli-scaffold-flags: ok');
} finally {
  await rm(workdir, { recursive: true, force: true });
}
