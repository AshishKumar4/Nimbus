// fs.readFileSync and fs.promises.readFile give a file's content in the
// encoding asked for, as Node's do: base64, hex, latin1, utf16le and the
// rest through Buffer#toString, UTF-8 as text. Before, any encoding read as
// UTF-8 text (`readFileSync(p, 'base64')` returned the file's text).

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return __fsMod;',
);
const BYTES = new Uint8Array([0x68, 0xc3, 0xa9, 0x00, 0xff, 0x7f, 0x0a]);
const TEXT = 'h\u00e9llo, w\u00f6rld\n';
const fs = factory(
  { 'home/user/bytes.bin': BYTES, 'home/user/text.txt': TEXT },
  {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user',
);

for (const [path, content] of [['/home/user/bytes.bin', Buffer.from(BYTES)], ['/home/user/text.txt', Buffer.from(TEXT)]]) {
  for (const encoding of ['base64', 'base64url', 'hex', 'latin1', 'binary', 'ascii', 'utf16le', 'ucs2', 'utf8', 'utf-8', 'UTF8']) {
    const want = content.toString(encoding);
    assert.equal(fs.readFileSync(path, encoding), want, `${path} in ${encoding}`);
    assert.equal(fs.readFileSync(path, { encoding }), want, `${path} in { encoding: ${encoding} }`);
    assert.equal(await fs.promises.readFile(path, encoding), want, `${path} in ${encoding}, promised`);
  }
  assert.deepEqual([...fs.readFileSync(path)], [...content], `${path} as bytes`);
}
console.log('node-fs-read-encodings: ok');
