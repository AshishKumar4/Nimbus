#!/usr/bin/env bun
// What a run says about the account's container storage, read from a
// registry and Containers API that answer as Cloudflare's do: the total
// counts a layer once however many manifests share it; a snapshot is held by
// the application whose instance took it, an image by its repository; a
// manifest is read once, then kept by digest; and a total grown 10 GB or
// more since the last run is a warning.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeContainerStorage, readContainerStorage } from '../../scripts/ci/lib/container-storage.mjs';

const GB = 1e9;
const SNAPSHOTS = 'acct/cloudchamber-snapshots/abc';
const manifests = {
  'sha256:m1': { layers: [{ digest: 'sha256:l1', size: 3 * GB }], config: { digest: 'sha256:c1', size: 1000 }, annotations: { 'io.cloudflare.cloudchamber.deployment_id': 'instance-a' } },
  // Shares l1 with m1: counted once.
  'sha256:m2': { layers: [{ digest: 'sha256:l1', size: 3 * GB }, { digest: 'sha256:l2', size: 5 * GB }], annotations: { 'io.cloudflare.cloudchamber.deployment_id': 'instance-gone' } },
  'sha256:m3': { layers: [{ digest: 'sha256:l3', size: 2 * GB }] },
};
let manifestReads = 0;
let catalog = { [SNAPSHOTS]: ['rootfs-snapshot-x', 'sha256:m1', 'sha256:m2'], 'acct/kernel': ['latest', 'sha256:m3'] };
const json = (body, init = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...init.headers }, status: init.status ?? 200 });
async function registry(url, init = {}) {
  const { pathname, searchParams } = new URL(url);
  if (pathname.endsWith('/registries/registry.cloudflare.com/credentials')) {
    assert.deepEqual(JSON.parse(init.body).permissions, ['pull'], 'pull-only credentials');
    return json({ success: true, result: { username: 'u', password: 'p' } });
  }
  if (pathname === '/v2/_catalog') {
    assert.equal(init.headers.authorization, `Basic ${btoa('u:p')}`);
    // Two pages: the registry's link names the next page's cursor.
    const [first, ...rest] = Object.entries(catalog);
    return searchParams.get('last') === 'page-2'
      ? json({ repositories: Object.fromEntries(rest) })
      : json({ repositories: Object.fromEntries([first]) }, { headers: { link: '</v2/_catalog?tags=true&last=page-2>; rel="next"' } });
  }
  const manifest = /\/manifests\/(sha256:\w+)$/.exec(pathname)?.[1];
  if (manifest !== undefined) {
    manifestReads++;
    return manifests[manifest] ? json(manifests[manifest]) : json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, { status: 404 });
  }
  if (pathname.endsWith('/containers/applications')) return json({ success: true, result: [{ id: 'app-1', name: 'dewml-preparer' }] });
  if (pathname.endsWith('/containers/applications/app-1/instances')) return json({ success: true, result: { instances: [{ id: 'instance-a' }] } });
  throw new Error(`unexpected ${url}`);
}

const cacheDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'container-storage-'));
try {
  const read = () => readContainerStorage({ account: 'acct', token: 't', cacheDir, fetch: registry });
  const first = await read();
  assert.equal(first.total, 10 * GB + 1000, 'each layer once');
  assert.deepEqual(first.holders, [
    { name: 'snapshots of instances no longer listed', bytes: 5 * GB },
    { name: 'snapshots of dewml-preparer', bytes: 3 * GB + 1000 },
    { name: 'image kernel', bytes: 2 * GB },
  ]);
  assert.equal(first.read, 3);
  console.log('  ✓ the total counts a shared layer once; holders by application and repository');

  const again = await read();
  assert.equal(again.read, 0, 'a manifest already read is not read again');
  assert.equal(again.total, first.total);
  console.log('  ✓ manifests are read once, by digest');

  // A manifest deleted between the listing and its read holds nothing.
  catalog = { ...catalog, [SNAPSHOTS]: [...catalog[SNAPSHOTS], 'sha256:gone'] };
  assert.equal((await read()).total, first.total);
  console.log('  ✓ a manifest gone since the listing holds nothing');

  let now = Date.parse('2026-10-19T10:00:00Z');
  const say = (usage) => describeContainerStorage(usage, { cacheDir, now: now += 60_000 });
  const firstSaid = say({ ...first, total: 100 * GB });
  assert.equal(firstSaid.length, 1);
  assert.match(firstSaid[0], /^container storage: 100\.0 GB; most held by snapshots of instances no longer listed 5\.0 GB/);
  assert.equal(say({ ...first, total: 109 * GB }).length, 1, '9 GB of growth is said, not warned about');
  const grown = say({ ...first, total: 120 * GB });
  assert.match(grown[0], /\+11\.0 GB since the run at /);
  assert.match(grown[1], /WARNING: it grew 11\.0 GB since the last run/);
  assert.match(say({ ...first, total: 60 * GB })[0], /−60\.0 GB since/, 'a total that fell says so');
  console.log('  ✓ a total grown 10 GB or more since the last run is warned about');
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
console.log('ci-container-storage: ok');
