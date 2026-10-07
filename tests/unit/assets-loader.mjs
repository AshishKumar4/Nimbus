#!/usr/bin/env bun
/**
 * loadAssetBytes / loadAssetText: one fetch per path per isolate, the
 * missing-binding, 404 and non-2xx refusals, and eviction on failure so the
 * next call refetches.
 */

import assert from 'node:assert/strict';
import {
  loadAssetBytes,
  loadAssetText,
  NimbusAssetLoadError,
  _resetAssetsCacheForTests,
} from '../../packages/core/src/runtime/assets-loader.ts';

function fetcher(responses) {
  const calls = [];
  return {
    calls,
    async fetch(url) {
      calls.push(url);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch ${url}`);
      return new Response(next.body ?? null, { status: next.status ?? 200 });
    },
  };
}

_resetAssetsCacheForTests();

{
  const assets = fetcher([{ body: new Uint8Array([1, 2, 3]) }]);
  const [a, b] = await Promise.all([
    loadAssetBytes(assets, '/_assets/x.bin'),
    loadAssetBytes(assets, '/_assets/x.bin'),
  ]);
  assert.deepEqual([...a], [1, 2, 3]);
  assert.equal(a, b, 'concurrent callers share one promise');
  assert.deepEqual(assets.calls, ['https://assets.invalid/_assets/x.bin']);
  assert.ok(a instanceof Uint8Array);
}

{
  const assets = fetcher([{ body: 'héllo' }]);
  assert.equal(await loadAssetText(assets, '/_assets/x.txt'), 'héllo');
  assert.equal(await loadAssetText(assets, '/_assets/x.txt'), 'héllo');
  assert.equal(assets.calls.length, 1, 'text is cached too');
}

{
  const assets = fetcher([{ status: 404 }, { body: 'later' }]);
  await assert.rejects(loadAssetText(assets, '/_assets/gone.txt'), (err) => {
    assert.ok(err instanceof NimbusAssetLoadError);
    assert.equal(err.code, 'E_ASSET_NOT_FOUND');
    assert.equal(err.status, 404);
    assert.equal(err.path, '/_assets/gone.txt');
    return true;
  });
  assert.equal(await loadAssetText(assets, '/_assets/gone.txt'), 'later', 'a failure is evicted');
}

{
  const assets = fetcher([{ status: 503 }]);
  await assert.rejects(loadAssetBytes(assets, '/_assets/busy.bin'), (err) => {
    assert.equal(err.code, 'E_ASSET_FETCH_FAILED');
    assert.equal(err.status, 503);
    assert.equal(err.message, 'Asset fetch failed: /_assets/busy.bin → 503');
    return true;
  });
}

for (const load of [loadAssetBytes, loadAssetText]) {
  await assert.rejects(load(undefined, '/_assets/x'), (err) => err.code === 'E_ASSETS_BINDING_MISSING');
  await assert.rejects(load({}, '/_assets/x'), (err) => err.code === 'E_ASSETS_BINDING_MISSING');
}

_resetAssetsCacheForTests();
console.log('assets-loader: ok');
