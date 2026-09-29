import assert from 'node:assert/strict';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';

const parent = 'file:///home/user/app/main.cjs';
const cases = [
  ['member-keyword division', 'const api={if(){return 6}}; const ratio=api.if()/2; return import("./x.mjs").then(m => [ratio,m.value]);', false, [3, 7]],
  ['member-keyword metadata', 'const api={if(){return 6}}; const ratio=api.if()/2; return [ratio,import.meta.url];', true, [3, parent]],
  ['sloppy CommonJS octal', 'const mode=0644; return import("./x.mjs").then(m => [mode,m.value]);', false, [420, 7]],
  ['ASI block after import', 'return import("./x.mjs")\n{}', false, {value: 7}],
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
