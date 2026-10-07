#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { oxcEngine } from './lib/oxc-engine.mjs';
import { prefetchForRequire, requireFsOverBridge } from '../../packages/core/src/runtime/require-resolver.ts';
import { buildPrefetchBundle, greedyAddMainEntries } from '../../packages/worker/src/facets/manager.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { TurnBudget } from '../../packages/fabric/src/turn-budget.ts';
import { launchFs } from './lib/launch-fs.mjs';

const APP = 'home/user/app';
const P = APP + '/node_modules/pkg';
const bytes = s => Buffer.byteLength(s);
const base = {
  [APP + '/package.json']: '{"dependencies":{"pkg":"1"}}',
  [P + '/package.json']: '{"name":"pkg","main":"source/index.cjs"}',
  [P + '/source/index.cjs']: 'module.exports = require("./child.cjs");',
  [P + '/source/child.cjs']: 'module.exports = require("./deep.cjs");',
  [P + '/source/deep.cjs']: 'require("./child.cjs"); module.exports = 42;',
};
async function walk(world, root, held = {}, allowance = 10000, files = 100, progress) {
  return prefetchForRequire(requireFsOverBridge(world.fs), '', root.slice(0,root.lastIndexOf('/')), root,
    10000, progress, {purpose:'dependency-closure',held,maxAdditionalBytes:allowance,maxAdditionalFiles:files});
}

// Resolved dependency content is atomic, while unavailable specifiers remain runtime failures.
{
  const world = launchFs(base);
  const bundle = {};
  await greedyAddMainEntries(world.fs, '/' + APP, bundle, {totalBytes:0,fileCount:0});
  assert.equal(bundle[P + '/source/deep.cjs'], base[P + '/source/deep.cjs']);
  const total = Object.entries(base).filter(([path])=>path!==APP+'/package.json').reduce((n,[,s])=>n+bytes(s),0);
  const rejected = {};
  const rejectedBudget = {totalBytes:0,fileCount:0};
  await greedyAddMainEntries(world.fs, '/' + APP, rejected, rejectedBudget, new Set(), {maxBundleBytes:total-1});
  assert.equal(rejected[P + '/source/index.cjs'], undefined);
  assert.equal(rejected[P + '/source/child.cjs'], undefined);
  assert.equal(rejected[P + '/source/deep.cjs'], undefined);
  assert.deepEqual(rejected,{[P+'/package.json']:base[P+'/package.json']},'independently admitted resolution metadata survives a declined code group');
  assert.deepEqual(rejectedBudget,{totalBytes:bytes(base[P+'/package.json']),fileCount:1},'retained metadata is charged once, not with the discarded delta');
}

// Metadata alone can consume the remaining bytes, and is rejected before its read.
{
  const world = launchFs({...base,[P+'/package.json']: JSON.stringify({name:'pkg',padding:'x'.repeat(500)})});
  const result = await walk(world, P+'/source/index.cjs', {}, bytes(base[P+'/source/index.cjs'])+10);
  assert.equal(result.kind,'dependency-closure-declined');
  assert.equal(result.path,P+'/package.json');
  assert.equal(result.reason,'bytes');
  assert.equal(world.reads.includes(P+'/package.json'),false);
}

// The size guard observes resumed metadata and verifies actual returned bytes.
{
  const root=P+'/source/index.cjs';
  const world=launchFs(base);
  let grew=false;
  const pacer=new TurnBudget({async nextTurn(){if(!grew){grew=true;await world.fs.writeFile(root,'x'.repeat(512));}}},1);
  const result=await walk(world,root,{},64,100,work=>pacer.spend(work));
  pacer.settle();
  assert.equal(result.kind,'dependency-closure-declined');
  assert.equal(result.path,root);
  assert.equal(world.reads.includes(root),false,'current stat is checked after the scheduling checkpoint');
  const fs=requireFsOverBridge(launchFs({[root]:'é'.repeat(64)}).fs);
  fs.stat=()=>null;
  const actual=await prefetchForRequire(fs,'',P+'/source',root,10000,undefined,
    {purpose:'dependency-closure',held:{},maxAdditionalBytes:100,maxAdditionalFiles:100});
  assert.deepEqual(actual,{kind:'dependency-closure-declined',path:root,reason:'bytes'},'actual UTF-8 bytes are checked when stat supplied no size');
}

