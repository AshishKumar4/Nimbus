#!/usr/bin/env bun
// Behavior test: which interpreter variant a session gets, and how it gets there.
//
// wasm32-wasi has no dlopen, so numpy and markupsafe's speedups are linked into
// a second interpreter (EXTENSIONS.md). Choosing it is the one decision that
// could quietly become a per-program classifier — "this script says numpy, boot
// the big one" — which cannot be right for `python -c` naming a module in a
// variable, and which is the shape this migration has been removing. So the
// contract asserted here is that the choice is a function of *installed state*
// and nothing else.
//
// The paired risk is a package that selects the variant but never installs a
// record, or installs a record the selector does not recognise. Either one is a
// session that pip says has numpy and whose interpreter does not, so the
// recorded path and the read path are asserted against each other rather than
// each against a literal.

import assert from 'node:assert/strict';

import {
  buildPipInvocation,
  PYTHON_SITE_PACKAGES_ROOT,
  sessionUsesSciVariant,
} from '../../packages/core/src/runtime/python-pip.ts';

/** A VFS that knows only which paths exist, which is all the selector reads. */
function vfsWith(paths) {
  const present = new Set(paths);
  return {
    exists: (p) => present.has(p.replace(/^\/+/, '')),
    readFile: () => { throw new Error('the variant selector must not read file contents'); },
  };
}

// ── A session that installed nothing compiled stays on the base interpreter ──
assert.equal(sessionUsesSciVariant(vfsWith([])), false,
  'an empty session must not pay for the sci variant');
assert.equal(
  sessionUsesSciVariant(vfsWith([`${PYTHON_SITE_PACKAGES_ROOT}/attrs-25.4.0.dist-info`])),
  false,
  'a pure-Python install must not select the sci variant');
console.log('  ok  a session without compiled packages stays on the base interpreter');

// ── Installing numpy is what selects it, and pip is what records that ───────
// The dist-info path is not written out here: it is taken from the install
// pip actually generates, so the two halves cannot drift apart.
const install = await buildPipInvocation(['install', 'numpy'], 'pip', '/home/user', vfsWith([]));
assert.equal(install.error, undefined, `pip install numpy failed to plan: ${install.error}`);
assert.equal(install.mode, 'pip');

const distInfoDirs = [...install.code.matchAll(/"canonicalName":\s*"([^"]+)",\s*"version":\s*"([^"]+)"/g)]
  .map(([, name, version]) => `${name}-${version}.dist-info`);
assert.deepEqual(distInfoDirs, ['numpy-2.4.3.dist-info'],
  `pip install numpy must record exactly numpy, got ${JSON.stringify(distInfoDirs)}`);
assert.match(install.code, /_nimbus_install_variant_package/,
  'numpy must install through the variant path, not by fetching a wheel');
// The helper that fetches wheels is always emitted, so the claim is about the
// data it is handed: nothing is downloaded, because the code is already here.
assert.match(install.code, /^remote_wheels = \[\]$/m,
  'there is no numpy wheel to fetch: its code is already in the interpreter');
assert.match(install.code, /^source_packages = \[\]$/m,
  'numpy has no source archive to unpack either');
console.log('  ok  pip install numpy records it instead of fetching a wheel');

// The record pip writes is exactly what the selector looks for. This is the
// join that makes `pip install numpy` change the next interpreter, and it is
// asserted by feeding one side's output into the other.
for (const dir of distInfoDirs) {
  assert.equal(sessionUsesSciVariant(vfsWith([`${PYTHON_SITE_PACKAGES_ROOT}/${dir}`])), true,
    `${dir} is written by pip but does not select the sci variant`);
}
console.log('  ok  the record pip writes is the record the selector reads');

// ── markupsafe selects it too, and its pin matches the compiled half ────────
// Its Python half installs from source and its _speedups is compiled into the
// variant, so the two are only compatible at one version. build-python.sh pins
// the same one; a bump on either side without the other is what this catches.
const ms = await buildPipInvocation(['install', 'markupsafe'], 'pip', '/home/user', vfsWith([]));
assert.equal(ms.error, undefined, `pip install markupsafe failed to plan: ${ms.error}`);
const msVersion = ms.code.match(/markupsafe-([0-9.]+)\/src\/markupsafe/)?.[1];
assert.equal(msVersion, '3.0.3', 'markupsafe must be pinned to the release _speedups.c is built from');
assert.equal(
  sessionUsesSciVariant(vfsWith([`${PYTHON_SITE_PACKAGES_ROOT}/markupsafe-${msVersion}.dist-info`])),
  true,
  'markupsafe has a compiled half in the variant, so installing it must select the variant',
);
console.log('  ok  markupsafe pins to the built _speedups and selects the variant');

// ── A version the interpreter does not carry is refused, not silently swapped ─
const wrong = await buildPipInvocation(['install', 'numpy==1.26.4'], 'pip', '/home/user', vfsWith([]));
assert.match(wrong.error ?? '', /2\.4\.3/,
  'asking for a numpy the variant does not have must say which one it has');
assert.notEqual(wrong.exitCode, 0, 'an unsatisfiable pin must fail rather than install something else');
console.log('  ok  a numpy version the variant does not carry is refused');

console.log('cpython-variant-selection: all cases passed');
