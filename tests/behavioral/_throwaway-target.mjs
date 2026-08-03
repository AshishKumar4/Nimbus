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

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mintProbeToken } from './_mint-probe-token.mjs';
import { assertThrowawaySafe } from '../../scripts/deploy-isolation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE_APP = join(ROOT, 'apps', 'probe');
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const STATE_DIR = join(ROOT, '.wrangler', 'throwaway-targets');

/** Throwaways are always `<prefix><suffix>` so a stray one is obvious. */
const NAME_PREFIX = 'nimbus-tw-';
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;

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
  const isolation = assertThrowawaySafe({
    configPath: 'apps/probe/wrangler.jsonc',
    workerName: name,
    root: ROOT,
  });
  for (const note of isolation.shared) log(`shared with production — ${note}`);
  log(`bindings verified: ${name} resolves no production resource`);

  if (flags.build !== false) {
    log(`building packages/worker → dist (wrangler bundles dist, not src)`);
    wrangle('bun', ['run', '--cwd', 'packages/worker', 'build'], { cwd: ROOT, account });
  }

  // Recorded before the deploy, not after: `wrangler deploy` can create the
  // script and still fail before it reports a URL, and a name nothing knows
  // about is a name nobody tears down.
  const createdAt = new Date().toISOString();
  writeState({ name, base: null, secret, createdAt });

  log(`deploying apps/probe as ${name}`);
  const deploy = wrangle(WRANGLER, ['deploy', '--name', name], { cwd: PROBE_APP, account });
  const base = workersDevUrl(deploy.stdout + deploy.stderr, name);
  writeState({ name, base, secret, createdAt });

  log(`setting JWT_SECRET on ${name}`);
  wrangle(WRANGLER, ['secret', 'put', 'JWT_SECRET', '--name', name], {
    cwd: PROBE_APP,
    account,
    input: secret,
  });

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
  const state = readState(resolveName());
  process.stdout.write(await mintProbeToken(state.secret, ttlMs()));
}

async function session() {
  const state = readState(resolveName());
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
    const state = readState(name);
    process.stdout.write(`${name}\t${state.base ?? '(deploy incomplete)'}\t${state.createdAt}\n`);
  }
}

// ── Session creation ─────────────────────────────────────────────────

/**
 * `POST /new` with a `session:create` bearer token. The core router
 * answers 302 to the session shell; the Location's bootstrap token is
 * for browsers, so probes keep using the bearer token instead.
 */
async function createSession(base, jwt) {
  const response = await fetch(`${base}/new`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const location = response.headers.get('location');
  if (response.status !== 302 || !location) {
    throw new Error(`POST /new → ${response.status} ${await response.text().catch(() => '')}`);
  }
  const match = location.match(/\/s\/([^/?]+)/);
  if (!match) throw new Error(`POST /new → unexpected Location: ${location}`);
  return { sessionId: match[1], attachPath: location };
}

/**
 * A fresh deployment takes a few seconds to answer on its workers.dev
 * hostname. Poll `POST /new` until it authenticates, then release the
 * session so the readiness check leaves nothing behind.
 */
async function waitForTarget(base, jwt, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const { sessionId } = await createSession(base, jwt);
      await fetch(`${base}/s/${sessionId}/`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      }).catch(() => {});
      return;
    } catch (e) {
      last = e.message;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`target never authenticated within ${timeoutMs}ms: ${last}`);
}

// ── Cloudflare plumbing ──────────────────────────────────────────────

function requireAccountPin() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    console.error(
      'CLOUDFLARE_ACCOUNT_ID is required so the throwaway lands on the intended account.\n'
      + 'Pick the account id from `wrangler whoami` and export it before running this script.',
    );
    process.exit(2);
  }
  return account;
}

function wrangle(bin, args, { cwd, account, input, allowFail = false }) {
  const result = spawnSync(bin, args, {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

function workersDevUrl(output, name) {
  const match = output.match(/https:\/\/[^\s]*\.workers\.dev/);
  if (!match) throw new Error(`deploy of ${name} printed no workers.dev URL`);
  return match[0].replace(/\/$/, '');
}

/**
 * Deletion is only done when Cloudflare stops serving the hostname AND
 * stops listing the script. `wrangler deployments list` is the API-backed
 * half — it exits 0 for a script that exists (even one that never finished
 * deploying) and 1 with `[code: 10007]` once the script is really gone.
 */
async function confirmDeleted(name, account) {
  const state = tryReadState(name);
  const checks = [];
  if (state?.base) {
    const response = await fetch(state.base, { redirect: 'manual' }).catch(() => null);
    if (response && response.status !== 404) {
      return { ok: false, reason: `${state.base} still answers ${response.status}` };
    }
    checks.push('hostname 404s');
  }
  const listed = wrangle(WRANGLER, ['deployments', 'list', '--name', name], {
    cwd: PROBE_APP,
    account,
    allowFail: true,
  });
  if (listed.status === 0) return { ok: false, reason: 'script is still listed by the API' };
  checks.push('the script is not listed');
  return { ok: true, reason: checks.join(' and ') };
}

// ── State ────────────────────────────────────────────────────────────

function statePath(name) {
  return join(STATE_DIR, `${name}.json`);
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(state.name), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function tryReadState(name) {
  try {
    return JSON.parse(readFileSync(statePath(name), 'utf8'));
  } catch {
    return null;
  }
}

function readState(name) {
  const state = tryReadState(name);
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

function randomSecret() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

function ttlMs() {
  return flags['ttl-ms'] ? Number(flags['ttl-ms']) : DEFAULT_TTL_MS;
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key.startsWith('no-')) out[key.slice(3)] = false;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

function log(message) {
  console.error(`[throwaway] ${message}`);
}
