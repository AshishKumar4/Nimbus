/**
 * @nimbus-sh/cli — Programmatic surface.
 *
 * The CLI's `bin` entries (`nimbus`, `cli`, `create-nimbus-app`) call these
 * functions. Embedders building custom dev tooling can import them
 * directly:
 *
 * ```ts
 * import { mintToken, syncRuntimes } from '@nimbus-sh/cli';
 * ```
 */

export { mintToken } from './commands/token.js';
export { syncRuntimes } from './commands/runtime-sync.js';
export { setupCloudflare } from './commands/setup.js';
export { scaffold } from './commands/scaffold.js';
