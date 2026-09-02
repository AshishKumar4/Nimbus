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
  },
  {}, {}, {}, { 'home/user': ['module-require.js', 'local-require.js'] },
  null,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);

// Node's Module object exposes the same scoped resolver as the wrapper's
// require parameter. The bounded ESM rewrite uses it so an upstream module may
// legally declare its own `require = createRequire(import.meta.url)` binding.
assert.match(requireFromFacet('/home/user/module-require.js'), /^v\d+\./);
assert.equal(requireFromFacet('/home/user/local-require.js'), 'local');

console.log('node-shims-module-require: ok');
