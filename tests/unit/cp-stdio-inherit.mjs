#!/usr/bin/env bun
// child_process.spawn with inherited descriptors exposes null streams while
// delivering child output through the parent's streams, before close. Late
// output must not be discarded when cpWait reports exit first; inherited
// stdin consumes the parent's live input and releases it on child exit.
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';
const timer = globalThis.setTimeout;
const sleep = ms => new Promise(resolve => timer(resolve, ms));
const factory = new Function('__vfsBundle','__vfsWrites','__vfsDirs','__supervisor','cred','cwd','argv','env','filename','dirname','__pendingIO','stdin',
  'let stdout="",stderr="";' + SHIMS_STORE_PRELUDE + generateShimsCode()
  + ';return {cp:__childProcessMod,process:__processMod,output:()=>({stdout,stderr})};');
const bytes = text => new TextEncoder().encode(text);
const input = new Uint8Array([0,255,195,169,10]);
const stdinSeen = [];
let stdinEnded = false;
let nextPid = 70;
const closed = new Set();
const supervisor = {
  async cpSpawn() { return {childPid:++nextPid}; },
  async cpWait(pid) {
    // Deliberately precedes output delivery: close must still wait for both streams.
    await sleep(2);
    if (pid === 74 && !stdinEnded) { await sleep(5); return {done:false}; }
    return {done:true,exitCode:0,signal:null};
  },
  async cpReadOutput(pid,fd,since) {
    await sleep(fd === 1 ? 15 : 8);
    closed.add(`${pid}:${fd}`);
    const data = bytes(fd === 1 ? `child-${pid} €\n` : `error-${pid}\n`);
    return {chunks:since ? [] : [{seq:1,data:data.subarray(0,data.length-2)},{seq:2,data:data.subarray(data.length-2)}],closed:true,maxSeq:2};
  },
  async cpReadStdin() { await sleep(3); return {data:input,ended:true}; },
  async cpStdinWrite(pid,data) { stdinSeen.push({pid,data:new Uint8Array(data)}); return {ok:true}; },
  async cpStdinEnd() { stdinEnded=true; },
  async cpDrainOutput() { return {stdout:new Uint8Array(),stderr:new Uint8Array(),stdoutClosed:true,stderrClosed:true}; },
};
const pending=[];
const guest=factory({}, {}, {}, supervisor, {uid:1000,gid:1000,groups:[1000],umask:0o022}, '/home/user', [], {NIMBUS_CP_CHILD_PID:'60'}, '/home/user/parent.js','/home/user',pending, '');
const done = child => new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code)=>resolve(code));});
const bounded = promise => Promise.race([promise,new Promise((_,reject)=>{const t=timer(()=>reject(new Error('child did not close')),3000);t.unref?.();})]);

// Output delivered after exit, in the parent's per-stream order. The public
// streams remain null and closing one inherited child leaves the parent open.
guest.process.stdout.write('before\n');guest.process.stderr.write('before-error\n');
const a=guest.cp.spawn('node',['a.js'],{stdio:['ignore','inherit','inherit']});
assert.equal(a.stdin,null);assert.equal(a.stdout,null);assert.equal(a.stderr,null);
assert.equal(await bounded(done(a)),0);
guest.process.stdout.write('after\n');guest.process.stderr.write('after-error\n');
assert.deepEqual(guest.output(),{stdout:'before\nchild-71 €\nafter\n',stderr:'before-error\nerror-71\nafter-error\n'});
assert.ok(closed.has('71:1') && closed.has('71:2'),'close includes both late outputs');
assert.equal(guest.process.stdout.writableEnded,false);
assert.equal(guest.process.stderr.writableEnded,false);

// Mixed descriptors preserve the pipe; ignore emits nothing to the parent.
const b=guest.cp.spawn('node',['b.js'],{stdio:['ignore','pipe','inherit']});
const piped=[];b.stdout.on('data',d=>piped.push(Buffer.from(d)));
await bounded(done(b));
assert.equal(Buffer.concat(piped).toString('utf8'),'child-72 €\n');
assert.equal(guest.output().stdout,'before\nchild-71 €\nafter\n');
assert.equal(guest.output().stderr,'before-error\nerror-71\nafter-error\nerror-72\n');
const c=guest.cp.spawn('node',['c.js'],{stdio:'ignore'});
await bounded(done(c));
assert.equal(guest.output().stderr,'before-error\nerror-71\nafter-error\nerror-72\n');

// String-form inherit also relays live terminal stdin. Bytes and EOF are
// delivered in order, and the child no longer holds the parent's input.
stdinEnded=false;
const listeners=guest.process.stdin.listenerCount('data');
const d=guest.cp.spawn('node',['interactive.js'],{stdio:'inherit'});
assert.deepEqual(d.stdio,[null,null,null]);
await bounded(done(d));
assert.deepEqual(Buffer.concat(stdinSeen.filter(x=>x.pid===74).map(x=>Buffer.from(x.data))),Buffer.from(input));
assert.equal(stdinEnded,true);
assert.equal(guest.process.stdin.listenerCount('data'),listeners);
assert.equal(guest.output().stdout,'before\nchild-71 €\nafter\nchild-74 €\n');

// The process's normal exit drain must retain a referenced inherited child
// even when user code does not attach an exit/close listener.
guest.cp.spawn('node',['unawaited.js'],{stdio:['ignore','inherit','ignore']});
await bounded(Promise.all(pending));
assert.equal(guest.output().stdout,'before\nchild-71 €\nafter\nchild-74 €\nchild-75 €\n');
console.log('cp-stdio-inherit: inherited output ordering, pipe/ignore separation, live input and cleanup');
