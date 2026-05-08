// W10 functional: KV options.cacheTtl is accepted and silently ignored
// (real KV uses it for edge cache; emulator is stateless across calls).

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { KvEmulator } from '../../../../src/bindings/kv.ts';

const vfs = makeMockVfs();
const kv = new KvEmulator({ vfs, root: 'home/user', binding: 'MY_KV', onLog: () => {} });

await kv.put('k', 'v');

// The contract: cacheTtl >= 60 in real KV; we accept any number and ignore.
let threw = false;
try {
  const v = await kv.get('k', { cacheTtl: 3600 });
  eq('cacheTtl: value still returned', v, 'v');
} catch { threw = true; }
ok('cacheTtl: no throw', !threw);

// cacheTtl with type
const json = await kv.put('json-k', JSON.stringify([1, 2]));
let threw2 = false;
try {
  const v2 = await kv.get('json-k', { type: 'json', cacheTtl: 60 });
  eq('cacheTtl with type: value parsed', v2, [1, 2]);
} catch { threw2 = true; }
ok('cacheTtl with type: no throw', !threw2);

summary('w10/functional/kv-cachettl-accepted-ignored');
