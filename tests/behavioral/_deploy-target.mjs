// _deploy-target.mjs — the mechanics every non-production Nimbus deploy
// shares: pin the account, verify isolation, deploy, prove the deploy
// landed, and get an authenticated session out of the result. Building is
// scripts/dist-integrity.mjs, which every deploy path in the repo calls.
//
// Two callers, two lifetimes, one set of mechanics:
//   _throwaway-target.mjs — `nimbus-tw-*`, a Worker Preview of
//                           `nimbus-probe-previews`, deployed and deleted
//                           per run.
//   _staging-target.mjs   — `nimbus-staging` + `nimbus-probe-staging`,
//                           persistent Workers, redeployed in place.
//
// The one rule worth reading before editing: **a deploy is verified by its
// version (or Preview deployment) id, never by wrangler's exit status.**
// `wrangler deploy` can die in the asset-upload phase with a bare `fetch
// failed` and still exit 0 — measured 2026-08-02, when a full green probe
// suite ran against a two-builds-stale Worker. `deployAndVerify` therefore
// reads the active version back from the API and refuses a deploy that did
// not change it; the throwaway reads its Preview's latest deployment back
// the same way.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Terminal, stripAnsi } from './_driver.mjs';
import { deletionResult } from './_ledger.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The vars every apps/probe target the suite drives is deployed with, staging
 * and each throwaway alike, as `--var KEY:VALUE` arguments: the suite is
 * written against this configuration, so a target without it fails probes
 * for its configuration, not for the change. apps/probe's own config leaves
 * them out, so nimbus-probe keeps its production gating.
 *
 * NIMBUS_DEBUG=1 opens the _diag and _test surfaces (cache reset, the
 * abort that durable probes reset with) and the terminal's exit trailers
 * (`[shell exited: pid=… code=0 …]`) that probes read.
 */
export const PROBE_TARGET_VARS = ['--var', 'NIMBUS_DEBUG:1'];
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

// ── Cloudflare API ───────────────────────────────────────────────────
//
// For what wrangler has no command for: reading a Preview and its latest
// deployment back, and provisioning a Preview parent Worker.

const CF_API = 'https://api.cloudflare.com/client/v4';

/**
 * A token for the REST API: CLOUDFLARE_API_TOKEN when set (CI), otherwise
 * the one wrangler's own login holds (`wrangler auth token --json`).
 */
export function apiToken({ cwd, account }) {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const out = wrangle(WRANGLER, ['auth', 'token', '--json'], { cwd, account });
  const token = JSON.parse(out.stdout).token;
  if (typeof token !== 'string' || !token) throw new Error('wrangler auth token --json printed no token');
  return token;
}

/**
 * One API call under the account. Answers `{ ok, status, result, errors }`;
 * a transport failure throws.
 */
