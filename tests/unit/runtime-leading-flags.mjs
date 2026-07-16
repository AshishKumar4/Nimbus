#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { makeClangRunnerFactory } from '../../packages/worker/src/runtime/clang-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/worker/src/runtime/ruby-runner.ts';

function outputContext(args) {
  let stdout = '';
  let stderr = '';
  return {
    ctx: {
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

const missingRuntimeVfs = {
  exists: () => false,
  readdir: () => [],
};

{
  const manifest = {
    files: [{ path: 'share/ruby/ruby+stdlib.wasm' }],
  };
  const runRuby = makeRubyRunnerFactory({
    facetMgr: {},
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
      { path: 'share/clang/memfs.wasm' },
      { path: 'share/clang/sysroot.tar' },
    ],
  };
  const runClang = makeClangRunnerFactory({
    facetMgr: {},
    vfs: missingRuntimeVfs,
  })(manifest, '/runtime/clang', 'clang', undefined);
  const invocation = outputContext(['main.c', '--version']);
  assert.equal(await runClang(invocation.ctx), 127);
  assert.doesNotMatch(invocation.output().stdout, /^Nimbus wasm-clang/);
  assert.match(invocation.output().stderr, /memfs\.wasm missing/);
}

console.log('runtime-leading-flags: ok');
