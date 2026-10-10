import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ImmutableModuleSource, moduleSource } from '../../packages/platform/src/module-source.ts';
import { readImmutableModuleSource } from '../../packages/core/src/_shared/staged-source.ts';
import { facetImageDigest, facetImagePath, residentLoaderConfig } from '../../packages/fabric/src/process-fabric.ts';
import { fetchNodeFacetSources } from '../../packages/worker/src/runtime/node-shims-artifact.ts';
import { generateLongRunningNodeCode } from '../../packages/worker/src/facets/manager.ts';
import { RUNTIME_NODE_LIB_MODULE, RUNTIME_NODE_DNS_MODULE } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { stagedAssets } from './lib/staged-assets.mjs';

const text = 'const shared = "' + 'library'.repeat(10_000) + '";';
const sha256 = createHash('sha256').update(text).digest('hex');
const asset = { path: '/_assets/' + sha256 + '.js', sha256 };
const shared = new ImmutableModuleSource(text, asset);
const source = moduleSource`${shared}\nexport default shared.length + ${42};`;
const encoded = new TextEncoder().encode(JSON.stringify(source.recipe()));
const image = facetImagePath(await facetImageDigest(encoded));
let assetReads = 0;
const env = { ASSETS: { async fetch() { assetReads++; return new Response(text); } } };
const disk = { async readFile(path) { assert.equal(path, image); return encoded; } };
const spec = {
  compatibilityDate: '2026-09-26', compatibilityFlags: [], mainModule: 'worker.js', modules: {},
  vfsComposedModules: { 'worker.js': image },
};
assert.equal(assetReads, 0, 'materializing a process recipe reads no library body');
assert.ok(encoded.byteLength < shared.byteLength, 'the process image holds a reference, not library text');
const load = () => residentLoaderConfig(spec, disk, (pin) => readImmutableModuleSource(env, pin));
const first = await load();
assert.equal(first.modules['worker.js'], source.text, 'the Loader receives the complete original module');
assert.equal(assetReads, 1);
assert.equal((await load()).modules['worker.js'], source.text);
assert.equal(assetReads, 1, 'a second process uses the verified immutable source');
await assert.rejects(residentLoaderConfig(spec, disk, (pin) => readImmutableModuleSource({ ASSETS: { async fetch() { return new Response('stale'); } } }, pin)), /integrity check failed/);

const sources = await fetchNodeFacetSources({ ASSETS: stagedAssets });
const generated = await generateLongRunningNodeCode('console.log("boot");', {
  bundle: {}, manifest: {}, metadata: {}, cursor: null, serializedManifest: '{}', serializedMetadata: '{}',
}, { cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } }, false, sources);
const refs = generated.source.recipe().filter((part) => typeof part !== 'string');
for (const name of ['shims', 'ledger', 'residentStore', 'registry']) {
  assert.ok(refs.some((pin) => pin.sha256 === sources.immutable[name].asset.sha256), name + ' is a shared source');
}
assert.equal(generated.codeModules[RUNTIME_NODE_LIB_MODULE], undefined);
assert.equal(generated.codeModules[RUNTIME_NODE_DNS_MODULE], undefined);
const registry = new Map();
const loaded = [];
const requireModule = (name) => {
  if (registry.has(name)) return registry.get(name).exports;
  const entry = { exports: {} };
  registry.set(name, entry);
  loaded.push(name);
  new Function('module', 'exports', 'require', generated.immutableModules[name].text)(entry, entry.exports,
    (specifier) => requireModule('nimbus/' + specifier.slice(2)));
  return entry.exports;
};
const lib = requireModule(RUNTIME_NODE_LIB_MODULE);
assert.equal(typeof lib.sources.util, 'function');
assert.deepEqual(loaded, [RUNTIME_NODE_LIB_MODULE], 'ordinary builtins do not load DNS');
assert.equal(typeof lib.sources.dns, 'function');
assert.equal(typeof lib.sources['internal/dns/promises'], 'function');
assert.deepEqual(loaded, [RUNTIME_NODE_LIB_MODULE, RUNTIME_NODE_DNS_MODULE], 'DNS loads one shared module on its first require');
console.log('immutable-runtime-modules: recipes, integrity, shared loading and lazy DNS are intact');
