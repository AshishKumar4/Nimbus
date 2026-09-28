#!/usr/bin/env bun
// node:module is Node's Module constructor, with Node's statics.
//
// jiti (how Nuxt and c12 load nuxt.config.ts) builds a module by hand:
// `new Module(filename)`, sets `filename`, `paths` from
// `Module._nodeModulePaths(dir)`, and runs the transpiled text through
// `mod._compile(code, filename)`. The shim's node:module was a plain object,
// so `new Module()` threw "Module is not a constructor" and `nuxt dev` died
// loading its config.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';

const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";const __compiledModules=new Map();const __compileFailures=new Map();' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return __require;',
);
const requireFromFacet = (declareNamespace({ metadata: {}, manifest: {
  'home/user': ['app'],
  'home/user/app': ['node_modules', 'nuxt.config.ts'],
  'home/user/app/node_modules': ['defu'],
  'home/user/app/node_modules/defu': ['package.json', 'index.js'],
} }), factory(
  {
    'home/user/app/nuxt.config.ts': 'export default {}\n',
    'home/user/app/node_modules/defu/package.json': JSON.stringify({ name: 'defu', main: 'index.js' }),
    'home/user/app/node_modules/defu/index.js': 'module.exports = (a, b) => ({ ...b, ...a });\n',
  },
  {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user/app', [], {},
  '/home/user/app/main.mjs', '/home/user/app',
));

const Module = requireFromFacet('node:module');
assert.equal(typeof Module, 'function', "require('module') is the Module constructor");
assert.equal(Module.Module, Module, 'Module.Module is the same function');
assert.equal(Module.name, 'Module');
assert.equal(requireFromFacet('module'), Module);
assert.throws(() => Module('x'), TypeError, 'a class constructor needs new');

// new Module(id, parent): Node's fields.
const parent = new Module('/home/user/app/parent.js');
const mod = new Module('/home/user/app/nuxt.config.ts', parent);
assert.equal(mod.id, '/home/user/app/nuxt.config.ts');
assert.equal(mod.path, '/home/user/app');
assert.deepEqual(mod.exports, {});
assert.equal(mod.filename, null);
assert.equal(mod.loaded, false);
assert.deepEqual(mod.paths, []);
assert.equal(mod.parent, parent);
assert.deepEqual(parent.children, [mod], 'a child registers with its parent');
assert.equal(new Module().path, '.', "dirname('') is '.'");

// Node's lookup paths: nearest first, never node_modules/node_modules.
assert.deepEqual(Module._nodeModulePaths('/home/user/app/src'), [
  '/home/user/app/src/node_modules', '/home/user/app/node_modules', '/home/user/node_modules', '/home/node_modules', '/node_modules',
]);
assert.deepEqual(Module._nodeModulePaths('/home/user/app/node_modules/defu'), [
  '/home/user/app/node_modules/defu/node_modules', '/home/user/app/node_modules', '/home/user/node_modules', '/home/node_modules', '/node_modules',
]);
assert.deepEqual(Module._nodeModulePaths('/'), ['/node_modules']);

// Resolution is real, relative to the parent's file.
assert.equal(Module._resolveFilename('defu', mod), '/home/user/app/node_modules/defu/index.js');
assert.equal(Module._resolveFilename('node:fs', mod), 'node:fs');
assert.throws(() => Module._resolveFilename('missing-pkg', mod), (e) => e.code === 'MODULE_NOT_FOUND');

// Node's wrapper, and _compile running CommonJS text as the module: its
// require resolves from the module's own file, its exports are the module's.
assert.equal(Module.wrap('x'), '(function (exports, require, module, __filename, __dirname) { x\n});');
mod.filename = '/home/user/app/nuxt.config.ts';
mod.paths = Module._nodeModulePaths('/home/user/app');
mod._compile(
  'const defu = require("defu"); module.exports = { merged: defu({ a: 1 }, { b: 2 }), file: __filename, dir: __dirname };',
  mod.filename,
);
assert.deepEqual(mod.exports, { merged: { a: 1, b: 2 }, file: '/home/user/app/nuxt.config.ts', dir: '/home/user/app' });
assert.equal(typeof mod.require('defu'), 'function', 'Module#require resolves from the module\'s file');

// The rest of the module API is unchanged.
assert.equal(Module.isBuiltin('node:fs'), true);
assert.equal(typeof Module.createRequire('/home/user/app/x.js')('defu'), 'function');
assert.ok(Module.builtinModules.includes('fs'));

console.log('node-shims-module-class: ok');
