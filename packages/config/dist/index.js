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
export function defineNimbusConfig(config) {
    return config;
}
/**
 * The bundler aliases that every Nimbus embedder needs.
 * Exposed as a named constant so embedders building their own configs
 * by hand can drop them in without copy-paste drift.
 */
export const NIMBUS_REQUIRED_ALIASES = Object.freeze({
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
export function buildNimbusWranglerConfig(opts) {
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
    const config = {
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
    return config;
}
