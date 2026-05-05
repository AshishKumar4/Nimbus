// W10 functional: R2 head() returns metadata, not body

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { R2Emulator } from '../../../../src/binding-r2.ts';

const vfs = makeMockVfs();
const r2 = new R2Emulator({ vfs, root: 'home/user', binding: 'BUCKET', onLog: () => {} });

await r2.put('greeting.txt', 'hi', {
  httpMetadata: { contentType: 'text/plain', cacheControl: 'public, max-age=3600' },
  customMetadata: { author: 'jane', version: '1' },
});

const h = await r2.head('greeting.txt');
ok('head returns object', !!h);
eq('head.key', h.key, 'greeting.txt');
eq('head.size', h.size, 2);
ok('head.etag is string', typeof h.etag === 'string' && h.etag.length > 0);
eq('head.httpMetadata.contentType', h.httpMetadata.contentType, 'text/plain');
eq('head.httpMetadata.cacheControl', h.httpMetadata.cacheControl, 'public, max-age=3600');
eq('head.customMetadata.author', h.customMetadata.author, 'jane');
eq('head.customMetadata.version', h.customMetadata.version, '1');
ok('head has no .body field (or it is null)', h.body == null);
ok('head.uploaded is Date', h.uploaded instanceof Date);

// head missing → null
const miss = await r2.head('does-not-exist');
eq('head missing returns null', miss, null);

summary('w10/functional/r2-head');
