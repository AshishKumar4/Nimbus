// W10 functional: R2 list() with prefix + cursor pagination

import { eq, ok, gte, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { R2Emulator } from '../../../../src/bindings/r2.ts';

const vfs = makeMockVfs();
const r2 = new R2Emulator({ vfs, root: 'home/user', binding: 'BUCKET', onLog: () => {} });

// 30 objects across two prefixes
for (let i = 0; i < 20; i++) await r2.put(`logs/2026-05-${String(i).padStart(2, '0')}.log`, `entry-${i}`);
for (let i = 0; i < 10; i++) await r2.put(`assets/img-${i}.png`, `imgdata-${i}`);

// list all
const all = await r2.list();
eq('all object count', all.objects.length, 30);
ok('truncated false', all.truncated === false);

// list with prefix
const logs = await r2.list({ prefix: 'logs/' });
eq('prefix-filter count', logs.objects.length, 20);
ok('all keys begin with prefix', logs.objects.every(o => o.key.startsWith('logs/')));

// cursor pagination
const p1 = await r2.list({ prefix: 'logs/', limit: 7 });
eq('p1 size', p1.objects.length, 7);
eq('p1 truncated', p1.truncated, true);
ok('p1 cursor present', typeof p1.cursor === 'string' && p1.cursor.length > 0);

const p2 = await r2.list({ prefix: 'logs/', limit: 7, cursor: p1.cursor });
eq('p2 size', p2.objects.length, 7);

const p3 = await r2.list({ prefix: 'logs/', limit: 7, cursor: p2.cursor });
eq('p3 size', p3.objects.length, 6);
eq('p3 truncated false (last page)', p3.truncated, false);

// No overlap
const seen = new Set();
for (const o of [...p1.objects, ...p2.objects, ...p3.objects]) {
  ok(`no dup ${o.key}`, !seen.has(o.key));
  seen.add(o.key);
}
eq('all distinct keys', seen.size, 20);

// Each object has the standard R2Object fields
const o = logs.objects[0];
ok('object.key', typeof o.key === 'string');
ok('object.size', typeof o.size === 'number');
ok('object.etag', typeof o.etag === 'string');
ok('object.uploaded is Date', o.uploaded instanceof Date);

// delimiter (basic): get common prefixes
const withDelim = await r2.list({ delimiter: '/' });
ok('delimiter returns delimitedPrefixes array', Array.isArray(withDelim.delimitedPrefixes));
ok('delimitedPrefixes contains logs/', withDelim.delimitedPrefixes.includes('logs/'));
ok('delimitedPrefixes contains assets/', withDelim.delimitedPrefixes.includes('assets/'));

summary('w10/functional/r2-list-prefix');
