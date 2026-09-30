#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
const make = (supervisor) => new Function('__vfsBundle','__vfsWrites','__vfsDirs','__supervisor','cred','cwd','argv','env','filename','dirname','__nimbusProcessId',
  'const __pendingIO = [];'+generateShimsCode()+'\nreturn { proc: __processMod, cp: builtins.child_process };')({}, {}, {}, supervisor, {uid:1000,gid:1000,groups:[1000],umask:0o022}, '/home/user', [], {}, '/home/user/main.js', '/home/user', 4321);
const { proc } = make(null);
assert.equal(proc.pid,4321,'lockfile identity is the actual supervised process, not the constant pid 1');
let term=0;
proc.on('SIGTERM',()=>{term++;});
assert.equal(proc.kill(proc.pid,0),true);
assert.equal(term,0,'signal 0 checks existence; it must not become SIGTERM via a falsy default');
assert.throws(()=>proc.kill(proc.pid+10000,0),(e)=>e.code==='ENOSYS'&&e.syscall==='kill',
  'an unknown cross-isolate pid cannot report success or fabricate ESRCH');

// The process's own child: process.kill(child.pid) signals it through its
// handle (tree-kill rethrows anything but ESRCH), and ESRCH once it is gone.
{
  const killed = [];
  const supervisor = {
    cpSpawn: async () => ({ childPid: 77 }),
    cpKill: async (pid, signal) => { killed.push([pid, signal]); },
    cpWait: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return killed.length > 0 ? { done: true, exitCode: null, signal: 'SIGTERM' } : { done: false };
    },
    cpStdinEnd: async () => {},
  };
  const { proc: parent, cp } = make(supervisor);
  const child = cp.spawn('sleep', ['10'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !child.pid; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(child.pid, 77, 'the child spawned');
  assert.equal(parent.kill(77, 0), true, 'a live child exists');
  assert.deepEqual(killed, [], 'and signal 0 delivers nothing');
  const closed = new Promise((resolve) => child.once('close', resolve));
  assert.equal(parent.kill(77), true, 'process.kill(childPid) signals the child');
  assert.deepEqual(killed, [[77, 'SIGTERM']]);
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(() => parent.kill(77, 0), (e) => e.code === 'ESRCH' && e.syscall === 'kill',
    'a child that has exited is ESRCH, as in Node');
}
console.log('node-shims-signal-probe: ok');
