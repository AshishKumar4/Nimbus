// @serial
// The supervisor may drop its slice as RPC takes the arguments, not when
// the bundler eventually answers. Check the actual workerd serialization boundary.
import assert from 'node:assert/strict';
import { servePlainWorkerd } from './lib/plain-workerd.mjs';
import { CF_COMPAT_DATE } from '../../packages/platform/src/limits.ts';

const source = `import { WorkerEntrypoint } from 'cloudflare:workers';
export class Receiver extends WorkerEntrypoint {
  async prebundle(spec) {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { path: spec.slice[0].path, byte: spec.slice[0].bytes[0], count: spec.slice.length };
  }
}
export default { async fetch(request, env) {
  let spec = { slice: [{ path: '/a.js', bytes: new Uint8Array([7, 8]), isDir: false }] };
  const pending = env.RECEIVER.prebundle(spec);
  spec.slice[0].bytes[0] = 99;
  spec.slice.length = 0;
  spec = null;
  return Response.json(await pending);
} };`;
const served = await servePlainWorkerd({
  name: 'prebundle-rpc-transfer', files: { 'main.js': source },
  config: ({ port }) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "main.js", esModule = embed "main.js")],
      compatibilityDate = "${CF_COMPAT_DATE}",
      bindings = [(name = "RECEIVER", service = (name = "receiver", entrypoint = "Receiver"))],
    )),
    (name = "receiver", worker = (
      modules = [(name = "main.js", esModule = embed "main.js")],
      compatibilityDate = "${CF_COMPAT_DATE}",
    )),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`,
});
try {
  const response = await fetch(served.base, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, served.logs());
  assert.deepEqual(await response.json(), { path: '/a.js', byte: 7, count: 1 },
    'RPC owns an independent copy before its call returns, even while its answer is pending');
} finally { await served.stop(); }
console.log('prebundle-rpc-transfer-workerd: RPC takes its input at the call boundary');
