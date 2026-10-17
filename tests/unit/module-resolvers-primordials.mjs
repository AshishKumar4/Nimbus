#!/usr/bin/env bun
// The module resolvers (core _shared/esm-resolver.ts, commonjs-resolver.ts,
// their package maps and TypeScript rules, and Node's errors) answer as they
// did after a program replaced a built-in they could call, as Node's loader
// does on its primordials: each built-in below replaced by one that throws,
// then all of them at once, and Object.prototype given the fields a
// package.json or an option may lack. The oracle is each resolver before any
// replacement, over the same tree (esm-resolver-matches-node and the
// require-resolver suites check those answers against host Node).
// The host is the test's own, on built-ins captured with the resolver's, as
// the guest's filesystem reads will be (design-guest-loader-primordials.md).

import assert from 'node:assert/strict';

import { createRequireResolver, NIMBUS_TYPESCRIPT_REQUIRE_POLICY } from '../../packages/core/src/runtime/require-resolution.ts';
import { createEsmResolver } from '../../packages/core/src/_shared/esm-resolver.ts';
import { BUILD_BROWSER_PACKAGE_MAP_POLICY, selectPackageMap } from '../../packages/core/src/_shared/exports-resolver.ts';
import { SafeMap, SafeSet } from '../../packages/core/src/_shared/primordials.ts';

// The test's own reach for built-ins, taken before it replaces any.
const define = Reflect.defineProperty;
const describe = Object.getOwnPropertyDescriptor;
const Failure = Error;
/** [label, owner, key]: what is replaced (the ticket's list, and the statics and constructors the resolver captured). */
const BUILTINS = [
  ...['charCodeAt', 'codePointAt', 'at', 'startsWith', 'endsWith', 'slice', 'substring', 'indexOf', 'lastIndexOf', 'includes',
    'split', 'replace', 'replaceAll', 'toLowerCase', 'toUpperCase', 'trim', 'padStart', 'normalize', 'match', 'search']
    .map((key) => [`String.prototype.${key}`, String.prototype, key]),
  ...['push', 'pop', 'shift', 'unshift', 'join', 'map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'indexOf',
    'includes', 'slice', 'splice', 'concat', 'reverse', 'sort', 'reduce', 'flat', 'flatMap', 'keys', 'values', 'entries', Symbol.iterator]
    .map((key) => [`Array.prototype.${String(key.description ?? key)}`, Array.prototype, key]),
  ...['exec', 'test', Symbol.replace, Symbol.split, Symbol.match].map((key) => [`RegExp.prototype.${String(key.description ?? key)}`, RegExp.prototype, key]),
  ...['get', 'set', 'has', 'delete'].map((key) => [`Map.prototype.${key}`, Map.prototype, key]),
  ...['add', 'has'].map((key) => [`Set.prototype.${key}`, Set.prototype, key]),
  ...['keys', 'entries', 'assign', 'freeze', 'getOwnPropertyNames', 'defineProperty', 'hasOwn', 'getOwnPropertyDescriptor', 'setPrototypeOf']
    .map((key) => [`Object.${key}`, Object, key]),
  ...['apply', 'get', 'set', 'has', 'defineProperty', 'deleteProperty', 'getPrototypeOf'].map((key) => [`Reflect.${key}`, Reflect, key]),
  ['Array.isArray', Array, 'isArray'],
  ['JSON.parse', JSON, 'parse'],
  ['JSON.stringify', JSON, 'stringify'],
  ['Error.captureStackTrace', Error, 'captureStackTrace'],
  ...['next', 'throw', 'return'].map((key) => [`%GeneratorPrototype%.${key}`, Object.getPrototypeOf(function* () {}.prototype), key]),
  [`%IteratorPrototype%[Symbol.iterator]`, Object.getPrototypeOf(Object.getPrototypeOf(function* () {}.prototype)), Symbol.iterator],
  ...['decodeURIComponent', 'encodeURIComponent', 'URL', 'String', 'Number', 'Error', 'TypeError', 'Promise']
    .map((key) => [key, globalThis, key]),
];
// Not URL.prototype's accessors: Node's resolver reads a URL's members live,
// and fails as the program's replacement does (host Node 22.22.3), as the
// resolver here does (package-map.ts urlPathname).

