// W10 functional: KV TTL/expiration handling

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { KvEmulator, _setKvNow } from '../../../../src/binding-kv.ts';

const vfs = makeMockVfs();
const kv = new KvEmulator({ vfs, root: 'home/user', binding: 'MY_KV', onLog: () => {} });

// Inject a controllable clock — this is what `_setKvNow` exists for in the
// emulator (test seam, not part of the public API). The probe will fail if
// the test seam isn't there or isn't honored by put/get.
let now = 1_700_000_000; // 2023-11-14 in unix seconds
_setKvNow(() => now);

// Absolute expiration: 60 seconds in the future
await kv.put('exp-abs', 'v1', { expiration: now + 60 });
eq('present before expiration', await kv.get('exp-abs'), 'v1');

now = now + 30;
eq('still present mid-window', await kv.get('exp-abs'), 'v1');

now = now + 31;
eq('expired returns null', await kv.get('exp-abs'), null);

// Expired keys should be lazy-deleted from the VFS on get.
ok('expired blob lazy-deleted', !vfs.exists('home/user/.nimbus/kv/MY_KV/exp-abs'));

// expirationTtl: relative seconds-from-now
await kv.put('exp-ttl', 'v2', { expirationTtl: 100 });
const list1 = await kv.list();
eq('exp-ttl listed before window', list1.keys.length, 1);

now = now + 99;
eq('exp-ttl still present at 99s', await kv.get('exp-ttl'), 'v2');
now = now + 2;
eq('exp-ttl expired at 101s', await kv.get('exp-ttl'), null);

summary('w10/functional/kv-ttl-expiration');
