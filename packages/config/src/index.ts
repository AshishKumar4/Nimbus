/**
 * @nimbus-sh/config — Typed wrangler-config helper.
 *
 * Use this from Pulumi/Terraform/CDK, custom CI scripts, or wherever
 * you generate `wrangler.jsonc` files programmatically. The function
 * is pure (no I/O) and zero-dependency.
 *
 * @example
 * ```ts
 * import { buildNimbusWranglerConfig } from '@nimbus-sh/config';
 * import { writeFileSync } from 'node:fs';
 *
 * const config = buildNimbusWranglerConfig({
 *   name: 'my-nimbus',
 *   compatibilityDate: '2026-04-01',
 *   r2BucketPrefix: 'my-nimbus',
 *   runtimeCache: 'shared',
 * });
 * writeFileSync('wrangler.jsonc', JSON.stringify(config, null, 2));
 * ```
 */

/**
 * Options for {@link buildNimbusWranglerConfig}.
 */
export type NimbusRuntimeName =
  | 'node'
  | 'bun'
  | 'npm'
  | 'git'
  | 'python'
  | 'ruby'
  | 'clang'
  | 'shell'
  | (string & {});

export interface NimbusSandboxProfile {
  root?: string;
  runtimes?: {
    preinstall?: string[];
    onDemand?: boolean;
    allow?: NimbusRuntimeName[];
  };
  tools?: {
    namespace?: string;
    kind?: string;
  };
  preview?: {
    baseUrl?: string;
    pathStyle?: boolean;
  };
}

export interface NimbusConfig {
  endpoint?: string;
  runtimeCache?: 'shared' | 'byoa' | { mode: 'shared' | 'byoa'; bucket?: string };
  sandboxes?: Record<string, NimbusSandboxProfile>;
}

export function defineNimbusConfig<T extends NimbusConfig>(config: T): T {
  return config;
}

export interface BuildWranglerOptions {
  /** Worker name. Becomes the deployed-Worker name and the prefix for derived R2 buckets. */
  name: string;
  /** Compatibility date. Default `2026-04-01`. */
  compatibilityDate?: string;
  /** Smart placement on/off. Default `true`. */
  placement?: 'smart' | undefined;
  /** Prefix for R2 buckets (npm tarball + packument caches). Default = `name`. */
  r2BucketPrefix?: string;
  /**
   * Runtime cache mode.
   *   - `'shared'` (default): bind `NIMBUS_RUNTIME_CACHE` to the
   *     standard account-local bucket `nimbus-runtime-cache-public`.
   *     Seed it with `nimbus setup cloudflare` or `nimbus runtime sync`.
   *   - `'byoa'`: bind to `${r2BucketPrefix}-runtime-cache`. Embedder
   *     must populate it with `nimbus runtime sync`.
   */
  runtimeCache?: 'shared' | 'byoa' | { mode: 'shared' | 'byoa'; bucket?: string };
  /**
   * Set true to opt into legacy single-tenant mode (no JWT verification).
   * Mirrors `NIMBUS_LEGACY_PUBLIC=1` env var. Default `false`.
   */
  legacyPublic?: boolean;
  /**
   * Extra Node-compat shim aliases to merge with the Nimbus-required
   * set. Embedder code that uses additional CJS deps can pass them here.
   */
  extraAliases?: Record<string, string>;
  /**
   * Optional session Agent configuration. Secrets are intentionally excluded:
   * set `NIMBUS_CF_OAUTH_CLIENT_SECRET` and `NIMBUS_CLOUDFLARE_API_TOKEN`
   * with `wrangler secret put`.
   */
  agent?: {
    model?: string;
    gatewayId?: string;
    oauth?: {
      clientId?: string;
      scopes?: string[];
      redirectUri?: string;
    };
    owner?: {
      accountId?: string;
    };
  };
}

/** Shape of the returned object — a valid wrangler.jsonc. */
export interface WranglerConfig {
  $schema?: string;
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  placement?: { mode: 'smart' };
  vars?: Record<string, string>;
  assets: {
    directory: string;
    binding: string;
    run_worker_first?: string[];
  };
  alias: Record<string, string>;
  durable_objects: {
    bindings: { name: string; class_name: string }[];
  };
  migrations: { tag: string; new_sqlite_classes: string[] }[];
  worker_loaders: { binding: string }[];
  r2_buckets: { binding: string; bucket_name: string }[];
}

/**
 * The bundler aliases that every Nimbus embedder needs.
 * Exposed as a named constant so embedders building their own configs
 * by hand can drop them in without copy-paste drift.
 */
