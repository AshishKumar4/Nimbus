#!/usr/bin/env bun
// What ONE member of a resident process's module map is allowed to cost the
// supervisor.
//
// The map is written to the image store a member at a time and read back a
// member at a time, both on the coordinator's own 128 MiB isolate, and the
// read-back happens when the whole map is already resident — so the peak is
// the map plus whatever the largest member costs on top of it. Bounding the
// partition by the LOADER's per-member ceiling (22 MiB) bounded the wrong
// thing: `astro dev` packed one member at 22,673,358 bytes and the alarm turn
// that materialized it died with "Durable Object's isolate exceeded its
// memory limit and was reset" (nimbus-probe-staging, 2026-09-21). `nuxt dev`
// and the opencode TUI hit the same wall from the inline side, as one ~13.4 MB
// `worker.js`.
//
// Two properties, both through the public APIs:
//
//   1. No member the launch generates exceeds FACET_MODULE_MEMBER_MAX_BYTES —
//      neither a side module nor the inline expression that rides in the main
//      module — and the members still reconstruct the bundle exactly.
//   2. Neither end of the image protocol encodes a member twice. The store
//      has the bytes in hand when it names them, and the reader has them in
//      hand when it verifies them; going through the string form to reach the
//      digest cost a full extra copy of the largest member at each end.

import assert from 'node:assert/strict';

import { FACET_MODULE_MEMBER_MAX_BYTES } from '../../packages/platform/src/limits.ts';
import { buildFacetVfsBundleSource } from '../../packages/worker/src/facets/manager.ts';
import { ImageStore } from '../../packages/fabric/src/image-store.ts';
import { TurnBudget } from '../../packages/fabric/src/turn-budget.ts';
import {
  facetImageDigest,
  facetImageBytesDigest,
  residentLoaderConfig,
} from '../../packages/fabric/src/process-fabric.ts';

const encodedBytes = (text) => new TextEncoder().encode(text).length;

// ── a disk, and a pacer that never actually leaves the turn ────────────────

function fakeBlobStore() {
  const files = new Map();
  return {
    files,
    mkdirp() {},
    sizeOf(path) { return files.has(path) ? files.get(path).length : null; },
    writeFile(path, bytes) { files.set(path, Uint8Array.from(bytes)); },
    writeRange(path, offset, bytes) {
      const prev = files.get(path) ?? new Uint8Array(0);
      const next = new Uint8Array(Math.max(prev.length, offset + bytes.length));
      next.set(prev);
      next.set(bytes, offset);
      files.set(path, next);
    },
    list(dir) {
      const prefix = `${dir}/`;
      return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    },
    unlink(path) {
      if (!files.delete(path)) throw new Error(`ENOENT: ${path}`);
    },
  };
}

const immediatePacer = () => new TurnBudget({ async nextTurn() {} });

// ── 1. the partition is bounded by what the supervisor can hold ────────────

// Two cells that together clear the bound several times over, so the packer
// has to spread them across members rather than pack one enormous one. Each
// cell is itself over the bound, which also exercises the fragment split.
const bundle = {
  'usr/lib/node_modules/astro/dist/core/index.js': 'const a = "cell-one";\n'.repeat(320_000),
  'usr/lib/node_modules/vite/dist/node/chunks/dep.js': 'const b = "cell-two";\n'.repeat(320_000),
  'usr/lib/node_modules/vite/package.json': '{"name":"vite"}',
  'usr/lib/node_modules/esbuild/lib/binary.node': new Uint8Array([0, 127, 128, 255]),
  'usr/lib/node_modules/private.key': { error: 'EACCES' },
};

const source = await buildFacetVfsBundleSource(bundle);

assert.ok(
  Object.keys(source.modules).length > 1,
  'a bundle past the member bound is partitioned rather than emitted as one member',
);
for (const [name, moduleSource] of Object.entries(source.modules)) {
  const bytes = encodedBytes(moduleSource);
  assert.ok(
    bytes <= FACET_MODULE_MEMBER_MAX_BYTES,
    `${name} is ${bytes} bytes, over the ${FACET_MODULE_MEMBER_MAX_BYTES}-byte member bound`,
  );
}
assert.ok(
  encodedBytes(source.expression) <= FACET_MODULE_MEMBER_MAX_BYTES,
  'the merge expression riding in the main module is within the member bound too',
);

