// @serial
// @tier slow — native HTTP framing, not only a readable stream's headers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const worker = `const stats=new Map();export default { async fetch(request) {
  const url=new URL(request.url);if(url.pathname==='/ready')return new Response('ready');
  if(url.pathname==='/stats')return Response.json(Object.fromEntries(stats));
  if(url.pathname.startsWith('/bulk-')){
    const key=url.pathname,row={bytes:0,chunks:0,histogram:{}};stats.set(key,row);
    const chunk=new Uint8Array(65536),size=8*1024*1024;let remaining=size;
    const source=new ReadableStream({pull(controller){if(!remaining){controller.close();return;}remaining-=chunk.length;controller.enqueue(chunk);}});
    const fixed=new FixedLengthStream(size);
    const gate=new TransformStream({expectedLength:size,transform(value,controller){row.bytes+=value.byteLength;row.chunks++;row.histogram[value.byteLength]=(row.histogram[value.byteLength]??0)+1;controller.enqueue(value);}});
    const body=key==='/bulk-main'?source.pipeThrough(gate).pipeThrough(fixed):source.pipeThrough(fixed).pipeThrough(gate);
    return new Response(body,{headers:{'Content-Length':String(size)}});
  }
  const size=Number(url.searchParams.get('size')??3);
  const source=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(size).fill(42));controller.close();}});
  const fixed=new FixedLengthStream(3);
  const gate=new TransformStream({transform(chunk,controller){controller.enqueue(chunk);},flush(){},
    ...(url.pathname==='/metadata-last'?{expectedLength:3}:{})});
  const body=url.pathname==='/fixed-last'?source.pipeThrough(gate).pipeThrough(fixed):source.pipeThrough(fixed).pipeThrough(gate);
  return new Response(body,{headers:{'Content-Length':'3','x-order':url.pathname}});
} };`;
const require = createRequire(import.meta.url);
const binary = createRequire(require.resolve('wrangler/package.json'))('workerd').default;
const dir = mkdtempSync(join(tmpdir(), 'registry-frame-order-'));
const free = net.createServer(); await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
const port = free.address().port; await new Promise(resolve => free.close(resolve));
writeFileSync(join(dir, 'worker.js'), worker);
writeFileSync(join(dir, 'config.capnp'), `using Workerd=import "/workerd/workerd.capnp";
const config:Workerd.Config=(services=[(name="main",worker=(compatibilityDate="2026-09-26",modules=[(name="worker.js",esModule=embed"worker.js")]))],
sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="main")]);`);
const child = spawn(binary, ['serve', 'config.capnp'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
try {
  const base = 'http://127.0.0.1:' + port;
  for (const deadline = Date.now() + 30000;;) {
    try { await fetch(base + '/ready'); break; } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  for (const [order, length] of [['fixed-last', '3'], ['plain-last', null], ['metadata-last', '3']]) {
    const response = await fetch(base + '/' + order);
    assert.equal(response.headers.get('content-length'), length, order + ': real HTTP length');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([42, 42, 42]));
    if (length === null) assert.equal(response.headers.get('transfer-encoding'), 'chunked');
    else assert.equal(response.headers.get('transfer-encoding'), null, order + ': no fallback to chunked');
  }
  for (const size of [2, 4]) {
    await assert.rejects(async () => {
      const response = await fetch(base + '/metadata-last?size=' + size);
      await response.arrayBuffer();
    }, 'upstream native count validation still rejects short and long bodies');
  }
  for (const key of ['bulk-main', 'bulk-reordered']) {
    const response = await fetch(base + '/' + key);
    assert.equal(response.headers.get('content-length'), String(8 * 1024 * 1024));
    assert.equal((await response.arrayBuffer()).byteLength, 8 * 1024 * 1024);
  }
  const stats = await (await fetch(base + '/stats')).json();
  console.log(JSON.stringify({ nativeGateChunkHistograms: stats }));
  assert.deepEqual(stats['/bulk-reordered'], stats['/bulk-main'], 'same stage count must preserve the producer chunk/backpressure topology');
} finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
