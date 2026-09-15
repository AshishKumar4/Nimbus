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
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { materializeNpmBinShims } from '../npm/bin-links.js';

export function createNpmInstallPort(self: SessionInternal): NpmInstallPort {
  return {
    async install(spec) {
      const globalBinDir = spec.global ? spec.globalBinDir : undefined;
      // <prefix>/bin → <prefix>: the bin dir is always `<prefix>/bin`.
      const globalPrefix = globalBinDir ? globalBinDir.replace(/\/bin$/, '') : undefined;
      self.ensureSqliteFs();
      await self.ensureNpmInstaller();
      if (globalPrefix) self.ensureGlobalPrefixDirs(globalPrefix);
      const installCwd = globalPrefix ? `${globalPrefix}/lib` : spec.projectDir;

      // The invoking process is always the shell — shell commands run
      // under the shell's identity, so shellProcessPid is the pid the
      // command's ctx.pid carried. (Verified: ctx.pid IS the shell pid
      // via commandIdentityFor.)
      const result = await self.npmInstaller!.install(installCwd, {
        packages: spec.packages.length > 0 ? [...spec.packages] : undefined,
        production: spec.production,
        pid: self.shellProcessPid ?? undefined,
        npmLog: spec.npmLog ?? undefined,
        onProgress: spec.onProgress,
      });

      let linkedBins = 0;
      if (globalPrefix && globalBinDir) {
        // Materialise on-PATH bin shims even for partial installs — the
        // bin linker already skips entries whose target never landed, so
        // a partial tree safely exposes exactly the bins that installed.
        linkedBins = materializeNpmBinShims(
          self.sqliteFs!.as(CRED_KERNEL) as never,
          `${installCwd}/node_modules`,
          globalBinDir,
        );
      }

      return {
        installed: result.installed,
        failed: result.failed,
        totalFiles: result.totalFiles,
        fromCacheHits: result.cachedHits,
        linkedBins,
      };
    },
  };
}
