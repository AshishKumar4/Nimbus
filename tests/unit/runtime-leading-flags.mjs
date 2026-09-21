#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { makeClangRunnerFactory } from '../../packages/core/src/runtime/clang-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/core/src/runtime/ruby-runner.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { ExecutionFs } from '../../packages/core/src/shell/execution-fs.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

// A session with a home but no installed runtime: the only thing a refusal can
// come from is the missing blob the manifest names.
function missingInstallAuthority() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true, mode: 0o755 });
  root.chown('home/user', USER.uid, USER.gid);
  return new SqliteFilesystemAuthority(raw);
}

function outputContext(filesystem, args) {
  let stdout = '';
  let stderr = '';
  return {
    ctx: {
      pid: 17,
      vfs: new ExecutionFs(filesystem.bind({ pid: 17, cred: USER })),
      cred: USER,
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
  open() { throw new Error('the runtime is missing — nothing may be opened'); },
};

{
  const manifest = {
    files: [{ path: 'share/ruby/ruby+stdlib.wasm' }],
  };
  const filesystem = missingInstallAuthority();
  const runRuby = await makeRubyRunnerFactory({
    facets: unreachableFacets,
    filesystem,
  })(manifest, '/runtime/ruby', 'ruby', undefined);
  const invocation = outputContext(filesystem, ['script.rb', '--version']);
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
  const filesystem = missingInstallAuthority();
  const runClang = makeClangRunnerFactory({
    facets: unreachableFacets,
    filesystem,
  })(manifest, '/runtime/clang', 'clang', undefined);
  const invocation = outputContext(filesystem, ['main.c', '--version']);
  assert.equal(await runClang(invocation.ctx), 127);
  assert.doesNotMatch(invocation.output().stdout, /^Nimbus wasm-clang/);
  assert.match(invocation.output().stderr, /sysroot\.tar missing/);
}

console.log('runtime-leading-flags: ok');
