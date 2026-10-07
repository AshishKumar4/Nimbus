import assert from 'node:assert/strict';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { runCell, withProcessImport } from './lib/process-import.mjs';

const parent = 'file:///home/user/app/main.cjs';
const cases = [
  ['member-keyword division', 'const api={if(){return 6}}; const ratio=api.if()/2; return import("./x.mjs").then(m => [ratio,m.value]);', false, [3, 7]],
  ['member-keyword metadata', 'const api={if(){return 6}}; const ratio=api.if()/2; return [ratio,import.meta.url];', true, [3, parent]],
  ['sloppy CommonJS octal', 'const mode=0644; return import("./x.mjs").then(m => [mode,m.value]);', false, [420, 7]],
  ['ASI block after import', 'return import("./x.mjs")\n{}', false, {value: 7}],
  ["await regexp","async function f(){return await /import(\"fake\")/.test('import\"fake\"');} return import('./x.mjs').then(f);",false,true],
  ["yield regexp","function* f(){yield /import(\"fake\")/.test('import\"fake\"');} return import('./x.mjs').then(() => f().next().value);",false,true],
  ["template expression regexp","return import(\"./x.mjs\").then(async m => `value:${await /import(\"fake\")/.test('import\"fake\"')}:${m.value}`);",false,"value:true:7"],
  ["comments and escaped regex","/* import('fake') */ const literal = /import\\(\"fake\"\\)/; // import('fake')\nreturn import(/* import('fake') */ './x.mjs').then(m => [literal.test('import(\"fake\")'), m.value]);",false,[true,7]],
  ['grouped import argument', 'return import(("./x.mjs")).then(m => m.value);', false, 7],
  ['method with its brace on the next line', "class Loader {\n  import(id)\n  {\n    return 'method:' + id;\n  }\n  static kind = 'loader';\n}\nreturn import('./x.mjs').then(m => [new Loader().import('a'), m.value]);", false, ['method:a', 7]],
];
const failures = [];
for (const [label, source, metadata, expected] of cases) {
  try {
    const { result, calls } = await withProcessImport(() => ({ value: 7 }),
      () => runCell(rewriteDynamicImports(source, parent, metadata), { module: { __nimbusImportMeta: { url: parent } } }));
    assert.deepEqual(result, expected);
    assert.deepEqual(calls, metadata ? [] : [[parent, './x.mjs']], 'imports resolve through the process, not the host loader');
  } catch (e) { failures.push(`${label}: ${e.message}`); }
}
assert.deepEqual(failures, []);
// Tokenization can also succeed while hiding the import inside a false regex
// token; detecting only thrown tokenizer errors would still miss this case.
{
  const source = 'const api={if(){return 6}}; return api.if()/await import("virtual")/2;';
  const AsyncFunction = (async function () {}).constructor;
  // An ESM namespace exporting valueOf.
  const { result, calls } = await withProcessImport(() => ({ valueOf() { return 2; } }),
    () => new AsyncFunction(rewriteDynamicImports(source, parent))());
  assert.equal(result, 1.5);
  assert.deepEqual(calls, [[parent, 'virtual']]);
}
console.log('dynamic-import-context: grammar-sensitive imports preserve process resolution');
