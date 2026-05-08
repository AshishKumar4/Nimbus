// W10 functional: NimbusWrangler.buildInnerEnv injects KV/D1/R2 bindings
// when present in wrangler.jsonc.
//
// We invoke the synthesis path WITHOUT calling start() — just construct the
// instance and call the test seam `_buildInnerEnvForTest()` (added during
// the build phase). This isolates the synthesis from the esbuild + LOADER
// path, which we test elsewhere.

import { ok, eq, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { NimbusWrangler } from '../../../../src/wrangler/nimbus-wrangler.ts';

const vfs = makeMockVfs();
vfs.writeFile('home/user/wrangler.jsonc', JSON.stringify({
  name: 'demo-worker',
  main: 'src/index.ts',
  compatibility_date: '2026-04-01',
  vars: { GREETING: 'hello' },
  kv_namespaces: [{ binding: 'CACHE', id: 'fake-id' }],
  d1_databases: [{ binding: 'DB', database_id: 'fake-d1', database_name: 'mydb' }],
  r2_buckets: [{ binding: 'STORE', bucket_name: 'mybucket' }],
}));
vfs.writeFile('home/user/src/index.ts', 'export default { fetch() { return new Response("hi"); } };');

const { sql } = makeMockSql();

// Construct the NimbusWrangler with a no-op loader env so start() would no-op,
// but invoke the test seam directly.
const wr = new NimbusWrangler({
  vfs,
  esbuild: { build: async () => ({ outputFiles: [], errors: [], warnings: [] }) },
  env: { LOADER: { load: () => ({ getEntrypoint: () => null, getDurableObjectClass: () => null }) } },
  ctx: {
    id: { toString: () => 'do-id-test' },
    storage: { sql },
    exports: {},
  },
  root: 'home/user',
  onLog: () => {},
  onHmrMessage: () => {},
});

// readConfig + buildInnerEnv — both need to be exposed via test seams.
const readOk = wr._readConfigForTest();
ok('readConfig parses wrangler.jsonc', readOk === true);

const env = wr._buildInnerEnvForTest();

ok('env.GREETING from vars', env.GREETING === 'hello');
ok('env.CACHE present (KV)', !!env.CACHE);
ok('env.CACHE has .get', typeof env.CACHE.get === 'function');
ok('env.CACHE has .put', typeof env.CACHE.put === 'function');
ok('env.CACHE has .list', typeof env.CACHE.list === 'function');
ok('env.CACHE has .delete', typeof env.CACHE.delete === 'function');
ok('env.CACHE has .getWithMetadata', typeof env.CACHE.getWithMetadata === 'function');

ok('env.DB present (D1)', !!env.DB);
ok('env.DB has .prepare', typeof env.DB.prepare === 'function');
ok('env.DB has .batch', typeof env.DB.batch === 'function');
ok('env.DB has .exec', typeof env.DB.exec === 'function');

ok('env.STORE present (R2)', !!env.STORE);
ok('env.STORE has .get', typeof env.STORE.get === 'function');
ok('env.STORE has .put', typeof env.STORE.put === 'function');
ok('env.STORE has .head', typeof env.STORE.head === 'function');
ok('env.STORE has .list', typeof env.STORE.list === 'function');
ok('env.STORE has .delete', typeof env.STORE.delete === 'function');

// Object.keys must enumerate them (workerd serializes via JsRpcTarget +
// users frequently introspect env)
const keys = Object.keys(env);
ok('env keys include GREETING', keys.includes('GREETING'));
ok('env keys include CACHE', keys.includes('CACHE'));
ok('env keys include DB', keys.includes('DB'));
ok('env keys include STORE', keys.includes('STORE'));

summary('w10/functional/env-bindings-injection');
