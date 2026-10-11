// Bundled CommonJS factories for provided packages are rebound to the runtime
// hook, including imported helper aliases and stripped native ES modules.
import assert from 'node:assert/strict';
import { PROVIDED_PACKAGE_HOOK, rewriteProvidedCommonJsModules } from '../../packages/core/src/runtime/provided-packages.ts';

const commonJs = `const __commonJS = init => {
  let cached;
  return () => {
    if (!cached) {
      cached = { exports: {} };
      Object.values(init)[0](cached.exports, cached);
    }
    return cached.exports;
  };
};`;
const provided = { transport: 'provided' };
// A bound record calls the runtime's hook, not the module's require (an ES
// module has none): the shims' hook is require's answer for the package.
let calls = [];
globalThis[PROVIDED_PACKAGE_HOOK] = (name) => {
  calls.push(name);
  assert.equal(name, 'undici');
  return provided;
};
function execute(source) {
  calls = [];
  const require = () => { throw new Error('a bound record does not call the module\'s require'); };
  const module = { exports: {}, require };
  new Function('module', 'exports', 'require', source)(module, module.exports, require);
  return { exports: module.exports, calls };
}

for (const label of ['node_modules/undici/index.js', 'node_modules/owner/node_modules/undici/index.js']) {
  const source = `${commonJs}
    const load = __commonJS({${JSON.stringify(label)}(exports, module) {
      const pattern = /["')]/;
      const template = \`ignored \${')'}\`;
      module.exports = { transport: 'native' };
    }});
    module.exports = [load(), load()];`;
  assert.equal(execute(source).exports[0].transport, 'native', 'the bundled factory bypasses ordinary require');
  const result = execute(rewriteProvidedCommonJsModules(source));
  assert.deepEqual(result.calls, ['undici', 'undici']);
  assert.equal(result.exports[0], provided);
  assert.equal(result.exports[1], provided, 'repeated loads preserve the runtime module identity');
}

for (const label of ['node_modules/other/index.js', 'node_modules/undici/lib/core/util.js', 'undici/index.js']) {
  const source = `${commonJs}; const load=__commonJS({${JSON.stringify(label)}(e,m){m.exports=42}}); module.exports=load();`;
  assert.equal(rewriteProvidedCommonJsModules(source), source, 'unprovided modules and private subpaths stay untouched');
  assert.equal(execute(source).exports, 42);
}

for (const source of [
  `const text = '__commonJS({"node_modules/undici/index.js"(e,m){}})';`,
  String.raw`const pattern = /__commonJS\(\{"node_modules\/undici\/index.js"/;`,
  `const load = __commonJS({"node_modules/undici/index.js"(e,m){}, other(){}});`,
  `const load = __commonJS({"node_modules/undici/index.js"(e,m){}}, cached);`,
  `const load = object.__commonJS({"node_modules/undici/index.js"(e,m){}});`,
]) {
  assert.equal(rewriteProvidedCommonJsModules(source), source, 'text, unrelated calls and ambiguous records are preserved');
}

{
  const helper = 'data:text/javascript,' + encodeURIComponent('export function __commonJS() { throw new Error("factory was not externalized"); }');
  const source = `import { __commonJS as wrap } from ${JSON.stringify(helper)};
    const load=wrap({"node_modules/undici/index.js"(e,m){throw new Error('native factory ran')}});
    export { load };`;
  const bound = rewriteProvidedCommonJsModules(source);
  const module = await import('data:text/javascript,' + encodeURIComponent(bound));
  assert.equal(module.load(), provided, 'an imported helper alias uses the same package binding');
}

{
  const source = `${commonJs}; const load=__commonJS({"node_modules/undici/index.js"(e,m){m.exports='native'},}); module.exports=load();`;
  assert.equal(execute(rewriteProvidedCommonJsModules(source)).exports, provided, 'a trailing comma is valid module metadata');
}
{
  // @babel/types' generated builders: a member named import/export at top level.
  const source = `"use strict";\nexports.import = _import;\nexports.export = _export;\nfunction _import() {}\nfunction _export() {}`;
  assert.equal(rewriteProvidedCommonJsModules(source), source, 'a member named import or export is not a declaration');
}
console.log('bundled provided packages: scoped binding, identity, aliases, syntax boundaries, and private subpaths pass');

// Stripped TypeScript is JavaScript to the transform facet: its bundled
// records are bound before it is staged natively, as a session binds JavaScript's.
{
  const { generateTransformFacetRuntimeSource } = await import('../../packages/core/src/runtime/esbuild-service.ts');
  const { rewriteDynamicImports } = await import('../../packages/core/src/runtime/dynamic-import-rewrite.ts');
  const { readEsModule } = await import('../../packages/core/src/runtime/native-esm.ts');
  const { parseJavaScriptModule } = await import('../../packages/core/src/runtime/javascript-ast.ts');
  const { runTransformRequest } = new Function(`${generateTransformFacetRuntimeSource()}\nreturn { runTransformRequest };`)();
  const typed = `${commonJs}
    const load = __commonJS({"node_modules/undici/index.js"(exports, module) { module.exports = { transport: 'native' }; }});
    export const transport: unknown = load();`;
  const stripped = typed.replace(': unknown', '         ');
  const bound = rewriteProvidedCommonJsModules(stripped);
  assert.notEqual(bound, stripped, 'premise: the stripped fixture has a provided-package record to bind');
  const runtime = {
    rewriteDynamicImports, readEsModule, rewriteProvidedCommonJsModules,
    stripTypeScript: async (code) => {
      assert.equal(code, typed, 'the strip receives the original TypeScript');
      return { code: stripped, format: 'module' };
    },
  };
  const options = { stripTypes: { mode: 'strip-only', sourceMap: false }, packageType: null, sourcefile: '/app/bundle.mts', dynamicImportParent: 'file:///app/bundle.mts' };
  const { code, map, esModule } = await runTransformRequest(null, typed, options, runtime);
  assert.equal(esModule, 'node');
  assert.equal(JSON.parse(map).moduleSyntax, true);
  assert.equal(code, bound, 'the native staged source binds the stripped record before reading its import sites');
  // The subject is the pipeline's record binding, not Bun's data-URL loader.
  // Run this fixture's exported declaration as an initializer, using its AST
  // range rather than changing any other source text or lowering a module.
  const exported = parseJavaScriptModule(code).body.find((statement) => statement.type === 'ExportNamedDeclaration');
  assert.equal(exported.declaration.type, 'VariableDeclaration');
  const initializer = code.slice(0, exported.start) + code.slice(exported.declaration.start, exported.declaration.end);
  calls = [];
  const transport = new Function(initializer + '\nreturn transport;')();
  assert.deepEqual(calls, ['undici']);
  assert.equal(transport, provided, 'the stripped initializer runs the provided package');
}
console.log('bundled provided packages: stripped TypeScript is bound before it is staged natively');
