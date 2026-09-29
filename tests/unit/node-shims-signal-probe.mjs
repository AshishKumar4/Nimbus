#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
const proc = new Function('__vfsBundle','__vfsWrites','__vfsDirs','__supervisor','cred','cwd','argv','env','filename','dirname',
  generateShimsCode()+'\nreturn __processMod;')({}, {}, {}, null, {uid:1000,gid:1000,groups:[1000],umask:0o022}, '/home/user', [], {}, '/home/user/main.js', '/home/user');
let term=0;
proc.on('SIGTERM',()=>{term++;});
assert.equal(proc.kill(proc.pid,0),true);
assert.equal(term,0,'signal 0 checks existence; it must not become SIGTERM via a falsy default');
assert.throws(()=>proc.kill(proc.pid+10000,0),(e)=>e.code==='ENOSYS'&&e.syscall==='kill',
  'an unknown cross-isolate pid cannot report success or fabricate ESRCH');
console.log('node-shims-signal-probe: ok');
