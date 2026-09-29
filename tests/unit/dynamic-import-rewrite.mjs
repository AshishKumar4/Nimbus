#!/usr/bin/env bun
// A module cell's dynamic import() is the process's: lexical import calls
// become calls of the process's ESM loader with the
// module's URL, and nothing that only looks like one changes (a string, a
// template's text, a comment, a regex, `import.meta`, a member or method
// named import). The rewrite runs where the ESM→CJS transform runs: in
// esbuild's facet, through runTransformRequest, which is what is checked
// here over the service's in-isolate path, which runs the same function.

import assert from 'node:assert/strict';

import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';

const parent = 'file:///home/user/app/lib/mod.js';


// What the rewritten code does: every call carries the parent, the specifier
// and the options as the program wrote them, evaluated in its order.
{
  const source = `
const quoted = 'await import("node:fs")';
const template = \`import("\${await import('./in-template.js')}")\`;
// import('./in-comment.js')
const pattern = /import\\("x"\\)/;
const meta = typeof import.meta;
const api = { import(id) { return 'method:' + id; } };
const viaMember = api.import('./member.js');
const viaOptional = api?.import('./optional.js');
const computed = './' + 'computed.js';
const loaded = [
  await import('node:http'),
  await import /* c */ (computed),
  await import('./data.json', { with: { type: 'json' } }),
  await import(await import('./nested.js')),
];
return { quoted, template, pattern: String(pattern), viaMember, viaOptional, loaded };
`;
  const rewritten = rewriteDynamicImports(source, parent);
  const calls = [];
  globalThis.__nimbusDynamicImport = async (from, specifier, options) => {
    calls.push(options === undefined ? [from, specifier] : [from, specifier, options]);
    return `ns:${specifier}`;
  };
  try {
    // `import.meta` is only valid in a module, so it stands in for itself.
    const body = rewritten.replace('typeof import.meta', "'meta'");
    const result = await new Function(`return (async () => {${body}})();`)();
    assert.equal(result.quoted, 'await import("node:fs")', 'a string is text');
    assert.equal(result.template, 'import("ns:./in-template.js")', "a template's text is text, its expression code");
    assert.equal(result.pattern, '/import\\("x"\\)/', 'a regex is text');
    assert.equal(result.viaMember, 'method:./member.js', 'a member named import is not an import');
    assert.equal(result.viaOptional, 'method:./optional.js');
    assert.deepEqual(result.loaded, ['ns:node:http', 'ns:./computed.js', 'ns:./data.json', 'ns:ns:./nested.js']);
    assert.deepEqual(calls, [
      [parent, './in-template.js'],
      [parent, 'node:http'],
      [parent, './computed.js'],
      [parent, './data.json', { with: { type: 'json' } }],
      [parent, './nested.js'],
      [parent, 'ns:./nested.js'],
    ]);
  } finally {
    delete globalThis.__nimbusDynamicImport;
  }
}

// Methods named import can contain real imports in their default parameters.
{
  const source = [
    'const api = { import(value = import("./default.js")) { return value; } };',
    'const ratio = 12 / 3 / 2;',
    'class Loader { static import(value = import("./class.js")) { return value; } }',
    'return Promise.all([api.import(), Loader.import(), import(`./${ratio}.js`)]);',
  ].join('\n');
  const calls = [];
  globalThis.__nimbusDynamicImport = async (from, spec) => { calls.push([from, spec]); return spec; };
  try {
    const result = await new Function(rewriteDynamicImports(source, parent))();
    assert.deepEqual(result, ['./default.js', './class.js', './2.js']);
    assert.deepEqual(calls, result.map(spec => [parent, spec]));
  } finally { delete globalThis.__nimbusDynamicImport; }
}

// Token traversal must still see later bindings, nested syntax
// and directives before choosing its metadata capture name.
{
  const source = `"use strict";
class Reader {
  #url = import.meta['url'];
  read() { return this.#url; }
}
function later(__nimbusMetadataModule_) { return [import.meta.url, __nimbusMetadataModule_]; }
const __nimbusMetadataModule = 'user binding';
const { url } = import.meta;
return [new Reader().read(), later('argument'), url, __nimbusMetadataModule,
  (function () { return this; })() === undefined];`;
  const rewritten = rewriteDynamicImports(source, parent, true);
  const execute = new Function('exports', 'require', 'module', rewritten);
  assert.deepEqual(execute({}, () => {}, { __nimbusImportMeta: { url: parent } }),
    [parent, [parent, 'argument'], parent, 'user binding', true]);
}

// A script the parse refuses is returned as written, for the compile to report.
assert.equal(rewriteDynamicImports('import(', parent), 'import(');
// Code with no import() is returned as is, unparsed.
assert.equal(rewriteDynamicImports('const x = 1;', parent), 'const x = 1;');

// Pure JavaScript rewriting needs no wasm engine, even on a host where one
// was never configured. Exercise metadata through both public entry points.
{
  const service = new EsbuildService();
  const options = { rewriteOnly: true, dynamicImportParent: parent, moduleMetadata: true };
  const single = await service.transform('return import.meta.url;', options);
  const [batch] = await service.transformMany([{ code: 'return import.meta["resolve"]("./value");', options }]);
  const module = { __nimbusImportMeta: { url: parent, resolve: path => new URL(path, parent).href } };
  assert.equal(new Function('exports', 'require', 'module', single.code)({}, null, module), parent);
  assert.equal(new Function('exports', 'require', 'module', batch.code)({}, null, module), 'file:///home/user/app/lib/value');
}


console.log('dynamic-import-rewrite: every ImportExpression, and nothing else, goes to the process loader');