// The tree: an application with `imports`, packages with conditional,
// pattern and null exports, a self-reference, a legacy main, and the
// package.json files and paths Node refuses.
const files = new SafeMap();
const dirs = new SafeSet();
const write = (path, text) => {
  files.set(path, text);
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) dirs.add(path.slice(0, at));
};
dirs.add('/');
write('/app/package.json', JSON.stringify({ name: 'app', type: 'module', exports: { '.': './src/main.js', './self/*': './src/*.js' }, imports: { '#util': './src/util.js', '#lib/*': './lib/*.js', '#dep': 'pkg', '#bad': '../out.js' } }));
for (const name of ['main', 'util', 'a', 'b']) write(`/app/src/${name}.js`, '');
write('/app/src/c.ts', '');
write('/app/src/d.wasm', '');
write('/app/src/e.json', '{}');
write('/app/src/f.cjs', '');
write('/app/lib/x.js', '');
write('/app/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', exports: {
  '.': { types: './index.d.ts', import: './esm/index.js', require: './cjs/index.cjs' },
  './feature/*': { import: './esm/feature/*.js', default: './cjs/*.cjs' },
  './feature/*.css': './css/*.css',
  './internal/*': null,
  './bad': '../escape.js',
  './list': [null, 'nope', './esm/index.js'],
} }));
write('/app/node_modules/pkg/esm/index.js', '');
write('/app/node_modules/pkg/esm/feature/one.js', '');
write('/app/node_modules/pkg/css/look.css', '');
write('/app/node_modules/@scope/kit/package.json', JSON.stringify({ name: '@scope/kit', type: 'commonjs', main: 'lib/kit' }));
write('/app/node_modules/@scope/kit/lib/kit.js', '');
write('/app/node_modules/legacy/package.json', JSON.stringify({ main: 'missing' }));
write('/app/node_modules/legacy/index.js', '');
write('/app/node_modules/broken/package.json', '{ not json');
write('/app/node_modules/numeric/package.json', JSON.stringify({ exports: { 0: './a.js' } }));
write('/app/node_modules/mixed/package.json', JSON.stringify({ exports: { '.': './a.js', import: './b.js' } }));
write('/app/node_modules/nomain/package.json', JSON.stringify({ name: 'nomain' }));
write('/app/node_modules/dirpkg/package.json', JSON.stringify({ name: 'dirpkg' }));
write('/app/node_modules/dirpkg/sub/x.js', '');
write('/app/src/g.ts', '');
write('/app/src/h/index.json', '{}');
write('/app/node_modules/cjs/package.json', JSON.stringify({ name: 'cjs', main: './lib/entry' }));
write('/app/node_modules/cjs/lib/entry.js', '');
write('/app/node_modules/badmain/package.json', JSON.stringify({ main: './nowhere' }));

const host = {
  kind: (path) => (files.has(path) ? 'file' : dirs.has(path) ? 'directory' : null),
  realpath: (path) => path,
  readText: (path) => (files.has(path) ? files.get(path) : null),
  isBuiltin: (specifier) => specifier === 'fs' || specifier === 'node:fs' || specifier === 'node:test',
  cjsResolve: (specifier) => (specifier === './nope.js' ? '/app/src/nope.cjs' : specifier === 'pkg/missing' ? '/app/node_modules/pkg/missing.js' : null),
};

