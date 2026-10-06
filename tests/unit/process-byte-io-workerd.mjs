// @serial
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import wabtInit from 'wabt';
const repo = process.env.NIMBUS_BYTE_BASELINE_REPO ?? new URL('../..', import.meta.url).pathname;
const { startLocalProbe, localTerminal } = await import(`${repo}/tests/unit/lib/workerd-probe.mjs`);
const wat = `(module
 (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
 (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
 (memory (export "memory") 1)
 (func (export "_start") (local $n i32)
  (i32.store (i32.const 0) (i32.const 128)) (i32.store (i32.const 4) (i32.const 32))
  (loop $again
   (drop (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 64)))
   (local.set $n (i32.load (i32.const 64)))
   (if (local.get $n) (then
    (i32.store (i32.const 4) (local.get $n))
    (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 68)))
    (i32.store (i32.const 4) (i32.const 32)) (br $again))))))`;
const wabt = await wabtInit(), mod = wabt.parseWat('byte-echo.wat', wat), wasm = mod.toBinary({}).buffer; mod.destroy();
const inheritWat = `(module
 (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
 (import "nimbus_proc" "spawn" (func $spawn (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
 (import "nimbus_proc" "start" (func $start (param i32) (result i32)))
 (import "nimbus_proc" "wait" (func $wait (param i32 i32 i32 i32) (result i32)))
 (memory (export "memory") 1)
 (data (i32.const 128) "/home/user/byte-echo.wasm\\00")
 (func $check (param i32) (if (local.get 0) (then (call $exit (local.get 0)))))
 (func (export "_start")
  (call $check (call $spawn (i32.const 128) (i32.const ${Buffer.byteLength('/home/user/byte-echo.wasm')+1}) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
   (i32.const 0) (i32.const 1) (i32.const 2) (i32.const 64)))
  (call $check (call $start (i32.load (i32.const 64))))
  (call $check (call $wait (i32.load (i32.const 64)) (i32.const 0) (i32.const 68) (i32.const 72)))
  (call $exit (i32.const 0))))`;
const inheritedMod=wabt.parseWat('inherit-echo.wat',inheritWat), inheritedWasm=inheritedMod.toBinary({}).buffer; inheritedMod.destroy();
const probe = await startLocalProbe({ runtimes: [] });
const hostBytes = spawnSync('node', ['-e', 'process.stdout.write(Buffer.from([0xff,0xfe]))']);
assert.equal(hostBytes.status,0); assert.equal(hostBytes.stdout.toString('hex'),'fffe');
let terminal;
try {
 terminal = await localTerminal(probe, { install: [] });
 const write = async (name, bytes) => {
  const b64 = Buffer.from(bytes).toString('base64');
  const r = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/${name}', Buffer.from('${b64}','base64'))"`);
  assert.equal(r.status, 0, r.stdout);
 };
 await write('byte-echo.wasm', wasm);
 await write('inherit-echo.wasm',inheritedWasm);
 await write('byte-script.sh', '#!/bin/sh\ncat\n');
 await terminal.run('chmod 755 /home/user/byte-script.sh /home/user/byte-echo.wasm /home/user/inherit-echo.wasm');
 const raw = await terminal.run(`node -e "process.stdout.write(Buffer.from([0xff,0xfe]))" | xxd -p`);
 assert.match(raw.stdout, new RegExp('^'+hostBytes.stdout.toString('hex')+'\\s*$','m'), 'Node foreground output matches host Node through a shell pipe');
 const program = `const {spawn}=require('child_process');
 (async()=>{for(const [name,command,args] of [['registry','cat',[]],['shebang','/home/user/byte-script.sh',[]],['node','node',['-e','process.stdin.pipe(process.stdout)']],['wasi','/home/user/byte-echo.wasm',[]],['inherited-wasi','/home/user/inherit-echo.wasm',[]]]){
 const result=await new Promise((resolve,reject)=>{const c=spawn(command,args);let out=Buffer.alloc(0),first=false;
 const one=Buffer.from([255,254,0,128]),two=Buffer.from([195,40,240,159]);const timer=setTimeout(()=>{c.kill();reject(new Error(name+' did not answer while stdin remained open'));},15000);
 c.stdout.on('data',d=>{out=Buffer.concat([out,d]);if(!first&&out.length>=one.length){if(!out.equals(one)){reject(new Error(name+' changed its first bytes'));return;}first=true;c.stdin.end(two);}});
 c.stderr.on('data',d=>reject(new Error(name+': '+d)));c.on('error',reject);c.on('close',(code,signal)=>{clearTimeout(timer);resolve({name,hex:out.toString('hex'),code,signal,first});});c.stdin.write(one);});console.log('BYTES '+JSON.stringify(result));}})();`;
 await write('byte-parent.js', program);
 const actual = await terminal.run('node /home/user/byte-parent.js', 180000);
 assert.equal(actual.status, 0, actual.stdout);
 const rows = [...actual.stdout.matchAll(/^BYTES (.+)$/gm)].map(m => JSON.parse(m[1]));
 assert.deepEqual(rows, ['registry','shebang','node','wasi','inherited-wasi'].map(name => ({name,hex:'fffe0080c328f09f',code:0,signal:null,first:true})), 'all child kinds, including inherited WASI fd0, answer before EOF and close after their final bytes');
 const wasi = await terminal.run(`node -e "process.stdout.write(Buffer.from([255,254,0,128]))" | /home/user/byte-echo.wasm | xxd -p`);
 assert.match(wasi.stdout, /^fffe0080\s*$/m, 'a foreground WASI fd 0 and fd 1 are byte-exact');
} finally { if (terminal) await terminal.close(); await probe.stop(); }
console.log('process-byte-io-workerd: Node/WASI foreground pipes and all child kinds preserve binary duplex/EOF/close');
