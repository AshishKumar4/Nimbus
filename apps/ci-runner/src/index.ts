/**
 * apps/ci-runner — the unit suite on Cloudflare Containers.
 *
 * `bun scripts/ci-run.mjs <commit>` uploads the commit's `git archive` here,
 * starts a run and polls it until the verdict. A run is a CiRun Durable
 * Object; each of its shards is a CiShard, which owns one standard-4
 * container (4 vCPU, 12 GiB) running one part of tests/unit/run-all.mjs.
 *
 * Routes (all but /health need `Authorization: Bearer <CI_TOKEN>`):
 *   GET  /health
 *   HEAD /sources/<tree>          200 when the archive of that tree is stored
 *   PUT  /sources/<tree>          store it (gzip tar, Content-Length required)
 *   POST /runs                    { commit, tree, tier?, shards?, jobs?, timeoutMs?, only?, label?, files? }
 *                                 (files: the commit's tests/unit/*.mjs, for the shard count)
 *   GET  /runs/<id>               progress, then verdict and summary
 *   GET  /runs/<id>/report        the full report (every file's verdict and times)
 *   GET  /runs/<id>/logs/<shard>  a shard's log (1-based; ?attempt=N)
 *   POST /runs/<id>/cancel
 *   GET  /timings                 the timing history shards are balanced with
 *   POST /timings/forget          { names } drop entries a hang or a rewrite made wrong
 *
 * Sources and reports live in the nimbus-ci-artifacts bucket, which expires
 * them after 7 days; the timing history is the CiTimings object's. The archive is keyed by tree, so a commit whose tree is
 * already stored (a rerun, or a merge identical to its branch) is not
 * uploaded again.
 */
import { CiRun } from './run.js';
import { CiShard } from './shard.js';
import { CiTimings } from './timings.js';
import { DEFAULT_JOBS, MAX_SHARDS, TIMINGS_NAME, type Tier, defaultShards } from './plan.js';
import type { Env, RunSpec } from './types.js';

export { CiRun, CiShard, CiTimings };

const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const DEFAULT_TIMEOUT_MS = 900_000;
const RUN_ID = /^[0-9a-z-]{8,80}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const given = new TextEncoder().encode(request.headers.get('authorization') ?? '');
  const expected = new TextEncoder().encode(`Bearer ${env.CI_TOKEN}`);
  if (!env.CI_TOKEN || given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}

