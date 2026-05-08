// W10 functional: KV put/get with text/json/arrayBuffer types

import { ok, eq, includes, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { KvEmulator } from '../../../../src/bindings/kv.ts';

const vfs = makeMockVfs();
const kv = new KvEmulator({ vfs, root: 'home/user', binding: 'MY_KV', onLog: () => {} });

await kv.put('hello', 'world');
eq('text get default', await kv.get('hello'), 'world');
eq('text get explicit type', await kv.get('hello', { type: 'text' }), 'world');
eq('text get string-form options', await kv.get('hello', 'text'), 'world');
eq('missing key returns null', await kv.get('nope'), null);

await kv.put('json-key', JSON.stringify({ a: 1, b: 'two' }));
eq('json type returns parsed object', await kv.get('json-key', { type: 'json' }), { a: 1, b: 'two' });

const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
await kv.put('bin-key', buf);
const got = await kv.get('bin-key', { type: 'arrayBuffer' });
ok('arrayBuffer type returns ArrayBuffer', got instanceof ArrayBuffer, `got=${typeof got}`);
eq('arrayBuffer roundtrip bytes', new Uint8Array(got)[2], 3);

// Stream type
await kv.put('stream-key', 'streamed-value');
const streamRes = await kv.get('stream-key', { type: 'stream' });
ok('stream type returns ReadableStream', streamRes instanceof ReadableStream);
const reader = streamRes.getReader();
let collected = '';
const dec = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  collected += dec.decode(value);
}
eq('stream collects to original text', collected, 'streamed-value');

// VFS layout sanity — emulator uses .nimbus/kv/<binding>/<key>
ok('vfs has hello blob under .nimbus/kv', vfs.exists('home/user/.nimbus/kv/MY_KV/hello'),
  `files: ${[...vfs.files.keys()].slice(0,5).join(',')}`);

// Two bindings don't collide
const kv2 = new KvEmulator({ vfs, root: 'home/user', binding: 'OTHER_KV', onLog: () => {} });
await kv2.put('hello', 'other-value');
eq('binding isolation: MY_KV.hello unchanged', await kv.get('hello'), 'world');
eq('binding isolation: OTHER_KV.hello distinct', await kv2.get('hello'), 'other-value');

summary('w10/functional/kv-put-get');
