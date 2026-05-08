// W10 functional: R2 put/get roundtrip with multiple body types

import { eq, ok, gte, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { R2Emulator } from '../../../../src/bindings/r2.ts';

const vfs = makeMockVfs();
const r2 = new R2Emulator({ vfs, root: 'home/user', binding: 'BUCKET', onLog: () => {} });

// String body
const obj1 = await r2.put('hello.txt', 'Hello, world!');
ok('put returns object', !!obj1);
eq('put returns key', obj1.key, 'hello.txt');
ok('put returns size', typeof obj1.size === 'number');
eq('put.size correct', obj1.size, 13);
ok('put returns etag', typeof obj1.etag === 'string' && obj1.etag.length > 0);

const got1 = await r2.get('hello.txt');
ok('get returns object', !!got1);
eq('get.key', got1.key, 'hello.txt');
eq('get.size', got1.size, 13);
ok('get.body is ReadableStream', got1.body instanceof ReadableStream);
ok('get has text() helper', typeof got1.text === 'function');
eq('text() returns body', await got1.text(), 'Hello, world!');

// Refetch — body re-creates a fresh stream each get
const got1b = await r2.get('hello.txt');
eq('refetch text() works', await got1b.text(), 'Hello, world!');

// Uint8Array body
const u8 = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
await r2.put('bin.dat', u8);
const got2 = await r2.get('bin.dat');
const ab = await got2.arrayBuffer();
ok('arrayBuffer() returns ArrayBuffer', ab instanceof ArrayBuffer);
const view = new Uint8Array(ab);
eq('byte 0', view[0], 0xde);
eq('byte 1', view[1], 0xad);
eq('byte 2', view[2], 0xbe);
eq('byte 3', view[3], 0xef);

// ArrayBuffer body
const ab2 = new ArrayBuffer(8);
new DataView(ab2).setUint32(0, 0xCAFEBABE, false);
await r2.put('cafe.bin', ab2);
const got3 = await r2.get('cafe.bin');
eq('cafe.bin size', got3.size, 8);

// ReadableStream body (one-shot, what user's request body usually is)
const stream = new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode('streamed-body'));
    c.close();
  }
});
await r2.put('stream-key', stream);
const got4 = await r2.get('stream-key');
eq('stream body roundtrip', await got4.text(), 'streamed-body');

// Missing key returns null (not undefined)
const missing = await r2.get('does-not-exist');
eq('missing get returns null', missing, null);

// VFS layout
ok('blob in .nimbus/r2/<binding>/', vfs.exists('home/user/.nimbus/r2/BUCKET/hello.txt'));

summary('w10/functional/r2-put-get');
