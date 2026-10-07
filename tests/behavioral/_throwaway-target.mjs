#!/usr/bin/env bun
// _throwaway-target.mjs — stand up a disposable, authenticated Nimbus
// target and get a real session against it.
//
// WHY THIS EXISTS
//   `apps/hosted-demo` (nimbus-os.dev) gates `POST /new` and every
//   `/s/<sid>/*` route on an interactive Cloudflare OAuth cookie, so a
//   headless agent cannot create a session there — `Authorization:
//   Bearer` is never consulted on those routes. `apps/probe` is the
//   embedder that *does* speak bearer tokens: the core router's
//   `POST /new` requires a `session:create` JWT signed with the target's
//   own `JWT_SECRET`. This script deploys that embedder as a Worker
//   Preview under a throwaway name, gives it a freshly generated secret,
//   and mints matching tokens. No production auth is relaxed anywhere: the
//   throwaway simply holds a secret only this machine knows.
//
// WHY A PREVIEW
//   Every throwaway is a Preview (`wrangler preview`) of one parent Worker,
//   PREVIEW_PARENT, which never has a production deployment of its own.
//   A Preview gets a Durable Object namespace and SQLite storage of its
//   own, automatically, and deleting the Preview deletes them
//   (https://developers.cloudflare.com/workers/previews/resources/#durable-objects).
//   Its bindings come only from apps/probe's `previews` block, which
//   scripts/deploy-isolation.mjs checks before anything is deployed, and
//   its JWT_SECRET travels with each deployment (`--secrets-file`), never
//   through the dashboard's Previews Base configuration
//   (`--ignore-base-config`). A Preview is served at
//   `<preview>-<parent>.<subdomain>.workers.dev`.
//   Staging is not a Preview: Cron Triggers and routes target production
//   only, and the least recently deployed Preview is deleted at the
//   per-Worker limit (https://developers.cloudflare.com/workers/previews/).
//
//   Use a throwaway for a one-off question. For verifying a change before
//   it ships — the whole suite, repeatedly, plus the hosted-demo surfaces
//   this embedder does not have — use the persistent staging environment:
//   `_staging-target.mjs`.
//
// USAGE
//   export CLOUDFLARE_ACCOUNT_ID=<account>            # account pin, required
//   bun tests/behavioral/_throwaway-target.mjs up     # deploy + secret + token
//   bun tests/behavioral/_throwaway-target.mjs session
//   bun tests/behavioral/_throwaway-target.mjs down
//
//   `up` prints the shell exports the behavioral driver reads, so the
//   whole suite runs against the throwaway:
//     BASE=<url> NIMBUS_PROBE_TOKEN=<jwt> bun tests/behavioral/run-all.mjs
//
// COMMANDS
//   up      [--name <n>] [--no-build | --bundle <release dir>] [--ttl-ms <ms>] [--rotate-secrets]
//           [--var KEY:VALUE ...]  override a config var for this deploy —
//           how one build is stood up twice to compare two settings of it.
//           Every throwaway is deployed with the suite's target vars
//           (_deploy-target.mjs PROBE_TARGET_VARS), as staging is
//   token   [--name <n>] [--ttl-ms <ms>] [--json]   → the token, or JSON {base, token}
//   session [--name <n>] [--ttl-ms <ms>]   → JSON {base, sessionId, token}
//   down    [--name <n>] | --all
//   list    every Preview under the parent, and which ones this checkout holds
//
// STATE
//   `.wrangler/throwaway-targets/<name>.json` (gitignored) holds the
//   target's name, Preview name, URL and signing secret so later commands
//   need no environment beyond the account pin. A throwaway belongs to the
//   checkout that stood it up, so the record stays with that checkout —
//   and `up` reuses the secret it finds there rather than replacing it,
//   which is what lets a target be redeployed under a suite that is
//   already running against it.
//
// TOKEN LIFETIME
//   Default 3h, matching CI. The docs terminal's anonymous token lives
//   120s by design; a probe that outran it could not even DELETE its own
//   session, which is how the shared anon pool got exhausted. Self-minted
//   tokens make that failure mode structurally impossible.

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { mintProbeToken } from './_mint-probe-token.mjs';
import { assertInstalled } from '../../scripts/ci/lib/installed.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

