#!/usr/bin/env bun
// A host that bundles in its own Durable Object, outside the session (Kinu's
// slates), reaches the supervisor's builds through the public `facet-host`
// entry, so its builds run in the object's build facet (rolldown) and not in
// its isolate. Kinu built `new EsbuildService(vfs)` because nothing public offered
// the hosted one: esbuild-wasm then held 28 MiB of the 128 MB isolate at first
// use and 44 MiB after ten rebuilds, never released.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const worker = JSON.parse(await readFile(new URL('../../packages/worker/package.json', import.meta.url), 'utf8'));
const entry = worker.exports['./facet-host'];
const { supervisorEsbuildService } = await import(new URL(`../../packages/worker/${entry.workspace}`, import.meta.url).href);

assert.equal(typeof supervisorEsbuildService, 'function', 'the facet-host entry exports supervisorEsbuildService');
assert.equal(entry.import.replace(/\.js$/, ''), entry.workspace.replace(/^\.\/src/, './dist').replace(/\.ts$/, ''),
  'the published entry is the same module');

const harness = createSqliteVfsTestHarness();
const kernel = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
kernel.mkdir('slate', { recursive: true, mode: 0o755 });
kernel.writeFile('slate/client.tsx', 'export const answer = <b>42</b>;');

const builds = [];
const facet = {
  async build(options, plugin) {
    builds.push({ entryPoints: options.entryPoints, plugin: typeof plugin });

    return {
      outputFiles: [{ path: '/dist/client.js', contents: new TextEncoder().encode('built in the facet') }],
      errors: [],
      warnings: [],
      metafile: { inputs: {}, outputs: {} },
    };
  },
};
const loaded = [];
const env = {
  LOADER: { get(id) { loaded.push(id); return { getDurableObjectClass: (name) => ({ facetClass: name }) }; } },
  ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
};
const ctx = { facets: { get: async (id, spec) => { loaded.push(`facet:${(await spec()).class.facetClass}`); return facet; } } };

const service = supervisorEsbuildService(ctx, env, kernel);
const result = await service.build(['/slate/client.tsx'], { format: 'esm' });

assert.deepEqual(builds, [{ entryPoints: ['/slate/client.tsx'], plugin: 'object' }], 'the build ran in the build facet');
assert.equal(result.outputFiles[0].contents, 'built in the facet');
assert.equal(loaded.length, 2, 'one loader worker and one facet, no bundler instantiated in the test or the caller');
assert.match(loaded[0], /^nimbus-build:rolldown-/);
assert.match(loaded[1], /^facet:BuildFacet$/);

console.log('facet-host-esbuild-service: ok');
