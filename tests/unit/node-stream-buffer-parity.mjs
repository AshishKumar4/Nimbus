import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
const code = `const describe=c=>({buffer:Buffer.isBuffer(c),name:c.constructor.name,text:c.toString('utf8'),hex:c.toString('hex'),first:c.readUInt8(0)});(async()=>{const s=require('stream');const raw=new Uint8Array([65,195,169]);for(const [name,r]of [['push',new s.Readable({read(){this.push(raw);this.push(null)}})],['web',s.Readable.fromWeb(new ReadableStream({start(c){c.enqueue(raw);c.close()}}))]]){for await(const c of r)console.log(JSON.stringify({name,...describe(c)}));}new s.Writable({write(c,e,cb){console.log(JSON.stringify(describe(c)));cb()}}).end(raw);})();`;
const host=spawnSync('node',['-e',code],{encoding:'utf8'});
assert.equal(host.status,0,host.stderr);
const expected=host.stdout.trim().split('\n').map(JSON.parse);
const factory=new Function('__vfsBundle','__vfsWrites','__vfsDirs','__supervisor','cred','cwd','argv','env','filename','dirname',
 'let stdout="",stderr="";const __pendingIO=[];'+generateShimsCode()+';return { streams:__streamMod, Buffer:__BufferMod };');
const g=factory({},{},{},null,{uid:1000,gid:1000,groups:[1000],umask:0o022},'/',[],{},'/a.js','/');
const raw=new Uint8Array([65,195,169]);
const rows=[];
for(const [name,r]of [['push',new g.streams.Readable({read(){this.push(raw);this.push(null)}})],['web',g.streams.Readable.fromWeb(new ReadableStream({start(c){c.enqueue(raw);c.close()}}))]]) {
 for await(const c of r)rows.push({name,buffer:g.Buffer.isBuffer(c),name:c.constructor.name,text:c.toString('utf8'),hex:c.toString('hex'),first:c.readUInt8?.(0)});
}
new g.streams.Writable({write(c,e,cb){rows.push({buffer:g.Buffer.isBuffer(c),name:c.constructor.name,text:c.toString('utf8'),hex:c.toString('hex'),first:c.readUInt8?.(0)});cb()}}).end(raw);
assert.deepEqual(rows,expected,'byte-mode readable consumers receive Node Buffers, not channel Uint8Arrays');
console.log('node-stream-buffer-parity: push/fromWeb chunks match Node Buffer methods and encodings');
