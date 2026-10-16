/**
 * cli/commands/runtime-sync — Re-runs the runtime-bundle pipeline that
 * populates an R2 bucket with the clang / cpython / ruby blobs.
 *
 * Two modes:
 *   - Default (no --bucket): syncs the canonical Nimbus-operated bucket
 *     `nimbus-runtime-cache-public` for the catalog the project ships
 *     today. This is what we run; embedders typically don't need it.
 *   - `--bucket <name>`: BYOA mode. Runtime names may be positional
 *     (`nimbus runtime sync cpython clang`) or comma-separated via
 *     `--runtimes cpython,clang`.
 *
 * Implementation: shells out to the runtime bundling helper shipped in
 * `@nimbus-sh/worker`. The CLI is the supported operator entrypoint. A
 * runtime Nimbus builds itself (cpython, bash, git) is published from its
 * npm runtime package there, which has no build tree.
 */
/**
 * Sync runtime blobs to an R2 bucket via the bundled worker helper.
 *
 * @example
 * ```bash
 * # BYOA mode — sync into your own bucket.
 * CLOUDFLARE_ACCOUNT_ID=… nimbus runtime sync --bucket my-runtime-cache cpython
 * ```
 */
export declare function syncRuntimes(args: string[], options?: {
    scriptPath?: string;
}): Promise<number>;
/** `nimbus runtime list` — print the selected bucket's actual defaults. */
export declare function listRuntimes(args: string[]): Promise<number>;
//# sourceMappingURL=runtime-sync.d.ts.map