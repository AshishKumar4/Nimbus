// W10 regression: vars/services/assets/worker_loaders/durable_objects
// synthesis is unchanged. We construct NimbusWrangler with a config
// exercising each existing binding and verify the buildInnerEnv test seam
// returns sensible bindings.

import { ok, eq, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { NimbusWrangler } from '../../../../src/nimbus-wrangler.ts';

const vfs = makeMockVfs();
vfs.writeFile('home/user/wrangler.jsonc', JSON.stringify({
  name: 'mixed-bindings',
  main: 'src/main.ts',
  vars: { API_KEY: 'sk-test', GREETING: 'hi' },
  // services intentionally omitted (would warn that they're not in outer env)
  // assets / worker_loaders / durable_objects all need ctx.exports —
  // we provide a stubbed ctx.exports.
}));
vfs.writeFile('home/user/src/main.ts', 'export default { fetch: () => new Response("hi") };');

// Mock ctx.exports.NimbusAssetsRPC etc.: each is a fn returning a stub.
const stubBinding = (name) => ({ __stub: name });
const ctxExports = {
  NimbusAssetsRPC: ({ props }) => stubBinding('assets:' + JSON.stringify(props)),
  NimbusLoaderRPC: ({ props }) => stubBinding('loader:' + JSON.stringify(props)),
  NimbusDurableObjectNamespace: ({ props }) => stubBinding('do:' + JSON.stringify(props)),
};
const { sql } = makeMockSql();

const wr = new NimbusWrangler({
  vfs,
  esbuild: { build: async () => ({ outputFiles: [], errors: [], warnings: [] }) },
  env: { LOADER: { load: () => ({ getEntrypoint: () => null, getDurableObjectClass: () => null }) } },
  ctx: { id: { toString: () => 'do-id' }, exports: ctxExports, storage: { sql } },
  root: 'home/user',
  onLog: () => {},
  onHmrMessage: () => {},
});
wr._readConfigForTest();

const env = wr._buildInnerEnvForTest();
eq('vars.API_KEY', env.API_KEY, 'sk-test');
eq('vars.GREETING', env.GREETING, 'hi');
ok('no synth bindings when not configured: env.ASSETS undefined', env.ASSETS === undefined);
ok('no synth bindings when not configured: env.MY_KV undefined', env.MY_KV === undefined);

// Now flip on assets + worker_loaders + durable_objects:
vfs.writeFile('home/user/wrangler.jsonc', JSON.stringify({
  name: 'mixed-bindings',
  main: 'src/main.ts',
  vars: { API_KEY: 'sk-test' },
  assets: { directory: 'public', binding: 'ASSETS' },
  worker_loaders: [{ binding: 'INNER_LOADER' }],
  // durable_objects synthesis requires extracting classes from the loaded
  // worker (probe load); we skip that one in this regression and rely on
  // the dedicated env-bindings-injection probe.
}));
const wr2 = new NimbusWrangler({
  vfs,
  esbuild: { build: async () => ({ outputFiles: [], errors: [], warnings: [] }) },
  env: { LOADER: { load: () => ({ getEntrypoint: () => null, getDurableObjectClass: () => null }) } },
  ctx: { id: { toString: () => 'do-id' }, exports: ctxExports, storage: { sql } },
  root: 'home/user',
  onLog: () => {},
  onHmrMessage: () => {},
});
wr2._readConfigForTest();
const env2 = wr2._buildInnerEnvForTest();
ok('env2.ASSETS synthesized', !!env2.ASSETS);
ok('env2.INNER_LOADER synthesized', !!env2.INNER_LOADER);
eq('env2.API_KEY survives W10 changes', env2.API_KEY, 'sk-test');

summary('w10/regression/nimbus-wrangler-existing-bindings-still-work');
