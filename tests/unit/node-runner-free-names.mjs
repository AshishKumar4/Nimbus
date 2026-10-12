#!/usr/bin/env bun
// Each node module a launch ships (the one-shot runner, the resident body, the
// opencode runner) reads only what it declares and imports and the globals
// every facet has: the structural check every generated facet module takes
// (scripts/free-names.mjs). The store's library, the instance each runner
// makes of it, the write ledger and the registry are text joined into one
// module, which no typecheck reads; a name nothing declares there is a
// ReferenceError inside the facet. The shims stand in as a marker: they read
// what some runners give them only under a typeof guard, which a scope
// analysis cannot tell from a missing declaration.
import assert from 'node:assert/strict';
import { generateEntrypointCode, generateLongRunningNodeCode } from '../../packages/worker/src/facets/manager.ts';
import { generateOpencodeRunnerCode } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { FACET_GLOBALS, freeNames } from '../../packages/worker/scripts/free-names.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';

const state = {
  bundle: {}, manifest: {}, metadata: {}, cursor: 0,
  serializedManifest: '{}', serializedMetadata: '{}',
};
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const sources = nodeFacetSources('/* the shims */');
const runners = {
  'one-shot runner': (await generateEntrypointCode('', state, false, sources)).code,
  'resident body': (await generateLongRunningNodeCode('', state, { cred }, false, sources)).code,
  'opencode runner': generateOpencodeRunnerCode({
    argv: [], env: {}, cred, cwd: '/home/user', stdin: '', mode: 'attached',
    sources, vfsBundle: '{}', vfsManifest: '{}', vfsMetadata: '{}',
  }).code,
};

const free = (source) => [...freeNames(source, { sourceType: 'module' })].filter((name) => !FACET_GLOBALS.has(name)).sort();

// The check itself: a name nothing declares is reported, a declared one under any name is not.
assert.deepEqual(free('const a = 1; export default b(a);'), ['b']);
assert.deepEqual(free('const renamed = (x) => x; export default renamed(1);'), []);

const failures = [];
for (const [label, source] of Object.entries(runners)) {
  const names = free(source);
  if (names.length > 0) failures.push(`${label} reads ${names.join(', ')}, which nothing in it declares`);
}
assert.deepEqual(failures, []);
console.log(`node-runner-free-names: ${Object.keys(runners).length} runners`);
