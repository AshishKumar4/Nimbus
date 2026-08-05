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
//   own `JWT_SECRET`. This script deploys that embedder under a
//   throwaway name, gives it a freshly generated secret, and mints
//   matching tokens. No production auth is relaxed anywhere: the
//   throwaway simply holds a secret only this machine knows.
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
//   up      [--name <n>] [--no-build] [--ttl-ms <ms>]
//   token   [--name <n>] [--ttl-ms <ms>]
//   session [--name <n>] [--ttl-ms <ms>]   → JSON {base, sessionId, token}
//   down    [--name <n>] | --all
//   list
//
// STATE
//   `.wrangler/throwaway-targets/<name>.json` (gitignored) holds the
//   target's name, URL and signing secret so later commands need no
//   environment beyond the account pin.
//
// TOKEN LIFETIME
//   Default 3h, matching CI. The docs terminal's anonymous token lives
//   120s by design; a probe that outran it could not even DELETE its own
//   session, which is how the shared anon pool got exhausted. Self-minted
//   tokens make that failure mode structurally impossible.

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { mintProbeToken } from './_mint-probe-token.mjs';
import { assertDeployIsolated } from '../../scripts/deploy-isolation.mjs';
import {
  ROOT,
  WRANGLER,
  buildDist,
  createSession,
  deployAndVerify,
  parseFlags,
  putSecret,
  randomSecret,
  readState,
  requireAccountPin,
  waitForTarget,
  wrangle,
  writeState,
} from './_deploy-target.mjs';

const PROBE_APP = join(ROOT, 'apps', 'probe');
const STATE_DIR = join(ROOT, '.wrangler', 'throwaway-targets');

/** Throwaways are always `<prefix><suffix>` so a stray one is obvious. */
const NAME_PREFIX = 'nimbus-tw-';
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * How long the workers.dev edge may keep serving a deleted script.
 * Declared here rather than beside its use: the commands run at module
 * top level, before a `const` further down has initialised.
 */
const HOSTNAME_SETTLE_MS = 60_000;

// ── CLI ──────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

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
  const secret = randomSecret();

  // Before wrangler is invoked at all: `--name` overrides only the name, so
  // every binding still comes from apps/probe's config. Verify none of them
  // resolve to a production resource rather than remembering that they do
  // not — a probe that skipped this wrote rows into the live demo D1.
  const isolation = assertDeployIsolated({
    configPath: 'apps/probe/wrangler.jsonc',
    workerName: name,
    root: ROOT,
  });
  for (const note of isolation.shared) log(`shared with production — ${note}`);
  for (const gap of isolation.missing) log(`WARNING: ${gap}`);
  log(`bindings verified: ${name} resolves no production resource`);

  if (flags.build !== false) buildDist({ account, log });

  // Recorded before the deploy, not after: `wrangler deploy` can create the
  // script and still fail before it reports a URL, and a name nothing knows
  // about is a name nobody tears down.
  const createdAt = new Date().toISOString();
  writeState(statePath(name), { name, base: null, secret, createdAt });

  log(`deploying apps/probe as ${name}`);
  const { base, versionId } = deployAndVerify({
    cwd: PROBE_APP, account, name, args: ['--name', name],
  });
  if (!base) throw new Error(`deploy of ${name} printed no workers.dev URL`);
  writeState(statePath(name), { name, base, secret, createdAt });
  log(`version ${versionId} is live at ${base}`);

  log(`setting JWT_SECRET on ${name}`);
  putSecret({ cwd: PROBE_APP, account, name, key: 'JWT_SECRET', value: secret });

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
  process.stdout.write(await mintProbeToken(state.secret, ttlMs()));
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

  for (const name of names) {
    log(`deleting ${name}`);
    wrangle(WRANGLER, ['delete', '--name', name, '--force'], { cwd: PROBE_APP, account, allowFail: true });
    const gone = await confirmDeleted(name, account);
    rmSync(statePath(name), { force: true });
    if (!gone.ok) {
      console.error(`FAILED to confirm ${name} is gone: ${gone.reason}`);
      process.exitCode = 1;
    } else {
      log(`confirmed gone: ${name} (${gone.reason})`);
    }
  }
}

function list() {
  for (const name of listStateNames()) {
    const state = requireState(name);
    process.stdout.write(`${name}\t${state.base ?? '(deploy incomplete)'}\t${state.createdAt}\n`);
  }
}

// ── Teardown ─────────────────────────────────────────────────────────

/**
 * Is the script gone?
 *
 * The API answers that, and only the API: `wrangler deployments list` exits
 * 0 for a script that exists — even one that never finished deploying — and
 * 1 with `[code: 10007]` once it is really gone. A 404 on the workers.dev
 * hostname is not the same claim and never was, which is why it cannot
 * stand in for this check.
 *
 * The hostname is polled afterwards for the operator's benefit, not as
 * evidence. It lags: measured 2026-08-05, a deleted Worker kept answering
 * 200 for ~30s after the API had stopped listing it. Reading it once,
 * immediately after `wrangler delete`, reported a correct deletion as a
 * failure — which in CI is a red teardown on every single run.
 */
async function confirmDeleted(name, account) {
  const listed = wrangle(WRANGLER, ['deployments', 'list', '--name', name], {
    cwd: PROBE_APP,
    account,
    allowFail: true,
  });
  if (listed.status === 0) return { ok: false, reason: 'the script is still listed by the API' };

  const base = readState(statePath(name))?.base;
  if (!base) return { ok: true, reason: 'the script is not listed' };

  const status = await waitForHostnameGone(base);
  return {
    ok: true,
    reason: status === null
      ? 'the script is not listed and the hostname no longer serves it'
      : `the script is not listed; ${base} still answers ${status} after `
        + `${HOSTNAME_SETTLE_MS}ms of edge propagation`,
  };
}

/**
 * Poll until the hostname stops serving the script. Returns null once it
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