// Already paid-for cells remain traversal roots: only missing bytes/files spend allowance.
{
  const world = launchFs(base);
  const held = {[P+'/source/index.cjs']:base[P+'/source/index.cjs'],[P+'/package.json']:base[P+'/package.json'],[P+'/source/child.cjs']:base[P+'/source/child.cjs']};
  const result = await walk(world,P+'/source/index.cjs',held,bytes(base[P+'/source/deep.cjs']),1);
  assert.equal(result.kind,undefined);
  assert.equal(result.bundle[P+'/source/deep.cjs'],base[P+'/source/deep.cjs']);
  assert.equal(world.reads.includes(P+'/source/child.cjs'),false);
  assert.deepEqual(held,{[P+'/source/index.cjs']:base[P+'/source/index.cjs'],[P+'/package.json']:base[P+'/package.json'],[P+'/source/child.cjs']:base[P+'/source/child.cjs']});
}

// ESM re-exports and literal cross-package edges use the existing nested resolver.
{
  const root=P+'/source/index.mjs';
  const world=launchFs({
    [P+'/package.json']:JSON.stringify({name:'pkg',dependencies:{unused:'1'}}),
    [root]:'export { value } from "./child.mjs";',
    [P+'/source/child.mjs']:'import "./grandchild.js"; export const value=42;',
    [P+'/source/grandchild.js']:'module.exports=require("leaf");',
    [P+'/node_modules/leaf/package.json']:'{"name":"leaf","main":"index.cjs"}',
    [P+'/node_modules/leaf/index.cjs']:'module.exports=42;',
    [APP+'/node_modules/leaf/package.json']:'{"name":"leaf","main":"wrong.cjs"}',
    [APP+'/node_modules/leaf/wrong.cjs']:'throw Error("wrong placement");',
  });
  const result=await walk(world,root);
  assert.equal(result.kind,undefined);
  assert.equal(result.bundle[P+'/node_modules/leaf/index.cjs'],'module.exports=42;');
  assert.equal(result.bundle[P+'/source/grandchild.js'],'module.exports=require("leaf");');
  assert.equal(result.bundle[APP+'/node_modules/leaf/wrong.cjs'],undefined);
}

// A guessed module's dynamic import is not an entry-program deferral.
{
  const world=launchFs({...base,[P+'/source/index.cjs']:'module.exports=()=>import("./lazy.js");',[P+'/source/lazy.js']:'export default 42;'});
  const result=await walk(world,P+'/source/index.cjs');
  assert.equal(result.kind,undefined);
  assert.equal(result.bundle[P+'/source/lazy.js'],undefined);
  assert.equal(world.reads.includes(P+'/source/lazy.js'),false);
}

// Scheduling failure while staging metadata retains identity, with no publication.
{
  const world=launchFs(base), bundle={};
  const failure=new Error('metadata turn cancelled');
  const pacer=new TurnBudget({async nextTurn(){throw failure;}},1);
  await assert.rejects(greedyAddMainEntries(world.fs,'/'+APP,bundle,{totalBytes:0,fileCount:0},new Set(),{pacer}),e=>e===failure);
  assert.equal(bundle[P+'/source/index.cjs'],undefined);
  assert.equal(bundle[P+'/source/child.cjs'],undefined);
  pacer.settle();
}

// Denied reads of resolved children cannot publish a supposedly closed root.
{
  const world=launchFs(base);
  const fs=requireFsOverBridge(world.fs), read=fs.readFileString;
  fs.readFileString=path=>{if(path===P+'/source/child.cjs')throw Object.assign(new Error('denied'),{code:'EACCES'});return read(path);};
  const result=await prefetchForRequire(fs,'',P+'/source',P+'/source/index.cjs',10000,undefined,
    {purpose:'dependency-closure',held:{},maxAdditionalBytes:10000,maxAdditionalFiles:100});
  assert.deepEqual(result,{kind:'dependency-closure-declined',path:P+'/source/child.cjs',reason:'unreadable'});
}

