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
export type NimbusRuntimeName = 'node' | 'bun' | 'npm' | 'git' | 'python' | 'ruby' | 'clang' | 'shell' | (string & {});
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
    /**
     * Deployment's `NIMBUS_PREVIEW_HOST_SUFFIX`, enabling `<port>--<sid>.<suffix>`
     * preview origins. Only remote clients need to state it — `Nimbus.fromEnv`
     * reads it straight off the bindings.
     */
    previewHostSuffix?: string;
    runtimeCache?: 'shared' | 'byoa' | {
        mode: 'shared' | 'byoa';
        bucket?: string;
    };
    sandboxes?: Record<string, NimbusSandboxProfile>;
}
export declare function defineNimbusConfig<T extends NimbusConfig>(config: T): T;
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
    runtimeCache?: 'shared' | 'byoa' | {
        mode: 'shared' | 'byoa';
        bucket?: string;
    };
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
     * set `NIMBUS_AGENT_COOKIE_SECRET` and `NIMBUS_CLOUDFLARE_API_TOKEN`
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
    placement?: {
        mode: 'smart';
    };
    vars?: Record<string, string>;
    assets: {
        directory: string;
        binding: string;
        run_worker_first?: string[];
    };
    alias: Record<string, string>;
    durable_objects: {
        bindings: {
            name: string;
            class_name: string;
        }[];
    };
    migrations: {
        tag: string;
        new_sqlite_classes: string[];
    }[];
    worker_loaders: {
        binding: string;
    }[];
    r2_buckets: {
        binding: string;
        bucket_name: string;
    }[];
}
/**
 * The bundler aliases that every Nimbus embedder needs.
 * Exposed as a named constant so embedders building their own configs
 * by hand can drop them in without copy-paste drift.
 */
export declare const NIMBUS_REQUIRED_ALIASES: Readonly<Record<string, string>>;
/**
 * Build a wrangler.jsonc-shaped object for a Nimbus embedder.
 *
 * The returned object is JSON-serializable and ready to write to disk
 * with `JSON.stringify(config, null, 2)`.
 *
 * @param opts See {@link BuildWranglerOptions}.
 * @returns A {@link WranglerConfig} ready to serialize.
 */
export declare function buildNimbusWranglerConfig(opts: BuildWranglerOptions): WranglerConfig;
//# sourceMappingURL=index.d.ts.map