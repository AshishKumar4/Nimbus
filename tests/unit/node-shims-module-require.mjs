#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";const __compiledModules=new Map();const __compileFailures=new Map();' + generateShimsCode() + '\n;return __require;',
);
const requireFromFacet = factory(
  {
    'home/user/module-require.js': 'module.exports = module.require("node:process").version;\n',
    'home/user/local-require.js': 'const require = () => "local"; module.exports = require();\n',
    // pi's CLI entry calls Node 22.1's compile cache unconditionally; the
    // answer is the status Node gives when the cache is off.
    'home/user/compile-cache.js': 'const m = require("node:module"); module.exports = [m.enableCompileCache().status === m.constants.compileCacheStatus.DISABLED, m.isBuiltin("node:fs"), m.isBuiltin("fs"), m.isBuiltin("undici"), m.isBuiltin("left-pad")];\n',
    'home/user/kit dist/index.mjs': 'module.exports = "kit";\n',
  },
  {}, {}, {}, {
    'home/user': ['module-require.js', 'local-require.js', 'compile-cache.js', 'kit dist'],
    'home/user/kit dist': ['index.mjs'],
  },
  null,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);

// Node's Module object exposes the same scoped resolver as the wrapper's
// require parameter. The bounded ESM rewrite uses it so an upstream module may
// legally declare its own `require = createRequire(import.meta.url)` binding.
assert.match(requireFromFacet('/home/user/module-require.js'), /^v\d+\./);
assert.equal(requireFromFacet('/home/user/local-require.js'), 'local');
assert.deepEqual(requireFromFacet('/home/user/compile-cache.js'), [true, true, true, false, false]);

// An absolute file: URL is a specifier Node's dynamic import() accepts, and it
// is how a package loads a path its own resolver just produced:
// @nuxt/cli's loadKit imports pathToFileURL(resolveModulePath('@nuxt/kit')).href.
// The ESM→CJS transform routes those through this same resolver, so the scheme
// has to be understood here or the href is looked up as a package name —
// "Cannot find module 'file:///…/@nuxt/kit/dist/index.mjs'" with the file
// sitting right there.
assert.equal(requireFromFacet('file:///home/user/local-require.js'), 'local');
assert.match(requireFromFacet('file:///home/user/module-require.js'), /^v\d+\./);
// A cache-busting query is the standard HMR spelling of the same import, and
// percent-escapes are how a file URL carries a path with a space in it.
assert.equal(requireFromFacet('file:///home/user/local-require.js?t=1790000000'), 'local');
assert.equal(requireFromFacet('file:///home/user/kit%20dist/index.mjs'), 'kit');

console.log('node-shims-module-require: ok');
