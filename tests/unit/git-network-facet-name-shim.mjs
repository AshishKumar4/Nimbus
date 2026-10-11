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
//   - the bundle's retry client retries a transient status with no __name in
//     the isolate.

import assert from 'node:assert/strict';

import { GIT_PACK_SRC } from '../../packages/worker/src/git/pack/facet.generated.ts';

if (GIT_PACK_SRC.includes('__name(')) assert.ok(/\bvar __name\b/.test(GIT_PACK_SRC), 'GIT_PACK_SRC calls __name( without declaring it');

// The pack bundle as the facet isolate runs it: no __name anywhere.
assert.equal(typeof globalThis.__name, 'undefined', 'globalThis.__name unexpectedly predefined');
// (Its node imports, which the facet module makes first, are the host's here.)
const pack = new Function('__nimbusNodeCrypto', '__nimbusNodeZlib', `${GIT_PACK_SRC}\nreturn __nimbusGitPack;`)(
  await import('node:crypto'), await import('node:zlib'));
assert.equal(typeof pack.networkWorker.fetch, 'function', 'the bundle exports the facet\'s worker');
const calls = [];
const outcomes = [{ statusCode: 522 }, { statusCode: 200 }];
const http = pack.retryingGitHttp({ async request(req) { calls.push(req); return outcomes[calls.length - 1]; } }, [1, 1]);
const response = await http.request({ method: 'GET', url: 'https://example.com/project.git/info/refs?service=git-upload-pack' });
assert.equal(response.statusCode, 200, 'the spliced retry client did not surface the retried 200');
assert.equal(calls.length, 2, 'the spliced retry client did not retry the transient 522');

console.log('git-network-facet name shim: ok');