// Real transform growth evicts a whole root unit; shared/required/evidence cells survive.
{
  const nm=APP+'/node_modules';
  const shared=nm+'/shared/index.cjs';
  const a=nm+'/a/index.ts', b=nm+'/b/index.cjs';
  const entry=APP+'/app.cjs';
  const files={
    [APP+'/package.json']: '{"dependencies":{"a":"1","b":"1"}}',
    [entry]: 'require("./keep.cjs");',
    [APP+'/keep.cjs']: 'module.exports=1;',
    [nm+'/a/package.json']: '{"name":"a","main":"index.ts"}',
    [a]: 'export const answer: number = require("shared") + 1;',
    [nm+'/b/package.json']: '{"name":"b","main":"index.cjs"}',
    [b]: 'module.exports=require("shared")+2;',
    [nm+'/shared/package.json']: '{"name":"shared","main":"index.cjs"}',
    [shared]: 'module.exports=40;',
    ['opt/evidence.cjs']:'module.exports=3;',
  };
  const bound=Object.values(files).reduce((n,s)=>n+bytes(s),0)+64;
  const esbuild=new EsbuildService(undefined,{transformHost:requests=>Promise.all(requests.map(({code,options})=>{
    return oxcEngine.transform(code,{loader:options.loader,format:options.format,target:options.target});
  }))});
  const build=async(requiredShared)=>{
    const view=launchFs({...files,[APP+'/keep.cjs']:requiredShared?'module.exports=require("shared");':files[APP+'/keep.cjs']});
    return buildPrefetchBundle(view.fs, { scriptPath: entry, cwd: APP, entryCode: files[entry], esbuild, observedReads: new Set(['opt/evidence.cjs']), maxBundleBytes: bound });
  };
  for(const requiredShared of [false,true]) {
    const warnings=[];
    const warn=console.warn;
    let state;
    console.warn=(...parts)=>warnings.push(parts.join(' '));
    try { state=await build(requiredShared); } finally { console.warn=warn; }
    assert.equal(state.truncated,true);
    assert.equal(warnings.length,1,'actual transformed-size eviction produces one diagnostic');
    assert.ok(warnings[0].includes(a) && warnings[0].includes(nm+'/a/package.json'),'diagnostic names the removed root and its private metadata');
    assert.equal(state.bundle[a],undefined,'overweight root source is removed');
    assert.equal(state.emits?.has(a) ?? false,false,'its emit goes with it');
    assert.equal(state.bundle[b],files[b],'other kept root survives');
    assert.equal(state.bundle[shared],files[shared],'shared member is retained by another root or the required closure');
    assert.equal(state.bundle[APP+'/keep.cjs']!==undefined,true);
    assert.equal(state.bundle['opt/evidence.cjs'],files['opt/evidence.cjs']);
    const emitted=[...(state.emits?.values()??[])].reduce((n,s)=>n+bytes(s),0);
    const carried=Object.entries(state.bundle).filter(([p])=>!state.codeOnly?.has(p)).reduce((n,[,s])=>n+(typeof s==='string'?bytes(s):s.byteLength),0);
    assert.ok(carried+emitted<=bound,'what the map carries is within the bound');
  }
}
// A guessed module's one deferral of its own package's file is a guess too:
// that is how a package proxies or splits its own code, and it loads whenever
// the deferring code runs. vinext imports @vitejs/plugin-rsc by a computed URL
// (a guess, as a project dependency); plugin-rsc imports vitefu, whose
// CommonJS entry loads its ESM build with import('./index.js'), which the
// second launch missed. A deferral of another package (an optional
// dependency: @vercel/og's import("sharp")) and one of several stay lazy.
{
  const nm=APP+'/node_modules';
  const files={
    [APP+'/package.json']:JSON.stringify({dependencies:{rsc:'1',og:'1',table:'1'}}),
    [nm+'/rsc/package.json']:JSON.stringify({name:'rsc',main:'index.js'}),
    [nm+'/rsc/index.js']:'module.exports=()=>require("fu").crawl();',
    [nm+'/rsc/node_modules/fu/package.json']:JSON.stringify({name:'fu',exports:{'.':{import:'./src/index.js',require:'./src/index.cjs'}}}),
    [nm+'/rsc/node_modules/fu/src/index.cjs']:'module.exports.crawl=()=>import("./index.js").then((m)=>m.crawl());',
    [nm+'/rsc/node_modules/fu/src/index.js']:'import "./walk.js"; export const crawl=()=>1;',
    [nm+'/rsc/node_modules/fu/src/walk.js']:'export const walk=1;',
    [nm+'/og/package.json']:JSON.stringify({name:'og',main:'index.js'}),
    [nm+'/og/index.js']:'module.exports=async()=>{try{return (await import("sharp")).default}catch{}};',
    [nm+'/sharp/package.json']:JSON.stringify({name:'sharp',main:'index.js'}),
    [nm+'/sharp/index.js']:'module.exports=1;',
    [nm+'/table/package.json']:JSON.stringify({name:'table',main:'index.js'}),
    [nm+'/table/index.js']:'module.exports={a:()=>import("./a.js"),b:()=>import("./b.js")};',
    [nm+'/table/a.js']:'module.exports=1;',
    [nm+'/table/b.js']:'module.exports=2;',
  };
  const world=launchFs(files);
  const bundle={};
  const result=await greedyAddMainEntries(world.fs,'/'+APP,bundle,{totalBytes:0,fileCount:0});
  assert.equal(bundle[nm+'/rsc/node_modules/fu/src/index.cjs'],files[nm+'/rsc/node_modules/fu/src/index.cjs'],'the guess reaches the proxy');
  assert.equal(bundle[nm+'/rsc/node_modules/fu/src/index.js'],files[nm+'/rsc/node_modules/fu/src/index.js'],"and the proxy's one deferral of its own package");
  assert.equal(bundle[nm+'/rsc/node_modules/fu/src/walk.js'],files[nm+'/rsc/node_modules/fu/src/walk.js'],'with its static closure');
  assert.ok(result.groups.some((group)=>group.root===nm+'/rsc/node_modules/fu/src/index.js'),'as a group of its own, evicted as one');
  assert.equal(bundle[nm+'/sharp/index.js'],undefined,"a deferral of another package is the guess's optional dependency");
  assert.equal(bundle[nm+'/table/a.js'],undefined,'a module that defers several chooses among them');
  assert.equal(world.reads.includes(nm+'/sharp/index.js'),false);
}

// Own package means the deferral resolves inside the deferring module's
// package, not that its specifier is relative: `import('../bar/index.cjs')`
// from node_modules/foo reaches another package, an optional dependency.
{
  const nm=APP+'/node_modules';
  const files={
    [APP+'/package.json']:JSON.stringify({dependencies:{foo:'1'}}),
    [nm+'/foo/package.json']:JSON.stringify({name:'foo',main:'index.js'}),
    [nm+'/foo/index.js']:'module.exports=()=>import("../bar/index.cjs");',
    [nm+'/bar/package.json']:JSON.stringify({name:'bar',main:'index.cjs'}),
    [nm+'/bar/index.cjs']:'module.exports=1;',
  };
  const world=launchFs(files);
  const bundle={};
  await greedyAddMainEntries(world.fs,'/'+APP,bundle,{totalBytes:0,fileCount:0});
  assert.equal(bundle[nm+'/foo/index.js'],files[nm+'/foo/index.js']);
  assert.equal(bundle[nm+'/bar/index.cjs'],undefined,'a relative import() into another package is not the guess\'s own');
}
console.log('facet-speculative-closure: atomic admission, shared ownership, real transform growth and control failures');