async function startRun(request: Request, env: Env): Promise<Response> {
  const body = await request.json<Record<string, unknown>>().catch(() => null);
  if (!body) return json({ error: 'body must be JSON' }, 400);
  const commit = String(body.commit ?? '');
  const tree = String(body.tree ?? '');
  if (!HEX.test(commit) || !HEX.test(tree)) return json({ error: 'commit and tree must be full hex object ids' }, 400);
  const tier = (body.tier ?? 'all') as Tier;
  if (!['fast', 'slow', 'all'].includes(tier)) return json({ error: 'tier must be fast, slow or all' }, 400);
  const only = Array.isArray(body.only) ? body.only.map(String) : [];
  const commitFiles = Array.isArray(body.files) ? body.files.map(String).slice(0, 10_000) : [];
  const jobs = body.jobs === undefined ? DEFAULT_JOBS : Number(body.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) return json({ error: 'jobs must be 1..16' }, 400);
  const sourceKey = `sources/${tree}.tar.gz`;
  if (!(await env.ARTIFACTS.head(sourceKey))) return json({ error: `no source for tree ${tree}; PUT /sources/${tree} first` }, 409);
  const history = await env.CI_TIMINGS.getByName(TIMINGS_NAME).history();
  const shards = body.shards === undefined ? defaultShards(history, tier, jobs, only, commitFiles) : Number(body.shards);
  if (!Number.isInteger(shards) || shards < 1 || shards > MAX_SHARDS) return json({ error: `shards must be 1..${MAX_SHARDS}` }, 400);
  // Three times run-all's local five minutes: a container's vCPU is about
  // 1.5x slower than a workstation core (the same files alone: 55.6 s
  // against 37.1 s, 34.7 s against 21.6 s), and a threaded file gets 4 of
  // them, not 24: interpreter-test262 took 315-641 s alone on one.
  const timeoutMs = body.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(body.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) return json({ error: 'timeoutMs must be 1000..1800000' }, 400);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const runId = `${stamp}-${commit.slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
  // Each run reads the history as it was when it started, whatever later runs write.
  const timingsKey = `runs/${runId}/timings.json`;
  await env.ARTIFACTS.put(timingsKey, JSON.stringify({ files: history.files }));
  const spec: RunSpec = {
    runId, commit, tree, tier, shards, jobs, timeoutMs, only,
    memoryMax: '4G',
    label: String(body.label ?? '').slice(0, 200),
    sourceKey, timingsKey, createdAt: Date.now(),
  };
  await env.CI_RUN.getByName(runId).create(spec);
  return json({ runId, shards, jobs, tier }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    // The image build this deployment expects: scripts/deploy.mjs skips the
    // image rollout when it is unchanged.
    if (url.pathname === '/health') return new Response(`ok ${env.CI_IMAGE_BUILD ?? ''}\n`);
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

    if (parts[0] === 'sources' && parts.length === 2 && HEX.test(parts[1])) {
      const key = `sources/${parts[1]}.tar.gz`;
      if (request.method === 'HEAD' || request.method === 'GET') {
        return new Response(null, { status: (await env.ARTIFACTS.head(key)) ? 200 : 404 });
      }
      if (request.method === 'PUT') {
        if (!request.body || !request.headers.get('content-length')) return json({ error: 'Content-Length required' }, 411);
        await env.ARTIFACTS.put(key, request.body, { httpMetadata: { contentType: 'application/gzip' } });
        return json({ stored: key }, 201);
      }
    }
    if (parts[0] === 'runs' && parts.length === 1 && request.method === 'POST') return startRun(request, env);
    if (parts[0] === 'runs' && parts.length >= 2 && RUN_ID.test(parts[1])) {
      const run = env.CI_RUN.getByName(parts[1]);
      if (parts.length === 2 && request.method === 'GET') {
        const status = await run.status();
        return status ? json(status) : json({ error: 'no such run' }, 404);
      }
      if (parts.length === 3 && parts[2] === 'report' && request.method === 'GET') {
        const object = await env.ARTIFACTS.get(`runs/${parts[1]}/report.json`);
        return object ? new Response(object.body, { headers: { 'content-type': 'application/json' } }) : json({ error: 'no report yet' }, 404);
      }
      if (parts.length === 3 && parts[2] === 'cancel' && request.method === 'POST') {
        await run.cancel('cancelled by request');
        return json({ cancelled: parts[1] });
      }
      if (parts.length === 4 && parts[2] === 'logs' && /^\d+$/.test(parts[3]) && request.method === 'GET') {
        const attempt = /^\d+$/.test(url.searchParams.get('attempt') ?? '') ? url.searchParams.get('attempt') : '1';
        const object = await env.ARTIFACTS.get(`runs/${parts[1]}/shard-${parts[3]}-attempt-${attempt}.log`);
        return object ? new Response(object.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } }) : json({ error: 'no such log' }, 404);
      }
    }
    if (parts[0] === 'timings' && parts.length === 1 && request.method === 'GET') {
      return json(await env.CI_TIMINGS.getByName(TIMINGS_NAME).history());
    }
    if (parts[0] === 'timings' && parts[1] === 'forget' && parts.length === 2 && request.method === 'POST') {
      const names = (await request.json<{ names?: unknown }>().catch(() => ({ names: null }))).names;
      if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) return json({ error: 'body must be { names: string[] }' }, 400);
      return json({ forgotten: await env.CI_TIMINGS.getByName(TIMINGS_NAME).forget(names) });
    }
    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
