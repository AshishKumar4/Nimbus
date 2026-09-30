import assert from 'node:assert/strict';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';

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
  // Where es-module-lexer can read a regex as code, or code as a regex, the
  // grammar decides.
  ['regexp after a block', "{}\n/import('fake')/.test('');\nreturn import('./x.mjs').then(m => m.value);", false, 7],
  ['regexp after ASI prefix increment', "var a = 6;\na\n++/import('fake')/.lastIndex;\nreturn import('./x.mjs').then(m => [a, m.value]);", false, [6, 7]],
  ['regexp class heritage', "class A extends /import('fake')/.constructor {}\nreturn import('./x.mjs').then(m => [A.name, m.value]);", false, ['A', 7]],
  ['quoted regexp after a block', "{}\n/[\"']/.test('x');\nreturn import('./x.mjs').then(m => m.value);", false, 7],
  ['HTML comment holding a quote', "<!-- it's\nreturn import('./x.mjs').then(m => m.value);", false, 7],
  ['identifier yield divides', "var yield = 8; const loaded = []; const ratio = yield / (loaded.push(import('./x.mjs')), 4) / 2; return Promise.all(loaded).then(([m]) => [ratio, m.value]);", false, [1, 7]],
  ['keyword member past a line break', "var o = { return: 6 };\nconst loaded = [];\nconst ratio = o.\nreturn / (loaded.push(import('./x.mjs')), 3) / 2;\nreturn Promise.all(loaded).then(([m]) => [ratio, m.value]);", false, [1, 7]],
  ['method with its brace on the next line', "class Loader {\n  import(id)\n  {\n    return 'method:' + id;\n  }\n  static kind = 'loader';\n}\nreturn import('./x.mjs').then(m => [new Loader().import('a'), m.value]);", false, ['method:a', 7]],
];
const failures = [];
for (const [label, source, metadata, expected] of cases) {
  const calls = [];
  globalThis.__nimbusDynamicImport = async (from, name) => {
    calls.push([from, name]);
    return { value: 7 };
  };
  try {
    const wrapped = new Function('exports', 'require', 'module', rewriteDynamicImports(source, parent, metadata));
    assert.deepEqual(await wrapped({}, undefined, { __nimbusImportMeta: { url: parent } }), expected);
    assert.deepEqual(calls, metadata ? [] : [[parent, './x.mjs']], 'imports resolve through the process, not the host loader');
  } catch (e) { failures.push(`${label}: ${e.message}`); }
  finally { delete globalThis.__nimbusDynamicImport; }
}
assert.deepEqual(failures, []);
// `new import(...)` stays the syntax error it is, not a constructor call.
assert.throws(() => new Function(rewriteDynamicImports("return new import('./x.mjs');", parent)), SyntaxError);
// Tokenization can also succeed while hiding the import inside a false regex
// token; detecting only thrown tokenizer errors would still miss this case.
const seen = [];
globalThis.__nimbusDynamicImport = async (from, name) => {
  seen.push([from, name]);
  return { valueOf() { return 2; } }; // an ESM namespace exporting valueOf
};
try {
  const source = 'const api={if(){return 6}}; return api.if()/await import("virtual")/2;';
  const AsyncFunction = (async function () {}).constructor;
  assert.equal(await new AsyncFunction(rewriteDynamicImports(source, parent))(), 1.5);
  assert.deepEqual(seen, [[parent, 'virtual']]);
} finally { delete globalThis.__nimbusDynamicImport; }
console.log('dynamic-import-context: grammar-sensitive imports preserve process resolution');
