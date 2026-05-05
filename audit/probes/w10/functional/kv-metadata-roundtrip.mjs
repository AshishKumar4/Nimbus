// W10 functional: KV metadata roundtrip via getWithMetadata

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { KvEmulator } from '../../../../src/binding-kv.ts';

const vfs = makeMockVfs();
const kv = new KvEmulator({ vfs, root: 'home/user', binding: 'MY_KV', onLog: () => {} });

// put with metadata
await kv.put('user:42', 'jane', { metadata: { role: 'admin', orgId: 7 } });

const r = await kv.getWithMetadata('user:42');
eq('value matches', r.value, 'jane');
eq('metadata roundtrips object', r.metadata, { role: 'admin', orgId: 7 });
ok('cacheStatus present', 'cacheStatus' in r);
eq('cacheStatus is null', r.cacheStatus, null);

// get without metadata still works (no metadata return)
eq('plain get returns just value', await kv.get('user:42'), 'jane');

// put without metadata, getWithMetadata returns metadata: null
await kv.put('user:43', 'bob');
const r2 = await kv.getWithMetadata('user:43');
eq('no-metadata value', r2.value, 'bob');
eq('no-metadata metadata is null', r2.metadata, null);

// Missing key
const r3 = await kv.getWithMetadata('does-not-exist');
eq('missing key value null', r3.value, null);
eq('missing key metadata null', r3.metadata, null);

// Updating value preserves metadata only if explicitly re-supplied
await kv.put('user:42', 'jane2');
const r4 = await kv.getWithMetadata('user:42');
eq('overwrite value', r4.value, 'jane2');
eq('overwrite WITHOUT metadata clears metadata', r4.metadata, null);

summary('w10/functional/kv-metadata-roundtrip');
