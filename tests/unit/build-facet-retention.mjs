#!/usr/bin/env bun
// What a build facet keeps of the builds it ran: nothing. Its isolate serves
// a Durable Object's every pre-bundle and build, and is reset past its
// 128 MiB; if each build stayed reachable, the isolate would fill build by
// build until it was reset under one (Markflow's install: after 20 to 40
// pre-bundles, "Durable Object's isolate exceeded its memory limit and was
// reset", whatever the build in flight was).
//
// rolldown 1.2.11 keeps a build alive across its binding, native and wasm
// alike, when a plugin has an output hook (generateBundle, renderChunk) or
// buildStart: the hook's context caches the build's normalized options (a
// native object holding the build's options), whose invalidateJsSideCache
// callback is a threadsafe function bound to that same context, so neither
// side is ever freed, nor anything the build's plugin reaches (here: every
// file of a pre-bundle's slice, every module's source, the caller's plugin).
// The facet's runtime asks rolldown for no such hook.
//
// Here, the staged facet (build-facet-harness) runs pre-bundles, each with a
// 2 MiB file in its slice, and builds; once collected, every pre-bundle's
// file and every build's plugin, but those of the build last run, are gone.

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { freshFacetClass, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';

const encoder = new TextEncoder();
const BUILDS = 12;
const collected = new Set();
const registry = new FinalizationRegistry((tag) => collected.add(tag));

/** A pre-bundle whose slice carries a 2 MiB file of its own (a package's data file). */
function prebundleSpec(n) {
  const root = `/home/user/r${n}/node_modules/pkg`;
  const blob = new Uint8Array(2 * 1024 * 1024).fill(n);
  registry.register(blob, `prebundle ${n}`);
  return {
    specifier: 'pkg', entryPath: `${root}/index.js`, externals: [], bundlerVersion: 'build-facet-retention',
    slice: [
      { path: root, isDir: true },
      { path: `${root}/package.json`, isDir: false, bytes: encoder.encode('{"name":"pkg","type":"module"}') },
      { path: `${root}/index.js`, isDir: false, bytes: encoder.encode(`import { v as w } from './util.js';\nexport const v = ${JSON.stringify(`r${n}`)} + w;\n`) },
      { path: `${root}/util.js`, isDir: false, bytes: encoder.encode('export const v = "util";\n') },
      { path: `${root}/data.bin`, isDir: false, bytes: blob },
    ],
  };
}

/** A build's project: two modules. */
function buildFiles(n) {
  const files = new Map([
    [`home/user/b${n}/m0.js`, encoder.encode(`import { v as w } from './m1.js';\nexport const v = ${JSON.stringify(`b${n}`)} + w;\n`)],
    [`home/user/b${n}/m1.js`, encoder.encode('export const v = "m1";\n')],
  ]);
  const strip = (p) => p.replace(/^\/+/, '');
  return {
    entry: `/home/user/b${n}/m0.js`,
    vfs: {
      exists: (p) => files.has(strip(p)),
      isDirectory: () => false,
      readFile: async (p) => files.get(strip(p)),
      readFileString: async (p) => new TextDecoder().decode(files.get(strip(p))),
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

try {
  const { BuildFacet } = await freshFacetClass();
  const facet = new BuildFacet({ id: { toString: () => 'build-facet-retention' } }, {});
  for (let n = 0; n < BUILDS; n++) {
    const result = await facet.prebundle(prebundleSpec(n));
    assert.ok(result.ok && result.esmCode.includes(`r${n}`), `pre-bundle ${n}: ${result.errorText ?? 'its output lacks its module'}`);
  }
  for (let n = 0; n < BUILDS; n++) {
    const { entry, vfs } = buildFiles(n);
    // The plugin the facet is handed (in workerd, an RPC stub of the caller's): its own.
    const buildHost = (options, plugin) => {
      registry.register(plugin, `build ${n}`);
      return facet.build(options, plugin);
    };
    const service = new EsbuildService(vfs, { buildHost });
    const result = await service.build([entry], { bundle: true, format: 'esm' });
    assert.ok(String(result.outputFiles[0].text ?? result.outputFiles[0].contents).includes(`b${n}`), `build ${n}: its output lacks its module`);
  }
  await settle();
} finally {
  releaseBuildFacetHarness();
}

// The build last run of each kind may still be referenced by the harness; none before it.
const kept = [];
for (const kind of ['prebundle', 'build']) {
  for (let n = 0; n < BUILDS - 1; n++) if (!collected.has(`${kind} ${n}`)) kept.push(`${kind} ${n}`);
}
assert.deepEqual(kept, [], `the facet keeps ${kept.length} of ${2 * (BUILDS - 1)} finished builds' state alive: ${kept.join(', ')}`);
console.log(`build-facet-retention: ${2 * BUILDS} builds on one facet; every finished one's state collected`);
