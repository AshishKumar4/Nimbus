#!/usr/bin/env bun
// ruby-repl-cwd: the Ruby prompt runs over the caller's filesystem, from the
// shell's working directory, and names its own command.
//
// It ran with no supervisor, no cwd and no binName: once the runner refused a
// working directory it could not enter (ec9644cdb), every `ruby` prompt
// printed "undefined: can't enter working directory '/home/user': [Errno 8]
// Bad file descriptor" and evaluated nothing (repl/ruby-hello-repl on
// staging). Before that, it evaluated in an empty '/'.
//
// The prompt's facet step (rubyReplStepFacetFn), driven over the facet's own
// __rubyRun with the VM stood in for by a recorder of what it evaluates: it
// publishes and adopts the pool's SUPERVISOR (the caller's filesystem), and
// hands __rubyRun the caller's cwd, HOME and command. What it evaluates then
// runs under the host's Ruby, in a directory holding a file: the prompt reads
// that file by its relative name.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plugin } from 'bun';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';

plugin({
  name: 'cloudflare-shims',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: { DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } },
    }));
  },
});
const { rubyReplStepFacetFn } = await import('../../packages/worker/src/runtime/ruby-repl.ts');

if (spawnSync('ruby', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('ruby-repl-cwd: SKIPPED (no host ruby)');
  process.exit(0);
}

// The facet's scope: the runner tail, with the VM and the WASI mount stood in for.
const evaluated = [];
Object.assign(globalThis, { __nimbusRubyStdout: [], __nimbusRubyStderr: [], __nimbusRubyStep: async () => ({ resumed: false, alive: false }) });
const stand = [
  'function __nimbusInstallRubyFs() {}',
  // What __rubyRun re-adopts after the mount: the supervisor the entry published.
  'function __wasiAdoptSupervisor(supervisor) { globalThis.__readopted = supervisor; }',
  'async function __nimbusRubyEval(boot, code) { globalThis.__evaluated.push(code); return { status: 0 }; }',
].join('\n');
globalThis.__evaluated = evaluated;
new Function('globalThis', `${RUBY_RUNNER_PREAMBLE_TAIL}\n${stand}`)(globalThis);
globalThis.__rubyBootstrap = Promise.resolve({ ok: true, rubyInitialized: true });
let adopted;
globalThis.__wasiAdoptSupervisor = (supervisor) => { adopted = supervisor; };

const dir = mkdtempSync(join(tmpdir(), 'ruby-repl-cwd-'));
try {
  writeFileSync(join(dir, 'hello.txt'), 'from the cwd\n');
  const sessionFs = { name: 'the caller\'s filesystem' };
  const step = async (cwd) => {
    evaluated.length = 0;
    const result = await rubyReplStepFacetFn(
      { userCode: 'print File.read("hello.txt"); print Dir.pwd', home: dir, cwd, binName: 'ruby' },
      { SUPERVISOR: sessionFs },
    );
    assert.equal(result.exitCode, 0);
    return spawnSync('ruby', ['-e', evaluated.join('\n')], { encoding: 'utf8', cwd: '/' });
  };

  const ran = await step(dir);
  assert.equal(adopted, sessionFs, 'the step adopts the pool\'s SUPERVISOR');
  assert.equal(globalThis.__nimbusRubySupervisor, sessionFs, 'and publishes it');
  assert.equal(globalThis.__readopted, sessionFs, 'so __rubyRun re-adopts it after the mount');
  assert.equal(ran.stdout, `from the cwd\n${dir}`, `the prompt reads a file in its cwd: ${ran.stderr}`);
  assert.match(ran.stderr, /__NIMBUS_RUBY_EXIT_0\n$/);

  // The next line on the same VM keeps the directory the program left: it
  // names no cwd, so nothing moves it back (Dir.chdir('/tmp'), then Dir.pwd).
  await step(dir);
  assert.ok(!evaluated.join('\n').includes('Dir.chdir('), 'a later line on the same VM does not change directory');

  // A fresh VM starts in the cwd again, and refuses one it cannot enter.
  delete globalThis.__nimbusRubyPromptStarted;
  const refused = await step(join(dir, 'gone'));
  assert.match(refused.stderr, new RegExp(`^ruby: can't enter working directory '${join(dir, 'gone')}': \\[Errno 2\\] `),
    `a cwd it cannot enter names the command: ${refused.stderr}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('ruby-repl-cwd: the prompt reads its cwd over the caller\'s filesystem');
