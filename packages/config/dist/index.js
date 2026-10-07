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
 *   compatibilityDate: '2026-09-26',
 *   r2BucketPrefix: 'my-nimbus',
 *   runtimeCache: 'shared',
 *   // What `nimbus runtime sync` printed for the bucket above.
 *   runtimeCatalogSha256: '<64 hex>',
 * });
 * writeFileSync('wrangler.jsonc', JSON.stringify(config, null, 2));
 * ```
 */
/**
 * Options for {@link buildNimbusWranglerConfig}.
 */
import { MAX_FACET_CPU_MS } from './facet-limits.generated.js';
export function defineNimbusConfig(config) {
    return config;
}
/**
 * The bundler aliases that every Nimbus embedder needs.
 * Exposed as a named constant so embedders building their own configs
 * by hand can drop them in without copy-paste drift.
 */
export const NIMBUS_REQUIRED_ALIASES = Object.freeze({
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
 * The flags Nimbus needs, each with the compatibility date from which
 * workerd enables it (src/workerd/io/compatibility-date.capnp): a config
 * names a flag only when its date is earlier. `enhanced_error_serialization`
 * (`enhancedErrorSerialization @115`) carries a filesystem error's `code`
 * across RPC; composeFabric refuses a Worker without it. `nodejs_compat`
 * (`nodeJsCompat @21`) brings `node:crypto` and `node:async_hooks`.
 */
const REQUIRED_FLAGS = [
    ['nodejs_compat', '2026-08-04'],
    ['enhanced_error_serialization', '2026-04-21'],
];
/**
 * Build a wrangler.jsonc-shaped object for a Nimbus embedder.
 *
 * The returned object is JSON-serializable and ready to write to disk
 * with `JSON.stringify(config, null, 2)`.
 *
 * @param opts See {@link BuildWranglerOptions}.
 * @returns A {@link WranglerConfig} ready to serialize.
 */
export function buildNimbusWranglerConfig(opts) {
    if (!opts.name || typeof opts.name !== 'string') {
        throw new Error('@nimbus-sh/config: `name` is required');
    }
    const compatDate = opts.compatibilityDate ?? '2026-09-26';
    const cpuMs = opts.cpuMs ?? MAX_FACET_CPU_MS;
    if (!Number.isInteger(cpuMs) || cpuMs < MAX_FACET_CPU_MS) {
        throw new Error(`@nimbus-sh/config: hosting Worker limits.cpu_ms=${cpuMs} is below facet policy maximum cpuMs=${MAX_FACET_CPU_MS}`);
    }
    const prefix = opts.r2BucketPrefix ?? opts.name;
    const runtimeCache = opts.runtimeCache ?? 'shared';
    const runtimeCacheMode = typeof runtimeCache === 'string' ? runtimeCache : runtimeCache.mode;
    const runtimeCacheBucket = typeof runtimeCache === 'object' && runtimeCache.bucket
        ? runtimeCache.bucket
        : runtimeCacheMode === 'shared'
            ? 'nimbus-runtime-cache-public'
            : `${prefix}-runtime-cache`;
    const config = {
        $schema: './node_modules/wrangler/config-schema.json',
        name: opts.name,
        main: 'src/index.ts',
        compatibility_date: compatDate,
        compatibility_flags: REQUIRED_FLAGS.filter(([, onByDate]) => compatDate < onByDate).map(([flag]) => flag),
        // Shell commands run in the session DO; the platform's 30 s default kills long ones.
        limits: { cpu_ms: cpuMs },
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
    if (opts.nimbusPublicDirectory) {
        config.durable_objects.bindings.push({
            name: 'NIMBUS_PUBLIC_DIRECTORY',
            class_name: 'NimbusPublicDirectory',
        });
        config.migrations.push({ tag: 'nimbus-v2', new_sqlite_classes: ['NimbusPublicDirectory'] });
    }
    if (opts.placement === 'smart' || opts.placement === undefined) {
        config.placement = { mode: 'smart' };
    }
    if (opts.legacyPublic) {
        config.vars = { NIMBUS_LEGACY_PUBLIC: '1' };
    }
    if (opts.runtimeCatalogSha256 !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(opts.runtimeCatalogSha256)) {
            throw new Error(`runtimeCatalogSha256 must be the 64-hex digest \`nimbus runtime sync\` prints, not "${opts.runtimeCatalogSha256}"`);
        }
        config.vars = { ...(config.vars ?? {}), NIMBUS_RUNTIME_CATALOG_SHA256: opts.runtimeCatalogSha256 };
    }
    const agentVars = buildAgentVars(opts.agent);
    if (Object.keys(agentVars).length > 0) {
        config.vars = { ...(config.vars ?? {}), ...agentVars };
    }
    return config;
}
function buildAgentVars(agent) {
    if (!agent)
        return {};
    const vars = {};
    if (agent.model)
        vars.NIMBUS_AGENT_MODEL = agent.model;
    if (agent.gatewayId)
        vars.NIMBUS_AGENT_GATEWAY_ID = agent.gatewayId;
    if (agent.oauth?.clientId)
        vars.NIMBUS_CF_OAUTH_CLIENT_ID = agent.oauth.clientId;
    if (agent.oauth?.redirectUri)
        vars.NIMBUS_CF_OAUTH_REDIRECT_URI = agent.oauth.redirectUri;
    if (agent.oauth?.scopes && agent.oauth.scopes.length > 0) {
        vars.NIMBUS_CF_OAUTH_SCOPES = agent.oauth.scopes.join(' ');
    }
    if (agent.owner?.accountId)
        vars.NIMBUS_CLOUDFLARE_ACCOUNT_ID = agent.owner.accountId;
    return vars;
}
