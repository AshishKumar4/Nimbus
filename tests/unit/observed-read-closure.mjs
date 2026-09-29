#!/usr/bin/env bun
// A module learned from a missed read brings its own transitive imports into
// the next launch. Walking an empty entry instead of its text admitted only
// the module itself, making Vinext fail on one sibling file per launch.
import assert from 'node:assert/strict';
import { addObservedReads, buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';
import { ClosureBoundExceededError } from '../../packages/core/src/runtime/require-resolver.ts';
const root='home/user/app/node_modules/plugin';
const files={
  [root+'/package.json']:JSON.stringify({name:'plugin',type:'module'}),
  [root+'/main.js']:'export { value } from "./one.js";',
  [root+'/one.js']:'import { base } from "./two.js"; export const value = base + 1;',
  [root+'/two.js']:'export const base = 40;',
  [root+'/unused.js']:'throw new Error("unreachable");',
};
const bundle={};const required=new Set();
await addObservedReads(launchFs(files).fs,new Set([root+'/main.js']),bundle,required,{totalBytes:0,fileCount:0});
for(const name of ['main.js','one.js','two.js']) {
  assert.equal(bundle[root+'/'+name],files[root+'/'+name],name+' is available to the next launch');
  assert.ok(required.has(root+'/'+name),name+' cannot be evicted as speculative data');
}
assert.equal(bundle[root+'/unused.js'],undefined,'learning one module does not pull in unrelated package files');

const app = 'home/user/bounded';
const learned = app + '/node_modules/plugin/learned.cjs';
const small = 'module.exports = require("./dep.cjs");';
const large = 'module.exports = ' + JSON.stringify('x'.repeat(2048)) + ';';
const bounded = launchFs({
  [app + '/package.json']: '{"name":"app"}',
  [app + '/entry.cjs']: 'module.exports = 1;',
  [app + '/node_modules/plugin/package.json']: '{"name":"plugin","main":"index.cjs"}',
  [app + '/node_modules/plugin/index.cjs']: 'module.exports = 0;',
  [learned]: small,
  [app + '/node_modules/plugin/dep.cjs']: large,
}).fs;
await assert.rejects(
  buildPrefetchBundle(bounded, '/' + app + '/entry.cjs', '/' + app, 'module.exports = 1;',
    undefined, undefined, new Set([learned]), undefined, 1024),
  error => error instanceof ClosureBoundExceededError && error.outcome.lastPath === app + '/node_modules/plugin/dep.cjs',
  'a learned executable graph that cannot fit is refused, never published with a missing import',
);
const complete = await buildPrefetchBundle(bounded, '/' + app + '/entry.cjs', '/' + app, 'module.exports = 1;',
  undefined, undefined, new Set([learned]), undefined, 4096);
const evaluate = filename => {
  const module = { exports: {} };
  const code = complete.bundle[filename];
  assert.equal(typeof code, 'string', 'every executed dependency is present');
  new Function('module', 'require', code)(module, () => evaluate(app + '/node_modules/plugin/dep.cjs'));
  return module.exports;
};
assert.equal(evaluate(learned), 'x'.repeat(2048), 'the fitting learned graph executes its actual transitive dependency');
console.log('observed-read-closure: ok');
