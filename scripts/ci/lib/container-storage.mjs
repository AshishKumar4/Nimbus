// What the account's container registry holds: every armada environment
// snapshot (and any other product's), and every container image. Read with
// pull-only registry credentials, so it can delete nothing. Each manifest is
// read once: a digest names fixed bytes, so its layers are kept in a cache
// under NIMBUS_STATE, and a run reads only the catalog and the manifests new
// since the last.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';
const REGISTRY = 'https://registry.cloudflare.com/v2';
const ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');
/** The catalog pages its names; past this many pages, no account's catalog goes. */
const CATALOG_PAGES = 100;
/** Growth since the last recorded run that is said as a warning. */
export const STORAGE_GROWTH_WARNING_BYTES = 10e9;
const SNAPSHOTS = /\/cloudchamber-snapshots\//;

/**
 * @typedef {{ layers: [string, number][], instance: string | null }} SizedManifest
 * @typedef {{ name: string, bytes: number }} Holder
 * @typedef {{ total: number, holders: Holder[], read: number }} Usage
 */

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};

/**
 * The registry's usage: its total (each layer once, however many manifests
 * share it) and its holders, largest first. A snapshot is held by the
 * application whose instance took it (the Containers API's instance
 * listing), or by "snapshots of instances no longer listed"; an image by its
 * repository. `read` is how many manifests this call read (the rest came
 * from the cache).
 *
 * @param {{ account: string, token: string, cacheDir: string, fetch?: typeof fetch }} options
 * @returns {Promise<Usage>}
 */
export async function readContainerStorage({ account, token, cacheDir, fetch: get = fetch }) {
  const api = async (path, init = {}) => {
    const response = await get(`${API}/accounts/${account}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
    const body = await response.json();
    if (!response.ok || body.success === false) throw new Error(`${path} answered ${response.status}: ${JSON.stringify(body.errors ?? body).slice(0, 200)}`);
    return body.result;
  };
  const minted = await api('/containers/registries/registry.cloudflare.com/credentials', {
    method: 'POST', body: JSON.stringify({ expiration_minutes: 5, permissions: ['pull'] }),
  });
  const authorization = `Basic ${btoa(`${minted.username}:${minted.password}`)}`;

  // Every manifest is listed under its digest, a tagged one under its tags too.
  const digests = new Map();
  let cursor;
  for (let page = 0; ; page += 1) {
    if (page === CATALOG_PAGES) throw new Error(`the registry's catalog ran past ${CATALOG_PAGES} pages`);
    const listed = await get(`${REGISTRY}/_catalog?tags=true${cursor === undefined ? '' : `&last=${cursor}`}`, { headers: { authorization } });
    if (!listed.ok) throw new Error(`the catalog answered ${listed.status}`);
    for (const [repository, names] of Object.entries((await listed.json()).repositories ?? {})) {
      for (const name of names ?? []) if (name.startsWith('sha256:')) digests.set(name, repository);
    }
    const next = /[?&]last=([^&;>\s]+)/u.exec(listed.headers.get('link') ?? '')?.[1];
    if (next === undefined || next === cursor) break;
    cursor = next;
  }

  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, 'manifests.json');
  /** @type {Record<string, SizedManifest>} */
  const cache = readJson(cachePath, {});
  let read = 0;
  for (const [digest, repository] of digests) {
    if (cache[digest] !== undefined) continue;
    const answered = await get(`${REGISTRY}/${repository}/manifests/${digest}`, { headers: { authorization, accept: ACCEPT } });
    // Deleted since the listing: it holds nothing now.
    if (answered.status === 404) continue;
    if (!answered.ok) throw new Error(`manifest ${digest} answered ${answered.status}`);
    const manifest = await answered.json();
    const layers = [...(manifest.layers ?? []), ...(manifest.config ? [manifest.config] : [])].map((layer) => [layer.digest, layer.size ?? 0]);
    cache[digest] = { layers, instance: manifest.annotations?.['io.cloudflare.cloudchamber.deployment_id'] ?? null };
    read += 1;
  }
  // The cache keeps only what the registry still holds.
  writeFileSync(cachePath, `${JSON.stringify(Object.fromEntries([...digests.keys()].filter((digest) => cache[digest] !== undefined).map((digest) => [digest, cache[digest]])))}\n`);

  const owners = new Map();
  for (const application of await api('/containers/applications')) {
    const { instances = [] } = await api(`/containers/applications/${application.id}/instances`) ?? {};
    for (const instance of instances) owners.set(instance.id, application.name);
  }
  const layerHolder = new Map();
  for (const [digest, repository] of digests) {
    const sized = cache[digest];
    if (sized === undefined) continue;
    const holder = SNAPSHOTS.test(repository)
      ? `snapshots of ${owners.get(sized.instance ?? '') ?? 'instances no longer listed'}`
      : `image ${repository.split('/').slice(1).join('/')}`;
    for (const [layer, size] of sized.layers) if (!layerHolder.has(layer)) layerHolder.set(layer, { holder, size });
  }
  const held = new Map();
  let total = 0;
  for (const { holder, size } of layerHolder.values()) {
    total += size;
    held.set(holder, (held.get(holder) ?? 0) + size);
  }
  return { total, holders: [...held].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes), read };
}

/**
 * What a run says about `usage`: the total, its change since the last
 * recorded run (recorded in `cacheDir`, then replaced by this one), the top
 * holders, and a warning when the total grew by STORAGE_GROWTH_WARNING_BYTES
 * or more.
 *
 * @param {Usage} usage
 * @param {{ cacheDir: string, now?: number, top?: number }} options
 * @returns {string[]}
 */
export function describeContainerStorage(usage, { cacheDir, now = Date.now(), top = 5 }) {
  const lastPath = join(cacheDir, 'last.json');
  const last = readJson(lastPath, null);
  writeFileSync(lastPath, `${JSON.stringify({ total: usage.total, at: new Date(now).toISOString() })}\n`);
  const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
  const grew = last === null ? null : usage.total - last.total;
  const lines = [`container storage: ${gb(usage.total)}${grew === null ? '' : ` (${grew >= 0 ? '+' : '−'}${gb(Math.abs(grew))} since the run at ${last.at})`}; most held by ${usage.holders.slice(0, top).map((holder) => `${holder.name} ${gb(holder.bytes)}`).join(', ')}`];
  if (grew !== null && grew >= STORAGE_GROWTH_WARNING_BYTES) {
    lines.push(`container storage WARNING: it grew ${gb(grew)} since the last run; the account's snapshots and images are limited (armada prune; an image's \`wrangler containers delete\`)`);
  }
  return lines;
}
