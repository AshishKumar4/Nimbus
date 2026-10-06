#!/usr/bin/env bun
import assert from 'node:assert/strict';
const source = process.env.NIMBUS_BYTE_SHIMS_BASELINE ?? new URL('../../packages/worker/src/runtime/node-shims.ts',import.meta.url).href;
const {generateShimsCode}=await import(source);
const timer=globalThis.setTimeout;
const sleep=ms=>new Promise(r=>timer(r,ms));
const piece=new Uint8Array(1024).fill(255), count=512;
let delivered=0, polls=0;
const sup={cpSpawn:async()=>({childPid:7}),cpStdinEnd:async()=>{},
 cpReadOutput:async(_pid,fd,since)=>{if(fd===1&&since<count){polls++;delivered++;return {chunks:[{seq:since+1,data:piece}],maxSeq:since+1,closed:false};}
 return {chunks:[],maxSeq:since,closed:fd===2||since===count};},
 cpWait:async()=>{await sleep(20);return delivered===count?{done:true,exitCode:0,signal:null}:{done:false};},
 cpDrainOutput:async()=>({stdout:new Uint8Array(),stderr:new Uint8Array(),stdoutClosed:true,stderrClosed:true}),
};
const factory=new Function('__vfsBundle','__vfsWrites','__vfsDirs','__supervisor','cred','cwd','argv','env','filename','dirname',
 'let stdout="",stderr="";const __pendingIO=[];'+generateShimsCode()+';return __childProcessMod;');
const cp=factory({},{},{},sup,{uid:1000,gid:1000,groups:[1000],umask:0o022},'/',[],{},'/a.js','/');
const child=cp.spawn('producer',[]);
await sleep(50);
assert.ok(polls>0&&polls<count,'without an application reader, stdout high-water mark stops broker acknowledgement');
const bytes=[];child.stdout.on('data',d=>bytes.push(Buffer.from(d)));
await new Promise((resolve,reject)=>{const timeout=timer(()=>reject(new Error('the child did not close after its output was read')),5000);child.once('close',()=>{clearTimeout(timeout);resolve();});});
assert.equal(Buffer.concat(bytes).length,count*piece.length);assert.ok(Buffer.concat(bytes).every(b=>b===255));
assert.equal(child.stdin.destroyed, true, 'a child exit closes its parent-side stdin as Node does');
let lateWrites = 0;
sup.cpStdinWrite = async () => { lateWrites++; return { ok: false }; };
child.stdin.end(new Uint8Array([120]));
for (let i=0;i<20;i++) await null;
assert.equal(lateWrites,0,'ending a closed child stdin sends no late write and cannot reject the parent loop');

console.log('node-child-output-backpressure: reader bounds relay until consumption; bytes and close preserved');
