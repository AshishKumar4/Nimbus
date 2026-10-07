#!/usr/bin/env bun
// _staging-target.mjs — the persistent pre-production environment.
//
// WHY THIS EXISTS
//   Verifying a change used to mean one of two things: deploy it to
//   production and look, or stand up a throwaway that is gone an hour
//   later. Neither gives a place to run the whole behavioral suite,
//   repeatedly, against a deployment shaped like the one users hit.
//
// WHAT IT DEPLOYS
//   Two Workers, from one release CI built (scripts/ci/lib/release.mjs),
//   in one command — because production is
//   two things and staging is only useful if it covers both:
//
//     nimbus-staging        apps/hosted-demo, env.staging. The product
//                           mirror: same `main`, same `dist/assets`
//                           (shell + /docs), same inherited smart
//                           placement, same cleanup cron. Its own D1
//                           (`nimbus-demo-staging`), rate-limit namespace
//                           and Durable Object namespace. This is where
//                           the demo's own code — OAuth, the anonymous
//                           docs terminal, session cleanup — runs before
//                           production does. Its `POST /new` is gated on
//                           an interactive Cloudflare cookie, exactly as
//                           production's is, so it is verified in a
//                           browser rather than headlessly.
//
//     nimbus-probe-staging  apps/probe under a `--name` override. The
//                           bearer-token embedder the behavioral suite
//                           can actually drive. It binds no account-level
//                           state of its own — its Durable Object
//                           namespace is per-Worker by construction and
//                           its R2 caches are content-addressed and
//                           shared with production by design — so a name
//                           override IS complete isolation here, and the
//                           preflight below proves that rather than
//                           asserting it. Giving it an env block would
//                           only copy an identical binding list a third
//                           time, for wrangler to drift.
//
//   Neither is `nimbus-probe`, the long-lived probe target, nor `nimbus`.
//   CI deploys its own `nimbus-tw-ci-*` throwaway per run and grades that,
//   so nothing here is a target a branch should land on.
//
// USAGE
//   export CLOUDFLARE_ACCOUNT_ID=<account>       # account pin, required
//   bun run staging:deploy                       # CI builds, this machine uploads + verifies
//   bun run staging:test                         # full suite against staging
//
// COMMANDS
//   up      --release <dir> [--rotate-secrets]   a release CI built for HEAD
//           (scripts/ci/release.mjs staging makes one and runs this)
//   test    [--ttl-ms <ms>] [...run-all.mjs flags]
//   status
//   token   [--ttl-ms <ms>] [--json]   → the token, or JSON {base, token}
//   session [--ttl-ms <ms>]   → JSON {base, sessionId, token}
//
// STATE
//   `~/.local/state/nimbus/staging-target.json` (mode 600) holds each
//   Worker's URL and signing secret. Machine state, not checkout state:
//   staging is one environment, and every worktree on this machine
//   deploys and drives the same two Workers. Keeping the record per
//   checkout is what let four worktrees hold three different secrets,
//   each `up` silently rotating the previous one out from under whatever
//   suite was mid-run. `up` now refuses to replace the secret of a
//   Worker that already exists unless `--rotate-secrets` says to.

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { mintProbeToken } from './_mint-probe-token.mjs';
import { PROBE_TARGET_SKIPS } from './_probe-target-skips.mjs';
import { assertDeployIsolated, describeTarget } from '../../scripts/deploy-isolation.mjs';
import { uploadConfig } from '../../scripts/ci/lib/release.mjs';
import {
  MACHINE_STATE_DIR,
  PROBE_TARGET_VARS,
  ROOT,
  activeVersionId,
  assertCredentialHeld,
  createSession,
  deployAndVerify,
  parseFlags,
  putSecret,
  randomSecret,
  readState,
  requireAccountPin,
  waitForTarget,
  workersDevSubdomain,
  writeState,
} from './_deploy-target.mjs';

const STATE_PATH = join(MACHINE_STATE_DIR, 'staging-target.json');

