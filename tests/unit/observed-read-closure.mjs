#!/usr/bin/env bun
// A module learned from a missed read brings its own transitive imports into
// the next launch. Walking an empty entry instead of its text admitted only
// the module itself, making Vinext fail on one sibling file per launch.
import assert from 'node:assert/strict';
import { addObservedReads } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';
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
console.log('observed-read-closure: ok');
