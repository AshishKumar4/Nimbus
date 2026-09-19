/**
 * The worker's half of `npm install`: core's `npm` command parses the
 * invocation, owns the pre-checks and the summary text, and hands the
 * install itself to this port. What the port owns is everything the
 * command must not know: the NpmInstaller, the global prefix's directory
 * shape, and the materialisation of bin shims into <prefix>/bin.
 *
 * `projectDir` is always the shell's cwd; `globalPrefix` (absolute VFS
 * path, e.g. `/usr/local`) is present only for `npm install -g` and says
 * where `<prefix>/lib/node_modules` and `<prefix>/bin` land. `pid` is the
 * running command's pid — it authorizes the batch-facet writes.
 */
import type { NpmInstallPort } from '@nimbus-sh/core/substrate/lifo/commands/system/npm.js';
import type { SessionInternal } from './internal.js';
type InstallHost = Pick<SessionInternal, 'ensureSqliteFs' | 'ensureNpmInstaller' | 'ensureGlobalPrefixDirs'>;
export declare function createNpmInstallPort(self: InstallHost): NpmInstallPort;
export {};
//# sourceMappingURL=npm-install-port.d.ts.map