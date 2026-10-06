#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
const factory = new Function('__vfsBundle','__vfsWrites','__vfsDirs','__supervisor','cred','cwd','argv','env','filename','dirname',
 'let stdout="",stderr="";const __pendingIO=[];'+generateShimsCode()+';return { proc:__processMod,write:__nimbusWriteLiveOutput };');
const g=factory({},{},{},null,{uid:1000,gid:1000,groups:[1000],umask:0o022},'/',[],{},'/a.js','/');
let complete, called=false, drain=0;
const delivery=new Promise(resolve=>{complete=resolve});
g.proc.stdout.once('drain',()=>drain++);
const bytes=new Uint8Array(g.proc.stdout.writableHighWaterMark);
assert.equal(g.write('stdout',bytes,undefined,()=>{called=true},()=>delivery),false);
for(let i=0;i<20;i++)await null;
assert.equal(called,false,'enqueueing is not a completed pipe write');
assert.equal(drain,0,'a reader that never reads leaves its writer waiting');
assert.equal(g.proc.stdout.writableLength,bytes.length);
complete();for(let i=0;i<20;i++)await null;
assert.equal(called,true);assert.equal(drain,1);assert.equal(g.proc.stdout.writableLength,0);
console.log('node-output-pipe-backpressure: high-water mark and drain follow delivery, not enqueue');
