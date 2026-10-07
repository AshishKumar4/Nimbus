import assert from 'node:assert/strict';
import { buildRuntimeHandler } from '../../packages/core/src/runtime/runtime-registry.ts';
const pieces = [Buffer.concat([Buffer.alloc(4095,65),Buffer.from([0xc3])]),Buffer.from([0xa9,66])];
let stdout='';
const handler=buildRuntimeHandler({name:'node',version:'v22',helpText:'help',supportsBinSpawn:true,
 async run(_code,opts){for(const bytes of pieces)await opts.output('stdout',bytes);return{exitCode:0,stdout:'',stderr:''};}},
 {registry:{resolve(){return undefined;}},getEsbuild(){throw new Error('unused')},vfs:{as(){throw new Error('bound context owns VFS')}}});
const vfs={process:{},exists(){return false},isFile(){return false},readFileString(){return null}};
const code=await handler({pid:1,cred:{uid:1000,gid:1000,groups:[1000],umask:0o022},args:['-e','unused'],cwd:'/home/user',env:{},vfs,
 stdout:{write(text){stdout+=text}},stderr:{write(text){throw new Error(text)}},signal:new AbortController().signal,isFdTerminal(){return true}});
assert.equal(code,0);
assert.equal(stdout,Buffer.concat(pieces).toString(),'one streaming text edge preserves a character split across 4096');
console.log('runtime-output-text-edge: byte chunks are decoded at one streaming display edge');