const parent = 'file:///app/src/main.js';
const RESOLVED = [
  './a.js', '../src/b.js', './c.ts', './d.wasm', './e.json', './f.cjs', './a.js?query#hash', 'file:///app/src/a.js',
  'pkg', 'pkg/feature/one', 'pkg/feature/look.css', 'pkg/internal/x', 'pkg/bad', 'pkg/list', 'pkg/missing', '@scope/kit',
  'legacy', 'broken', 'numeric', 'mixed', 'nomain', 'nopkg', 'app', 'app/self/util', '#util', '#lib/x', '#dep', '#bad', '#none', '#',
  'fs', 'node:fs', 'node:test', 'node:nope', 'data:text/javascript,1', 'https://x.test/a.js', './nope.js', './', './missing/',
  '.%2fa.js', '@bad', '.hidden', 'dirpkg/sub',
];
const META = ['./a.js', './missing.js', './', 'pkg', 'pkg/internal/x', '#util'];
const REQUIRED = [
  './a', './a.js', './g.js', './g', './h', './f.cjs', '../src/b', '/app/src/a', './', '.', 'pkg', 'pkg/feature/one', 'pkg/internal/x',
  '@scope/kit', 'cjs', 'badmain', 'legacy', 'broken', 'nopkg', 'app', 'app/self/util', '#util', '#lib/x', '#dep', '#bad', '#none', '#',
  'fs', 'node:fs', './nope', 'a\\b',
];
const ATTRIBUTES = [
  ['json', {}], ['json', { type: 'json' }], ['module', { type: 'json' }], ['module', { kind: 'x' }], ['module', { type: 1 }],
  ['data', { type: 'json' }], ['module', {}],
];

/** What the resolver answers for the tree: each resolution, or its error's class, code and message. */
function answers(options = { conditions: [] }) {
  const out = [];
  const record = (label, run) => {
    try {
      out[out.length] = `${label} => ${run()}`;
    } catch (error) {
      // The error's own url (an inherited one, Object.prototype's, is not the resolver's).
      const url = error !== null && typeof error === 'object' ? describe(error, 'url')?.value : undefined;
      out[out.length] = `${label} => ${error?.constructor?.name} ${error?.code} ${error?.message} ${typeof url === 'string' ? url : ''}`;
    }
  };
  const resolver = createEsmResolver(host, options);
  for (let i = 0; i < RESOLVED.length; i++) {
    record(RESOLVED[i], () => {
      const resolution = resolver.resolveSync(RESOLVED[i], parent);
      resolver.assertLoadable(resolution);
      return `${resolution.url} ${resolution.format} ${resolution.path} ${resolution.builtin}`;
    });
  }
  for (let i = 0; i < META.length; i++) record(`meta ${META[i]}`, () => resolver.metaResolveSync(META[i], parent));
  for (let i = 0; i < ATTRIBUTES.length; i++) {
    const format = ATTRIBUTES[i][0];
    const attributes = ATTRIBUTES[i][1];
    record(`attributes ${format} ${i}`, () => {
      resolver.validateAttributes(format === 'data' ? 'data:application/json,{}' : 'file:///app/src/a.js', format, attributes);
      return 'valid';
    });
  }
  record('scope', () => {
    const scope = resolver.packageScopeSync('file:///app/node_modules/@scope/kit/lib/kit.js');
    return `${scope.exists} ${scope.pjsonPath} ${scope.type}`;
  });
  const requirer = createRequireResolver(host, { conditions: [], policy: NIMBUS_TYPESCRIPT_REQUIRE_POLICY });
  for (let i = 0; i < REQUIRED.length; i++) {
    record(`require ${REQUIRED[i]}`, () => {
      const found = requirer.resolveSync(REQUIRED[i], '/app/src', { parent: '/app/src/main.js' });
      return found === null ? 'null' : `${found.path} ${found.builtin} ${found.packageType} ${found.scope?.packageJsonPath}`;
    });
  }
  record('require paths', () => requirer.resolveSync('pkg', '/app/src', { paths: ['/app/node_modules/@scope', '/app'] })?.path);
  record('require file', () => requirer.resolveFileSync('/app/src/h'));
  record('require scope', () => requirer.packageScopeSync('/app/node_modules/@scope/kit/lib')?.type);
  return out;
}

