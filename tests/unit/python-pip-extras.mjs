#!/usr/bin/env bun
// A package's dependencies are read again when a later request asks for an
// extra it was not resolved with, though its version stays: the extra's
// dependencies join the install. A request that changes neither its version
// nor its extras reads nothing again, so cycles end.
//
// Red before: a package resolved again at the same version was skipped
// before its dependencies were read, so `b` requiring `a[x]` after `a` was
// resolved without x never installed x's dependency `c`.

import assert from 'node:assert/strict';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { buildPipInvocation } from '../../packages/core/src/runtime/python-pip.ts';
import { FakeVfs, cwd, file, installMockPypi, markers, project, restoreFetch } from './lib/pypi-mock.mjs';

const wheel = (name) => ({ '1.0.0': [file(name, '1.0.0', `${name}-1.0.0-py3-none-any.whl`)] });

try {
  installMockPypi([
    project('a', wheel('a'), { '1.0.0': ['c; extra == "x"', 'd; extra == "y"', 'b'] }),
    project('b', wheel('b'), { '1.0.0': ['a[x]'] }),
    project('e', wheel('e'), { '1.0.0': ['a[y]'] }),
    project('c', wheel('c')),
    project('d', wheel('d')),
  ]);
  const invocation = await buildPipInvocation(['install', 'a', 'e'], 'pip', cwd, new FakeVfs(), { home: '/home/user', network: ISOLATE_NETWORK, markers });
  assert.equal(invocation.mode, 'pip', invocation.error);
  const installs = (name) => invocation.code.includes(`"canonicalName":"${name}"`);
  assert.ok(installs('c'), 'b asks for a[x] after a was resolved without x: x\'s dependency c is installed');
  assert.ok(installs('d'), 'e asks for a[y]: y\'s dependency d is installed too');
  assert.ok(['a', 'b', 'e'].every(installs));
  console.log('  ✓ an extra asked for after its package resolved adds its dependencies; the a ↔ b cycle ends');
} finally {
  restoreFetch();
}

console.log('python-pip-extras: ok');
