#!/usr/bin/env bun
// pip decides which dependencies apply by the environment markers of the
// interpreter it installs for, the ones its context names: CPython
// 3.13.14 on wasm32-wasi, whose sys_platform is "wasi".
//
// Red before: pip answered every marker from a table of its own, left from
// the Pyodide runtime: python_full_version 3.13.2 and sys_platform
// "emscripten". A dependency guarded by python_full_version >= "3.13.3" was
// dropped, and one for Emscripten installed.

import assert from 'node:assert/strict';
import { file, installMockPypi, markers, pipInstall, project, restoreFetch, scratch, wheelhouse } from './lib/pypi-mock.mjs';

const leaf = (name) => project(name, { '1.0.0': [file(name, '1.0.0', `${name.replace(/-/g, '_')}-1.0.0-py3-none-any.whl`)] });
const wasi = scratch();
const older = scratch();
try {
  installMockPypi(wheelhouse(wasi.root, [
    project('app', { '1.0.0': [file('app', '1.0.0', 'app-1.0.0-py3-none-any.whl')] }, {
      '1.0.0': [
        'wasi-only; sys_platform == "wasi"',
        'emscripten-only; sys_platform == "emscripten"',
        'patched-only; python_full_version >= "3.13.3"',
        'older-only; python_full_version < "3.13.3"',
      ],
    }),
    leaf('wasi-only'), leaf('emscripten-only'), leaf('patched-only'), leaf('older-only'),
  ]));
  const installed = await pipInstall(['app'], wasi);
  assert.deepEqual(installed, { installed: ['app==1.0.0', 'patched-only==1.0.0', 'wasi-only==1.0.0'] },
    'CPython 3.13.14 on WASI takes the WASI and >= 3.13.3 dependencies');
  console.log('  ✓ the interpreter\'s own markers decide: sys_platform "wasi", python_full_version 3.13.14');
  const other = await pipInstall(['app'], older, { markers: { ...markers, python_full_version: '3.13.2', implementation_version: '3.13.2' } });
  assert.deepEqual(other, { installed: ['app==1.0.0', 'older-only==1.0.0', 'wasi-only==1.0.0'] },
    'an interpreter at 3.13.2 takes the < 3.13.3 dependency instead');
  console.log('  ✓ another interpreter\'s markers decide for it');
} finally {
  restoreFetch();
  wasi.done();
  older.done();
}

console.log('python-pip-markers: ok');
