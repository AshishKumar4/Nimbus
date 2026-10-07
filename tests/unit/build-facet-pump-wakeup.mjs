#!/usr/bin/env bun
// The build facet's pump under JSPI, as workerd runs it: pre-bundles whose
// slice resolver awaits its way through each resolution all answer.
//
// With JSPI the pump is a promising call, and V8 hands back a promise that
// settles only after the wasm returns, so its `finished` runs a microtask
// later. A plugin hook's answer reaching the binding in between (a resolve
// hook that awaited, settling a microtask or two after the pump started)
// wakes a task that turn no longer polls; before 7dbf578fc the loader asked
// for no further turn while one was in flight, and the pre-bundle never
// answered. Deployed, that was Markflow's install: the background pre-bundles
// stalled past 120 s behind their lease, until the slice resolver was made
// synchronous (f62917695) so that its answers were settled before the pump
// ran. The resolver awaits again; this keeps the window covered.
//
// Bun has no JSPI, so `WebAssembly.Suspending` and `WebAssembly.promising`
// are given here as V8 runs a pump that never suspends (the facet's binding
// reads no file, so its pump does not): promising calls through and returns
// a settled promise. Each pre-bundle is a chain whose last module imports one
// already loaded, so the build's last hook is that resolve, its walk as long
// as its specifier and nesting make it; the shapes cover the window's offsets.
// Each takes tens of milliseconds; on the loader before 7dbf578fc each of the
// 56 took 2 to 3.5 s here (something of Bun's woke the pump in the end;
// deployed, nothing did).

import assert from 'node:assert/strict';
import { freshFacetClass, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';

const NativeSuspending = WebAssembly.Suspending;
const nativePromising = WebAssembly.promising;
let promisingCalls = 0;
WebAssembly.Suspending = class {
  constructor(fn) {
    return (...args) => {
      const result = fn(...args);
      if (result && typeof result.then === 'function') throw new Error('build-facet-pump-wakeup: a suspending import would suspend, which this JSPI cannot');
      return result;
    };
  }
};
WebAssembly.promising = (fn) => (...args) => {
  promisingCalls++;
  try {
    return Promise.resolve(fn(...args));
  } catch (error) {
    return Promise.reject(error);
  }
};

const encoder = new TextEncoder();

/**
 * A pre-bundle of pkg0: m0 … m{modules-1}, the last importing `last.js`
 * `depth` directories down, which imports m0 back by `form`.
 */
function shape(form, depth, modules) {
  const tag = `${form}-${depth}-${modules}`;
  const root = `/home/user/${tag}/node_modules`;
  const dir = `${root}/pkg0`;
  const nested = Array.from({ length: depth }, (_, i) => `d${i}`).join('/');
  const up = depth === 0 ? './' : '../'.repeat(depth);
  const slice = [
    { path: root, isDir: true },
    { path: dir, isDir: true },
    { path: `${dir}/package.json`, isDir: false, bytes: encoder.encode(JSON.stringify({ name: 'pkg0', type: 'module', exports: { '.': './m0.js', './*': './*.js' } })) },
  ];
  for (let m = 0; m < modules; m++) {
    const next = m + 1 < modules ? `./m${m + 1}.js` : `./${nested ? nested + '/' : ''}last.js`;
    slice.push({ path: `${dir}/m${m}.js`, isDir: false, bytes: encoder.encode(`import { v as a } from '${next}';\nexport const v = ${JSON.stringify(`${tag}:${m}`)} + a;\n`) });
  }
  const back = { relative: `${up}m0`, 'relative.js': `${up}m0.js`, bare: 'pkg0', 'bare/sub': 'pkg0/m0' }[form];
  slice.push({ path: `${dir}/${nested ? nested + '/' : ''}last.js`, isDir: false, bytes: encoder.encode(`import * as first from '${back}';\nexport const v = ${JSON.stringify(`${tag}:last`)} + typeof first;\n`) });
  return { tag, spec: { specifier: 'pkg0', entryPath: `${dir}/m0.js`, externals: [], slice, bundlerVersion: 'build-facet-pump-wakeup' } };
}

const within = (ms, promise) => {
  const timer = Promise.withResolvers();
  const handle = setTimeout(() => timer.resolve('no answer'), ms);
  return Promise.race([promise, timer.promise]).finally(() => clearTimeout(handle));
};

const unanswered = [];
const failed = [];
let built = 0;
try {
  const { BuildFacet } = await freshFacetClass();
  const facet = new BuildFacet({ id: { toString: () => 'build-facet-pump-wakeup' } }, {});
  for (const form of ['relative', 'relative.js', 'bare', 'bare/sub']) {
    for (let depth = 0; depth <= 6; depth++) {
      for (const modules of [1, 3]) {
        const { tag, spec } = shape(form, depth, modules);
        const result = await within(1_000, facet.prebundle(spec));
        if (result === 'no answer') unanswered.push(tag);
        else if (result.ok && result.esmCode.includes(JSON.stringify(`${tag}:last`))) built++;
        else failed.push(`${tag}: ${result.errorText ?? JSON.stringify(result).slice(0, 200)}`);
      }
    }
  }
} finally {
  WebAssembly.Suspending = NativeSuspending;
  WebAssembly.promising = nativePromising;
  releaseBuildFacetHarness();
}

assert.ok(promisingCalls > 0, 'the binding pumped through JSPI');
assert.deepEqual(failed, [], 'every pre-bundle builds');
assert.deepEqual(unanswered, [], `every pre-bundle answers within 1 s (${unanswered.length} did not)`);
console.log(`build-facet-pump-wakeup: ${built} pre-bundles through the awaited slice resolver answered, pumped by JSPI (${promisingCalls} turns)`);
