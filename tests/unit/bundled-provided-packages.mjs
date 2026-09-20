import assert from 'node:assert/strict';
import { rewriteBundledEsmToCjs, rewriteProvidedCommonJsModules } from '../../packages/core/src/runtime/esbuild-service.ts';

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
function execute(source) {
  const calls = [];
  const require = name => {
    calls.push(name);
    assert.equal(name, 'undici');
    return provided;
  };
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
  const transformed = rewriteBundledEsmToCjs(bound, 'file:///app/bundle.js');
  assert.ok(transformed);
  const require = name => name === './helper.js' ? { __commonJS() { throw new Error('factory was not externalized'); } } : provided;
  const module = { exports: {}, require };
  new Function('module', 'exports', 'require', transformed.code)(module, module.exports, require);
  assert.equal(module.exports.load(), provided, 'an imported helper alias uses the same package binding');
}

{
  const source = `${commonJs}; const load=__commonJS({"node_modules/undici/index.js"(e,m){m.exports='native'},}); module.exports=load();`;
  assert.equal(execute(rewriteProvidedCommonJsModules(source)).exports, provided, 'a trailing comma is valid module metadata');
}
console.log('bundled provided packages: scoped binding, identity, aliases, syntax boundaries, and private subpaths pass');
