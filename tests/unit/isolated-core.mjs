#!/usr/bin/env bun
// Measured files and directory trees belong to each arm, including names
// present in only one revision. Everything else shares the candidate's copy.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadIsolatedCore } from '../bench/lib/isolated-core.mjs';

const root = mkdtempSync(join(tmpdir(), 'isolated-core-'));
const real = join(root, 'real');
const base = join(root, 'base');
const cleanups = [];
const cleanup = (dispose) => cleanups.push(dispose);
const put = (from, path, text) => {
  const target = join(from, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
};

try {
  for (const [from, version, only] of [[real, 'real', 'provisional.mjs'], [base, 'base', 'own-names.mjs']]) {
    put(from, 'support.mjs', `export const version = '${version}'; export const token = {};`);
    put(from, '_shared/client.mjs', `
      import { existsSync } from 'node:fs';
      export const version = '${version}';
      export const token = {};
      export const added = existsSync(new URL('../added/only.mjs', import.meta.url));
      export const removed = existsSync(new URL('../removed/only.mjs', import.meta.url));
    `);
    put(from, 'runtime/wasi/resident.mjs', `
      import { readdirSync } from 'node:fs';
      import * as client from '../../_shared/client.mjs';
      import * as support from '../../support.mjs';
      import { version } from './${only}';
      export { client, support, version };
      export const names = readdirSync(new URL('./', import.meta.url)).sort();
    `);
    put(from, `runtime/wasi/${only}`, `export const version = '${version}';`);
    put(from, 'runtime/wasi/nested/child.mjs', `export const version = '${version}';`);
    put(from, 'runtime/picked.mjs', `
      import * as support from '../support.mjs';
      export { support };
      export const version = '${version}';
      export const token = {};
    `);
  }
  put(real, 'added/only.mjs', 'export const present = true;');
  put(base, 'removed/only.mjs', 'export const present = true;');

  const modules = ['runtime/wasi/resident.mjs', '_shared/client.mjs', 'runtime/wasi/nested/child.mjs'];
  const sources = { source: real, directories: ['runtime/wasi', '_shared', 'added', 'removed'] };
  const a = await loadIsolatedCore(base, cleanup, { sources, modules });
  const n = await loadIsolatedCore(base, cleanup, { sources, modules });
  const b = await loadIsolatedCore(real, cleanup, { sources, modules });
  assert.deepEqual(Object.keys(a), modules);
  for (const [arm, version, only] of [[a, 'base', 'own-names.mjs'], [n, 'base', 'own-names.mjs'], [b, 'real', 'provisional.mjs']]) {
    const resident = arm[modules[0]];
    assert.deepEqual(resident.names, ['nested', only, 'resident.mjs'].sort());
    assert.equal(resident.version, version);
    assert.equal(arm[modules[2]].version, version, 'directory selection is recursive');
    assert.equal(resident.client, arm[modules[1]], 'imports resolve to the arm\'s measured modules');
    assert.equal(resident.client.version, version);
    assert.equal(resident.client.added, version === 'real');
    assert.equal(resident.client.removed, version === 'base');
    assert.equal(resident.support.version, 'real', 'unmeasured files come from the candidate');
  }
  assert.notEqual(a[modules[1]].token, n[modules[1]].token, 'the two baseline copies are isolated');
  assert.notEqual(a[modules[1]].token, b[modules[1]].token);
  assert.equal(a[modules[0]].support, b[modules[0]].support, 'unmeasured modules are shared');

  const listed = { sources: { source: real, files: ['runtime/picked.mjs'] }, modules: ['runtime/picked.mjs'] };
  const fileA = (await loadIsolatedCore(base, cleanup, listed))['runtime/picked.mjs'];
  const fileN = (await loadIsolatedCore(base, cleanup, listed))['runtime/picked.mjs'];
  const fileB = (await loadIsolatedCore(real, cleanup, listed))['runtime/picked.mjs'];
  assert.equal(fileA.version, 'base');
  assert.equal(fileN.version, 'base');
  assert.equal(fileB.version, 'real');
  assert.notEqual(fileA.token, fileN.token);
  assert.equal(fileA.support, fileB.support);
  assert.equal(fileA.support.version, 'real');

  const entire = await loadIsolatedCore(base, cleanup, { sources: { source: real }, modules });
  assert.equal(entire[modules[0]].support.version, 'base', 'omitting selectors copies every source');
  assert.equal(entire[modules[1]].added, false);
  assert.equal(entire[modules[1]].removed, true);
} finally {
  for (const dispose of cleanups.reverse()) dispose();
  rmSync(root, { recursive: true, force: true });
}

console.log('isolated-core: ok');
