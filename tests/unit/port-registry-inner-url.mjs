import assert from 'node:assert/strict';
import { innerRequestUrl } from '../../packages/core/src/runtime/port-registry.ts';

// The forwarded URL read off the request's serialization equals the one URL builds, on every shape.
const reference = (outer, pathname) => { const url = new URL(outer); return new URL(pathname + url.search, url.origin).href; };
const outers = [
  'https://app.example.com/s/sid/port/3000/x?a=1&b=2',
  'https://app.example.com:8443/s/sid/port/3000/',
  'http://127.0.0.1:8787/p?q=%20x#frag',
  'https://user:pw@app.example.com/p?x=1',
  'https://app.example.com/p#only-fragment?not-a-query',
  'https://3000--sid.preview.example.com/',
  'https://app.example.com/p?',
];
for (const outer of outers) for (const pathname of ['/', '/x', '/x/y?z', '/%7Euser', 'relative']) {
  assert.equal(innerRequestUrl(outer, pathname), reference(outer, pathname), `${outer} ${pathname}`);
}
console.log('port-registry-inner-url: ok');
