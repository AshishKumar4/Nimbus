/**
 * cli/commands/runtime-sync — Re-runs the runtime-bundle pipeline that
 * populates an R2 bucket with the clang / python / ruby blobs.
 *
 * Two modes:
 *   - Default (no --bucket): syncs the canonical Nimbus-operated bucket
 *     `nimbus-runtime-cache-public` for the catalog the project ships
 *     today. This is what we run; embedders typically don't need it.
 *   - `--bucket <name>`: BYOA mode. Runtime names may be positional
 *     (`nimbus runtime sync python clang`) or comma-separated via
 *     `--runtimes python,clang`.
 *
 * Implementation: shells out to the runtime bundling helper shipped in
 * `@nimbus-sh/worker`. The CLI is the supported operator entrypoint.
 */
/**
 * Sync runtime blobs to an R2 bucket via the bundled worker helper.
 *
 * @example
 * ```bash
 * # BYOA mode — sync into your own bucket.
 * CLOUDFLARE_ACCOUNT_ID=… nimbus runtime sync --bucket my-runtime-cache python
 * ```
 */
export declare function syncRuntimes(args: string[]): Promise<number>;
/** `nimbus runtime list` — print the catalog the SDK ships against. */
export declare function listRuntimes(_args: string[]): Promise<number>;
//# sourceMappingURL=runtime-sync.d.ts.map