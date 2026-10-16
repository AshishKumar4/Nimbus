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

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildPipInvocation,
  pythonSitePackages,
  sessionUsesSciVariant,
} from '../../packages/core/src/runtime/python-pip.ts';
import { markers, pipInstall, scratch } from './lib/pypi-mock.mjs';

/** A VFS that knows only which paths exist, which is all the selector reads. */
function vfsWith(paths) {
  const present = new Set(paths);
  return {
    exists: (p) => present.has(p.replace(/^\/+/, '')),
    readFile: () => { throw new Error('the variant selector must not read file contents'); },
  };
}

// ── A session that installed nothing compiled stays on the base interpreter ──
assert.equal((await sessionUsesSciVariant(vfsWith([]), '/home/user')), false,
  'an empty session must not pay for the sci variant');
assert.equal(
  (await sessionUsesSciVariant(vfsWith([`${pythonSitePackages('/home/user')}/attrs-25.4.0.dist-info`]), '/home/user')),
  false,
  'a pure-Python install must not select the sci variant');
console.log('  ok  a session without compiled packages stays on the base interpreter');

// ── Installing numpy is what selects it, and pip is what records that ───────
// pip's install, run as the CPython runner runs it, with no network to reach:
// numpy's code is already in the interpreter, so nothing is fetched, and what
// it writes is the record the selector reads.
{
  const place = scratch();
  try {
    assert.deepEqual(await pipInstall(['numpy'], place), { installed: ['numpy==2.4.3'] }, 'pip install numpy records exactly numpy');
    const site = `/${pythonSitePackages(place.home)}`;
    const distInfo = join(site, 'numpy-2.4.3.dist-info');
    assert.equal(readFileSync(join(distInfo, 'METADATA'), 'utf8'), 'Metadata-Version: 2.1\nName: numpy\nVersion: 2.4.3\n');
    assert.equal(readFileSync(join(distInfo, 'WHEEL'), 'utf8'),
      'Wheel-Version: 1.0\nGenerator: Nimbus pip\nRoot-Is-Purelib: true\nTag: py3-none-any\n');
    assert.equal(readFileSync(join(distInfo, 'RECORD'), 'utf8'), '');
    console.log('  ok  pip install numpy records it instead of fetching a wheel');

    // The record pip writes is exactly what the selector looks for: the join
    // that makes `pip install numpy` change the next interpreter.
    const written = readdirSync(site).map((entry) => `${pythonSitePackages(place.home)}/${entry}`);
    assert.equal((await sessionUsesSciVariant(vfsWith(written), place.home)), true,
      `${written.join(', ')} is written by pip but does not select the sci variant`);
    console.log('  ok  the record pip writes is the record the selector reads');

    writeFileSync(join(distInfo, 'METADATA'), 'kept');
    assert.equal((await pipInstall(['numpy'], place)).error, undefined, 'a second install of numpy succeeds');
    assert.equal(readFileSync(join(distInfo, 'METADATA'), 'utf8'), 'kept', 'an installed variant record is not rewritten');
    console.log('  ok  the generated installer writes the variant record once');
  } finally {
    place.done();
  }
}

// ── markupsafe selects it too, and its pin matches the compiled half ────────
// Its Python half installs from source and its _speedups is compiled into the
// variant, so the two are only compatible at one version. build-python.sh pins
// the same one; a bump on either side without the other is what this catches.
const ms = await buildPipInvocation(['install', 'markupsafe<3.0.3'], 'pip', '/home/user', vfsWith([]), { home: '/home/user', network: ISOLATE_NETWORK, markers });
assert.match(ms.error ?? '', /available artifact is markupsafe==3\.0\.3/,
  'markupsafe must be pinned to the release _speedups.c is built from');
assert.equal(
  (await sessionUsesSciVariant(vfsWith([`${pythonSitePackages('/home/user')}/markupsafe-3.0.3.dist-info`]), '/home/user')),
  true,
  'markupsafe has a compiled half in the variant, so installing it must select the variant',
);
console.log('  ok  markupsafe pins to the built _speedups and selects the variant');

// ── A version the interpreter does not carry is refused, not silently swapped ─
const wrong = await buildPipInvocation(['install', 'numpy==1.26.4'], 'pip', '/home/user', vfsWith([]), { home: '/home/user', network: ISOLATE_NETWORK, markers });
assert.match(wrong.error ?? '', /2\.4\.3/,
  'asking for a numpy the variant does not have must say which one it has');
assert.notEqual(wrong.exitCode, 0, 'an unsatisfiable pin must fail rather than install something else');
console.log('  ok  a numpy version the variant does not carry is refused');

console.log('cpython-variant-selection: all cases passed');
