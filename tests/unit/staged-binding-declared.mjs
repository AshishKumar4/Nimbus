#!/usr/bin/env bun
// A launched bin carries the staged bindings its own dependency tree installs.
//
// A launch carried a staged binding only when its module closure named the
// binding, and a program can reach the binding's owner by a specifier no walk
// follows. Nuxt 4 loads its builder with
// `if (builder === "@nuxt/vite-builder") return await import(builder)`; Vite
// then loads rolldown, whose binding the launch had not carried, and a wasm
// binding cannot be compiled after the launch. `nuxt dev` failed its first
// run with "Cannot find native binding" (nuxt-real on a throwaway, sid
// fast-piper-4853: rolldown/dist/shared/parse-*.mjs, "Cannot resolve
// '@rolldown/binding-wasm32-wasi'").
//
// stagedBindingsDeclaredBy walks the launched bin's package's declared
// dependencies, resolved as Node resolves them, to each binding's owner at the
// binding's version.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { STAGED_BINDINGS, stagedBindingsDeclaredBy } from '../../packages/worker/src/runtime/staged-bindings.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { processBridge } from './lib/process-bridge.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const APP = 'home/user/app';
const version = (name) => STAGED_BINDINGS.find((b) => b.name === name).version;
const ROLLDOWN = version('rolldown');

