// W10 functional: R2 etag is deterministic content hash

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { R2Emulator } from '../../../../src/bindings/r2.ts';

const vfs = makeMockVfs();
const r2 = new R2Emulator({ vfs, root: 'home/user', binding: 'BUCKET', onLog: () => {} });

const o1 = await r2.put('a.txt', 'hello');
const o2 = await r2.put('b.txt', 'hello');
eq('same content → same etag', o1.etag, o2.etag);

const o3 = await r2.put('c.txt', 'world');
ok('diff content → diff etag', o1.etag !== o3.etag);

// Etag is hex
ok('etag hex chars only', /^[0-9a-f]+$/i.test(o1.etag), `etag=${o1.etag}`);

// Replace same key, same content → same etag
const o4 = await r2.put('a.txt', 'hello');
eq('rewrite same content → same etag', o1.etag, o4.etag);

summary('w10/functional/r2-etag-content-addressed');
