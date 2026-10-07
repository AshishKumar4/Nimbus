#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { makeCPythonRunnerFactory } from '../../packages/core/src/runtime/cpython-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/core/src/runtime/ruby-runner.ts';
import { makeWasmRunner } from '../../packages/core/src/runtime/wasm-runner.ts';
import { ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { SESSION_USER, installedRuntime, runtimeContext } from './lib/runtime-session.mjs';


// The probe is refused before any program is compiled, so a facet host that
// throws on use proves the refusal came first.
const unreachableFacets = {
  parking: 'none',
  open() { throw new Error('a denied program must never open a facet'); },
};

function accessDenied(path) {
  return Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
}

const outputContext = (args, vfs) => runtimeContext(null, {
  args, vfs, pid: 17, setUmask() {}, async runAs() { return { status: 1, signal: null }; },
});

/**
 * The denied program lives in a root-owned directory the session user may not
 * traverse, so the refusal comes from the authority rather than from a stub.
 */
function deniedProgramAuthority(runtimeFiles, deniedPath) {
  const { root, filesystem } = installedRuntime(runtimeFiles);
  root.mkdir('home/user/locked', { mode: 0o700 });
  root.writeFile(deniedPath, new Uint8Array([0]), { mode: 0o644 });
  return filesystem;
}

function invocationVfs(filesystem) {
  return new ProcessView(filesystem.bind({ pid: 17, cred: SESSION_USER }));
}

{
  const filesystem = deniedProgramAuthority({
    '/runtime/python/share/cpython/python.wasm': new Uint8Array([0]),
    '/runtime/python/lib/python313.zip': new Uint8Array(),
  }, 'home/user/locked/tool.py');
  const run = makeCPythonRunnerFactory({ facets: unreachableFacets })(
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
  const invocation = outputContext(['locked/tool.py'], invocationVfs(filesystem));
  const exitCode = await run(invocation.ctx);
  assert.equal(exitCode, 1);
  assert.match(invocation.output().stderr, /python: locked\/tool\.py: EACCES:/);
}

{
  const filesystem = deniedProgramAuthority({
    '/runtime/ruby/share/ruby/ruby+stdlib.wasm': new Uint8Array([0]),
  }, 'home/user/locked/tool.rb');
  const run = await makeRubyRunnerFactory({ facets: unreachableFacets, filesystem, getHome: () => '/home/user' })(
    { files: [{ path: 'share/ruby/ruby+stdlib.wasm' }] },
    '/runtime/ruby',
    'ruby',
    undefined,
  );
  const invocation = outputContext(['locked/tool.rb'], invocationVfs(filesystem));
  const exitCode = await run(invocation.ctx);
  assert.equal(exitCode, 1);
  assert.match(invocation.output().stderr, /ruby: locked\/tool\.rb: EACCES:/);
}

{
  const filesystem = deniedProgramAuthority({}, 'home/user/locked/program.wasm');
  const run = makeWasmRunner({
    filesystem,
    facets: { open: () => { throw new Error('unreachable'); } },
    processes: {},
  });
  const result = await run('', {
    argv: [],
    env: {},
    cwd: '/home/user',
    filename: '/home/user/locked/program.wasm',
    dirname: '/home/user/locked',
    command: 'wasm-runner /home/user/locked/program.wasm',
    cred: SESSION_USER,
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
  );
  const invocation = outputContext(['locked/tool.sh'], vfs);
  const exitCode = await commands.get('sh')(invocation.ctx);
  assert.equal(exitCode, 126);
  assert.equal(invocation.output().stderr, 'sh: locked/tool.sh: Permission denied\n');
}

console.log('runtime program probe permissions: ok');
