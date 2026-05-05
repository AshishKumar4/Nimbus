// W10 regression: hot reload latency on file save < 500 ms target.
//
// The clock here is wall-clock between the source-file mutation and the
// (mocked) rebuild completing. Real esbuild takes 50-200ms; we mock it as
// a 50ms delay to verify the framework's debounce + rebuild scheduling
// stays inside budget.

import { ok, lte, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { NimbusWrangler } from '../../../../src/nimbus-wrangler.ts';

const vfs = makeMockVfs();
vfs.writeFile('home/user/wrangler.jsonc', JSON.stringify({
  name: 'lat',
  main: 'src/index.ts',
}));
vfs.writeFile('home/user/src/index.ts', 'export default { fetch() {} };');

const rebuildTimestamps = [];
const wr = new NimbusWrangler({
  vfs,
  esbuild: {
    build: async () => {
      // Realistic-ish esbuild simulated delay
      await new Promise(r => setTimeout(r, 50));
      return { outputFiles: [{ contents: new Uint8Array([0]) }], errors: [], warnings: [] };
    },
  },
  env: {
    LOADER: { load: () => ({
      getEntrypoint: () => ({ fetch: async () => new Response('hi') }),
      getDurableObjectClass: () => null,
    }) },
  },
  ctx: { id: { toString: () => 'do-id' }, exports: {}, storage: makeMockSql().storage },
  root: 'home/user',
  onLog: () => {},
  onHmrMessage: () => { rebuildTimestamps.push(Date.now()); },
});

wr._installWatchersForTest();

const t0 = Date.now();
vfs.writeFile('home/user/src/index.ts', 'export default { fetch() { return new Response("v2"); } };');

// Wait for the rebuild
const deadline = Date.now() + 1500;
while (rebuildTimestamps.length === 0 && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 25));
}
ok('rebuild fired within deadline', rebuildTimestamps.length > 0);

const latency = rebuildTimestamps[0] - t0;
console.log(`  # observed latency: ${latency}ms`);
lte('latency < 500ms target', latency, 500);

// Run a second cycle to verify debouncing of rapid saves
rebuildTimestamps.length = 0;
const t1 = Date.now();
for (let i = 0; i < 5; i++) {
  vfs.writeFile('home/user/src/index.ts', `export default { fetch() { return new Response("v${i}"); } };`);
  await new Promise(r => setTimeout(r, 20));  // < debounce window
}
// Wait for the (single) coalesced rebuild
while (rebuildTimestamps.length === 0 && Date.now() - t1 < 1500) {
  await new Promise(r => setTimeout(r, 25));
}
ok('5 rapid saves coalesced into one rebuild', rebuildTimestamps.length === 1,
  `count: ${rebuildTimestamps.length}`);

summary('w10/regression/hot-reload-latency');
