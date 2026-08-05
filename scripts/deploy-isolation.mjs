#!/usr/bin/env bun
/**
 * deploy-isolation — the single definition of "this deploy cannot reach
 * production state".
 *
 * A throwaway Worker is deployed by overriding only the *name*
 * (`wrangler deploy --name nimbus-tw-foo`). Every binding still comes from
 * the config file, so a throwaway inherits whatever account-level resources
 * the block it deployed from happens to name. That is not a hypothetical:
 * a probe deployed from `apps/hosted-demo` wrote rows into the production
 * demo D1 because the top-level block hardcoded the production
 * `database_id`, and nothing in the deploy path looked.
 *
 * The invariant enforced here:
 *
 *   The set of shared account-level resources reachable from a
 *   non-production deploy must be DISJOINT from the set reachable from the
 *   production deploy.
 *
 * Resources are compared by *value*, not by a hand-maintained inventory of
 * production ids: production is defined as "whatever `env.production`
 * names", so the check keeps working when a binding is added, renamed or
 * repointed. Nothing has to be remembered.
 *
 * Unknown keys fail closed. `KNOWN_KEYS` is checked against wrangler's own
 * `config-schema.json`, so a wrangler upgrade that introduces a new binding
 * kind breaks this check until the kind is classified — rather than
 * silently opening a new path to production.
 *
 * The invariant stands over every deploy target the repo can name: each
 * config's default block AND each of its non-production env blocks, all
 * enumerated from the files rather than listed. Adding `env.staging` put
 * it under this check with no second step.
 *
 * Used by:
 *   - tests/unit/deploy-isolation.mjs   (CI enforces the invariant)
 *   - tests/behavioral/_throwaway-target.mjs (preflight before deploying)
 *   - tests/behavioral/_staging-target.mjs   (preflight, both halves)
 *   - `bun scripts/deploy-isolation.mjs` (CLI)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Deployable Worker configs in this repo. */
export const DEPLOYABLE_CONFIGS = [
  'apps/hosted-demo/wrangler.jsonc',
  'apps/probe/wrangler.jsonc',
];

/** The environment whose bindings define "production". */
export const PRODUCTION_ENV = 'production';

/**
 * Binding kinds that name an account-level resource two Workers can both
 * reach. These are the ones an isolation boundary has to be drawn around.
 */
const SHARED_STATE_KEYS = new Set([
  'd1_databases',
  'kv_namespaces',
  'r2_buckets',
  'queues',
  'services',
  'dispatch_namespaces',
  'hyperdrive',
  'vectorize',
  'analytics_engine_datasets',
  'mtls_certificates',
  'send_email',
  'pipelines',
  'workflows',
  'secrets_store_secrets',
  'ratelimits',
  'ai_search',
  'ai_search_namespaces',
  'agent_memory',
  'artifacts',
  'flagship',
  'vpc_services',
  'vpc_networks',
  'logfwdr',
  'tail_consumers',
  'streaming_tail_consumers',
  'containers',
  'cloudchamber',
  'stream',
  'media',
  'images',
  'cache',
  'unsafe',
]);

/**
 * Binding kinds that are per-Worker by construction: the platform scopes
 * them to the deploying script, so two Workers cannot collide.
 *
 *   durable_objects — a DO namespace belongs to the Worker that defines the
 *     class. Only a `script_name` entry reaches another Worker's namespace,
 *     which is why that one field is still collected below.
 *   worker_loaders, assets, ai, browser, version_metadata, websearch,
 *   python_modules, unsafe_hello_world — no account-level identifier.
 *   vars/secrets — values, not shared resources. Secrets are per-Worker and
 *     are never in the config file.
 */
const PER_WORKER_KEYS = new Set([
  'durable_objects',
  'worker_loaders',
  'assets',
  'ai',
  'browser',
  'version_metadata',
  'websearch',
  'python_modules',
  'unsafe_hello_world',
  'vars',
  'secrets',
]);

/** Keys that configure the build/deploy itself and bind nothing. */
const NON_BINDING_KEYS = new Set([
  '$schema', 'account_id', 'base_dir', 'build', 'compatibility_date',
  'compatibility_flags', 'compliance_region', 'define', 'dev',
  'find_additional_modules', 'first_party_worker', 'jsx_factory',
  'jsx_fragment', 'keep_names', 'limits', 'logpush', 'main', 'migrations',
  'minify', 'name', 'no_bundle', 'observability', 'placement',
  'preserve_file_names', 'preview_urls', 'previews', 'route', 'routes',
  'rules', 'triggers', 'tsconfig', 'upload_source_maps', 'workers_dev',
  'alias', 'env',
]);

