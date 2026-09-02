#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + generateShimsCode() + '\n;return __processMod;',
);
const processShim = factory(
  {}, {}, {}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);

// Node 22 exposes both APIs. Pi 0.84.3 probes them while deciding whether it
// runs as a single-executable application. A missing features object threw at
// module initialization before even `pi --version` could run.
assert.equal(typeof processShim.features, 'object');
assert.equal(Object.isFrozen(processShim.features), true);
assert.equal(typeof processShim.getBuiltinModule, 'function');
assert.equal(processShim.getBuiltinModule('node:process'), processShim);
assert.equal(processShim.getBuiltinModule('process'), processShim);
assert.equal(processShim.getBuiltinModule('node:sea'), undefined);
assert.equal(processShim.getBuiltinModule('definitely-not-a-node-builtin'), undefined);

console.log('node-shims-process-features: ok');