/** A tree of package.json files ({ dir: manifest }) and links ({ link: target }), as the walk's fs. */
function tree(packages, links = {}) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  const write = (key, text) => {
    kernel.mkdir(key.slice(0, key.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    kernel.writeFile(key, encoder.encode(text), { mode: 0o644 });
  };
  for (const [dir, manifest] of Object.entries(packages)) {
    write(`${dir}/package.json`, JSON.stringify(manifest));
    write(`${dir}/index.js`, 'module.exports = 1;\n');
  }
  for (const [link, target] of Object.entries(links)) {
    kernel.mkdir(link.slice(0, link.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    kernel.symlink(target, link);
  }
  const bridge = processBridge(raw, kernel);
  let questions = 0;
  const fs = {
    readText: async (path) => { questions++; const bytes = await bridge.readFile(path); return bytes === null ? null : decoder.decode(bytes); },
    exists: async (path) => { questions++; return (await bridge.stat(path)) !== null; },
    realpath: async (path) => { try { return await bridge.realpath(path); } catch { return null; } },
  };
  return { fs, questions: () => questions };
}
const pkg = (name, v, deps = {}, field = 'dependencies') => ({ name, version: v, [field]: deps });
const NM = `${APP}/node_modules`;

// ── nuxt dev: nuxt → @nuxt/vite-builder → vite → rolldown, all hoisted ──
{
  const { fs } = tree({
    [APP]: pkg('app', '1.0.0', { nuxt: '^4' }),
    [`${NM}/nuxt`]: pkg('nuxt', '4.6.0', { '@nuxt/vite-builder': '4.6.0', consola: '^3' }),
    [`${NM}/consola`]: pkg('consola', '3.4.0'),
    [`${NM}/@nuxt/vite-builder`]: pkg('@nuxt/vite-builder', '4.6.0', { vite: '^8.3.2' }),
    [`${NM}/vite`]: pkg('vite', '8.3.3', { rolldown: `~${ROLLDOWN}`, picomatch: '^4' }),
    [`${NM}/picomatch`]: pkg('picomatch', '4.0.0'),
    [`${NM}/rolldown`]: pkg('rolldown', ROLLDOWN),
  }, { [`${NM}/.bin/nuxt`]: '../nuxt/index.js' });
  assert.deepEqual(await stagedBindingsDeclaredBy(fs, `/${NM}/.bin/nuxt`), ['rolldown'], 'nuxt carries rolldown through its builder');
  assert.deepEqual(await stagedBindingsDeclaredBy(fs, `/${NM}/nuxt/index.js`), ['rolldown']);
}

// ── the version is the one the requiring package would load: nested before hoisted ──
{
  const packages = {
    [`${NM}/nuxt`]: pkg('nuxt', '4.6.0', { vite: '^8' }),
    [`${NM}/vite`]: pkg('vite', '8.3.3', { rolldown: '*' }),
    [`${NM}/vite/node_modules/rolldown`]: pkg('rolldown', '1.3.0'),
    [`${NM}/rolldown`]: pkg('rolldown', ROLLDOWN),
  };
  assert.deepEqual(await stagedBindingsDeclaredBy(tree(packages).fs, `/${NM}/nuxt/index.js`), [],
    "vite loads its own nested rolldown, not the staged build's version");
  delete packages[`${NM}/vite/node_modules/rolldown`];
  assert.deepEqual(await stagedBindingsDeclaredBy(tree(packages).fs, `/${NM}/nuxt/index.js`), ['rolldown'], 'without it, the hoisted one');
  packages[`${NM}/rolldown`] = pkg('rolldown', '1.2.12');
  assert.deepEqual(await stagedBindingsDeclaredBy(tree(packages).fs, `/${NM}/nuxt/index.js`), [], 'another version is not the staged build');
}

// ── from a nested package, ancestors' node_modules in Node's order ──
{
  const { fs } = tree({
    [`${NM}/a`]: pkg('a', '1.0.0', { b: '*' }),
    [`${NM}/a/node_modules/b`]: pkg('b', '1.0.0', { rolldown: '*' }),
    [`${NM}/a/node_modules/rolldown`]: pkg('rolldown', ROLLDOWN),
    [`${NM}/rolldown`]: pkg('rolldown', '0.9.0'),
  });
  assert.deepEqual(await stagedBindingsDeclaredBy(fs, `/${NM}/a/index.js`), ['rolldown'], "b finds a's copy before the top level's");
}

// ── peers are installed beside the package that declares them (react-router dev) ──
{
  const { fs } = tree({
    [`${NM}/@react-router/dev`]: pkg('@react-router/dev', '8.4.0', { vite: '^8' }, 'peerDependencies'),
    [`${NM}/vite`]: pkg('vite', '8.3.3', { rolldown: `~${ROLLDOWN}` }),
    [`${NM}/rolldown`]: pkg('rolldown', ROLLDOWN),
  });
  assert.deepEqual(await stagedBindingsDeclaredBy(fs, `/${NM}/@react-router/dev/index.js`), ['rolldown']);
}

// ── every binding the tree installs, in table order (astro) ──
{
  const { fs } = tree({
    [`${NM}/astro`]: pkg('astro', '7.0.0', {
      vite: '^8', satteri: version('satteri'), '@astrojs/compiler-binding': version('astro-compiler'),
    }),
    [`${NM}/vite`]: pkg('vite', '8.3.3', { rolldown: `~${ROLLDOWN}` }),
    [`${NM}/rolldown`]: pkg('rolldown', ROLLDOWN),
    [`${NM}/satteri`]: pkg('satteri', version('satteri')),
    [`${NM}/@astrojs/compiler-binding`]: pkg('@astrojs/compiler-binding', version('astro-compiler')),
  });
  assert.deepEqual(await stagedBindingsDeclaredBy(fs, `/${NM}/astro/index.js`), STAGED_BINDINGS.map((b) => b.name));
}

// ── a program of the user's own declares nothing, whatever the project installs ──
{
  const { fs } = tree({
    [APP]: pkg('app', '1.0.0', { vite: '^8' }),
    [`${NM}/vite`]: pkg('vite', '8.3.3', { rolldown: `~${ROLLDOWN}` }),
    [`${NM}/rolldown`]: pkg('rolldown', ROLLDOWN),
  });
  assert.deepEqual(await stagedBindingsDeclaredBy(fs, `/${APP}/index.js`), []);
  assert.deepEqual(await stagedBindingsDeclaredBy(fs, undefined), []);
}

// ── bounded, and a cycle ends ──
{
  const packages = {
    [`${NM}/a`]: pkg('a', '1.0.0', { b: '*' }),
    [`${NM}/b`]: pkg('b', '1.0.0', { a: '*', c: '*' }),
    [`${NM}/c`]: pkg('c', '1.0.0', { rolldown: '*' }),
    [`${NM}/rolldown`]: pkg('rolldown', ROLLDOWN),
  };
  assert.deepEqual(await stagedBindingsDeclaredBy(tree(packages).fs, `/${NM}/a/index.js`), ['rolldown'], 'a cycle on the way is walked once');
  const bounded = tree(packages);
  assert.deepEqual(await stagedBindingsDeclaredBy(bounded.fs, `/${NM}/a/index.js`, 3), [], 'past the bound, nothing');
  assert.ok(bounded.questions() <= 3, `the bound is on questions asked (${bounded.questions()})`);
}

console.log('staged-binding-declared: ok');