// Checked before the deploy path is imported: it parses wrangler configs
// through packages/worker, which only an install provides.
assertInstalled(ROOT, '_throwaway-target.mjs');
const {
  MACHINE_STATE_DIR,
  PROBE_TARGET_VARS,
  WRANGLER,
  apiToken,
  assertCredentialHeld,
  cfApi,
  createSession,
  parseFlags,
  randomSecret,
  readState,
  requireAccountPin,
  waitForTarget,
  withSecretsFile,
  wrangle,
  writeState,
} = await import('./_deploy-target.mjs');
const { assertDeployIsolated } = await import('../../scripts/deploy-isolation.mjs');
const { uploadConfig } = await import('../../scripts/ci/lib/release.mjs');

const PROBE_APP = join(ROOT, 'apps', 'probe');
/** Machine state: every Preview this machine deleted, until its hostname stops answering. */
const DELETED_PATH = join(MACHINE_STATE_DIR, 'deleted-previews.json');
const STATE_DIR = join(ROOT, '.wrangler', 'throwaway-targets');

/** Throwaways are always `<prefix><suffix>` so a stray one is obvious. */
const NAME_PREFIX = 'nimbus-tw-';
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * The Worker every throwaway is a Preview of. It holds no production
 * deployment and no binding of its own; only its Previews are ever served.
 * scripts/deploy-isolation.mjs refuses a Preview whose parent is a
 * production Worker.
 */
const PREVIEW_PARENT = 'nimbus-probe-previews';

/**
 * How long the workers.dev edge may keep serving a deleted Preview.
 * Declared here rather than beside its use: the commands run at module
 * top level, before a `const` further down has initialised.
 */
const HOSTNAME_SETTLE_MS = 60_000;

// ── CLI ──────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
/**
 * The suite's target vars (PROBE_TARGET_VARS), then each `--var KEY:VALUE`
 * given here, forwarded to wrangler verbatim: a later --var for the same
 * key wins.
 */
const varOverrides = [...PROBE_TARGET_VARS, ...rest.flatMap((arg, i) => (arg === '--var' && rest[i + 1] ? ['--var', rest[i + 1]] : []))];

const COMMANDS = { up, token, session, down, list };
const run = COMMANDS[command];
if (!run) {
  console.error(`usage: bun tests/behavioral/_throwaway-target.mjs <${Object.keys(COMMANDS).join('|')}> [flags]`);
  process.exit(2);
}
await run();

// ── Commands ─────────────────────────────────────────────────────────

