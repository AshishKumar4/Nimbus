#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  bindImportMetaResolve,
  importMetaDefines,
} from '../../packages/worker/src/runtime/import-meta-transform.ts';

const absUrl = 'file:///home/user/app/mod.js';
assert.deepEqual(importMetaDefines(absUrl), {
  'import.meta.url': JSON.stringify(absUrl),
  'import.meta.resolve': '__nimbusImportMetaResolveForModule',
});

const unchanged = 'console.log("no helper");';
assert.equal(bindImportMetaResolve(unchanged, absUrl), unchanged);

const bound = bindImportMetaResolve(
  'console.log(__nimbusImportMetaResolveForModule("./x.js"));',
  absUrl,
);
assert.match(bound, /globalThis\.__nimbusImportMetaResolve\(specifier, "file:\/\/\/home\/user\/app\/mod\.js"\)/);
assert.match(bound, /console\.log\(__nimbusImportMetaResolveForModule/);

console.log('import-meta-transform: ok');
