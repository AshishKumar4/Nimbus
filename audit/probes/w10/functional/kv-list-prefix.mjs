// W10 functional: KV list with prefix + cursor pagination

import { ok, eq, gte, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { KvEmulator } from '../../../../src/binding-kv.ts';

const vfs = makeMockVfs();
const kv = new KvEmulator({ vfs, root: 'home/user', binding: 'MY_KV', onLog: () => {} });

// Seed 25 keys spread across two prefixes
for (let i = 0; i < 15; i++) await kv.put('user:' + i, 'u' + i);
for (let i = 0; i < 10; i++) await kv.put('post:' + i, 'p' + i);

// list() — no prefix
const all = await kv.list();
eq('list returns 25 keys total', all.keys.length, 25);
eq('list_complete true when fits in one page', all.list_complete, true);

// list({prefix: 'user:'})
const users = await kv.list({ prefix: 'user:' });
eq('prefix-filtered count', users.keys.length, 15);
ok('all keys have prefix', users.keys.every(k => k.name.startsWith('user:')),
  'first 3: ' + users.keys.slice(0,3).map(k => k.name).join(','));

// list({prefix: 'user:', limit: 10}) — pagination
const page1 = await kv.list({ prefix: 'user:', limit: 10 });
eq('paginated first page size', page1.keys.length, 10);
eq('list_complete false on partial page', page1.list_complete, false);
ok('cursor returned', typeof page1.cursor === 'string' && page1.cursor.length > 0);

const page2 = await kv.list({ prefix: 'user:', limit: 10, cursor: page1.cursor });
eq('paginated remainder', page2.keys.length, 5);
eq('list_complete true on tail page', page2.list_complete, true);

// No overlap between pages
const set1 = new Set(page1.keys.map(k => k.name));
const set2 = new Set(page2.keys.map(k => k.name));
let overlap = 0;
for (const n of set1) if (set2.has(n)) overlap++;
eq('no overlap between pages', overlap, 0);

// metadata field exposed
const meta = await kv.list({ prefix: 'post:', limit: 1 });
ok('keys have name field', typeof meta.keys[0].name === 'string');

// cacheStatus field present (we always return null)
ok('cacheStatus field present', 'cacheStatus' in meta);

summary('w10/functional/kv-list-prefix');