async function up() {
  const account = requireAccountPin();
  const name = flags.name ? qualify(flags.name) : `${NAME_PREFIX}${randomSuffix()}`;
  const preview = previewName(name);

  // Redeploying a throwaway under a name it already has is routine — a
  // fix, a rebuild, another round. Minting a fresh secret for it is not:
  // that 401s every token already handed out, including the ones the
  // suite running against this very target is holding. Keep the live
  // secret unless there is none to keep or a rotation was asked for.
  const recorded = readState(statePath(name));
  const reuseSecret = !flags['rotate-secrets'] && Boolean(recorded?.secretPushed);
  const secret = reuseSecret ? recorded.secret : randomSecret();
  const createdAt = recorded?.createdAt ?? new Date().toISOString();

  // Before wrangler is invoked at all: a Preview binds what apps/probe's
  // `previews` block names and nothing else. Verify none of it reaches a
  // production resource, the parent's own resources or a production
  // Worker, rather than remembering that it does not — a probe that skipped
  // the Worker version of this check wrote rows into the live demo D1.
  const isolation = assertDeployIsolated({
    configPath: 'apps/probe/wrangler.jsonc',
    workerName: PREVIEW_PARENT,
    preview: true,
    root: ROOT,
  });
  for (const note of isolation.shared) log(`shared with production — ${note}`);
  for (const gap of isolation.missing) log(`WARNING: ${gap}`);
  log(`bindings verified: Preview ${preview} of ${PREVIEW_PARENT} resolves no production resource`);

  // Also before the build: a Preview already standing that this checkout
  // holds no secret for belongs to somebody else's run, and taking it
  // over is the one thing `up` must not do by accident.
  const token = apiToken({ cwd: PROBE_APP, account });
  const before = await latestDeployment({ account, token, preview });
  assertCredentialHeld({
    name,
    statePath: statePath(name),
    hasSecret: reuseSecret,
    provisioned: before !== null,
    rotate: Boolean(flags['rotate-secrets']),
  });

  // --bundle: a release CI built for this commit, the dist gate included
  // (scripts/ci/lib/release.mjs); this machine only uploads it.
  // Without one, `wrangler preview` bundles here, after the gate builds:
  // only a CI runner (GitHub's behavioral job) may do that. On the
  // workstation it is remote-probes --deploy.
  const bundle = flags.bundle ? uploadConfig(flags.bundle, 'apps/probe', { root: ROOT, preview: true, log }) : null;
  if (!bundle && process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('up without --bundle builds and bundles on this machine, which builds nothing: run `bun scripts/ci/remote-probes.mjs --deploy <name>`, which bundles on CI and uploads from here');
  }
  if (!bundle && flags.build !== false) {
    const { assertDistMatchesSource } = await import('../../scripts/dist-integrity.mjs');
    await assertDistMatchesSource({ root: ROOT, log });
  }

  await ensurePreviewParent({ account, token });

  // Recorded before the deploy, not after: `wrangler preview` can create
  // the Preview and still fail before its deployment lands, and a name
  // nothing knows about is a name nobody tears down. `secretPushed` stays
  // false until a deployment carrying the secret is live, so a crashed
  // `up` is retried with a secret that gets deployed rather than one only
  // this machine believes in.
  writeState(statePath(name), { name, preview, parent: PREVIEW_PARENT, base: null, secret, secretPushed: reuseSecret, createdAt });

  log(`deploying apps/probe as Preview ${preview} of ${PREVIEW_PARENT}`);
  for (let i = 0; i < varOverrides.length; i += 2) log(`var override: ${varOverrides[i + 1]}`);
  const { base, deploymentId, startupMs } = await deployPreview({ account, token, preview, secret, before, config: bundle });
  writeState(statePath(name), { name, preview, parent: PREVIEW_PARENT, base, secret, secretPushed: true, createdAt });
  // The platform's own measure of the script's startup, limit 1 s
  // (https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time).
  log(`deployment ${deploymentId} is live at ${base} (startup ${startupMs ?? '?'} ms)`);
  log(reuseSecret
    ? `kept the JWT_SECRET ${name} already had — tokens minted earlier stay valid`
    : `deployed a new JWT_SECRET with ${name}`);

  const jwt = await mintProbeToken(secret, ttlMs());
  await waitForTarget(base, jwt);

  log(`ready: ${base}`);
  process.stdout.write([
    `export BASE=${base}`,
    `export NIMBUS_PROBE_TOKEN=${jwt}`,
    '',
  ].join('\n'));
}

async function token() {
  const state = requireState(resolveName());
  const jwt = await mintProbeToken(state.secret, ttlMs());
  process.stdout.write(flags.json ? `${JSON.stringify({ base: state.base, token: jwt })}\n` : jwt);
}

