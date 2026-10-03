#!/usr/bin/env bun
// Pre-bundling (core runtime/prebundle-slice.ts, which the build facet runs
// on rolldown) against the bundler it replaced, esbuild-wasm 0.24.2, on the
// same slices: each npm specifier's slice walked by the supervisor's
// buildSliceForSpecifierWithCap, bundled by each engine behind the same
// slice resolver, then served as the Vite dev server serves a bundle
// (rewriteExternalRequires, synthesizeCjsNamedExports) and imported, with
// the shared React runtime as a separate module. What a consumer sees is
// compared: the export names, each value's shape, what calling or awaiting
// them gives, and the resolver's warnings.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWithEsbuild } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';
import { prebundleSlice } from '../../packages/core/src/runtime/prebundle-slice.ts';
import { buildSliceForSpecifierWithCap, externalsForSpecifier, BUNDLER_VERSION } from '../../packages/worker/src/npm/pre-bundle-facet.ts';
import { rewriteExternalRequires, synthesizeCjsNamedExports } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { CASES, FILES, NODE_MODULES } from '../fixtures/prebundle-differential/packages.mjs';

const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
globalThis.self ??= globalThis;
const esbuild = await import(fromCore.resolve('esbuild-wasm/esm/browser.js'));
await esbuild.initialize({ wasmModule: await WebAssembly.compile(await readFile(fromCore.resolve('esbuild-wasm/esbuild.wasm'))), worker: false });
assert.equal(esbuild.version, '0.24.2');
const rolldown = await import(createRequire(new URL('../../packages/worker/package.json', import.meta.url)).resolve('rolldown'));

// Each engine as the build facet's would be called: options and outcomes cross RPC.
const clone = (value) => structuredClone(value);
const engines = {
  esbuild: (options, plugin) => buildWithEsbuild(esbuild, clone(options), plugin).then(clone),
  rolldown: (options, plugin) => buildWithRolldown(rolldown, clone(options), plugin).then(clone),
};

/** The project's files as the supervisor's VFS, for the slice walk. */
const vfs = (() => {
  const files = new Map(Object.entries(FILES).map(([p, v]) => [p, typeof v === 'string' ? new TextEncoder().encode(v) : v]));
  const strip = (p) => p.replace(/^\/+|\/+$/g, '');
  const isDirectory = (p) => !files.has(strip(p)) && [...files.keys()].some((k) => k.startsWith(strip(p) + '/'));
  return {
    exists: (p) => files.has(strip(p)) || isDirectory(p),
    isDirectory,
    readFile: (p) => {
      const bytes = files.get(strip(p));
      if (!bytes) throw new Error(`ENOENT ${p}`);
      return bytes;
    },
    readFileString: (p) => new TextDecoder().decode(vfs.readFile(p)),
    readdir: (p) => {
      const prefix = strip(p) + '/';
      const names = new Map();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const [name, ...rest] = k.slice(prefix.length).split('/');
        names.set(name, rest.length ? 'directory' : 'file');
      }
      return [...names].map(([name, type]) => ({ name, type }));
    },
  };
})();

// Where bundles run: the shared React runtime, which every bundle imports
// rather than embeds, is the `react` pre-bundle itself, served by esbuild.
const scratch = join(process.env.TMPDIR ?? tmpdir(), `prebundle-differential-${process.pid}`);
mkdirSync(scratch, { recursive: true });
let n = 0;
const served = new Map();
const missing = join(scratch, 'missing.mjs');
writeFileSync(missing, 'export default {};');

/** A bundle as the dev server serves it, its module URLs pointing at the served bundles. */
function serve(code) {
  let out = synthesizeCjsNamedExports(rewriteExternalRequires(code, '/'));
  out = out.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\/@modules\/)?([\w@][\w@/.-]*)\2/g, (whole, lead, quote, modules, spec) => {
    // A module the dev server would serve from /@modules/ but no case
    // pre-bundles (an import left external): an empty module.
    const file = served.get(spec) ?? (modules || !spec.startsWith('.') ? missing : null);
    return file ? `${lead}${quote}${pathToFileURL(file).href}${quote}` : whole;
  });
  const file = join(scratch, `m${n++}.mjs`);
  writeFileSync(file, out);
  return file;
}

async function shape(value, depth = 0) {
  if (value === null || value === undefined) return value === null ? null : 'undefined';
  if (typeof value === 'function') {
    let called;
    try {
      const result = value({}, { a: 1 }, { b: 2 });
      called = result && typeof result.then === 'function' ? { awaited: await shape(await result, depth + 1) } : await shape(result, depth + 1);
    } catch (error) {
      called = `throws ${error.constructor.name}`;
    }
    return { fn: value.name, length: value.length, called };
  }
  if (typeof value === 'symbol') return String(value);
  if (typeof value !== 'object') return value;
  if (depth > 3) return 'object';
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = await shape(value[key], depth + 1);
  return out;
}

try {
  for (const { specifier, entry, define, expectFailure } of CASES) {
    const seen = {};
    for (const [engine, build] of Object.entries(engines)) {
      const slice = buildSliceForSpecifierWithCap(vfs, specifier, NODE_MODULES.slice(1), 28 * 1024 * 1024);
      assert.ok(slice, `${specifier}: the slice fits`);
      const spec = { specifier, entryPath: `${NODE_MODULES}/${entry}`, externals: externalsForSpecifier(specifier), slice: slice.slice, bundlerVersion: BUNDLER_VERSION, define };
      const result = await prebundleSlice(spec, build);
      if (!result.ok) {
        seen[engine] = { failure: result.errorText, warnings: result.warnings };
        continue;
      }
      const file = serve(result.esmCode);
      if (specifier === 'react' || specifier === 'react/jsx-runtime') {
        // The React runtime the others import: esbuild's, so both engines' bundles meet the same one.
        if (engine === 'esbuild') served.set(specifier, file);
      }
      const ns = await import(pathToFileURL(file).href);
      seen[engine] = { names: Object.keys(ns).sort(), namespace: await shape({ ...ns }), warnings: result.warnings };
    }
    assert.deepEqual(seen.rolldown, seen.esbuild, `${specifier}:\n  esbuild:  ${JSON.stringify(seen.esbuild)}\n  rolldown: ${JSON.stringify(seen.rolldown)}`);
    assert.equal(Boolean(seen.rolldown.failure), Boolean(expectFailure), `${specifier}: ${JSON.stringify(seen.rolldown).slice(0, 300)}`);
    console.log(`  ok  ${specifier}: ${seen.rolldown.failure ? `the same failure (${seen.rolldown.failure})` : seen.rolldown.names.join(', ')}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
  await esbuild.stop();
}
console.log('prebundle-differential OK');
