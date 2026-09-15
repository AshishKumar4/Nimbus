/**
 * The worker's half of `npm install`: core's `npm` command parses the
 * invocation, owns the pre-checks and the summary text, and hands the
 * install itself to this port. What the port owns is everything the
 * command must not know: the NpmInstaller, the global prefix's directory
 * shape, and the materialisation of bin shims into <prefix>/bin.
 *
 * `projectDir` is always the shell's cwd; `globalBinDir` (root-relative
 * VFS path, e.g. `usr/local/bin`) is present only for `npm install -g`
 * and says where the shims go — the install root is its sibling
 * `<prefix>/lib`, and node_modules lands under it.
 */
import type { NpmInstallPort } from '@nimbus-sh/core/substrate/lifo/commands/system/npm.js';
import type { SessionInternal } from './internal.js';
export declare function createNpmInstallPort(self: SessionInternal): NpmInstallPort;
//# sourceMappingURL=npm-install-port.d.ts.map