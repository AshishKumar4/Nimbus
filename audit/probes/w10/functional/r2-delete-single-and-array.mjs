// W10 functional: R2 delete supports single key and array

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { R2Emulator } from '../../../../src/binding-r2.ts';

const vfs = makeMockVfs();
const r2 = new R2Emulator({ vfs, root: 'home/user', binding: 'BUCKET', onLog: () => {} });

await r2.put('a', '1');
await r2.put('b', '2');
await r2.put('c', '3');
await r2.put('d', '4');

// Single key
await r2.delete('a');
eq('a gone', await r2.get('a'), null);
eq('b survives', (await r2.get('b'))?.size, 1);

// Array of keys
await r2.delete(['b', 'c']);
eq('b gone', await r2.get('b'), null);
eq('c gone', await r2.get('c'), null);
eq('d survives', (await r2.get('d'))?.size, 1);

// Idempotent — deleting nonexistent key doesn't throw
let threw = false;
try { await r2.delete('missing'); } catch { threw = true; }
ok('delete missing idempotent', !threw);

// Array with all-missing
let threw2 = false;
try { await r2.delete(['x', 'y', 'z']); } catch { threw2 = true; }
ok('delete all-missing array idempotent', !threw2);

// Meta sidecar gone
ok('a meta gone', !vfs.exists('home/user/.nimbus/r2/BUCKET/a.meta'));

summary('w10/functional/r2-delete-single-and-array');
