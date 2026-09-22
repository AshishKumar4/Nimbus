#!/usr/bin/env bun
// The facet's URL constructor against Node's, through the shim's public
// `node:url` surface.
//
// `new URL(x)` with ONE argument is Node's strict absolute-URL parse: it
// throws TypeError [ERR_INVALID_URL] for a string that is not already a URL.
// That throw is an API, not an accident — Node's ESM resolver, and every
// vendored copy of it, spells the bare-specifier test as
//
//     try { resolved = new URL(specifier); } catch { packageResolve(…); }
//
// so a constructor that answers `file:///@nuxt/kit` instead of throwing sends
// the resolver down the absolute-path branch and makes it probe the
// FILESYSTEM ROOT. See tests/unit/node-shims-exsolve-resolution.mjs for the
// real resolver walking a real tree over this primitive.
//
// The deliberate divergence from Node is the two-argument form with a
// null/undefined base: rolldown- and esbuild-reduced `import.meta.url`
// evaluates to the bare word null, and `new URL(rel, null)` has to compose
// against the loading module rather than throw. That case is asserted here
// too, so narrowing the one-argument form cannot silently take it away.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

// Installing the shims reassigns globalThis.URL for the whole realm, which is
// exactly what a facet gets. Keep a handle on the host's native URL first: it
// is the Node-behaviour oracle every parity assertion below compares against.
const NativeURL = globalThis.URL;

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";const __compiledModules=new Map();const __compileFailures=new Map();'
    + generateShimsCode() + '\n;return builtins;',
);
const builtins = factory(
  {}, {}, {}, {}, {}, null,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);
const ShimURL = builtins.url.URL;
globalThis.URL = NativeURL;

assert.notEqual(ShimURL, NativeURL, 'node:url must expose the facet URL, not the host one');

// ── 1. one-argument parity with Node ──────────────────────────────────────
// Answer shape for one input, so "matches Node" is a comparison rather than
// a pair of hand-written expectations that could drift apart.
function oneArg(Ctor, input) {
  try { return `href:${new Ctor(input).href}`; }
  catch (e) { return `throw:${e.constructor.name}`; }
}

const notUrls = [
  '@nuxt/kit',            // the specifier `nuxt dev` could not resolve
  'nuxt',
  'exsolve',
  '@scope/pkg/sub/path',
  'foo/bar',
  './rel',
  '../up',
  '/abs/path',
  'home/user/x',
  '',
];
for (const input of notUrls) {
  assert.equal(
    oneArg(ShimURL, input), oneArg(NativeURL, input),
    `new URL(${JSON.stringify(input)}) must answer as Node does`,
  );
  assert.equal(
    oneArg(ShimURL, input), 'throw:TypeError',
    `new URL(${JSON.stringify(input)}) must throw — the resolver's bare-specifier test rides on it`,
  );
  // The static already told the truth about these strings while the
  // constructor was fabricating URLs for them. They have to agree.
  assert.equal(ShimURL.canParse(input), false);
}

const realUrls = [
  'file:///home/user/proj/node_modules/@nuxt/kit/package.json',
  'file:///',
  'http://example.test/a/b?c=1#d',
  'https://example.test',
  'data:text/plain,hi',
  'node:fs',
];
for (const input of realUrls) {
  assert.equal(
    oneArg(ShimURL, input), oneArg(NativeURL, input),
    `new URL(${JSON.stringify(input)}) must answer as Node does`,
  );
  assert.equal(ShimURL.canParse(input), true);
}

// ── 2. two-argument form with a real base: plain Node semantics ───────────
const base = 'file:///home/user/proj/';
for (const rel of ['./node_modules/@nuxt/kit/package.json', '../sibling/x.mjs', 'rel.js', '/rooted.js']) {
  assert.equal(
    new ShimURL(rel, base).href, new NativeURL(rel, base).href,
    `new URL(${JSON.stringify(rel)}, base) must answer as Node does`,
  );
}
assert.equal(
  new ShimURL('./node_modules/@nuxt/kit/package.json', base).href,
  'file:///home/user/proj/node_modules/@nuxt/kit/package.json',
);

// ── 3. the deliberate divergence: null/undefined base, still lenient ──────
// Node throws for all four of these; the facet composes them, because the
// bundler that emitted them dropped the base it meant to pass.
assert.throws(() => new NativeURL('../foo.js', null));
assert.throws(() => new NativeURL('./foo.js', undefined));

assert.equal(new ShimURL('../foo.js', null).href, 'file:///foo.js');
assert.equal(new ShimURL('./foo.js', undefined).href, 'file:///foo.js');
assert.equal(new ShimURL('http://example.test/x', null).href, 'http://example.test/x');

globalThis.__currentModulePath = '/home/user/proj/node_modules/vite/dist/node/chunks/logger.js';
try {
  assert.equal(
    new ShimURL('../../../src/node/constants.ts', undefined).href,
    'file:///home/user/proj/node_modules/vite/src/node/constants.ts',
    'a null base composes against the loading module, not the root',
  );
  // The one-argument form must stay strict even while a module path is set —
  // that is the state every `require()`d module resolves its imports in.
  assert.throws(() => new ShimURL('@nuxt/kit'), TypeError);
} finally {
  delete globalThis.__currentModulePath;
}

// ── 4. structural passthrough ─────────────────────────────────────────────
const u = new ShimURL('file:///home/user/proj/a.mjs');
assert.ok(u instanceof NativeURL, 'facet URLs must stay instanceof the platform URL');
assert.ok(u instanceof ShimURL);
assert.equal(u.protocol, 'file:');
assert.equal(u.pathname, '/home/user/proj/a.mjs');
assert.equal(typeof ShimURL.canParse, 'function');

// ── 5. the round trip the resolver actually performs ──────────────────────
const { pathToFileURL, fileURLToPath } = builtins.url;
const from = '/home/user/proj';
const fromUrl = pathToFileURL(`${from}/`);
assert.equal(fromUrl.href, 'file:///home/user/proj/');
const pkgUrl = new ShimURL('./node_modules/@nuxt/kit/package.json', fromUrl);
assert.equal(fileURLToPath(pkgUrl), '/home/user/proj/node_modules/@nuxt/kit/package.json');

console.log('node-shims-url-constructor: ok');
