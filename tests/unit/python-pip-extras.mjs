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
import { file, installMockPypi, pipInstall, project, restoreFetch, scratch, wheelhouse } from './lib/pypi-mock.mjs';

const wheel = (name) => ({ '1.0.0': [file(name, '1.0.0', `${name}-1.0.0-py3-none-any.whl`)] });
const place = scratch();
try {
  installMockPypi(wheelhouse(place.root, [
    project('a', wheel('a'), { '1.0.0': ['c; extra == "x"', 'd; extra == "y"', 'b'] }),
    project('b', wheel('b'), { '1.0.0': ['a[x]'] }),
    project('e', wheel('e'), { '1.0.0': ['a[y]'] }),
    project('c', wheel('c')),
    project('d', wheel('d')),
  ]));
  assert.deepEqual(await pipInstall(['a', 'e'], place), { installed: ['a==1.0.0', 'b==1.0.0', 'c==1.0.0', 'd==1.0.0', 'e==1.0.0'] },
    'b asks for a[x] after a was resolved without x, and e for a[y]: c and d are installed');
  console.log('  ✓ an extra asked for after its package resolved adds its dependencies; the a ↔ b cycle ends');
} finally {
  restoreFetch();
  place.done();
}

console.log('python-pip-extras: ok');
