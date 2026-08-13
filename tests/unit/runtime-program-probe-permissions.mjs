#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { makeCPythonRunnerFactory } from '../../packages/core/src/runtime/cpython-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/core/src/runtime/ruby-runner.ts';
import { makeWasmRunner } from '../../packages/core/src/runtime/wasm-runner.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';

const USER_CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

// The probe is refused before any program is compiled, so a facet host that
// throws on use proves the refusal came first.
const unreachableFacets = {
  parking: 'none',
  seedFilesystem() { throw new Error('a denied program must never be seeded'); },
  open() { throw new Error('a denied program must never open a facet'); },
};

function accessDenied(path) {
  return Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
}

function outputContext(args) {
  let stdout = '';
  let stderr = '';
  return {
    ctx: {
      pid: 17,
      cred: USER_CRED,
      args,
      cwd: '/home/user',
      env: {},
      stdin: '',
      stdout: { write: (value) => { stdout += String(value); } },
      stderr: { write: (value) => { stderr += String(value); } },
      setUmask() {},
      async runAs() { return 1; },
    },
    output: () => ({ stdout, stderr }),
  };
}

function runtimeVfs(runtimeFiles, deniedPath) {
  const files = new Map(Object.entries(runtimeFiles));
  return {
    as() { return this; },
    exists(path) {
      if (path === deniedPath) throw accessDenied(path);
      return files.has(path);
    },
    readFile(path) {
      const contents = files.get(path);
      if (!contents) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    readdir() { return []; },
    revision() { return 0; },
  };
}

{
  const deniedPath = 'home/user/locked/tool.py';
  const vfs = runtimeVfs({
    '/runtime/python/share/cpython/python.wasm': new Uint8Array([0]),
    '/runtime/python/lib/python313.zip': new Uint8Array(),
  }, deniedPath);
  const run = makeCPythonRunnerFactory({ facets: unreachableFacets, vfs })(
    {
      files: [
        { path: 'share/cpython/python.wasm' },
        { path: 'lib/python313.zip' },
      ],
    },
    '/runtime/python',
    'python',
    undefined,
  );
  const invocation = outputContext(['locked/tool.py']);
  const exitCode = await run(invocation.ctx);
  assert.equal(exitCode, 1);
  assert.match(invocation.output().stderr, /python: locked\/tool\.py: EACCES:/);
}

{
  const deniedPath = 'home/user/locked/tool.rb';
  const vfs = runtimeVfs({
    '/runtime/ruby/share/ruby/ruby+stdlib.wasm': new Uint8Array([0]),
  }, deniedPath);
  const run = makeRubyRunnerFactory({ facets: unreachableFacets, vfs })(
    { files: [{ path: 'share/ruby/ruby+stdlib.wasm' }] },
    '/runtime/ruby',
    'ruby',
    undefined,
  );
  const invocation = outputContext(['locked/tool.rb']);
  const exitCode = await run(invocation.ctx);
  assert.equal(exitCode, 1);
  assert.match(invocation.output().stderr, /ruby: locked\/tool\.rb: EACCES:/);
}

{
  const deniedPath = 'home/user/locked/program.wasm';
  const vfs = runtimeVfs({}, deniedPath);
  const run = makeWasmRunner({ vfs, facets: { open: () => { throw new Error('unreachable'); } }, processes: {} });
  const result = await run('', {
    argv: [],
    env: {},
    cwd: '/home/user',
    filename: '/home/user/locked/program.wasm',
    dirname: '/home/user/locked',
    command: 'wasm-runner /home/user/locked/program.wasm',
    cred: USER_CRED,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /wasm-runner: cannot read .*program\.wasm.*EACCES:/);
}

{
  const commands = new Map();
  const deniedPath = 'home/user/locked/tool.sh';
  const vfs = {
    exists(path) {
      if (path === deniedPath) throw accessDenied(path);
      return false;
    },
    readFileString() {
      throw new Error('script contents must not be read after a denied probe');
    },
  };
  registerShellEntrypointCommands(
    {
      has: (name) => commands.has(name),
      register: (name, handler) => commands.set(name, handler),
    },
    { async execute() { throw new Error('denied script must not execute'); } },
    vfs,
  );
  const invocation = outputContext(['locked/tool.sh']);
  invocation.ctx.vfs = vfs;
  const exitCode = await commands.get('sh')(invocation.ctx);
  assert.equal(exitCode, 126);
  assert.equal(invocation.output().stderr, 'sh: locked/tool.sh: Permission denied\n');
}

console.log('runtime program probe permissions: ok');