export async function cfApi(path, { account, token, method = 'GET', body, contentType = 'application/json' }) {
  const response = await fetch(`${CF_API}/accounts/${account}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': contentType }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok && json.success === true, status: response.status, result: json.result ?? null, errors: json.errors ?? [] };
}

// ── Sessions ─────────────────────────────────────────────────────────

/**
 * `POST /new` with a `session:create` bearer token. The core router
 * answers 302 to the session shell; the Location's bootstrap token is for
 * browsers, so probes keep using the bearer token instead.
 */
export async function createSession(base, jwt, { signal } = {}) {
  const response = await fetch(`${base}/new`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${jwt}` },
    signal,
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
 * The Worker can authenticate `/new` before its DO namespace/code is usable.
 * Readiness requires a real terminal command and the confirmed public destroy
 * result. A failed attempt owns its session until cleanup is acknowledged;
 * never mint another one while the previous cleanup is unconfirmed.
 */
export async function waitForTarget(base, jwt, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const headers = { Authorization: `Bearer ${jwt}` };
  const pendingCleanup = new Set();
  const budget = (max) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('readiness deadline exceeded');
    return Math.min(max, remaining);
  };
  const destroy = async (sid) => {
    // Still attempt cleanup when a terminal consumed the readiness budget.
    const timeout = Math.max(1_000, Math.min(10_000, deadline - Date.now()));
    const result = await deletionResult(await fetch(`${base}/s/${encodeURIComponent(sid)}/`, {
      method: 'DELETE',
      headers: { ...headers, 'X-Nimbus-Cleanup-Reason': 'target-readiness' },
      signal: AbortSignal.timeout(timeout),
    }));
    if (!result.ok) {
      throw new Error(`DELETE ${sid} → ${result.status}: destroy unconfirmed: ${result.body.slice(0, 300)}`);
    }
    pendingCleanup.delete(sid);
  };
  let last = '';
  while (Date.now() < deadline) {
    let sid, terminal, ready = false;
    try {
      for (const pending of pendingCleanup) await destroy(pending);
      const session = await createSession(base, jwt, { signal: AbortSignal.timeout(budget(15_000)) });
      sid = session.sessionId;
      pendingCleanup.add(sid);
      terminal = new Terminal(sid, { base, wsOptions: { headers } });
      await terminal.connect(budget(15_000));
      await terminal.waitForPrompt(budget(30_000));
      // The expected full marker is absent from the source, so a terminal
      // echo cannot masquerade as successful command execution.
      const command = await terminal.run('printf "__NIMBUS_READY_%s__\\n" "$((6*7))"', budget(30_000));
      if (!/^__NIMBUS_READY_42__\r?$/m.test(stripAnsi(command.output))) {
        throw new Error(`terminal command did not produce readiness output: ${command.output.slice(-300)}`);
      }
      ready = true;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    } finally {
      await terminal?.close();
      if (sid) {
        try { await destroy(sid); }
        catch (e) {
          ready = false;
          const cleanup = e instanceof Error ? e.message : String(e);
          last = last ? `${last}; cleanup failed: ${cleanup}` : `cleanup failed: ${cleanup}`;
        }
      }
    }
    if (ready && pendingCleanup.size === 0) return;
    const delay = Math.min(3_000, Math.max(0, deadline - Date.now()));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const unresolved = pendingCleanup.size > 0 ? `; unconfirmed cleanup sessions: ${[...pendingCleanup].join(', ')}` : '';
  throw new Error(`target never became ready within ${timeoutMs}ms: ${last}${unresolved}`);
}

// ── State ────────────────────────────────────────────────────────────
//
// Signing secrets are written at mode 600 so later commands need no
// environment beyond the account pin. Where the file lives follows the
// lifetime of what it describes. A throwaway belongs to the checkout
// that deployed it, so its state stays under that checkout's
// `.wrangler/` (gitignored). Staging is ONE environment shared by every
// checkout on the machine, so its state is machine state.
//
// That distinction is not cosmetic. Measured 2026-08-05: four worktrees
// held three different `nimbus-probe-staging` secrets, because each one
// deployed with no local record of the environment, minted a fresh
// secret and pushed it — invalidating every token the other checkouts
// were mid-suite with. Same host, same Worker, three answers.

export const MACHINE_STATE_DIR = join(
  process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'nimbus',
);

/**
 * Refuse to mint a new signing secret for a target that is already
 * provisioned and whose secret this machine has lost. Rotating it is a
 * legitimate operation — it is just never one to perform by accident,
 * because every client holding the old secret starts failing every
 * session-creating request with a bare 401.
 */
export function assertCredentialHeld({ name, statePath, hasSecret, provisioned, rotate }) {
  if (rotate || hasSecret || !provisioned) return;
  throw new Error(
    `${name} is already deployed, but there is no live signing secret for it at\n`
    + `${statePath}. Deploying now would mint a new one and push it, which invalidates\n`
    + `every token minted from the old secret — including the ones any suite running\n`
    + `against ${name} right now is holding.\n`
    + `  • to keep those working: restore that record from whatever last deployed ${name};\n`
    + `  • to take the name over deliberately: re-run with --rotate-secrets.`,
  );
}

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