const KNOWN_KEYS = new Set([
  ...SHARED_STATE_KEYS, ...PER_WORKER_KEYS, ...NON_BINDING_KEYS,
]);

/**
 * Fields that name the *binding* rather than the resource. Two environments
 * are expected to expose the same JS-visible binding name — `env.DEMO_DB`
 * is `env.DEMO_DB` everywhere — so these are not evidence of shared state.
 */
const BINDING_LOCAL_FIELDS = new Set(['binding', 'class_name', 'name', 'experimental_remote']);

/**
 * Resources that are cross-tenant BY DESIGN, with the evidence for each.
 *
 * Listed one by one rather than waved through by binding kind: a newly
 * added R2 bucket is a violation until somebody states why sharing it is
 * safe. They are still reported, so the sharing stays visible.
 *
 * The distinction that matters is mutable *tenant* state. A D1 row is one
 * tenant's session; a content-addressed tarball is a copy of public
 * registry bytes every tenant would fetch identically. Forcing probes onto
 * cold caches would slow every run and hammer the registry for no isolation
 * gain — and a check that expensive gets routed around, which is worse than
 * sharing deliberately.
 */
const SHARED_BY_DESIGN = new Map([
  ['r2_buckets:nimbus-npm-cache',
    'content-addressed npm tarballs, keyed by name+version, immutable ' +
    '(packages/worker/src/npm/r2-cache.ts)'],
  ['r2_buckets:nimbus-npm-packument-cache',
    'packument JSON on a 5-minute TTL, refreshed from the registry ' +
    '(packages/worker/src/npm/r2-cache.ts)'],
  ['r2_buckets:nimbus-runtime-cache',
    'never written by the Worker — runtime-catalog.ts only fetches blobs, ' +
    'manifests and the catalog; an operator script publishes them'],
]);

/**
 * Bindings whose ABSENCE fails loudly at runtime rather than degrading.
 *
 * The isolation check above asks "can this deploy reach production?". This
 * asks the symmetric question — "can this deploy actually run?" — because
 * stripping bindings is the obvious way to make a throwaway look isolated,
 * and two of them do not degrade: they throw from deep inside a session,
 * where the error reads as a bug in whatever was being probed.
 *
 * A missing one is a WARNING, not a violation: a loader-only probe that
 * never touches a runtime is legitimately minimal. Sharing production
 * resources is a safety boundary; lacking a capability is a limitation.
 * Conflating them would make the safety check something people turn off.
 */
const REQUIRED_BINDINGS = [
  {
    binding: 'ASSETS',
    present: (b) => Boolean(b.assets?.binding),
    breaks: 'almost everything. Four unguarded paths, none of which is the ' +
      'bundled real-vite mode people expect: npm install\'s pre-bundler ' +
      '(npm/installer.ts) and the DEFAULT in-process vite shim ' +
      '(facets/vite-dev-server.ts) both call fetchEsbuildWasmBytes, which ' +
      'fetches env.ASSETS bare; the generated vite/cirrus/tailwind modules ' +
      'call loadAssetText, which rejects E_ASSETS_BINDING_MISSING. The ' +
      '`if (env.ASSETS)` guards in router/index.ts cover only the router\'s ' +
      'own static fallthrough and say nothing about these. Assets-free is ' +
      'safe only for a probe that installs nothing and transforms nothing',
  },
  {
    binding: 'NIMBUS_RUNTIME_CACHE',
    present: (b) => (b.r2_buckets ?? []).some((r) => r.binding === 'NIMBUS_RUNTIME_CACHE'),
    breaks: 'anything touching a runtime (python, ruby, clang, node) — ' +
      'runtime-catalog.ts throws "NIMBUS_RUNTIME_CACHE binding missing" for ' +
      'catalog, manifest and blob fetches',
  },
];

/** Load-bearing bindings absent from `block`, with what each one breaks. */
export function missingCapabilities(block) {
  return REQUIRED_BINDINGS
    .filter((r) => !r.present(block))
    .map((r) => `${r.binding} is absent — breaks ${r.breaks}`);
}

export function loadConfig(relPath, root = REPO_ROOT) {
  // Bun parses JSONC natively; the repo's tooling is Bun throughout.
  return JSON.parse(stripJsonc(readFileSync(join(root, relPath), 'utf8')));
}

