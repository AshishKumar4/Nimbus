// Guards the `__name` break that took down prod git clone ("Failed to load
// bundled isomorphic-git: __name is not defined"). wrangler bundles the worker
// with keepNames, so a function the git facet embedded with `${fn.toString()}`
// carried bare `__name(` calls whose helper lives elsewhere in the worker's
// bundle, and threw inside the facet isolate.
//
// The facet now embeds no function by toString(): it is one self-contained
// esbuild bundle (GIT_PACK_SRC, its worker git/pack/network-worker.ts). So:
//   - the bundle calls `__name(` only if it declares it;
//   - the facet's module is the bundle and the worker it exports;
//   - the bundle's smart-HTTP client (upload-pack.ts discover) retries a
//     transient status with no __name in the isolate.

import assert from 'node:assert/strict';

import { GIT_PACK_SRC } from '../../packages/worker/src/git/pack/facet.generated.ts';

if (GIT_PACK_SRC.includes('__name(')) assert.ok(/\bvar __name\b/.test(GIT_PACK_SRC), 'GIT_PACK_SRC calls __name( without declaring it');

// The pack bundle as the facet isolate runs it: no __name anywhere.
assert.equal(typeof globalThis.__name, 'undefined', 'globalThis.__name unexpectedly predefined');
// (Its node imports, which the facet module makes first, are the host's here.)
const pack = new Function('__nimbusNodeCrypto', '__nimbusNodeZlib', `${GIT_PACK_SRC}\nreturn __nimbusGitPack;`)(
  await import('node:crypto'), await import('node:zlib'));
assert.equal(typeof pack.networkWorker.fetch, 'function', 'the bundle exports the facet\'s worker');
const encoder = new TextEncoder();
const pkt = (line) => encoder.encode((line.length + 4).toString(16).padStart(4, '0') + line);
const advertisement = () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(pkt('# service=git-upload-pack\n'));
    controller.enqueue(encoder.encode('0000'));
    controller.enqueue(pkt('1'.repeat(40) + ' HEAD\0side-band-64k\n'));
    controller.enqueue(encoder.encode('0000'));
    controller.close();
  },
}), { status: 200 });
let calls = 0;
const fetch = async () => (++calls === 1 ? new Response('edge', { status: 522 }) : advertisement());
const discovered = await pack.discover({ url: 'https://example.com/project.git', fetch });
assert.equal(discovered.refs.get('HEAD'), '1'.repeat(40), 'the bundle\'s client did not surface the retried advertisement');
assert.equal(calls, 2, 'the bundle\'s client did not retry the transient 522');

console.log('git-network-facet name shim: ok');
