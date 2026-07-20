#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { makePythonRunnerFactory } from '../../packages/worker/src/runtime/python-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/worker/src/runtime/ruby-runner.ts';

const encoder = new TextEncoder();

class RuntimeVfs {
  constructor(files) {
    this.files = new Map(Object.entries(files));
  }
  exists(path) { return this.files.has(path); }
  isDirectory() { return false; }
  readFile(path) {
    const value = this.files.get(path);
    if (!value) throw new Error(`missing ${path}`);
    return value;
  }
  readdir() { return []; }
  revision() { return 0; }
  writeFile() {}
  mkdir() {}
  unlink() {}
  rmdir() {}
}

function loaderHarness() {
  const calls = [];
  const env = {
    LOADER: {
      get() {
        return {
          getEntrypoint() {
            return {
              async execute(args) {
                calls.push(args);
                return { exitCode: 0, stdout: '', stderr: '' };
              },
            };
          },
        };
      },
    },
  };
  const ctx = { id: { toString: () => 'unit-runtime-home' }, waitUntil() {} };
  return { calls, facetMgr: { env, ctx } };
}

function commandContext(env) {
  return {
    args: ['-e', 'puts ENV["HOME"]'],
    cwd: '/home/user',
    env,
    stdin: '',
    stdout: { write() {} },
    stderr: { write() {} },
  };
}

{
  const harness = loaderHarness();
  const sentinel = '/* Nimbus Pyodide workerd adapter: pyodide-0.29.4-workerd-adapter-v2 */';
  const vfs = new RuntimeVfs({
    '/runtime/python/share/pyodide/pyodide.asm.wasm': new Uint8Array([0]),
    '/runtime/python/share/pyodide/pyodide.asm.js': encoder.encode(sentinel),
    '/runtime/python/share/pyodide/python_stdlib.zip': new Uint8Array(),
  });
  const manifest = {
    version: '0.29.4',
    files: [
      { path: 'share/pyodide/pyodide.asm.wasm' },
      { path: 'share/pyodide/pyodide.asm.js' },
      { path: 'share/pyodide/python_stdlib.zip' },
    ],
    runtime_artifacts: [{
      id: 'pyodide-0.29.4-workerd-adapter-v2',
      kind: 'workerd-adapter',
      path: 'share/pyodide/pyodide.asm.js',
    }],
  };
  const run = makePythonRunnerFactory({ facetMgr: harness.facetMgr, vfs })(
    manifest,
    '/runtime/python',
    'python',
    undefined,
  );
  const ctx = commandContext({ HOME: '/home/pyodide' });
  ctx.args = ['-c', 'print(1)'];
  assert.equal(await run(ctx), 0);
  assert.equal(harness.calls[0].userEnv.HOME, '/home/pyodide');
  const defaultCtx = commandContext({});
  defaultCtx.args = ['-c', 'print(1)'];
  assert.equal(await run(defaultCtx), 0);
  assert.equal(harness.calls[1].userEnv.HOME, '/home/user');
}

{
  const harness = loaderHarness();
  const vfs = new RuntimeVfs({
    '/runtime/ruby/share/ruby/ruby+stdlib.wasm': new Uint8Array([0]),
  });
  const manifest = {
    files: [{ path: 'share/ruby/ruby+stdlib.wasm' }],
  };
  const run = makeRubyRunnerFactory({ facetMgr: harness.facetMgr, vfs })(
    manifest,
    '/runtime/ruby',
    'ruby',
    undefined,
  );
  assert.equal(await run(commandContext({ HOME: '/home/ruby' })), 0);
  assert.equal(harness.calls[0].userEnv.HOME, '/home/ruby');
  assert.equal(await run(commandContext({})), 0);
  assert.equal(harness.calls[1].userEnv.HOME, '/home/user');
}

console.log('runtime-home-env: ok');