async function session() {
  const state = requireState(resolveName());
  if (!state.base) throw new Error(`${state.name} never finished deploying — run \`down\` and try \`up\` again`);
  const jwt = await mintProbeToken(state.secret, ttlMs());
  const { sessionId, attachPath } = await createSession(state.base, jwt);
  process.stdout.write(`${JSON.stringify({ base: state.base, sessionId, attachPath, token: jwt }, null, 2)}\n`);
}

async function down() {
  const account = requireAccountPin();
  const names = flags.all ? listStateNames() : [resolveName()];
  if (names.length === 0) log('no throwaway targets recorded');
  const token = apiToken({ cwd: PROBE_APP, account });

  for (const name of names) {
    const preview = readState(statePath(name))?.preview ?? previewName(name);
    const base = readState(statePath(name))?.base ?? null;
    const existing = await cfApi(`/workers/workers/${PREVIEW_PARENT}/previews/${encodeURIComponent(preview)}`, { account, token });
    log(`deleting Preview ${preview} of ${PREVIEW_PARENT}`);
    wrangle(WRANGLER, ['preview', 'delete', '--name', preview, '--worker-name', PREVIEW_PARENT, '--skip-confirmation'], {
      cwd: PROBE_APP, account, allowFail: true,
    });
    const gone = await confirmDeleted({ name, preview, account, token });
    // Its hostname may go on being served (spike/preview-stale): `list` looks.
    if (existing.ok && base) recordDeleted({ name, preview, id: existing.result?.id ?? null, base });
    rmSync(statePath(name), { force: true });
    if (!gone.ok) {
      console.error(`FAILED to confirm ${name} is gone: ${gone.reason}`);
      process.exitCode = 1;
    } else {
      log(`confirmed gone: ${name} (${gone.reason})`);
    }
  }
}

/**
 * Every Preview under the parent, with the ones this checkout holds a
 * record for marked. A cancelled CI run never reaches its teardown; its
 * Preview (`tw-ci-*`) shows up here unmarked.
 */
