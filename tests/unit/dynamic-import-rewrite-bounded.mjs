#!/usr/bin/env bun
// A large bundled cell is rewritten without Acorn reading the whole of it,
// and without the module lexer keeping what the cell grew.
//
// Every token Acorn reads, parsing or tokenizing, passes through
// Parser.prototype.nextToken, which is counted: the rewrite may read small
// spans (a call's arguments, a method's braces, a directive) but not the cell.
// The cell has what sent whole cells to Acorn before: a hashbang, methods
// named import (with the brace on the method's line, and on the next line),
// and member calls named import. The emitted module is then executed.

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { runCell, withProcessImport } from './lib/process-import.mjs';
const { Parser } = await import(Bun.resolveSync('acorn', new URL('../../packages/core/src/runtime', import.meta.url).pathname));

const parent = 'file:///home/user/bin/catalog.mjs';
const count = 12000;
const entries = Array.from({ length: count }, (_, i) => `m${i}:{cost:${i},name:"model-${i}",limits:{input:${i + 1},output:${i + 2}}}`);
const source = String.raw`#!/usr/bin/env node
"use strict";
const catalog = {${entries.join(',')}};
const loader = { import(id) { return 'object:' + id; } };
class Loader {
  import(id)
  {
    return 'class:' + id;
  }
  static kind = 'loader';
}
const viaMembers = [loader.import('a'), new Loader().import('b'), (loader)?.import('c')];
const __nimbu\u0073MetadataModule_ = 'escaped user binding';
function read(__nimbusMetadataModule) {
  return [new URL('.', import.meta.url).href, __nimbusMetadataModule, __nimbu\u0073MetadataModule_];
}
return import('./later.js').then((later) => ({ metadata: read('parameter'), viaMembers, later,
  count: Object.keys(catalog).length, total: Object.values(catalog).reduce((sum, model) => sum + model.cost, 0) }));
`;

// ── Lexing the cell grows the module lexer's scratch buffer; it is let go ───
{
  const NativeArrayBuffer = globalThis.ArrayBuffer;
  const grown = [];
  globalThis.ArrayBuffer = class extends NativeArrayBuffer {
    constructor(...args) {
      super(...args);
      if (this.byteLength > 2 * 1024 * 1024) grown.push(new WeakRef(this));
    }
  };
  try {
    rewriteDynamicImports(source, parent, true);
  } finally {
    globalThis.ArrayBuffer = NativeArrayBuffer;
  }
  assert.ok(grown.length > 0, `a ${(source.length / 1024).toFixed(0)} KiB cell grows the lexer's scratch buffer past its initial 1 MiB`);
  rewriteDynamicImports("return import('./small.js');", parent);
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
  assert.equal(grown.filter((buffer) => buffer.deref() !== undefined).length, 0, 'and once the cell is lexed, nothing holds that buffer');
  console.log('  ok  the lexer does not keep the scratch buffer a large cell grew');
}

// ── The rewrite reads spans of the cell, not the cell ───────────────────────
{
  let tokens = 0;
  const nextToken = Parser.prototype.nextToken;
  Parser.prototype.nextToken = function () {
    tokens++;
    return Reflect.apply(nextToken, this, []);
  };
  let result;
  try {
    const service = new EsbuildService();
    result = await service.transform(source, { rewriteOnly: true, dynamicImportParent: parent, moduleMetadata: true });
  } finally {
    Parser.prototype.nextToken = nextToken;
  }
  // The catalog alone is some 30 tokens an entry.
  assert.ok(tokens < 1000, `Acorn read ${tokens} tokens of a cell of ${count * 30}`);
  {
    // A loader skips the hashbang line; so does this.
    const body = result.code.replace(/^#!/, '//');
    const { result: output } = await withProcessImport((specifier, from) => ({ from, specifier }),
      () => runCell(body, { module: { __nimbusImportMeta: { url: parent } } }));
    assert.deepEqual(output, {
      metadata: ['file:///home/user/bin/', 'parameter', 'escaped user binding'],
      viaMembers: ['object:a', 'class:b', 'object:c'],
      later: { from: parent, specifier: './later.js' },
      count,
      total: count * (count - 1) / 2,
    });
  }
  console.log(`  ok  a ${(source.length / 1024).toFixed(0)} KiB cell is rewritten from ${tokens} Acorn tokens, and runs`);
}
console.log('dynamic-import-rewrite-bounded OK');