/**
 * The two halves of staging. `envName` vs `nameOverride` is not a style
 * choice: hosted-demo binds account-level state that has to be split from
 * production's, which needs an env block; apps/probe binds none.
 */
const TARGETS = {
  demo: {
    label: 'hosted-demo',
    name: 'nimbus-staging',
    dir: join(ROOT, 'apps', 'hosted-demo'),
    configPath: 'apps/hosted-demo/wrangler.jsonc',
    envName: 'staging',
    deployArgs: [],
  },
  probe: {
    label: 'probe',
    name: 'nimbus-probe-staging',
    dir: join(ROOT, 'apps', 'probe'),
    configPath: 'apps/probe/wrangler.jsonc',
    envName: null,
    // The suite's vars ride the deploy override for the same reason --name
    // does: apps/probe has no env blocks, and they must reach THIS worker —
    // the one the suite drives — while nimbus-probe keeps its production
    // gating (PROBE_TARGET_VARS).
    deployArgs: ['--name', 'nimbus-probe-staging', ...PROBE_TARGET_VARS],
  },
};

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;

// ── CLI ──────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

const COMMANDS = { up, test, status, token, session };
const run = COMMANDS[command];
if (!run) {
  console.error(`usage: bun tests/behavioral/_staging-target.mjs <${Object.keys(COMMANDS).join('|')}> [flags]`);
  process.exit(2);
}
await run();

// ── Commands ─────────────────────────────────────────────────────────

async function up() {
  const account = requireAccountPin();
  const state = flags['rotate-secrets'] ? {} : (readState(STATE_PATH) ?? {});

  if (flags['rotate-secrets']) {
    log('WARNING: --rotate-secrets — every token minted from the current secrets stops');
    log('WARNING: working the moment the new ones land, including in suites running now');
  }

  // Before wrangler is invoked at all. Both blocks are also checked in CI
  // by tests/unit/deploy-isolation.mjs; this is the same function, run
  // against the same files, at the moment it matters.
  for (const target of Object.values(TARGETS)) {
    const isolation = assertDeployIsolated({
      configPath: target.configPath,
      envName: target.envName,
      workerName: target.envName ? null : target.name,
      root: ROOT,
    });
    for (const note of isolation.shared) log(`${target.label}: shared with production — ${note}`);
    for (const gap of isolation.missing) log(`${target.label}: WARNING: ${gap}`);
    log(`${describeTarget(isolation)} resolves no production resource`);

    // Also before the build: a rotation this machine did not ask for is
    // an outage for every other client of the environment, and finding
    // that out after a three-minute build is finding it out too late.
    assertCredentialHeld({
      name: target.name,
      statePath: STATE_PATH,
      hasSecret: Boolean(state[keyOf(target)]?.secret),
      provisioned: Boolean(activeVersionId(target.name, { cwd: target.dir, account })),
      rotate: Boolean(flags['rotate-secrets']),
    });
  }

  // A release CI built for this commit, the dist gate and the demo's assets
  // included (scripts/ci/release.mjs staging, scripts/ci/lib/release.mjs):
  // this machine only uploads it, and checks every byte against CI's.
  if (!flags.release) throw new Error('staging deploys a release CI built for this commit: run `bun scripts/ci/release.mjs staging`');
  const probeConfig = uploadConfig(flags.release, 'apps/probe', { root: ROOT, log });
  const demoConfig = uploadConfig(flags.release, `apps/hosted-demo:${TARGETS.demo.envName}`, { root: ROOT, log });

  const probe = await deployTarget(TARGETS.probe, { account, state, config: probeConfig });
  const subdomain = workersDevSubdomain(probe.base);
  if (!subdomain) throw new Error(`could not read the workers.dev subdomain from ${probe.base}`);
  const demo = await deployTarget(TARGETS.demo, { account, state, config: demoConfig });

  writeState(STATE_PATH, { ...state, subdomain, updatedAt: new Date().toISOString() });

  // The probe target is the one the suite drives, so readiness means "it
  // authenticates", not "it answers".
  const jwt = await mintProbeToken(state.probe.secret, ttlMs());
  await waitForTarget(probe.base, jwt);

  log(`ready — ${TARGETS.demo.name} ${demo.versionId} / ${TARGETS.probe.name} ${probe.versionId}`);
  process.stdout.write([
    `export BASE=${probe.base}`,
    `export NIMBUS_PROBE_TOKEN=${jwt}`,
    '',
  ].join('\n'));
}