/** Minimal JSONC → JSON so this module also runs under plain node. */
function stripJsonc(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // Trailing commas are legal in JSONC, not in JSON.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Keys wrangler does NOT inherit into an env block: every binding kind,
 * plus the two that look like bindings and behave like them. An env block
 * must redeclare each of these or the deployed Worker simply lacks it.
 * https://developers.cloudflare.com/workers/wrangler/configuration/#non-inheritable-keys
 *
 * `worker_loaders` is here on evidence rather than on the docs list:
 * `wrangler deploy -e production --dry-run` warns that it is not inherited
 * and asks for it to be redeclared.
 */
const NON_INHERITABLE_KEYS = new Set([
  ...SHARED_STATE_KEYS, 'durable_objects', 'vars', 'secrets', 'worker_loaders',
]);

/**
 * Resolve what a deploy of `envName` actually gets.
 *
 * By default this is the env block alone, which is the right answer for the
 * isolation check: every key it classifies as a binding is non-inheritable,
 * so the block names, by itself, every shared resource the deploy can
 * reach. That is what makes the blocks independently auditable, and why
 * apps/hosted-demo/wrangler.jsonc redeclares each binding under each env.
 *
 * `inherit: true` fills in the keys wrangler DOES carry down — `assets`,
 * `main`, `placement`, `alias` — which is the right answer for asking what
 * the deploy can DO. env.production omits `assets` and production serves
 * them, so reading an env block literally reports capabilities it has.
 */
export function resolveEnvironment(config, envName = null, { inherit = false } = {}) {
  const block = envName ? (config.env?.[envName] ?? null) : config;
  if (!block) throw new Error(`no env block "${envName}" in config`);
  if (!inherit || !envName) return block;

  const merged = { ...block };
  for (const [key, value] of Object.entries(config)) {
    if (key === 'env' || key in merged || NON_INHERITABLE_KEYS.has(key)) continue;
    merged[key] = value;
  }
  return merged;
}

/** The Worker name a deploy of `envName` lands on. */
export function resolveWorkerName(config, envName = null, override = null) {
  if (override) return override;
  const block = resolveEnvironment(config, envName);
  // `name` is inheritable; wrangler appends the env name when an env block
  // does not set one explicitly.
  if (block.name) return block.name;
  return envName ? `${config.name}-${envName}` : config.name;
}

/** Every string value under `node`, except binding-local names. */
function collectStrings(node, out) {
  if (typeof node === 'string') { out.add(node); return out; }
  if (Array.isArray(node)) { for (const v of node) collectStrings(v, out); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (BINDING_LOCAL_FIELDS.has(k)) continue;
      collectStrings(v, out);
    }
  }
  return out;
}

/**
 * Identifiers of shared account-level resources reachable from `block`, as
 * `kind:value`. Deep-collecting every non-binding-local string (rather than
 * reading known id fields) means a resource stays covered when wrangler
 * adds a field to a binding kind that already exists.
 */
export function sharedResourceIdentifiers(block) {
  const ids = new Set();
  for (const [key, value] of Object.entries(block)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(
        `deploy-isolation: unclassified wrangler key "${key}". Classify it in ` +
        `scripts/deploy-isolation.mjs as shared account-level state or per-Worker ` +
        `before deploying — refusing to guess.`,
      );
    }
    if (SHARED_STATE_KEYS.has(key)) {
      for (const s of collectStrings(value, new Set())) ids.add(`${key}:${s}`);
    } else if (key === 'durable_objects') {
      // Only a cross-script binding escapes this Worker's own namespace.
      for (const b of value?.bindings ?? []) {
        if (b.script_name) ids.add(`durable_objects:${b.script_name}`);
      }
    }
  }
  return ids;
}

/**
 * Check one config: does a non-production deploy reach production state?
 *
 * `workerName` lets a caller ask about a specific throwaway; without it the
 * config's own default-block name is used.
 */
/**
 * Everything production binds, across every deployable in the repo.
 *
 * Production is a property of the ACCOUNT, not of one config file:
 * apps/probe declares no `env.production` of its own, yet names resources
 * that apps/hosted-demo's production block also names. Scoping the
 * comparison per-file would call that clean.
 */
export function productionIdentifiers({ root = REPO_ROOT, configs = DEPLOYABLE_CONFIGS } = {}) {
  const ids = new Set();
  const names = new Set();
  for (const relPath of configs) {
    const config = loadConfig(relPath, root);
    if (!config.env?.[PRODUCTION_ENV]) continue;
    names.add(resolveWorkerName(config, PRODUCTION_ENV));
    for (const id of sharedResourceIdentifiers(resolveEnvironment(config, PRODUCTION_ENV))) {
      ids.add(id);
    }
  }
  return { ids, names };
}

