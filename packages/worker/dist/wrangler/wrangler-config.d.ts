/**
 * wrangler-config.ts — a project's wrangler.json or wrangler.jsonc, as
 * `nimbus wrangler dev` reads it and as its unsupported-binding warning
 * reads it.
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
     * Service bindings. In the outer session the `service` field names
     * another deployed Worker; here we honor it only if the outer env
     * happens to have a field by the same name (i.e. wrangler dev --local
     * with a companion worker). Otherwise we warn and leave undefined.
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
}
/**
 * A wrangler.json or wrangler.jsonc as wrangler reads one: jsonc-parser,
 * trailing commas allowed, refused at its first error.
 */
export declare function parseWranglerJsonc(text: string): WranglerConfig;
//# sourceMappingURL=wrangler-config.d.ts.map