// Guards the `__name` break that took down prod git clone ("Failed to load
// bundled isomorphic-git: __name is not defined"). wrangler bundles the worker
// with keepNames, so a function the git facet embedded with `${fn.toString()}`
// carried bare `__name(` calls whose helper lives elsewhere in the worker's
// bundle, and threw inside the facet isolate.
//
// The facet now embeds no function by toString(): its retry client
// (retryingGitHttp, git/pack/transport.ts) and every other helper come in
// self-contained esbuild bundles (GIT_PACK_SRC, the wave writer). So:
//   - the facet template has no `.toString()}` embed;
//   - a bundle the facet splices calls `__name(` only if it declares it;
//   - the idempotent globalThis.__name shim still precedes the facet's code;
//   - the spliced retry client retries a transient status with no __name in
//     the isolate.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { GIT_PACK_SRC } from '../../packages/worker/src/git/pack/facet.generated.ts';

const FACET_NAME_SHIM =
  'if (typeof globalThis.__name !== "function") {\n' +
  '  globalThis.__name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });\n' +
  '}';

const template = readFileSync(new URL('../../packages/worker/src/git/network-facet.ts', import.meta.url), 'utf8');
assert.ok(!/\.toString\(\)\}/.test(template), 'the facet template embeds a function by toString()');

const facet = assembleGitNetworkFacetSource();
assert.ok(facet.includes(FACET_NAME_SHIM), 'assembled git facet is missing the idempotent globalThis.__name shim');
for (const [name, source] of [['GIT_PACK_SRC', GIT_PACK_SRC]]) {
  assert.ok(facet.includes(source), name + ' is not spliced into the facet');
  if (source.includes('__name(')) assert.ok(/\bvar __name\b/.test(source), name + ' calls __name( without declaring it');
}

// The pack bundle as the facet isolate runs it: no __name anywhere.
assert.equal(typeof globalThis.__name, 'undefined', 'globalThis.__name unexpectedly predefined');
// (Its node imports, which the facet module makes first, are the host's here.)
const pack = new Function('__nimbusNodeCrypto', '__nimbusNodeZlib', `${GIT_PACK_SRC}\nreturn __nimbusGitPack;`)(
  await import('node:crypto'), await import('node:zlib'));
const calls = [];
const outcomes = [{ statusCode: 522 }, { statusCode: 200 }];
const http = pack.retryingGitHttp({ async request(req) { calls.push(req); return outcomes[calls.length - 1]; } }, [1, 1]);
const response = await http.request({ method: 'GET', url: 'https://example.com/project.git/info/refs?service=git-upload-pack' });
assert.equal(response.statusCode, 200, 'the spliced retry client did not surface the retried 200');
assert.equal(calls.length, 2, 'the spliced retry client did not retry the transient 522');

console.log('git-network-facet name shim: ok');
