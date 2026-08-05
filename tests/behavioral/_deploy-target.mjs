// _deploy-target.mjs — the mechanics every non-production Nimbus deploy
// shares: pin the account, verify isolation, build, deploy, prove the
// deploy landed, and get an authenticated session out of the result.
//
// Two callers, two lifetimes, one set of mechanics:
//   _throwaway-target.mjs — `nimbus-tw-*`, deployed and deleted per run.
//   _staging-target.mjs   — `nimbus-staging` + `nimbus-probe-staging`,
//                           persistent, redeployed in place.
//
// The one rule worth reading before editing: **a deploy is verified by its
// version id, never by wrangler's exit status.** `wrangler deploy` can die
// in the asset-upload phase with a bare `fetch failed` and still exit 0 —
// measured 2026-08-02, when a full green probe suite ran against a
// two-builds-stale Worker. `deployAndVerify` therefore reads the active
// version back from the API and refuses a deploy that did not change it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// ── Cloudflare plumbing ──────────────────────────────────────────────

/**
 * Two Cloudflare accounts are logged in on this machine, and wrangler
 * silently picks one. Every deploy pins the intended account explicitly.
 */
export function requireAccountPin() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    console.error(
      'CLOUDFLARE_ACCOUNT_ID is required so the deploy lands on the intended account.\n'
      + 'Pick the account id from `wrangler whoami` and export it before running this script.',
    );
    process.exit(2);
  }
  return account;
}

export function wrangle(bin, args, { cwd, account, input, env = {}, allowFail = false }) {
  const result = spawnSync(bin, args, {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env, CLOUDFLARE_ACCOUNT_ID: account },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

/**
 * The version id Cloudflare is currently serving for `name`, or null when
 * the Worker does not exist. API-backed: `deployments status` exits
 * non-zero with `[code: 10007]` for an absent script.
 */
export function activeVersionId(name, { cwd, account }) {
  const listed = wrangle(WRANGLER, ['deployments', 'status', '--name', name], {
    cwd, account, allowFail: true,
  });
  if (listed.status !== 0) return null;
  const match = `${listed.stdout}${listed.stderr}`.match(new RegExp(`Version\\(s\\):.*?(${UUID_RE.source})`, 's'));
  return match ? match[1] : null;
}

/**
 * Deploy, then prove it. Returns `{ versionId, base }`.
 *
 * Three independent facts have to agree, because each one alone has been
 * observed lying:
 *   - the deploy printed a `Current Version ID` (a failed asset upload
 *     exits 0 and prints none);
 *   - Cloudflare now serves that same id (the deploy could report a
 *     version that never became active);
 *   - the id differs from the one served before (a no-op deploy is a
 *     stale deploy, and the whole point is to probe what was just built).
 */
export function deployAndVerify({ cwd, account, name, envName = null, args = [] }) {
  const before = activeVersionId(name, { cwd, account });

  const deployArgs = ['deploy', ...(envName ? ['-e', envName] : []), ...args];
  const result = wrangle(WRANGLER, deployArgs, { cwd, account, allowFail: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`;

  const printed = output.match(new RegExp(`Current Version ID:\\s*(${UUID_RE.source})`))?.[1] ?? null;
  const after = activeVersionId(name, { cwd, account });

  if (!printed || !after || after !== printed || after === before) {
    process.stderr.write(output);
    throw new Error(deployFailureReason({ name, before, printed, after, status: result.status }));
  }

  return { versionId: after, base: workersDevUrl(output) };
}

function deployFailureReason({ name, before, printed, after, status }) {
  const detail = !printed
    ? 'wrangler printed no `Current Version ID` — the upload did not complete'
    : !after
      ? `Cloudflare does not serve ${name} at all — the script was never activated`
      : after !== printed
        ? `Cloudflare serves ${after} but the deploy reported ${printed}`
        : `the active version is still ${after} — nothing was deployed`;
  return (
    `deploy of ${name} did not land: ${detail}.\n`
    + `wrangler exited ${status}; its exit status is not evidence — a deploy can `
    + `fail in asset upload and still exit 0.`
  );
}

/** The workers.dev hostname a deploy printed, or null for a routed Worker. */
export function workersDevUrl(output) {
  return output.match(/https:\/\/[^\s]*\.workers\.dev/)?.[0].replace(/\/$/, '') ?? null;
}

/** `<name>.<subdomain>.workers.dev` → `<subdomain>`. */
export function workersDevSubdomain(base) {
  return base?.match(/^https:\/\/[^.]+\.([^.]+)\.workers\.dev$/)?.[1] ?? null;
}

export function putSecret({ cwd, account, name, key, value }) {
  wrangle(WRANGLER, ['secret', 'put', key, '--name', name], { cwd, account, input: value });
}

// ── Sessions ─────────────────────────────────────────────────────────

/**
 * `POST /new` with a `session:create` bearer token. The core router
 * answers 302 to the session shell; the Location's bootstrap token is for
 * browsers, so probes keep using the bearer token instead.
 */
export async function createSession(base, jwt) {
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
 * A fresh deployment takes a few seconds to answer on its hostname, and a
 * `wrangler secret put` needs its own propagation window. Poll `POST /new`
 * until it authenticates, then release the session so the readiness check
 * leaves nothing behind.
 */
export async function waitForTarget(base, jwt, timeoutMs = 90_000) {
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

// ── State ────────────────────────────────────────────────────────────
//
// Signing secrets live under `.wrangler/` (gitignored) at mode 600, so
// later commands need no environment beyond the account pin.

export function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// ── Small helpers ────────────────────────────────────────────────────

export function randomSecret() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export function parseFlags(argv) {
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