// The API as callers use it, unreplaced: a native Set of conditions selects
// as an array does, and a hole in require's paths is no origin
// (Array.prototype.flatMap skipped it before the captures).
{
  const select = (conditions) => selectPackageMap({ node: './node.js', default: './fallback.js' }, '.', conditions, BUILD_BROWSER_PACKAGE_MAP_POLICY).next().value;
  assert.equal(select(new Set(['node'])), './node.js', 'a native Set of conditions selects its condition');
  assert.equal(select(['node']), './node.js', 'an array of conditions selects its condition');
  const requirer = createRequireResolver(host, { conditions: [] });
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(requirer.resolveSync('cjs', '/app/src', { paths: [, '/app'] })?.path, '/app/node_modules/cjs/lib/entry.js', 'a hole in paths is skipped');
}

const want = answers();
const failures = [];
const compare = (label, seen) => {
  for (let i = 0; i < want.length; i++) {
    if (seen[i] !== want[i]) {
      failures[failures.length] = `${label}: want ${want[i]}, seen ${seen[i]}`;
      return;
    }
  }
};
const thrower = function () { throw new Failure('a replaced built-in was called'); };
for (let i = 0; i < BUILTINS.length; i++) {
  const label = BUILTINS[i][0];
  const owner = BUILTINS[i][1];
  const key = BUILTINS[i][2];
  const descriptor = describe(owner, key);
  define(owner, key, { value: thrower, writable: true, configurable: true });
  let seen;
  try {
    seen = answers();
  } catch (error) {
    seen = [`threw ${error?.message}`];
  }
  define(owner, key, descriptor);
  compare(label, seen);
}

// All at once.
{
  const saved = [];
  for (let i = 0; i < BUILTINS.length; i++) saved[i] = describe(BUILTINS[i][1], BUILTINS[i][2]);
  for (let i = 0; i < BUILTINS.length; i++) define(BUILTINS[i][1], BUILTINS[i][2], { value: thrower, writable: true, configurable: true });
  let seen;
  try {
    seen = answers();
  } catch (error) {
    seen = [`threw ${error?.message}`];
  }
  for (let i = BUILTINS.length - 1; i >= 0; i--) define(BUILTINS[i][1], BUILTINS[i][2], saved[i]);
  compare('every built-in at once', seen);
}

// Fields a package.json, a resolution or an option may lack, given by Object.prototype.
{
  const POLLUTED = ['main', 'exports', 'imports', 'type', 'name', 'path', 'builtin', 'url', 'conditions', 'stripTypes', 'cwd', 'default',
    'policy', 'progress', 'paths', 'parent', 'collectPackageScope', 'typescriptFallback', 'globalFolders', 'isBuiltin'];
  const pollution = (key) => (key === 'cwd' || key === 'progress' || key === 'isBuiltin' ? () => true
    : key === 'conditions' || key === 'paths' || key === 'globalFolders' ? ['import', '/elsewhere']
      : key === 'collectPackageScope' || key === 'typescriptFallback' || key === 'stripTypes' ? false
        : `./polluted-${key}.js`);
  for (const key of POLLUTED) define(Object.prototype, key, { value: pollution(key), writable: true, configurable: true });
  let seen;
  try {
    seen = answers({ conditions: [] });
  } catch (error) {
    seen = [`threw ${error?.message}`];
  }
  for (const key of POLLUTED) delete Object.prototype[key];
  compare('Object.prototype polluted', seen);
}

console.log(failures.join('\n'));
assert.deepEqual(failures, [], `the resolver answers otherwise after ${failures.length} replacements`);
console.log(`ok - module-resolvers-primordials (${want.length} answers, under ${BUILTINS.length} built-ins replaced in turn, all at once, and a polluted Object.prototype)`);
