import assert from 'node:assert/strict';
import { PROVIDED_PACKAGE_HOOK, rewriteProvidedCommonJsModules } from '../../packages/core/src/runtime/provided-packages.ts';
import { lowerEsModule } from '../../packages/core/src/runtime/async-module-lowering.ts';

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
  const source = `import { __commonJS as wrap } from './helper.js';
    const load=wrap({"node_modules/undici/index.js"(e,m){throw new Error('native factory ran')}});
    export { load };`;
  const bound = rewriteProvidedCommonJsModules(source);
  const transformed = lowerEsModule(bound, 'node', 'file:///app/bundle.js');
  const require = (name) => {
    assert.equal(name, './helper.js');
    return { __commonJS() { throw new Error('factory was not externalized'); } };
  };
  const module = { exports: {}, require };
  new Function('exports', 'require', 'module', transformed.code)(module.exports, require, module);
  assert.equal(module.exports.load(), provided, 'an imported helper alias uses the same package binding');
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
// records are bound before it is lowered, as a session binds JavaScript's.
{
  const { generateTransformFacetRuntimeSource } = await import('../../packages/core/src/runtime/esbuild-service.ts');
  const { rewriteDynamicImports } = await import('../../packages/core/src/runtime/dynamic-import-rewrite.ts');
  const { lowerAsyncModule } = await import('../../packages/core/src/runtime/async-module-lowering.ts');
  const { runTransformRequest } = new Function(`${generateTransformFacetRuntimeSource()}\nreturn { runTransformRequest };`)();
  const typed = `${commonJs}
    const load = __commonJS({"node_modules/undici/index.js"(exports, module) { module.exports = { transport: 'native' }; }});
    export const transport: unknown = load();`;
  const runtime = {
    rewriteDynamicImports, lowerAsyncModule, lowerEsModule, rewriteProvidedCommonJsModules,
    stripTypeScript: async (code) => ({ code: code.replace(': unknown', '         '), format: 'module' }),
  };
  const options = { stripTypes: { mode: 'strip-only', sourceMap: false }, packageType: null, sourcefile: '/app/bundle.mts', dynamicImportParent: 'file:///app/bundle.mts' };
  const { code } = await runTransformRequest(null, typed, options, runtime);
  calls = [];
  const module = { exports: {} };
  new Function('exports', 'require', 'module', code)(module.exports, () => { throw new Error('no require'); }, module);
  assert.deepEqual(calls, ['undici']);
  assert.equal(module.exports.transport, provided, 'the stripped module runs the provided package');
}
console.log('bundled provided packages: stripped TypeScript is bound before it is lowered');