/**
 * Run the whole behavioral suite against staging. Extra argv goes to the
 * runner, so `staging:test --no-retry` is CI-strict mode.
 */
async function test() {
  const state = requireState();
  const jwt = await mintProbeToken(state.probe.secret, ttlMs());
  const passthrough = withoutFlag(rest, '--ttl-ms');

  log(`running the behavioral suite against ${state.probe.base}`);
  log(`skipping: ${PROBE_TARGET_SKIPS.join(', ')}`);
  const result = spawnSync('bun', ['tests/behavioral/run-all.mjs', ...passthrough], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      BASE: state.probe.base,
      NIMBUS_PROBE_TOKEN: jwt,
      NIMBUS_PROBE_SKIP: process.env.NIMBUS_PROBE_SKIP || PROBE_TARGET_SKIPS.join(','),
    },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function status() {
  const account = requireAccountPin();
  const state = readState(STATE_PATH);
  for (const target of Object.values(TARGETS)) {
    const version = activeVersionId(target.name, { cwd: target.dir, account });
    const base = state?.[keyOf(target)]?.base ?? '(not deployed from this machine)';
    process.stdout.write(`${target.name}\t${version ?? '(absent)'}\t${base}\n`);
  }
}

async function token() {
  const state = requireState();
  const jwt = await mintProbeToken(state.probe.secret, ttlMs());
  process.stdout.write(flags.json ? `${JSON.stringify({ base: state.probe.base, token: jwt })}\n` : jwt);
}

async function session() {
  const state = requireState();
  const jwt = await mintProbeToken(state.probe.secret, ttlMs());
  const { sessionId, attachPath } = await createSession(state.probe.base, jwt);
  process.stdout.write(`${JSON.stringify({ base: state.probe.base, sessionId, attachPath, token: jwt }, null, 2)}\n`);
}

// ── Deploy ───────────────────────────────────────────────────────────

/**
 * Deploy one half of staging and make sure it can be talked to. The
 * signing secret is created on first deploy and reused afterwards, so
 * tokens minted earlier keep working across redeploys.
 */
async function deployTarget(target, { account, state, config }) {
  const key = keyOf(target);
  const secret = state[key]?.secret ?? randomSecret();
  const isNewSecret = !state[key]?.secret;

  log(`deploying ${target.configPath}${target.envName ? ` (env.${target.envName})` : ''} as ${target.name}`);
  const { base, versionId } = deployAndVerify({
    cwd: target.dir,
    account,
    name: target.name,
    envName: target.envName,
    args: ['--config', config, ...target.deployArgs],
  });
  if (!base) throw new Error(`deploy of ${target.name} printed no workers.dev URL`);
  log(`${target.name} → version ${versionId} live at ${base}`);

  if (isNewSecret) {
    log(`setting JWT_SECRET on ${target.name}`);
    putSecret({ cwd: target.dir, account, name: target.name, key: 'JWT_SECRET', value: secret });
  }
  state[key] = { name: target.name, base, secret };
  writeState(STATE_PATH, state);
  return { base, versionId };
}

// ── Small helpers ────────────────────────────────────────────────────

function keyOf(target) {
  return Object.keys(TARGETS).find((k) => TARGETS[k] === target);
}

function requireState() {
  const state = readState(STATE_PATH);
  if (!state?.probe?.base) {
    throw new Error('staging has not been deployed from this machine — run `bun run staging:deploy` first');
  }
  return state;
}

function ttlMs() {
  return flags['ttl-ms'] ? Number(flags['ttl-ms']) : DEFAULT_TTL_MS;
}

/** Drop `--flag value` from argv so the rest can be handed to the runner. */
function withoutFlag(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
}

function log(message) {
  console.error(`[staging] ${message}`);
}
