#!/usr/bin/env bun
// Each node module a launch ships (the one-shot runner, the resident body, the
// opencode runner) reads only what it declares and imports and the globals
// every facet has: the structural check every generated facet module takes
// (scripts/free-names.mjs). The store's library, the instance each runner
// makes of it, the write ledger and the registry are text joined into one
// module, which no typecheck reads; a name nothing declares there is a
// ReferenceError inside the facet. What the shims read only under a typeof
// guard (an input some runners give), and what the module installs on
// globalThis itself, is not missing.
import assert from 'node:assert/strict';
import { generateEntrypointCode, generateLongRunningNodeCode } from '../../packages/worker/src/facets/manager.ts';
import { generateOpencodeRunnerCode } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { FACET_GLOBALS, freeNames } from '../../packages/worker/scripts/free-names.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';

const state = {
  bundle: {}, manifest: {}, metadata: {}, cursor: 0,
  serializedManifest: '{}', serializedMetadata: '{}',
};
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const sources = nodeFacetSources(generateShimsCode());
const runners = {
  'one-shot runner': (await generateEntrypointCode('', state, false, sources)).code,
  'resident body': (await generateLongRunningNodeCode('', state, { cred }, false, sources)).code,
  'opencode runner': generateOpencodeRunnerCode({
    argv: [], env: {}, cred, cwd: '/home/user', stdin: '', mode: 'attached',
    sources, vfsBundle: '{}', vfsManifest: '{}', vfsMetadata: '{}',
  }).code,
};

const free = (source) => [...freeNames(source, { sourceType: 'module', guarded: true })].filter((name) => !FACET_GLOBALS.has(name)).sort();

// The check itself: a name nothing declares is reported, a declared one under any name is not, nor one
// read under a typeof test of it or installed on globalThis; one read past its guard is.
assert.deepEqual(free('const a = 1; export default b(a);'), ['b']);
assert.deepEqual(free('const renamed = (x) => x; export default renamed(1);'), []);
assert.deepEqual(free('export default typeof given === "number" ? given : 0;'), []);
assert.deepEqual(free('globalThis.made = 1; export default made;'), []);
assert.deepEqual(free('if (typeof given === "number") f(given); export default given;'), ['f', 'given']);

const failures = [];
for (const [label, source] of Object.entries(runners)) {
  const names = free(source);
  if (names.length > 0) failures.push(`${label} reads ${names.join(', ')}, which nothing in it declares`);
}
assert.deepEqual(failures, []);
console.log(`node-runner-free-names: ${Object.keys(runners).length} runners`);
