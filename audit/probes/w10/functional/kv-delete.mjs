// W10 functional: KV.delete

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { KvEmulator } from '../../../../src/bindings/kv.ts';

const vfs = makeMockVfs();
const kv = new KvEmulator({ vfs, root: 'home/user', binding: 'MY_KV', onLog: () => {} });

await kv.put('a', '1');
await kv.put('b', '2');
eq('present before delete', await kv.get('a'), '1');

await kv.delete('a');
eq('null after delete', await kv.get('a'), null);
eq('other key untouched', await kv.get('b'), '2');

// Idempotent: delete non-existent key resolves
let threw = false;
try { await kv.delete('does-not-exist'); } catch { threw = true; }
ok('delete missing is idempotent (no throw)', !threw);

// VFS sidecar gone too
ok('blob gone', !vfs.exists('home/user/.nimbus/kv/MY_KV/a'));
ok('meta sidecar gone', !vfs.exists('home/user/.nimbus/kv/MY_KV/a.meta'));

summary('w10/functional/kv-delete');
