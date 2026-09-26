#!/usr/bin/env bun
// A module cell's dynamic import() is the process's: each ImportExpression, as
// acorn parses it, becomes a call of the process's ESM loader with the
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
    assert.doesNotMatch(rewritten, /in-comment\.js'\)[^\n]*__nimbus/, 'a comment is untouched');
    assert.match(rewritten, /\/\/ import\('\.\/in-comment\.js'\)/);
  } finally {
    delete globalThis.__nimbusDynamicImport;
  }
}

// A script the parse refuses is returned as written, for the compile to report.
assert.equal(rewriteDynamicImports('import(', parent), 'import(');
// Code with no import() is returned as is, unparsed.
assert.equal(rewriteDynamicImports('const x = 1;', parent), 'const x = 1;');

// Through the transform: esbuild keeps the dynamic import (it no longer
// lowers a literal one to require) and the rewrite routes it; a CommonJS cell
// goes through the rewrite alone.
{
  // esbuild itself, native, standing in for the wasm build the facet runs.
  const service = new EsbuildService();
  service.ensureInit = async () => {};
  service._esbuild = await import('esbuild');
  const [esm, cjs, plain] = await service.transformMany([
    { code: 'export const load = () => import("./x.js");', options: { loader: 'js', format: 'cjs', dynamicImportParent: parent } },
    { code: 'exports.load = () => import("./x.js");', options: { rewriteOnly: true, dynamicImportParent: parent } },
    { code: 'export const load = () => import("./x.js");', options: { loader: 'js', format: 'cjs' } },
  ]);
  assert.match(esm.code, /__nimbusDynamicImport\("file:\/\/\/home\/user\/app\/lib\/mod\.js", "\.\/x\.js"\)/);
  assert.doesNotMatch(esm.code, /require\("\.\/x\.js"\)/, 'not lowered to require');
  assert.equal(cjs.code, `exports.load = () => __nimbusDynamicImport(${JSON.stringify(parent)}, "./x.js");`);
  assert.doesNotMatch(plain.code, /__nimbusDynamicImport/, 'no parent: esbuild lowers it as before');
}

console.log('dynamic-import-rewrite: every ImportExpression, and nothing else, goes to the process loader');