/**
 * Every (config, env) pair a deploy can target, except production itself.
 *
 * Enumerated from the files rather than kept as a list: an env block nobody
 * remembered to add to a list is exactly the one that ships bound to a
 * production resource. Adding `env.staging` therefore puts it under the same
 * CI check as the default block, with no second step to forget.
 */
export function deployableTargets({ root = REPO_ROOT, configs = DEPLOYABLE_CONFIGS } = {}) {
  const targets = [];
  for (const relPath of configs) {
    const config = loadConfig(relPath, root);
    targets.push({ config: relPath, envName: null });
    for (const envName of Object.keys(config.env ?? {})) {
      if (envName !== PRODUCTION_ENV) targets.push({ config: relPath, envName });
    }
  }
  return targets;
}

export function checkConfig(relPath, {
  root = REPO_ROOT, envName = null, workerName = null, configs = DEPLOYABLE_CONFIGS,
} = {}) {
  const config = loadConfig(relPath, root);
  const violations = [];

  const { ids: prodIds, names: prodNames } = productionIdentifiers({ root, configs });
  const prodName = [...prodNames].join(', ');
  const targetName = resolveWorkerName(config, envName, workerName);
  const isProductionDeploy = envName === PRODUCTION_ENV && !workerName;

  if (isProductionDeploy) {
    return {
      config: relPath, env: envName, violations, shared: [], missing: [],
      production: prodName, target: targetName,
    };
  }

  // A non-production deploy must not land on the production Worker name.
  if (prodNames.has(targetName)) {
    violations.push(
      `worker name "${targetName}" is the production Worker: a non-production ` +
      `deploy would overwrite the live script`,
    );
  }

  const shared = [];
  const targetIds = sharedResourceIdentifiers(resolveEnvironment(config, envName));
  for (const id of targetIds) {
    if (!prodIds.has(id)) continue;
    const [kind, ...rest] = id.split(':');
    const name = rest.join(':');
    const byDesign = SHARED_BY_DESIGN.get(id);
    if (byDesign) {
      shared.push(`${kind} → "${name}" shared with production by design: ${byDesign}`);
      continue;
    }
    violations.push(
      `${kind} → "${name}" is a PRODUCTION resource (also bound by ` +
      `env.${PRODUCTION_ENV}); a deploy of "${targetName}" would read and write it`,
    );
  }

  const missing = missingCapabilities(resolveEnvironment(config, envName, { inherit: true }));
  return {
    config: relPath, env: envName, violations, shared, missing,
    production: prodName, target: targetName,
  };
}

export function checkAll({ root = REPO_ROOT, configs = DEPLOYABLE_CONFIGS } = {}) {
  return deployableTargets({ root, configs })
    .map(({ config, envName }) => checkConfig(config, { root, envName, configs }));
}

/**
 * Preflight for any non-production deploy — a `--name` throwaway, the
 * persistent staging environment, or a bare default-block deploy. Throws
 * before wrangler is invoked.
 */
export function assertDeployIsolated({
  configPath, workerName = null, envName = null, root = REPO_ROOT, configs = DEPLOYABLE_CONFIGS,
}) {
  const result = checkConfig(configPath, { root, envName, workerName, configs });
  if (result.violations.length > 0) {
    throw new Error(
      `refusing to deploy "${result.target}" from ${configPath}${envName ? ` (env.${envName})` : ''} ` +
      `— it would reach production state:\n` +
      result.violations.map((v) => `  - ${v}`).join('\n') +
      `\n\nA non-production deploy must not share account-level resources with ` +
      `production. Move the production identifier under env.${PRODUCTION_ENV} only, ` +
      `or point this block at its own resource.`,
    );
  }
  return result;
}

/** How a result names the thing it checked, for logs and CLI output. */
export function describeTarget(result) {
  return `${result.config}${result.env ? ` (env.${result.env})` : ''} → ${result.target}`;
}

if (import.meta.main) {
  let failed = false;
  for (const result of checkAll()) {
    const where = describeTarget(result);
    if (result.violations.length > 0) {
      failed = true;
      console.error(`FAIL ${where} — this deploy reaches production:`);
      for (const v of result.violations) console.error(`  - ${v}`);
    } else {
      console.log(`ok  ${where} (production: ${result.production})`);
    }
    // Not a failure: a minimal probe may legitimately lack these. Printed so
    // a stripped-down config does not fail cryptically from inside a session.
    for (const m of result.missing ?? []) console.warn(`warn  ${where} — ${m}`);
  }
  process.exit(failed ? 1 : 0);
}
