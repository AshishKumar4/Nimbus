#!/usr/bin/env bun
// A module cell's dynamic import() is the process's: each ImportExpression, as
// acorn parses it, becomes a call of the process's ESM loader with the
// module's URL, and nothing that only looks like one changes (a string, a
// template's text, a comment, a regex, `import.meta`, a member or method
// named import). The rewrite runs where the ESM→CJS transform runs: in
// esbuild's facet, through runTransformRequest, which is what is checked
// here over the service's in-isolate path, which runs the same function.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';

const parent = 'file:///home/user/app/lib/mod.js';
const coreRequire = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { parse } = coreRequire('acorn');
const { full } = coreRequire('acorn-walk');

// Full-tree reference for the streaming parser's externally visible edits:
// positions, captured binding name, directives and syntax rejection.
function reference(source) {
  let ast;
  for (const sourceType of ['module', 'script']) {
    try { ast = parse(source, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true }); break; } catch {}
  }
  if (!ast) return source;
  const edits = [], metas = [], names = new Set();
  full(ast, node => {
    if (node.type === 'Identifier') names.add(node.name);
    if (node.type === 'ImportExpression') edits.push({ start: node.start, end: node.source.start, text: `__nimbusDynamicImport(${JSON.stringify(parent)}, ` });
    if (node.type === 'MetaProperty' && node.meta.name === 'import') metas.push({ start: node.start, end: node.end });
  });
  if (metas.length) {
    let binding = '__nimbusMetadataModule';
    while (names.has(binding)) binding += '_';
    for (const span of metas) edits.push({ ...span, text: `${binding}.__nimbusImportMeta` });
    let at = ast.body[0]?.start ?? 0;
    for (const statement of ast.body) { if (typeof statement.directive !== 'string') break; at = statement.end; }
    edits.push({ start: at, end: at, text: `\n"use strict";\nconst ${binding} = arguments[2];\n` });
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let at = 0, result = '';
  for (const edit of edits) { result += source.slice(at, edit.start) + edit.text; at = edit.end; }
  return result + source.slice(at);
}
for (const source of [
  'export { value }; const value = import.meta.url; const __nimbusMetadataModule = 0;',
  '"use strict"; "another directive"; const f = async (__nimbusMetadataModule_) => import(await import("x")); const __nimbusMetadataModule = import.meta["url"];',
  'class Reader { #x = import.meta.url; method() { return import("x", {with:{type:"json"}}); } } export {Reader};',
  'export const x = import.meta.url; export {x};', // duplicate export
  'export {missing}; import("x");', // unresolved forward export
  'const duplicate = 1; let duplicate = import.meta.url;',
  'function broken( { return import("x");',
  '#!/usr/bin/env node\n"use strict"; import(import.meta.url);',
]) assert.equal(rewriteDynamicImports(source, parent, true), reference(source), 'streamed statement parsing preserves full-parser edits and syntax checks');

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

// Statement-at-a-time parsing must still see later bindings, nested syntax
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
