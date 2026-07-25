#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { BUNDLE_MAX_ENCODED_BYTES } from '../../packages/worker/src/constants.ts';
import { buildFacetVfsBundleSource } from '../../packages/worker/src/facets/manager.ts';

function evaluateModule(source) {
  const prefix = 'export default ';
  assert.ok(source.startsWith(prefix), 'VFS side module has a default export');
  return new Function(`return (${source.slice(prefix.length, -1)});`)();
}

function evaluateBundleSource(source) {
  const imports = [...source.imports.matchAll(/^import (\w+) from "([^"]+)";$/gm)];
  const aliases = imports.map((match) => match[1]);
  const parts = imports.map((match) => evaluateModule(source.modules[match[2]]));
  return new Function(...aliases, `return (${source.expression});`)(...parts);
}

const oversizedSource = 'const value = "escaped";\n'.repeat(900_000);
const bundle = {
  'usr/local/lib/node_modules/large-cli/index.js': oversizedSource,
  'usr/local/lib/node_modules/shebang-command/index.js': 'module.exports = () => "node";',
  'usr/local/lib/node_modules/native/data.bin': new Uint8Array([0, 127, 128, 255]),
  'usr/local/lib/node_modules/private.txt': { error: 'EACCES' },
};

const source = buildFacetVfsBundleSource(bundle);
assert.ok(
  Object.keys(source.modules).length >= 2,
  'an oversized required bundle is split across Worker Loader side modules',
);
for (const [name, moduleSource] of Object.entries(source.modules)) {
  assert.ok(
    new TextEncoder().encode(moduleSource).length <= BUNDLE_MAX_ENCODED_BYTES,
    `${name} stays within the encoded per-module ceiling`,
  );
}
assert.deepEqual(
  evaluateBundleSource(source),
  bundle,
  'side modules reconstruct every text, binary, denial, and transitive leaf cell exactly',
);

const inline = buildFacetVfsBundleSource({
  'usr/local/lib/node_modules/shebang-command/index.js': 'module.exports = true;',
});
assert.deepEqual(inline.modules, {}, 'small bundles keep the existing inline path');
assert.deepEqual(evaluateBundleSource(inline), {
  'usr/local/lib/node_modules/shebang-command/index.js': 'module.exports = true;',
});

console.log('facet VFS bundle source: ok');
