#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { makeClangRunnerFactory } from '../../packages/core/src/runtime/clang-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/core/src/runtime/ruby-runner.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { installedRuntime, manifestFile, runtimeContext } from './lib/runtime-session.mjs';

// A session with a home but no installed runtime: the only thing a refusal can
// come from is the missing blob the manifest names (with the digest of the
// bytes it would be, as every manifest entry carries).
const missingInstallAuthority = () => installedRuntime().filesystem;
const published = (path) => manifestFile(path, new Uint8Array([0]));
const outputContext = (filesystem, args) => runtimeContext(filesystem, { args, pid: 17 });

// A missing install is refused before anything is compiled, so a host that
// throws on use proves the refusal happened first.
const unreachableFacets = {
  parking: 'none',
  open() { throw new Error('the runtime is missing — nothing may be opened'); },
};

{
  const manifest = {
    files: [published('share/ruby/ruby+stdlib.wasm')],
  };
  const filesystem = missingInstallAuthority();
  const runRuby = await makeRubyRunnerFactory({
    facets: unreachableFacets,
    filesystem,
    getHome: () => '/home/user',
    network: ISOLATE_NETWORK,
  })(manifest, '/runtime/ruby', 'ruby', undefined);
  const invocation = outputContext(filesystem, ['script.rb', '--version']);
  assert.equal(await runRuby(invocation.ctx), 127);
  assert.doesNotMatch(invocation.output().stdout, /^ruby 3\.3\.3/);
  assert.match(invocation.output().stderr, /ruby\+stdlib\.wasm missing/);
}

{
  const manifest = {
    files: [
      published('bin/clang'),
      published('bin/wasm-ld'),
      published('share/clang/sysroot.tar'),
    ],
  };
  const filesystem = missingInstallAuthority();
  const runClang = makeClangRunnerFactory({
    facets: unreachableFacets,
    filesystem,
    session: 'runtime-leading-flags',
  })(manifest, '/runtime/clang', 'clang', undefined);
  const invocation = outputContext(filesystem, ['main.c', '--version']);
  assert.equal(await runClang(invocation.ctx), 127);
  assert.doesNotMatch(invocation.output().stdout, /^Nimbus wasm-clang/);
  assert.match(invocation.output().stderr, /sysroot\.tar missing/);
}

console.log('runtime-leading-flags: ok');
