// W10 e2e: full inner-Worker → KV → response cycle, using a mock LOADER
// that runs the user's worker code as a JS function (NOT real workerd).
//
// This is unit-level e2e: it exercises NimbusWrangler.start() →
// readConfig() → buildAndLoad() → buildInnerEnv() → workerStub.fetch()
// without any actual workerd isolate creation. The real-workerd e2e is
// gated by NIMBUS_W10_E2E_PROD and runs against a deployed Nimbus.

import { ok, eq, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { NimbusWrangler } from '../../../../src/nimbus-wrangler.ts';

// Worker source — uses env.MY_KV
const workerSrc = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'PUT') {
      const body = await request.text();
      await env.MY_KV.put(url.pathname.slice(1), body);
      return new Response('ok');
    }
    if (request.method === 'GET') {
      const v = await env.MY_KV.get(url.pathname.slice(1));
      return new Response(v ?? 'null');
    }
    return new Response('method?', { status: 405 });
  }
};
`;

const vfs = makeMockVfs();
vfs.writeFile('home/user/wrangler.jsonc', JSON.stringify({
  name: 'kv-demo', main: 'src/worker.js',
  kv_namespaces: [{ binding: 'MY_KV' }],
}));
vfs.writeFile('home/user/src/worker.js', workerSrc);

// Mock esbuild — return the source as-is (it's already a single file ESM).
const esbuild = {
  build: async () => ({
    outputFiles: [{ contents: new TextEncoder().encode(workerSrc) }],
    errors: [], warnings: [],
  }),
};

// Mock LOADER.load: imports the module via data URL, returns a stub with
// fetch + env injection. NOTE: data: URL importing requires Bun, and we
// receive `env` from baseWorkerCode.env (W10 will be passing innerEnv there).
const loaderLoadCalls = [];
const env = {
  LOADER: {
    load(spec) {
      loaderLoadCalls.push(spec);
      const innerEnv = spec.env || {};
      const code = new TextDecoder().decode(spec.modules['worker.js']);
      // Lazy module load — Bun supports data: URL ESM
      const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
      let modPromise = null;
      const getMod = () => {
        if (!modPromise) modPromise = import(dataUrl);
        return modPromise;
      };
      return {
        getEntrypoint() {
          return {
            async fetch(req) {
              const mod = await getMod();
              return mod.default.fetch(req, innerEnv, {});
            },
          };
        },
        getDurableObjectClass() { return null; },
      };
    },
  },
};

const { sql } = makeMockSql();
const wr = new NimbusWrangler({
  vfs, esbuild, env,
  ctx: { id: { toString: () => 'test-do' }, exports: {}, storage: { sql } },
  root: 'home/user',
  onLog: () => {},
  onHmrMessage: () => {},
});

const started = await wr.start();
ok('NimbusWrangler.start succeeded', started === true);
ok('LOADER.load was called', loaderLoadCalls.length >= 1);

const lastLoad = loaderLoadCalls[loaderLoadCalls.length - 1];
ok('LOADER.load received env.MY_KV', !!lastLoad.env?.MY_KV);
ok('LOADER.load env.MY_KV has .get', typeof lastLoad.env.MY_KV.get === 'function');

// PUT a value via the worker
const putResp = await wr.handleRequest(new Request('https://nimbus.test/foo', {
  method: 'PUT', body: 'bar',
}), '/foo');
eq('PUT status', putResp.status, 200);
eq('PUT body', await putResp.text(), 'ok');

// GET it back
const getResp = await wr.handleRequest(new Request('https://nimbus.test/foo'), '/foo');
eq('GET status', getResp.status, 200);
eq('GET body roundtrip', await getResp.text(), 'bar');

// Verify VFS layout
ok('VFS contains the KV blob',
  vfs.exists('home/user/.nimbus/kv/MY_KV/foo'),
  'files: ' + [...vfs.files.keys()].join(','));

wr.stop();
summary('w10/e2e/kv-roundtrip-e2e');
