/**
 * wrangler-config.ts — a project's wrangler.json or wrangler.jsonc, as
 * `nimbus wrangler dev`, its unsupported-binding warning and the repo's
 * deploy-isolation gate read it.
 */

import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

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
  kv_namespaces?: { binding: string; id?: string; preview_id?: string }[];
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
  services?: { binding: string; service: string; entrypoint?: string }[];
  /** Static assets directory + binding name. */
  assets?: { directory?: string; binding?: string; [k: string]: any };
  /** Worker Loader bindings. */
  worker_loaders?: { binding: string }[];
  /** Durable Object bindings. */
  durable_objects?: { bindings?: { name: string; class_name: string; script_name?: string }[] };
  /** DO migrations — informational; we don't apply them (facets auto-create SQLite). */
  migrations?: any[];
  /** Environment blocks: the deploy-isolation gate reads them; `nimbus wrangler dev` serves the top level. */
  env?: Record<string, WranglerConfig>;
}

/**
 * A wrangler.json or wrangler.jsonc as wrangler reads one: jsonc-parser,
 * trailing commas allowed, refused at its first error.
 */
export function parseWranglerJsonc(text: string): WranglerConfig {
  const errors: ParseError[] = [];
  const config: WranglerConfig | undefined = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new SyntaxError(`${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new SyntaxError('the config is not a JSON object');
  }
  return config;
}
