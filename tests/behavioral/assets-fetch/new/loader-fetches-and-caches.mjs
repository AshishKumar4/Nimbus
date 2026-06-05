#!/usr/bin/env bun
// assets-fetch/new/loader-fetches-and-caches — loadAssetText fetches
// from the ASSETS Fetcher exactly once per path; subsequent calls
// return from the per-isolate cache without hitting the binding.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('assets-fetch/new/loader-fetches-and-caches');

const { loadAssetText, loadAssetBytes, _resetAssetsCacheForTests, NimbusAssetLoadError } =
  await import('../../../../packages/worker/src/runtime/assets-loader.ts');

_resetAssetsCacheForTests();

// Fake ASSETS binding that counts fetch invocations.
function makeFakeAssets(handler) {
  let calls = 0;
  return {
    fetch: async (input, init) => {
      calls++;
      return handler(input, init);
    },
    get calls() { return calls; },
  };
}

// 1. First call fetches; second call hits the cache.
{
  const assets = makeFakeAssets(async (url) => {
    const u = new URL(url.toString());
    if (u.pathname === '/_assets/hello.txt') {
      return new Response('hello-world', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  const first = await loadAssetText(assets, '/_assets/hello.txt');
  a.check('first call returns content', first === 'hello-world');
  a.check('first call invoked fetch once', assets.calls === 1, `calls=${assets.calls}`);
  const second = await loadAssetText(assets, '/_assets/hello.txt');
  a.check('second call returns same content', second === 'hello-world');
  a.check('second call did NOT re-fetch', assets.calls === 1, `calls=${assets.calls}`);
}

_resetAssetsCacheForTests();

// 2. Concurrent calls share the same fetch promise.
{
  const assets = makeFakeAssets(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return new Response('shared', { status: 200 });
  });
  const [r1, r2, r3] = await Promise.all([
    loadAssetText(assets, '/_assets/shared.txt'),
    loadAssetText(assets, '/_assets/shared.txt'),
    loadAssetText(assets, '/_assets/shared.txt'),
  ]);
  a.check('concurrent results identical', r1 === 'shared' && r2 === 'shared' && r3 === 'shared');
  a.check('concurrent calls deduped to one fetch', assets.calls === 1, `calls=${assets.calls}`);
}

_resetAssetsCacheForTests();

// 3. 404 throws NimbusAssetLoadError with code E_ASSET_NOT_FOUND.
{
  const assets = makeFakeAssets(async () => new Response('nope', { status: 404 }));
  try {
    await loadAssetText(assets, '/_assets/missing.txt');
    a.check('404 throws', false, 'did not throw');
  } catch (e) {
    a.check('404 throws NimbusAssetLoadError', e instanceof NimbusAssetLoadError);
    a.check('404 code === E_ASSET_NOT_FOUND', e.code === 'E_ASSET_NOT_FOUND');
    a.check('404 status === 404', e.status === 404);
  }
}

_resetAssetsCacheForTests();

// 4. Failure is NOT cached — subsequent calls retry.
{
  let attempts = 0;
  const assets = makeFakeAssets(async () => {
    attempts++;
    if (attempts === 1) return new Response('', { status: 500 });
    return new Response('recovered', { status: 200 });
  });
  try {
    await loadAssetText(assets, '/_assets/flake.txt');
  } catch { /* expected first time */ }
  // Give the failed-promise eviction a microtask.
  await Promise.resolve();
  const result = await loadAssetText(assets, '/_assets/flake.txt');
  a.check('failure not cached; retry succeeds', result === 'recovered',
    `attempts=${attempts}`);
}

_resetAssetsCacheForTests();

// 5. Missing binding → NimbusAssetLoadError with code E_ASSETS_BINDING_MISSING.
{
  try {
    await loadAssetText(undefined, '/_assets/x');
    a.check('undefined binding throws', false, 'did not throw');
  } catch (e) {
    a.check('undefined binding → NimbusAssetLoadError', e instanceof NimbusAssetLoadError);
    a.check('undefined binding code', e.code === 'E_ASSETS_BINDING_MISSING');
  }
}

// 6. loadAssetBytes returns a Uint8Array.
_resetAssetsCacheForTests();
{
  const assets = makeFakeAssets(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
  const bytes = await loadAssetBytes(assets, '/_assets/bin');
  a.check('loadAssetBytes returns Uint8Array', bytes instanceof Uint8Array);
  a.check('loadAssetBytes content roundtrips',
    bytes.length === 4 && bytes[0] === 1 && bytes[3] === 4,
    `actual=[${Array.from(bytes).join(',')}]`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
