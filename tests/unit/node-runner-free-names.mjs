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

// The check itself. A name nothing declares is reported; a declared one, under any name, is not.
assert.deepEqual(free('const a = 1; export default b(a);'), ['b']);
assert.deepEqual(free('const renamed = (x) => x; export default renamed(1);'), []);
// A read only where a typeof test of the name says it is there cannot throw: the branch the test
// guards, by its sense (negation and && included), and the typeof itself.
const guarded = [
  'export default typeof given === "number" ? given : 0;',
  'export default typeof given !== "undefined" && given !== null ? given : null;',
  'export default typeof given === "undefined" ? undefined : given;',
  'export default typeof given === "function" ? given() : null;',
  'export default typeof given !== "undefined" && given === true;',
  'if (typeof given !== "undefined") given(); export default 0;',
  'if (typeof given === "undefined") {} else given(); export default 0;',
  'export default !(typeof given === "undefined") && given;',
  'export default typeof given == "undefined" || given;',
  'export default typeof given;',
];
for (const source of guarded) assert.deepEqual(free(source), [], source);
// Anywhere else the read may throw: the other branch, the test's own reads before its typeof, after the guard.
const unguarded = [
  ['export default typeof missing === "undefined" ? missing : 0;', ['missing']],
  ['export default typeof missing === "number" ? 0 : missing;', ['missing']],
  ['if (typeof missing === "undefined") missing(); export default 0;', ['missing']],
  ['if (typeof missing !== "undefined") {} else missing(); export default 0;', ['missing']],
  ['export default missing === 1 && typeof missing === "number" ? missing : 0;', ['missing']],
  ['export default typeof missing === "number" || missing;', ['missing']],
  ['if (typeof missing === "number") f(missing); export default missing;', ['f', 'missing']],
];
for (const [source, names] of unguarded) assert.deepEqual(free(source), names, source);
// A name some code puts on globalThis is still not declared: a read of it may run before the
// install, or the install never run (it is read as globalThis's property where that is meant).
const installed = [
  'globalThis.missing = 1; export default missing;',
  'if (false) globalThis.missing = 1; export default missing;',
  'globalThis.missing = missing; export default 0;',
  'function f() { globalThis.missing = 1; } export default missing;',
  'function f(globalThis) { globalThis.missing = 1; } f({}); export default missing;',
  'Object.defineProperty(globalThis, "missing", { value: 1 }); export default missing;',
  'Object.defineProperties(globalThis, { missing: { value: 1 } }); export default missing;',
];
for (const source of installed) assert.deepEqual(free(source), ['missing'], source);
assert.deepEqual(free('globalThis.made = 1; export default globalThis.made;'), []);

const failures = [];
for (const [label, source] of Object.entries(runners)) {
  const names = free(source);
  if (names.length > 0) failures.push(`${label} reads ${names.join(', ')}, which nothing in it declares`);
}
assert.deepEqual(failures, []);
console.log(`node-runner-free-names: ${Object.keys(runners).length} runners`);
