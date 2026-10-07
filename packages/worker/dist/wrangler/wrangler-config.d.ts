/**
 * wrangler-config.ts — a project's wrangler.json or wrangler.jsonc, as
 * `nimbus wrangler dev`, its unsupported-binding warning, the repo's
 * deploy-isolation gate and its release uploads (scripts/ci/lib/release.mjs)
 * read it.
 */
/**
 * Subset of wrangler.jsonc we actually understand. Unknown top-level
 * fields are ignored; known fields in WRANGLER_UNSUPPORTED_CONFIG_FIELDS
 * (session/helpers.ts) are warned about at call time.
 */
export interface WranglerConfig {
    name?: string;
    main?: string;
    compatibility_date?: string;
    compatibility_flags?: string[];
    kv_namespaces?: {
        binding: string;
        id?: string;
        preview_id?: string;
    }[];
    d1_databases?: {
        binding: string;
        database_id?: string;
        database_name?: string;
        migrations_dir?: string;
        preview_database_id?: string;
    }[];
    r2_buckets?: {
        binding: string;
        bucket_name?: string;
        preview_bucket_name?: string;
        jurisdiction?: string;
    }[];
    /** Inline env-vars (strings) delivered to the inner worker as env.<KEY>. */
    vars?: Record<string, string>;
    /**
     * Service bindings: not supported in `nimbus wrangler dev`, which warns
     * and leaves each undefined. No outer binding is ever forwarded by name:
     * that once handed a sandbox NIMBUS_SESSION and JWT_SECRET
     * (NimbusWrangler.buildInnerEnv).
     */
    services?: {
        binding: string;
        service: string;
        entrypoint?: string;
    }[];
    /** Static assets directory + binding name. */
    assets?: {
        directory?: string;
        binding?: string;
        [k: string]: any;
    };
    /** Worker Loader bindings. */
    worker_loaders?: {
        binding: string;
    }[];
    /** Durable Object bindings. */
    durable_objects?: {
        bindings?: {
            name: string;
            class_name: string;
            script_name?: string;
        }[];
    };
    /** DO migrations — informational; we don't apply them (facets auto-create SQLite). */
    migrations?: any[];
    /** Environment blocks: the deploy-isolation gate reads them; `nimbus wrangler dev` serves the top level. */
    env?: Record<string, WranglerConfig>;
    /**
     * Build-time global replacements (wrangler's `define`). A release built by
     * `wrangler deploy` is uploaded as a Preview only when the Preview's own
     * `define` is the same (scripts/ci/lib/release.mjs).
     */
    define?: Record<string, string>;
    /** What `wrangler preview` applies over the top level: the release path compares its `define`. */
    previews?: {
        define?: Record<string, string>;
        [k: string]: unknown;
    };
    /** Import aliases for wrangler's bundler; a release uploads an already bundled module and drops them. */
    alias?: Record<string, string>;
    /** The JSON schema an editor validates the file against; dropped from a release's upload config. */
    $schema?: string;
}
/**
 * A wrangler.json or wrangler.jsonc as wrangler reads one: jsonc-parser,
 * trailing commas allowed, refused at its first error.
 */
export declare function parseWranglerJsonc(text: string): WranglerConfig;
//# sourceMappingURL=wrangler-config.d.ts.map