#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { makeClangRunnerFactory } from '../../packages/core/src/runtime/clang-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/core/src/runtime/ruby-runner.ts';

function outputContext(args) {
  let stdout = '';
  let stderr = '';
  return {
    ctx: {
      cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
      args,
      cwd: '/home/user',
      env: {},
      stdin: '',
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

// A missing install is refused before anything is compiled, so a host that
// throws on use proves the refusal happened first.
const unreachableFacets = {
  parking: 'none',
  seedFilesystem() { throw new Error('the runtime is missing — nothing may be seeded'); },
  open() { throw new Error('the runtime is missing — nothing may be opened'); },
};

const missingRuntimeVfs = {
  as() { return this; },
  exists: () => false,
  readdir: () => [],
};

{
  const manifest = {
    files: [{ path: 'share/ruby/ruby+stdlib.wasm' }],
  };
  const runRuby = makeRubyRunnerFactory({
    facets: unreachableFacets,
    vfs: missingRuntimeVfs,
  })(manifest, '/runtime/ruby', 'ruby', undefined);
  const invocation = outputContext(['script.rb', '--version']);
  assert.equal(await runRuby(invocation.ctx), 127);
  assert.doesNotMatch(invocation.output().stdout, /^ruby 3\.3\.3/);
  assert.match(invocation.output().stderr, /ruby\+stdlib\.wasm missing/);
}

{
  const manifest = {
    files: [
      { path: 'bin/clang' },
      { path: 'bin/wasm-ld' },
      { path: 'share/clang/sysroot.tar' },
    ],
  };
  const runClang = makeClangRunnerFactory({
    facets: unreachableFacets,
    vfs: missingRuntimeVfs,
  })(manifest, '/runtime/clang', 'clang', undefined);
  const invocation = outputContext(['main.c', '--version']);
  assert.equal(await runClang(invocation.ctx), 127);
  assert.doesNotMatch(invocation.output().stdout, /^Nimbus wasm-clang/);
  assert.match(invocation.output().stderr, /sysroot\.tar missing/);
}

console.log('runtime-leading-flags: ok');
