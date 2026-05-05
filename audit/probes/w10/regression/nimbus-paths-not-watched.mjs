// W10 regression: writes to .nimbus/ paths must NOT trigger the
// hot-reload watcher. (Otherwise every KV.put or R2.put causes a rebuild.)

import { ok, eq, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { NimbusWrangler } from '../../../../src/nimbus-wrangler.ts';

const vfs = makeMockVfs();
vfs.writeFile('home/user/wrangler.jsonc', JSON.stringify({
  name: 'demo', main: 'src/index.ts',
}));
vfs.writeFile('home/user/src/index.ts', 'export default { fetch() { return new Response("hi"); } };');

let rebuildCount = 0;
const wr = new NimbusWrangler({
  vfs,
  esbuild: { build: async () => { rebuildCount++; return { outputFiles: [], errors: [], warnings: [] }; } },
  env: { LOADER: { load: () => ({ getEntrypoint: () => null, getDurableObjectClass: () => null }) } },
  ctx: { id: { toString: () => 'do-id' }, exports: {}, storage: makeMockSql().storage },
  root: 'home/user',
  onLog: () => {},
  onHmrMessage: () => {},
});

// Wire up the watcher. We call the test seam that registers the listener
// without running the full start() sequence (which would require esbuild).
wr._installWatchersForTest();

// Write a real source file change → must trigger rebuild
const initial = rebuildCount;
vfs.writeFile('home/user/src/index.ts', 'export default { fetch() { return new Response("changed"); } };');
await new Promise(r => setTimeout(r, 50));
// debounce is 250ms, wait for it
await new Promise(r => setTimeout(r, 350));
ok('source change triggers rebuild', rebuildCount > initial,
  `rebuildCount: initial=${initial} now=${rebuildCount}`);

// Write to .nimbus/kv/* — must NOT trigger
const before = rebuildCount;
for (let i = 0; i < 20; i++) {
  vfs.writeFile('home/user/.nimbus/kv/MY_KV/key-' + i, 'value-' + i);
}
await new Promise(r => setTimeout(r, 350));
eq('.nimbus/kv writes do NOT trigger rebuild', rebuildCount, before);

// Write to .nimbus/r2/* — must NOT trigger
for (let i = 0; i < 5; i++) {
  vfs.writeFile('home/user/.nimbus/r2/BUCKET/asset-' + i, 'data-' + i);
  vfs.writeFile('home/user/.nimbus/r2/BUCKET/asset-' + i + '.meta', '{}');
}
await new Promise(r => setTimeout(r, 350));
eq('.nimbus/r2 writes do NOT trigger rebuild', rebuildCount, before);

// node_modules writes still skipped (existing behavior must survive)
vfs.writeFile('home/user/node_modules/foo/index.js', 'module.exports = 1;');
await new Promise(r => setTimeout(r, 350));
eq('node_modules writes do NOT trigger rebuild', rebuildCount, before);

summary('w10/regression/nimbus-paths-not-watched');
