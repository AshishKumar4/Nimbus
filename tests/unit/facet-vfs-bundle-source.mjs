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

// The inline-vs-side-module decision is made from a COUNTED encoded size, not
// from `TextEncoder().encode(expression)` — encoding a bundle to learn its own
// length put a second full copy of pi's 18.26 MB expression on the session DO.
// A counter is only allowed to replace the encoder if it agrees with it
// exactly, so pin both directions against the encoder at the ceiling, with
// multi-byte content a char-count would get wrong by 2/3.
const CELL = 'src/multibyte.js';
const overheadBytes = new TextEncoder()
  .encode(buildFacetVfsBundleSource({ [CELL]: '' }).expression).length;

for (const [label, char, bytesPerChar] of [
  ['three-byte', '€', 3],   // €   — BMP, 3 UTF-8 bytes, 1 UTF-16 unit
  ['four-byte', '\u{1d11e}', 4], // 𝄞  — astral, 4 UTF-8 bytes, 2 UTF-16 units
]) {
  // Eight bytes under the ceiling: an inline verdict here is only correct if
  // the counter is right to within those eight bytes.
  const justUnder = char.repeat(
    Math.floor((BUNDLE_MAX_ENCODED_BYTES - 8 - overheadBytes) / bytesPerChar),
  );
  const fits = buildFacetVfsBundleSource({ [CELL]: justUnder });
  assert.deepEqual(
    fits.modules, {},
    `a ${label} bundle that truly fits the ceiling is not split (the counter does not over-count)`,
  );
  assert.ok(
    new TextEncoder().encode(fits.expression).length <= BUNDLE_MAX_ENCODED_BYTES,
    `an inline ${label} bundle really is within the ceiling (the counter does not under-count)`,
  );

  const justOver = char.repeat(justUnder.length / char.length + 1_000);
  assert.ok(
    Object.keys(buildFacetVfsBundleSource({ [CELL]: justOver }).modules).length >= 1,
    `a ${label} bundle past the ceiling is split across side modules`,
  );
}

console.log('facet VFS bundle source: ok');
