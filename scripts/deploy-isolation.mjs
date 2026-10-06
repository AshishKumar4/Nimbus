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
 * config's default block, each of its non-production env blocks, and each
 * `previews` block (a Worker Preview, `wrangler preview`), all enumerated
 * from the files rather than listed. Adding `env.staging` put it under this
 * check with no second step; adding a `previews` block does the same.
 *
 * A Preview is audited by stricter rules than a Worker, because it is NOT a
 * separate Worker: it runs under its parent Worker, and only its Durable
 * Objects are isolated automatically. Everything else it binds is shared
 * with whoever else binds the same id — including the parent's own
 * production deployment — and a service binding from a Preview always
 * reaches the bound Worker's production. See `checkPreview`.
 *
 * Used by:
 *   - tests/unit/deploy-isolation.mjs   (CI enforces the invariant)
 *   - tests/behavioral/_throwaway-target.mjs (preflight before a preview)
 *   - tests/behavioral/_staging-target.mjs   (preflight, both halves)
 *   - `bun scripts/deploy-isolation.mjs` (CLI)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Deployable Worker configs in this repo. */
export const DEPLOYABLE_CONFIGS = [
  'apps/ci-runner/wrangler.jsonc',
  'apps/hosted-demo/wrangler.jsonc',
  'apps/probe/wrangler.jsonc',
];

/** Directories a Worker config can live in. */
const APP_DIRS = 'apps';

/**
 * Every wrangler config on disk, whether or not anything claims it.
 *
 * The list above is what the invariant is checked against; this is what
 * exists. A config missing from the list is not audited by anything, and
 * `apps/hosted-demo/wrangler.iso.json` sat there for two days that way —
 * a second Worker with its own D1, committed as a drive-by in an unrelated
 * merge, invisible to this module. Comparing the two is how that stays a
 * one-time event rather than a recurring one.
 */
