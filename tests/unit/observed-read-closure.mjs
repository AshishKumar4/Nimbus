#!/usr/bin/env bun
// A module learned from a missed read brings its own transitive imports into
// the next launch. Walking an empty entry instead of its text admitted only
// the module itself, making Vinext fail on one sibling file per launch.
import assert from 'node:assert/strict';
import { addObservedReads, buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
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
// A file an earlier run READ is data, whatever its extension: Tailwind v3
// scans .js/.ts content files as text. Rooting it walked its imports into the
// required graph, and a launch over the bound failed every time after.
{
  const scanned = await buildPrefetchBundle(bounded, { scriptPath: '/' + app + '/entry.cjs', cwd: '/' + app, entryCode: 'module.exports = 1;', observedReads: new Set([learned]), maxBundleBytes: 1024 });
  assert.equal(scanned.bundle[learned], small, 'the read file is staged as the bytes it was read as');
  assert.equal(scanned.bundle[app + '/node_modules/plugin/dep.cjs'], undefined, 'its imports are not required');
}
// A learned executable graph that cannot fit is never published with a
// missing import: it is staged whole or not at all, and the launch starts
// without it (learned-roots-over-bound.mjs), loading it late as the run that
// learned it did.
{
  const over = await buildPrefetchBundle(bounded, { scriptPath: '/' + app + '/entry.cjs', cwd: '/' + app, entryCode: 'module.exports = 1;', maxBundleBytes: 1024, executedModules: [{ path: learned }] });
  assert.equal(over.bundle[learned], undefined, 'a learned module whose closure cannot fit is not staged');
  assert.equal(over.bundle[app + '/node_modules/plugin/dep.cjs'], undefined, 'nor any of its closure');
}
const complete = await buildPrefetchBundle(bounded, { scriptPath: '/' + app + '/entry.cjs', cwd: '/' + app, entryCode: 'module.exports = 1;', maxBundleBytes: 4096, executedModules: [{ path: learned }] });
const evaluate = filename => {
  const module = { exports: {} };
  const code = complete.bundle[filename];
  assert.equal(typeof code, 'string', 'every executed dependency is present');
  new Function('module', 'require', code)(module, () => evaluate(app + '/node_modules/plugin/dep.cjs'));
  return module.exports;
};
assert.equal(evaluate(learned), 'x'.repeat(2048), 'the fitting learned graph executes its actual transitive dependency');
const generatedPath = 'home/user/generated/config.timestamp-1.cjs';
const dependencyPath = 'opt/runtime-plugin/deep/plugin.cjs';
const generatedText = 'import plugin from "file:///opt/runtime-plugin/deep/plugin.cjs"; export default plugin;';
const generatedFs = launchFs({ [dependencyPath]: 'module.exports = "loaded-from-generated-config";' }).fs;
const generated = await buildPrefetchBundle(generatedFs, { cwd: '/home/user/generated', entryCode: '', maxBundleBytes: 4096, executedModules: [{ path: generatedPath, text: generatedText }] });
assert.equal(generated.bundle[dependencyPath], 'module.exports = "loaded-from-generated-config";',
  'a deleted temporary config still brings the imports of its retained executable source');
console.log('observed-read-closure: ok');