// The bound is only worth anything if the members still add up to the bundle.
function evaluateModule(moduleSource) {
  const prefix = 'export default ';
  assert.ok(moduleSource.startsWith(prefix), 'a VFS side module has a default export');
  return new Function(`return (${moduleSource.slice(prefix.length, -1)});`)();
}
const imports = [...source.imports.matchAll(/^import (\w+) from "([^"]+)";$/gm)];
const merged = new Function(
  ...imports.map((m) => m[1]),
  `return (${source.expression});`,
)(...imports.map((m) => evaluateModule(source.modules[m[2]])));
assert.deepEqual(merged, bundle, 'the partitioned members reconstruct the bundle exactly');

// A bundle that genuinely fits keeps the inline path — the bound tightened
// where members are generated, it did not turn every launch into side modules.
const small = await buildFacetVfsBundleSource({ 'src/index.js': 'module.exports = 1;' });
assert.deepEqual(small.modules, {}, 'a bundle inside the member bound stays inline');

// ── 2. neither end of the image protocol encodes a member twice ────────────

// The digest of an image's bytes IS the digest of its source: the store only
// ever writes this one encoding, so taking the name from the bytes is the
// same name, reached without a second copy.
for (const text of ['plain ascii source', 'multibyte € source', 'astral \u{1d11e} source', '']) {
  assert.equal(
    await facetImageBytesDigest(new TextEncoder().encode(text)),
    await facetImageDigest(text),
    `the byte digest and the source digest agree for ${JSON.stringify(text)}`,
  );
}

// Count what each end of the protocol encodes. An image is named by its own
// bytes at both ends, so the write encodes each member exactly once and the
// read encodes nothing at all.
const NativeTextEncoder = globalThis.TextEncoder;
let encodedByteCount = 0;
class CountingTextEncoder extends NativeTextEncoder {
  encode(input = '') {
    const bytes = super.encode(input);
    encodedByteCount += bytes.length;
    return bytes;
  }
}

const members = { 'worker.js': 'const boot = 1;\n'.repeat(40_000), ...source.modules };
const memberBytes = Object.values(members).reduce((sum, text) => sum + encodedBytes(text), 0);

const blobs = fakeBlobStore();
const store = new ImageStore(() => blobs, () => true);

globalThis.TextEncoder = CountingTextEncoder;
let paths;
try {
  paths = await store.materialize(4242, Object.entries(members), immediatePacer());
} finally {
  globalThis.TextEncoder = NativeTextEncoder;
}
assert.equal(
  encodedByteCount, memberBytes,
  'materialize encodes each member exactly once: naming it must not cost a second copy',
);
assert.deepEqual(
  Object.keys(paths).sort(), Object.keys(members).sort(),
  'every member is materialized and named',
);
for (const [name, path] of Object.entries(paths)) {
  assert.equal(
    blobs.files.get(path.replace(/^\/+/, '')).length, encodedBytes(members[name]),
    `${name} landed at its full size`,
  );
}

// The read-back is where the map is already resident, so it is the copy that
// matters most: verifying against the bytes read means nothing is encoded.
const disk = { readFile(path) { return blobs.files.get(path.replace(/^\/+/, '')); } };
encodedByteCount = 0;
globalThis.TextEncoder = CountingTextEncoder;
let config;
try {
  config = await residentLoaderConfig(
    {
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'worker.js',
      modules: {},
      vfsTextModules: paths,
    },
    disk,
  );
} finally {
  globalThis.TextEncoder = NativeTextEncoder;
}
assert.equal(
  encodedByteCount, 0,
  'the loader read-back encodes nothing: an image is verified against the bytes it read',
);
for (const [name, text] of Object.entries(members)) {
  assert.equal(config.modules[name], text, `${name} reads back byte-for-byte`);
}

// Verification is still real: a member whose bytes do not hash to the name it
// was fetched under does not reach the loader as the program.
const [corrupted] = Object.values(paths);
const stored = corrupted.replace(/^\/+/, '');
blobs.files.set(stored, new TextEncoder().encode('module.exports = "not the image";'));
await assert.rejects(
  residentLoaderConfig(
    {
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'worker.js',
      modules: {},
      vfsTextModules: paths,
    },
    disk,
  ),
  /does not match its digest/,
  'a corrupt image is refused rather than booted',
);

console.log('facet image member bound: ok');
