// What the account's container registry holds: every armada environment
// snapshot (and any other product's), and every container image. Read with
// pull-only registry credentials, so it can delete nothing. Each manifest is
// read once: a digest names fixed bytes, so its layers are kept in a cache
// (under the state directory, per account), and a run reads only the catalog
// and the manifests new since the last.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfApi } from './cloudflare-api.mjs';

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
 * @typedef {{ account: string, total: number, holders: Holder[], read: number }} Usage
 */

/** What `path` holds as JSON, or null when it holds none (absent, or not JSON). */
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

/** `value` written to `path` whole: a run reading it at once reads the old file or this one, never part of one. */
const writeJson = (path, value) => {
  const staged = `${path}.${randomUUID()}`;
  writeFileSync(staged, `${JSON.stringify(value)}\n`);
  renameSync(staged, path);
};

const isSized = (entry) => entry !== null && typeof entry === 'object' && Array.isArray(entry.layers)
  && entry.layers.every((layer) => Array.isArray(layer) && typeof layer[0] === 'string' && Number.isFinite(layer[1]))
  && (entry.instance === null || typeof entry.instance === 'string');

/**
 * The registry's usage: its total (each layer once, however many manifests
 * share it) and its holders, largest first. A snapshot is held by the
 * application whose instance took it (the Containers API's instance
 * listing), or by "snapshots of instances no longer listed"; an image by its
 * repository. `read` is how many manifests this call read (the rest came
 * from the cache).
 *
 * @param {{ account: string, token: string, stateDir: string, signal?: AbortSignal, fetch?: typeof fetch }} options
 * @returns {Promise<Usage>}
 */
export async function readContainerStorage({ account, token, stateDir, signal, fetch: get = globalThis.fetch }) {
  const api = async (path, call = {}) => {
    const answered = await cfApi(path, { account, token, signal, fetch: get, ...call });
    if (!answered.ok) throw new Error(`${path} answered ${answered.status}: ${JSON.stringify(answered.errors).slice(0, 200)}`);
    return answered.result;
  };
  const minted = await api('/containers/registries/registry.cloudflare.com/credentials', {
    method: 'POST', body: { expiration_minutes: 5, permissions: ['pull'] },
  });
  const authorization = `Basic ${btoa(`${minted.username}:${minted.password}`)}`;

  // Every manifest is listed under its digest, a tagged one under its tags
  // too, and one digest in every repository that holds it.
  /** @type {Map<string, string[]>} */
  const digests = new Map();
  let cursor;
  for (let page = 0; ; page += 1) {
    if (page === CATALOG_PAGES) throw new Error(`the registry's catalog ran past ${CATALOG_PAGES} pages`);
    const listed = await get(`${REGISTRY}/_catalog?tags=true${cursor === undefined ? '' : `&last=${cursor}`}`, { headers: { authorization }, signal });
    if (!listed.ok) throw new Error(`the catalog answered ${listed.status}`);
    for (const [repository, names] of Object.entries((await listed.json()).repositories ?? {})) {
      for (const name of names ?? []) if (name.startsWith('sha256:')) digests.set(name, [...(digests.get(name) ?? []), repository]);
    }
    const next = /[?&]last=([^&;>\s]+)/u.exec(listed.headers.get('link') ?? '')?.[1];
    if (next === undefined || next === cursor) break;
    cursor = next;
  }

  const cacheDir = join(stateDir, account);
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, 'manifests.json');
  const kept = readJson(cachePath);
  /** @type {Map<string, SizedManifest>} */
  const cache = new Map(kept !== null && typeof kept === 'object' ? Object.entries(kept).filter(([, entry]) => isSized(entry)) : []);
  /** Where this run read a manifest, which holds it. */
  const servedBy = new Map();
  let read = 0;
  for (const [digest, repositories] of digests) {
    if (cache.has(digest)) continue;
    // A repository that deleted it since the listing holds nothing; another may hold it still.
    for (const repository of repositories) {
      const answered = await get(`${REGISTRY}/${repository}/manifests/${digest}`, { headers: { authorization, accept: ACCEPT }, signal });
      if (answered.status === 404) continue;
      if (!answered.ok) throw new Error(`manifest ${digest} answered ${answered.status}`);
      const manifest = await answered.json();
      const layers = [...(manifest.layers ?? []), ...(manifest.config ? [manifest.config] : [])].map(/** @returns {[string, number]} */ (layer) => [layer.digest, layer.size ?? 0]);
      cache.set(digest, { layers, instance: manifest.annotations?.['io.cloudflare.cloudchamber.deployment_id'] ?? null });
      servedBy.set(digest, repository);
      read += 1;
      break;
    }
  }
  // The cache keeps only what the registry still holds.
  writeJson(cachePath, Object.fromEntries([...digests.keys()].filter((digest) => cache.has(digest)).map((digest) => [digest, cache.get(digest)])));

  const owners = new Map();
  for (const application of await api('/containers/applications')) {
    const { instances = [] } = await api(`/containers/applications/${application.id}/instances`) ?? {};
    for (const instance of instances) owners.set(instance.id, application.name);
  }
  const layerHolder = new Map();
  for (const [digest, [listed]] of digests) {
    const sized = cache.get(digest);
    if (sized === undefined) continue;
    const repository = servedBy.get(digest) ?? listed;
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
  return { account, total, holders: [...held].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes), read };
}

/**
 * What a run says about `usage`: the total, its change since the last
 * recorded run of its account (recorded under `stateDir`, then replaced by
 * this one), the top holders, and a warning when the total grew by
 * STORAGE_GROWTH_WARNING_BYTES or more.
 *
 * @param {Usage} usage
 * @param {{ stateDir: string, now?: number, top?: number }} options
 * @returns {string[]}
 */
export function describeContainerStorage(usage, { stateDir, now = Date.now(), top = 5 }) {
  const lastPath = join(stateDir, usage.account, 'last.json');
  const kept = readJson(lastPath);
  mkdirSync(join(stateDir, usage.account), { recursive: true });
  const last = kept !== null && Number.isFinite(kept.total) && typeof kept.at === 'string' ? kept : null;
  writeJson(lastPath, { total: usage.total, at: new Date(now).toISOString() });
  const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
  const grew = last === null ? null : usage.total - last.total;
  const lines = [`container storage: ${gb(usage.total)}${grew === null ? '' : ` (${grew >= 0 ? '+' : '−'}${gb(Math.abs(grew))} since the run at ${last.at})`}; most held by ${usage.holders.slice(0, top).map((holder) => `${holder.name} ${gb(holder.bytes)}`).join(', ')}`];
  if (grew !== null && grew >= STORAGE_GROWTH_WARNING_BYTES) {
    lines.push(`container storage WARNING: it grew ${gb(grew)} since the last run; the account's snapshots and images are limited (armada prune; an image's \`wrangler containers images delete <image>:<tag>\`)`);
  }
  return lines;
}
