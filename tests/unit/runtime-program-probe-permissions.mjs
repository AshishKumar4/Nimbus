#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { makeCPythonRunnerFactory } from '../../packages/core/src/runtime/cpython-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/core/src/runtime/ruby-runner.ts';
import { makeWasmRunner } from '../../packages/core/src/runtime/wasm-runner.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { ExecutionFs } from '../../packages/core/src/shell/execution-fs.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER_CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

// The probe is refused before any program is compiled, so a facet host that
// throws on use proves the refusal came first.
const unreachableFacets = {
  parking: 'none',
  open() { throw new Error('a denied program must never open a facet'); },
};

function accessDenied(path) {
  return Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
}

function outputContext(args, vfs) {
  let stdout = '';
  let stderr = '';
  return {
    ctx: {
      pid: 17,
      vfs,
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

/**
 * The denied program lives in a root-owned directory the session user may not
 * traverse, so the refusal comes from the authority rather than from a stub.
 */
function deniedProgramAuthority(runtimeFiles, deniedPath) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true, mode: 0o755 });
  root.chown('home/user', USER_CRED.uid, USER_CRED.gid);
  root.mkdir('home/user/locked', { mode: 0o700 });
  root.writeFile(deniedPath, new Uint8Array([0]), { mode: 0o644 });
  for (const [path, bytes] of Object.entries(runtimeFiles)) {
    const clean = path.replace(/^\/+/, '');
    root.mkdir(clean.replace(/\/[^/]+$/, ''), { recursive: true, mode: 0o755 });
    root.writeFile(clean, bytes, { mode: 0o644 });
  }
  return new SqliteFilesystemAuthority(raw);
}

function invocationVfs(filesystem) {
  return new ExecutionFs(filesystem.bind({ pid: 17, cred: USER_CRED }));
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
  const run = await makeRubyRunnerFactory({ facets: unreachableFacets, filesystem })(
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
  );
  const invocation = outputContext(['locked/tool.sh'], vfs);
  const exitCode = await commands.get('sh')(invocation.ctx);
  assert.equal(exitCode, 126);
  assert.equal(invocation.output().stderr, 'sh: locked/tool.sh: Permission denied\n');
}

console.log('runtime program probe permissions: ok');