export const NIMBUS_REQUIRED_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '@lifo-sh/ui': './node_modules/@nimbus-sh/worker/dist/stubs/lifo-ui.js',
  'clean-git-ref': 'clean-git-ref/lib/index.js',
  'is-git-ref-name-valid': 'is-git-ref-name-valid/index.js',
  'crc-32': 'crc-32',
  'sha.js': 'sha.js',
  pako: 'pako',
  pify: 'pify',
  diff: 'diff',
  diff3: 'diff3',
  ignore: 'ignore',
  'readable-stream': 'readable-stream',
  'simple-get': 'simple-get',
  minimisted: 'minimisted',
});

/**
 * Build a wrangler.jsonc-shaped object for a Nimbus embedder.
 *
 * The returned object is JSON-serializable and ready to write to disk
 * with `JSON.stringify(config, null, 2)`.
 *
 * @param opts See {@link BuildWranglerOptions}.
 * @returns A {@link WranglerConfig} ready to serialize.
 */
export function buildNimbusWranglerConfig(opts: BuildWranglerOptions): WranglerConfig {
  if (!opts.name || typeof opts.name !== 'string') {
    throw new Error('@nimbus-sh/config: `name` is required');
  }
  const compatDate = opts.compatibilityDate ?? '2026-04-01';
  const prefix = opts.r2BucketPrefix ?? opts.name;
  const runtimeCache = opts.runtimeCache ?? 'shared';
  const runtimeCacheMode = typeof runtimeCache === 'string' ? runtimeCache : runtimeCache.mode;
  const runtimeCacheBucket = typeof runtimeCache === 'object' && runtimeCache.bucket
    ? runtimeCache.bucket
    : runtimeCacheMode === 'shared'
      ? 'nimbus-runtime-cache-public'
      : `${prefix}-runtime-cache`;

  const config: WranglerConfig = {
    $schema: './node_modules/wrangler/config-schema.json',
    name: opts.name,
    main: 'src/index.ts',
    compatibility_date: compatDate,
    compatibility_flags: ['nodejs_compat'],
    assets: {
      directory: 'node_modules/@nimbus-sh/worker/public',
      binding: 'ASSETS',
      run_worker_first: ['/api/*', '/s/*', '/new'],
    },
    alias: { ...NIMBUS_REQUIRED_ALIASES, ...(opts.extraAliases ?? {}) },
    durable_objects: {
      bindings: [{ name: 'NIMBUS_SESSION', class_name: 'NimbusSession' }],
    },
    migrations: [
      { tag: 'nimbus-v1', new_sqlite_classes: ['NimbusSession'] },
    ],
    worker_loaders: [{ binding: 'LOADER' }],
    r2_buckets: [
      { binding: 'NPM_TARBALL_CACHE', bucket_name: `${prefix}-npm-cache` },
      { binding: 'NPM_PACKUMENT_CACHE', bucket_name: `${prefix}-npm-packument-cache` },
      { binding: 'NIMBUS_RUNTIME_CACHE', bucket_name: runtimeCacheBucket },
    ],
  };

  if (opts.placement === 'smart' || opts.placement === undefined) {
    config.placement = { mode: 'smart' };
  }
  if (opts.legacyPublic) {
    config.vars = { NIMBUS_LEGACY_PUBLIC: '1' };
  }
  const agentVars = buildAgentVars(opts.agent);
  if (Object.keys(agentVars).length > 0) {
    config.vars = { ...(config.vars ?? {}), ...agentVars };
  }

  return config;
}

function buildAgentVars(agent: BuildWranglerOptions['agent']): Record<string, string> {
  if (!agent) return {};
  const vars: Record<string, string> = {};
  if (agent.model) vars.NIMBUS_AGENT_MODEL = agent.model;
  if (agent.gatewayId) vars.NIMBUS_AGENT_GATEWAY_ID = agent.gatewayId;
  if (agent.oauth?.clientId) vars.NIMBUS_CF_OAUTH_CLIENT_ID = agent.oauth.clientId;
  if (agent.oauth?.redirectUri) vars.NIMBUS_CF_OAUTH_REDIRECT_URI = agent.oauth.redirectUri;
  if (agent.oauth?.scopes && agent.oauth.scopes.length > 0) {
    vars.NIMBUS_CF_OAUTH_SCOPES = agent.oauth.scopes.join(' ');
  }
  if (agent.owner?.accountId) vars.NIMBUS_CLOUDFLARE_ACCOUNT_ID = agent.owner.accountId;
  return vars;
}