export function discoverConfigs({ root = REPO_ROOT } = {}) {
  const found = [];
  for (const app of readdirSync(join(root, APP_DIRS), { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    for (const entry of readdirSync(join(root, APP_DIRS, app.name), { withFileTypes: true })) {
      if (entry.isFile() && /^wrangler(\..+)?\.(jsonc?|toml)$/.test(entry.name)) {
        found.push(`${APP_DIRS}/${app.name}/${entry.name}`);
      }
    }
  }
  return found.sort();
}

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

/**
 * Keys that configure the build/deploy itself and bind nothing. `env` and
 * `previews` are nested deploy targets rather than bindings of this block:
 * `deployableTargets` enumerates each one and audits it on its own.
 */
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
    'npm tarballs keyed by their resolved integrity digest and re-hashed on ' +
    'every read, so a writer can only ever address its own bytes; immutable ' +
    '(packages/worker/src/npm/r2-cache.ts). Also read profiles under ' +
    'read-profiles/v1/, keyed by the same integrity: package-relative paths ' +
    'only, validated when written and when read, so an entry can only widen ' +
    "which of a session's own files are staged, through its own credential " +
    '(packages/worker/src/facets/read-profile.ts)'],
  ['r2_buckets:nimbus-npm-packument-cache',
    'packument JSON on a 60-minute TTL, filled only by the registry fetch ' +
    'that produced it (packages/worker/src/npm/r2-cache.ts)'],
  ['r2_buckets:nimbus-runtime-cache',
    'never written by the Worker — runtime-catalog.ts only fetches blobs, ' +
    'manifests and the catalog; an operator script publishes them. The Worker ' +
    'DOES write the colo cache in front of it, so every entry there is keyed ' +
    'by its own digest and re-hashed on read, chained to the deployment\'s ' +
    'NIMBUS_RUNTIME_CATALOG_SHA256 var (packages/worker/src/runtime/runtime-catalog.ts)'],
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
      '(facets/vite-dev-server.ts) both call fetchEsbuildJsFnBody, which ' +
      'fetches esbuild\'s staged JS adapter from env.ASSETS bare; the generated vite/cirrus/tailwind modules ' +
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

/**
 * A block that binds the runtime cache must name the catalog it reads there
 * (vars.NIMBUS_RUNTIME_CATALOG_SHA256): runtime-catalog.ts reads the catalog
 * by that digest and refuses every `nimbus install` without it. Unlike a
 * missing capability this is a violation, production included: a deploy
 * that binds the cache and cannot read it is a deploy with a broken install.
 */
export function missingCatalogPin(block) {
  const binds = (block.r2_buckets ?? []).some((r) => r.binding === 'NIMBUS_RUNTIME_CACHE');
  const pin = block.vars?.NIMBUS_RUNTIME_CATALOG_SHA256;
  if (!binds || (typeof pin === 'string' && /^[a-f0-9]{64}$/.test(pin))) return [];
  return [
    `vars.NIMBUS_RUNTIME_CATALOG_SHA256 is ${pin === undefined ? 'absent' : `"${pin}", not a hex SHA-256`} ` +
    'while NIMBUS_RUNTIME_CACHE is bound: every `nimbus install` would fail ' +
    '(packages/worker/src/runtime/runtime-catalog.ts). `bundle-runtime.mjs --pin-catalog` writes it',
  ];
}

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
 * Every deploy target the repo can name, except production itself.
 *
 * Enumerated from the files rather than kept as a list: an env block nobody
 * remembered to add to a list is exactly the one that ships bound to a
 * production resource. Adding `env.staging` therefore puts it under the same
 * CI check as the default block, with no second step to forget.
 *
 * Every block that resolves a `previews` block — production's included,
 * since a Preview of the production Worker is not production — adds a
 * `{ preview: true }` target. `previews` is inheritable in wrangler
 * (wrangler-dist/cli.js `previews: inheritable(...)` in the environment
 * normalizer), so an env block without its own inherits the top-level one.
 */
export function deployableTargets({ root = REPO_ROOT, configs = DEPLOYABLE_CONFIGS } = {}) {
  const targets = [];
  for (const relPath of configs) {
    const config = loadConfig(relPath, root);
    const envNames = Object.keys(config.env ?? {});
    targets.push({ config: relPath, envName: null });
    for (const envName of envNames) {
      if (envName !== PRODUCTION_ENV) targets.push({ config: relPath, envName });
    }
    for (const envName of [null, ...envNames]) {
      if (resolveEnvironment(config, envName, { inherit: true }).previews) {
        targets.push({ config: relPath, envName, preview: true });
      }
    }
  }
  return targets;
}

/**
 * Keys a Preview takes from its parent block when `previews` does not set
 * them — read from wrangler 4.143's `assemblePreviewDeploymentSettings`
 * (wrangler-dist/cli.js): assets, compatibility date/flags, migrations and
 * the build come from the top level; limits, placement, cache,
 * observability and logpush fall back to it. Every BINDING comes from
 * `previews` alone (`extractConfigBindings` → `extractBindings(
 * config.previews, config.assets)`), which is what makes the block
 * auditable by itself.
 */
const PREVIEW_INHERITED_KEYS = new Set([
  'main', 'alias', 'assets', 'compatibility_date', 'compatibility_flags',
  'migrations', 'limits', 'placement', 'cache', 'observability', 'logpush',
  'rules', 'find_additional_modules', 'base_dir', 'no_bundle', 'minify',
  'keep_names', 'tsconfig', 'jsx_factory', 'jsx_fragment', 'build',
  'preserve_file_names', 'upload_source_maps',
]);

/**
 * What a `wrangler preview` of `envName` runs with. Literal by default (the
 * `previews` block alone, which names every binding the Preview gets);
 * `inherit: true` adds the keys a Preview takes from its parent block.
 */
export function resolvePreview(config, envName = null, { inherit = false } = {}) {
  const parent = resolveEnvironment(config, envName, { inherit: true });
  const block = parent.previews;
  if (!block) throw new Error(`no previews block for ${envName ? `env.${envName}` : 'the top level'}`);
  if (!inherit) return block;
  const merged = { ...block };
  for (const key of PREVIEW_INHERITED_KEYS) {
    if (!(key in merged) && key in parent) merged[key] = parent[key];
  }
  return merged;
}

/** JS-visible binding names a block declares, as `name → kind`. */
function bindingNames(block) {
  const names = new Map();
  for (const [key, value] of Object.entries(block)) {
    if (key === 'assets' || key === 'secrets') continue;
    if (key === 'vars') {
      for (const name of Object.keys(value ?? {})) names.set(name, key);
    } else if (SHARED_STATE_KEYS.has(key) || PER_WORKER_KEYS.has(key)) {
      const entries = key === 'durable_objects' ? (value?.bindings ?? []) : [value].flat();
      for (const entry of entries) {
        const name = entry?.binding ?? entry?.name;
        if (typeof name === 'string') names.set(name, key);
      }
    }
  }
  return names;
}

const PREVIEWS_DOCS = 'https://developers.cloudflare.com/workers/previews/resources/';

/**
 * Check one `previews` block: does a Worker Preview reach state it does not
 * own?
 *
 * A Preview is not a separate Worker, so the Worker rule (disjoint from
 * production) is necessary but not sufficient. From the platform's own
 * matrix (https://developers.cloudflare.com/workers/previews/resources/):
 *   - "Two Previews bound to the same account-level resource ID or name
 *     share its data or instances." A Preview is therefore held disjoint
 *     from its PARENT's own resources too, not only from production's —
 *     the shared-by-design caches excepted, as everywhere.
 *   - "Service bindings from a Preview call the bound Worker's production
 *     deployment." A binding to a production Worker, or to the parent
 *     itself, is refused: it leaves the Preview.
 *   - "Workflow bindings use existing Workflows and do not create
 *     Preview-specific Workflows." One owned by the parent or by a
 *     production Worker runs that Worker's deployed code and instances.
 *   - Durable Objects are isolated automatically "for a class defined in
 *     the same Worker without `script_name`". A `script_name` binding to
 *     the parent or to production reaches that Worker's namespace.
 * And a Preview of a production Worker is refused outright: it shares that
 * Worker's dashboard Previews Base configuration, which can "import names
 * and values from production" — the path a production secret would take
 * into a Preview (https://developers.cloudflare.com/workers/previews/configuration/).
 */
export function checkPreview(relPath, {
  root = REPO_ROOT, envName = null, workerName = null, configs = DEPLOYABLE_CONFIGS,
} = {}) {
  const config = loadConfig(relPath, root);
  const violations = [];
  const { ids: prodIds, names: prodNames } = productionIdentifiers({ root, configs });
  const parent = resolveWorkerName(config, envName, workerName);
  const result = {
    config: relPath, env: envName, preview: true, parent, violations, shared: [], missing: [],
    production: [...prodNames].join(', '), target: `${parent} (preview)`,
  };

  const parentBlock = resolveEnvironment(config, envName, { inherit: true });
  if (!parentBlock.previews) {
    violations.push(
      `no \`previews\` block: \`wrangler preview\` needs one, and without it nothing ` +
      `here says which resources the Preview binds`,
    );
    return result;
  }
  const block = resolvePreview(config, envName);

  if (prodNames.has(parent)) {
    violations.push(
      `parent Worker "${parent}" is the production Worker: its Previews share its ` +
      `Previews Base configuration, which the dashboard fills by importing production ` +
      `vars and secrets`,
    );
  }

  const parentIds = sharedResourceIdentifiers(resolveEnvironment(config, envName));
  for (const id of sharedResourceIdentifiers(block)) {
    const [kind, ...rest] = id.split(':');
    const name = rest.join(':');
    const byDesign = SHARED_BY_DESIGN.get(id);
    if (byDesign && (prodIds.has(id) || parentIds.has(id))) {
      result.shared.push(`${kind} → "${name}" shared with production by design: ${byDesign}`);
    } else if (prodIds.has(id)) {
      violations.push(
        `${kind} → "${name}" is a PRODUCTION resource (also bound by env.${PRODUCTION_ENV}); ` +
        `a Preview of "${parent}" would read and write it`,
      );
    } else if (parentIds.has(id)) {
      violations.push(
        `${kind} → "${name}" is also bound by the parent Worker "${parent}"; "two Previews ` +
        `bound to the same account-level resource ID or name share its data or instances" ` +
        `(${PREVIEWS_DOCS}) — bind the Preview to its own resource`,
      );
    }
  }

  // Bindings whose target is a Worker's production by the platform's rules,
  // whatever id they carry.
  const leavesPreview = (worker) => worker === parent || prodNames.has(worker);
  const whose = (worker) => (worker === parent ? `the parent Worker "${parent}"` : `production Worker "${worker}"`);
  for (const b of [block.services ?? []].flat()) {
    if (leavesPreview(b.service)) {
      violations.push(
        `services → "${b.service}": service bindings from a Preview call the bound Worker's ` +
        `production deployment (${PREVIEWS_DOCS}#service-bindings), so this reaches ` +
        `${whose(b.service)} — use ctx.exports for same-Worker calls`,
      );
    }
  }
  for (const b of block.durable_objects?.bindings ?? []) {
    if (b.script_name && leavesPreview(b.script_name)) {
      violations.push(
        `durable_objects → "${b.name}" names script_name "${b.script_name}": only a class ` +
        `defined in the same Worker without script_name gets a per-Preview namespace ` +
        `(${PREVIEWS_DOCS}#durable-objects), so this reaches ${whose(b.script_name)}`,
      );
    }
  }
  for (const w of [block.workflows ?? []].flat()) {
    const owner = w.script_name ?? parent;
    if (leavesPreview(owner)) {
      violations.push(
        `workflows → "${w.name}": a Preview binds an existing Workflow and runs its ` +
        `deployed code and instances (${PREVIEWS_DOCS}#workflows), so this reaches ` +
        `${whose(owner)} — bind a dedicated non-production Workflow`,
      );
    }
  }

  result.violations.push(...missingCatalogPin(resolvePreview(config, envName)));
  result.missing = missingCapabilities(resolvePreview(config, envName, { inherit: true }));
  const declared = bindingNames(block);
  for (const [name, kind] of bindingNames(resolveEnvironment(config, envName))) {
    if (declared.has(name)) continue;
    result.missing.push(
      `${name} (${kind}) is bound by "${parent}" but not under \`previews\` — Previews do ` +
      `not inherit bindings, so "the binding will not exist in the Preview and your Worker ` +
      `can return a 1101 error" (${PREVIEWS_DOCS})`,
    );
  }
  return result;
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
  violations.push(...missingCatalogPin(resolveEnvironment(config, envName)));

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

/**
 * The preflight: every deployable target's isolation, and production's own
 * config read, not deployed. A production deploy goes through checkConfig
 * with its env (the pin, nothing else); reading it here as well means a pin
 * removed from production alone fails this check, not the deploy.
 */
export function checkAll({ root = REPO_ROOT, configs = DEPLOYABLE_CONFIGS } = {}) {
  const results = deployableTargets({ root, configs }).map(({ config, envName, preview }) => (preview
    ? checkPreview(config, { root, envName, configs })
    : checkConfig(config, { root, envName, configs })));
  for (const relPath of configs) {
    if (loadConfig(relPath, root).env?.[PRODUCTION_ENV] === undefined) continue;
    results.push(checkConfig(relPath, { root, envName: PRODUCTION_ENV, configs }));
  }
  return results;
}

/**
 * Preflight for any non-production deploy — a `--name` throwaway, the
 * persistent staging environment, a bare default-block deploy, or (with
 * `preview: true`) a `wrangler preview` under the parent `workerName`.
 * Throws before wrangler is invoked.
 */
export function assertDeployIsolated({
  configPath, workerName = null, envName = null, preview = false,
  root = REPO_ROOT, configs = DEPLOYABLE_CONFIGS,
}) {
  const check = preview ? checkPreview : checkConfig;
  const result = check(configPath, { root, envName, workerName, configs });
  if (result.violations.length > 0) {
    throw new Error(
      `refusing to deploy "${result.target}" from ${configPath}${envName ? ` (env.${envName})` : ''}` +
      `${preview ? ' `previews`' : ''} — it would reach state it does not own:\n` +
      result.violations.map((v) => `  - ${v}`).join('\n') +
      (preview
        ? `\n\nA Preview isolates only its Durable Objects. Point every other binding under ` +
          `\`previews\` at a Preview-only resource, and reach no Worker's production.`
        : `\n\nA non-production deploy must not share account-level resources with ` +
          `production. Move the production identifier under env.${PRODUCTION_ENV} only, ` +
          `or point this block at its own resource.`),
    );
  }
  return result;
}

/** How a result names the thing it checked, for logs and CLI output. */
export function describeTarget(result) {
  return `${result.config}${result.env ? ` (env.${result.env})` : ''}` +
    `${result.preview ? ' previews' : ''} → ${result.target}`;
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