async function list() {
  const account = requireAccountPin();
  const token = apiToken({ cwd: PROBE_APP, account });
  const held = new Map(listStateNames().map((name) => [readState(statePath(name))?.preview ?? previewName(name), name]));
  const listed = await cfApi(`/workers/workers/${PREVIEW_PARENT}/previews`, { account, token });
  if (!listed.ok) throw new Error(`listing Previews of ${PREVIEW_PARENT} failed (${listed.status}): ${JSON.stringify(listed.errors)}`);
  for (const p of listed.result ?? []) {
    const local = held.get(p.name);
    process.stdout.write(`${p.name}\t${workersDevUrlOf(p.urls) ?? '(no URL)'}\t${p.created_on ?? ''}\t${local ? `held here as ${local}` : 'not held here'}\n`);
  }
  // Every Preview this machine deleted whose hostname still answers. The
  // edge can go on serving a deleted Preview's first deployment for hours,
  // under the deleted Preview's id, after the API has forgotten both
  // (spike/preview-stale), and nothing can delete it. It holds the secret
  // `down` discarded, so it mints nothing; listed so it is never mistaken
  // for a live target. One whose hostname answers 404 is dropped; one that
  // cannot be reached is kept, as unknown.
  const live = new Set((listed.result ?? []).map((p) => p.name));
  const still = [];
  for (const entry of readDeleted()) {
    if (live.has(entry.preview)) continue;
    const answer = await fetch(entry.base, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
      .then((r) => ({ status: r.status }), (error) => ({ error: error?.message ?? String(error) }));
    // Only a real 404 means the hostname has gone: a failed fetch says nothing, and keeps the record.
    if (answer.status === 404) continue;
    still.push(entry);
    process.stdout.write(answer.error
      ? `${entry.preview}\t${entry.base}\tdeleted ${entry.deletedAt}\tunknown (fetch failed: ${answer.error})\n`
      : `${entry.preview}\t${entry.base}\tdeleted ${entry.deletedAt}\tSTILL SERVED by the edge (${answer.status}): a deployment of this deleted Preview (last id ${entry.id ?? '?'}); nothing can delete it, and its secret is gone\n`);
  }
  writeDeleted(still);
}

// ── Deleted Previews ─────────────────────────────────────────────────

function readDeleted() {
  return readState(DELETED_PATH)?.previews ?? [];
}

function writeDeleted(previews) {
  writeState(DELETED_PATH, { previews });
}

function recordDeleted({ name, preview, id, base }) {
  writeDeleted([...readDeleted().filter((entry) => entry.preview !== preview), { name, preview, id, base, deletedAt: new Date().toISOString() }]);
}

// ── Previews ─────────────────────────────────────────────────────────

/** `nimbus-tw-x` → Preview `tw-x`; the parent's name already says nimbus. */
function previewName(name) {
  return name.slice('nimbus-'.length);
}

/** The latest deployment of `preview`, or null when there is no such Preview. */
async function latestDeployment({ account, token, preview }) {
  const got = await cfApi(`/workers/workers/${PREVIEW_PARENT}/previews/${encodeURIComponent(preview)}/deployments/latest`, { account, token });
  return got.ok ? got.result : null;
}

/**
 * The parent Worker, with Preview URLs on. `wrangler preview` would create
 * a missing parent itself, but with `previews_enabled` taken from
 * apps/probe's `preview_urls` (false there, for the probe Workers), and a
 * Preview under such a parent has no URL.
 */
async function ensurePreviewParent({ account, token }) {
  const subdomain = { enabled: true, previews_enabled: true };
  const got = await cfApi(`/workers/workers/${PREVIEW_PARENT}`, { account, token });
  if (!got.ok) {
    log(`creating the Preview parent Worker ${PREVIEW_PARENT}`);
    const created = await cfApi('/workers/workers', { account, token, method: 'POST', body: { name: PREVIEW_PARENT, subdomain } });
    if (!created.ok) throw new Error(`creating ${PREVIEW_PARENT} failed (${created.status}): ${JSON.stringify(created.errors)}`);
    return;
  }
  if (got.result?.subdomain?.enabled === true && got.result?.subdomain?.previews_enabled === true) return;
  log(`turning Preview URLs on for ${PREVIEW_PARENT}`);
  const patched = await cfApi(`/workers/workers/${PREVIEW_PARENT}`, {
    account, token, method: 'PATCH', body: { subdomain }, contentType: 'application/merge-patch+json',
  });
  if (!patched.ok) throw new Error(`enabling Preview URLs on ${PREVIEW_PARENT} failed (${patched.status}): ${JSON.stringify(patched.errors)}`);
}

/**
 * `wrangler preview`, then prove it. The same three facts as a Worker
 * deploy (_deploy-target.mjs deployAndVerify): the command reported a
 * deployment id, the API serves that id as the Preview's latest, and it
 * differs from the latest before.
 */
async function deployPreview({ account, token, preview, secret, before, config = null }) {
  // The secret travels with the deployment: each Preview deployment
  // carries its own env, so every deploy uploads it again.
  const result = withSecretsFile({ JWT_SECRET: secret }, (secretsFile) => wrangle(WRANGLER, [
    'preview', '--name', preview, '--worker-name', PREVIEW_PARENT,
    '--ignore-base-config', '--json', '--secrets-file', secretsFile, ...varOverrides, ...(config ? ['--config', config] : []),
  ], { cwd: PROBE_APP, account, allowFail: true }));
  const stdout = result.stdout || '';
  let printed = null;
  try {
    printed = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch { /* reported below */ }
  const deploymentId = printed?.deployment?.id ?? null;
  const latest = await latestDeployment({ account, token, preview });
  const after = latest?.id ?? null;
  if (!deploymentId || after !== deploymentId || after === (before?.id ?? null)) {
    process.stderr.write(`${stdout}${result.stderr || ''}`);
    const detail = !deploymentId
      ? '`wrangler preview` reported no deployment id'
      : after !== deploymentId
        ? `the API serves ${after} as the latest deployment, not ${deploymentId}`
        : `the latest deployment is still ${after} — nothing was deployed`;
    throw new Error(`Preview ${preview} of ${PREVIEW_PARENT} did not land: ${detail}; wrangler exited ${result.status}`);
  }
  const base = workersDevUrlOf(printed.preview?.urls);
  if (!base) throw new Error(`Preview ${preview} has no workers.dev URL (urls: ${JSON.stringify(printed.preview?.urls)})`);
  return { base, deploymentId, startupMs: latest.startup_time_ms };
}

/** The workers.dev URL among a Preview's URLs, without a trailing slash. */
function workersDevUrlOf(urls) {
  return (urls ?? []).find((url) => /\.workers\.dev\/?$/.test(url))?.replace(/\/$/, '') ?? null;
}

// ── Teardown ─────────────────────────────────────────────────────────

/**
 * Is the Preview gone?
 *
 * The API answers that, and only the API: once the Preview is deleted, GET
 * .../previews/<name> stops answering it. A 404 on its hostname is not the
 * same claim, which is why it cannot stand in for this check.
 *
 * The hostname is polled afterwards for the operator's benefit, not as
 * evidence. It lags: measured 2026-08-05, a deleted Worker kept answering
 * 200 for ~30s after the API had stopped listing it.
 */
async function confirmDeleted({ name, preview, account, token }) {
  const got = await cfApi(`/workers/workers/${PREVIEW_PARENT}/previews/${encodeURIComponent(preview)}`, { account, token });
  if (got.ok) return { ok: false, reason: `the API still answers Preview ${preview}` };

  const base = readState(statePath(name))?.base;
  if (!base) return { ok: true, reason: `Preview ${preview} is not listed (${got.status})` };

  const status = await waitForHostnameGone(base);
  return {
    ok: true,
    reason: status === null
      ? `Preview ${preview} is not listed (${got.status}) and the hostname no longer serves it`
      : `Preview ${preview} is not listed; ${base} still answers ${status} after `
        + `${HOSTNAME_SETTLE_MS}ms of edge propagation`,
  };
}

/**
 * Poll until the hostname stops serving the Preview. Returns null once it
 * 404s or stops answering at all, otherwise the last status seen.
 */
async function waitForHostnameGone(base) {
  const deadline = Date.now() + HOSTNAME_SETTLE_MS;
  for (;;) {
    const status = await fetch(base, { redirect: 'manual' }).then((r) => r.status, () => 404);
    if (status === 404) return null;
    if (Date.now() >= deadline) return status;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ── State ────────────────────────────────────────────────────────────

function statePath(name) {
  return join(STATE_DIR, `${name}.json`);
}

function requireState(name) {
  const state = readState(statePath(name));
  if (!state) throw new Error(`no throwaway target recorded for ${name} — run \`up\` first`);
  return state;
}

function listStateNames() {
  try {
    return readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

function resolveName() {
  if (flags.name) return qualify(flags.name);
  const names = listStateNames();
  if (names.length === 1) return names[0];
  if (names.length === 0) throw new Error('no throwaway target recorded — run `up` first');
  throw new Error(`--name is required; recorded targets: ${names.join(', ')}`);
}

// ── Small helpers ────────────────────────────────────────────────────

function qualify(name) {
  return name.startsWith(NAME_PREFIX) ? name : `${NAME_PREFIX}${name}`;
}

function randomSuffix() {
  return crypto.randomUUID().slice(0, 8);
}

function ttlMs() {
  return flags['ttl-ms'] ? Number(flags['ttl-ms']) : DEFAULT_TTL_MS;
}

function log(message) {
  console.error(`[throwaway] ${message}`);
}
