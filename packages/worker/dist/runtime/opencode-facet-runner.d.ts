/**
 * opencode-facet-runner.ts — facet runner for the staged opencode ESM bundle.
 *
 * opencode is ESM-only (its CLI entry uses top-level await, so it cannot be
 * bundled to CJS) and imports a broad set of node: builtins plus node:sqlite.
 * It therefore cannot run through the standard `new Function` CJS facet path
 * (that path wraps entry code in a function body, which forbids ESM syntax).
 *
 * Instead the bundle rides into the facet Worker Loader module map as a real
 * ESM module (`opencode-bundle.js`) and this runner is the mainModule that:
 *
 *   1. Installs the Bun-global polyfill at module-init scope (Bun.stdin.text,
 *      Bun.stringWidth, Bun.file, Bun.hash) — opencode references `Bun.*` even
 *      on the node target.
 *   2. Seeds process.argv / env / cwd from the per-invocation constants baked
 *      into this module (the runner is regenerated per exec).
 *   3. Captures stdout/stderr and process.exit.
 *   4. Statically imports the opencode bundle, which runs the CLI for the
 *      seeded argv at module evaluation, before the fetch handler returns.
 *
 * node: builtins resolve through workerd's nodejs_compat. node:sqlite is not
 * provided by nodejs_compat, so it is supplied as an override module in the
 * facet map (see OPENCODE_NODE_SQLITE_MODULE_NAME). The `--version` path does
 * not construct a DatabaseSync, so the stub is sufficient there; the bash-tool
 * / serve paths that do open a DB hit the stub's clear diagnostic until the
 * VFS-backed sql.js shim is wired into the ESM path.
 */
/** Map-module specifier for the opencode ESM bundle. */
export declare const OPENCODE_BUNDLE_MODULE_NAME = "opencode-bundle.js";
/**
 * node:sqlite override module placed in the facet map. opencode statically
 * imports node:sqlite; workerd's nodejs_compat does not provide it, so the
 * static import would fail at link time and the whole module would never
 * load. This module satisfies the import. DatabaseSync throws a precise
 * diagnostic if actually constructed (the bash-tool/serve DB paths).
 */
export declare const OPENCODE_NODE_SQLITE_MODULE: string;
export interface OpencodeRunnerOptions {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    stdin: string;
}
/**
 * Generate the mainModule that boots the opencode ESM bundle in a facet.
 * captureOutput is implied: stdout/stderr are buffered and returned in the
 * JSON response (the staged-artifact path does not stream via SUPERVISOR
 * yet).
 */
export declare function generateOpencodeRunnerCode(opts: OpencodeRunnerOptions): string;
//# sourceMappingURL=opencode-facet-runner.d.ts.map