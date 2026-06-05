#!/usr/bin/env node
/**
 * bin/nimbus — Multi-verb CLI dispatcher.
 *
 * Usage:
 *   nimbus token mint  --tenant acme --sub alice [--ttl 3600]
 *   nimbus token verify <token>
 *   nimbus runtime sync                 # upload runtime blobs/catalog through CLI wrapper
 *   nimbus runtime list                 # show staged runtimes
 *   nimbus session new                  # mint a session via /new
 *   nimbus --version
 *   nimbus --help
 *
 * Design notes:
 *   - Zero dependencies on commander/yargs. The verb table is ~50 LOC.
 *     This keeps the install footprint tiny (matters for `npx`).
 *   - Every verb writes JSON to stdout on success (machine-parseable),
 *     a human-readable summary line to stderr, and exits 0. Failures
 *     emit JSON `{ error, code }` + exit code from CLI_EXIT_CODES.
 */
export {};
//# sourceMappingURL=bin.d.ts.map