#!/usr/bin/env bun
// A large bundled model catalog must bind metadata without constructing a
// whole-cell Acorn AST. Model the facet's allocation boundary by refusing
// whole-program parses, then execute the emitted module through EsbuildService.

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
const { Parser } = await import(Bun.resolveSync('acorn', new URL('../../packages/core/src/runtime', import.meta.url).pathname));

const parent = 'file:///home/user/catalog.mjs';
const count = 12000;
const entries = Array.from({ length: count }, (_, i) => `m${i}:{cost:${i},name:"model-${i}",limits:{input:${i + 1},output:${i + 2}}}`);
const source = String.raw`"use strict";
const catalog = {${entries.join(',')}};
const __nimbu\u0073MetadataModule_ = 'escaped user binding';
function read(__nimbusMetadataModule) {
  return [import.meta.url, __nimbusMetadataModule, __nimbu\u0073MetadataModule_];
}
return { metadata: read('parameter'), count: Object.keys(catalog).length,
  total: Object.values(catalog).reduce((sum, model) => sum + model.cost, 0) };
`;
const original = Parser.parse;
Parser.parse = () => { throw new Error('whole-cell AST exceeds the facet allocation envelope'); };
try {
  const service = new EsbuildService();
  const result = await service.transform(source, { rewriteOnly: true, dynamicImportParent: parent, moduleMetadata: true });
  const output = new Function('exports', 'require', 'module', result.code)({}, undefined, { __nimbusImportMeta: { url: parent } });
  assert.deepEqual(output, {
    metadata: [parent, 'parameter', 'escaped user binding'],
    count,
    total: count * (count - 1) / 2,
  });
} finally {
  Parser.parse = original;
}
console.log('dynamic-import-rewrite-bounded OK: large metadata cell executes without a whole-cell AST');
