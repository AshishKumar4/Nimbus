// @tier slow — drives a local workerd for WASI stdout binding
// @serial
import assert from 'node:assert/strict';
import wabtInit from 'wabt';
import {startLocalProbe,localTerminal} from './lib/workerd-probe.mjs';
const wabt=await wabtInit();
const m=wabt.parseWat('binding.wat',`(module
 (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
 (memory (export "memory") 1)
 (data (i32.const 128) "\\00\\7f\\c2\\a2\\1bA")
 (func (export "_start")
  (i32.store (i32.const 0) (i32.const 128)) (i32.store (i32.const 4) (i32.const 6))
  (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 64)))))`);
const bytes=m.toBinary({}).buffer;m.destroy();
const probe=await startLocalProbe({runtimes:[]});let terminal;
try {
 terminal=await localTerminal(probe,{install:[]});
 const b64=Buffer.from(bytes).toString('base64');
 assert.equal((await terminal.run(`node -e "require('fs').writeFileSync('/home/user/binding.wasm',Buffer.from('${b64}','base64'))"; chmod 755 /home/user/binding.wasm`)).status,0);
 const output=await terminal.run('/home/user/binding.wasm | xxd -p',60000);
 assert.equal(output.status,0,output.stdout);assert.match(output.stdout,/^007fc2a21b41\s*$/m,'generic WASI fd1 keeps binary NUL/control/UTF8 bytes across the real runtime binding');
} finally {if(terminal)await terminal.close();await probe.stop();}
console.log('process-binding-wasi-workerd: a real generic WASI program reaches the session with byte-exact fd1');
