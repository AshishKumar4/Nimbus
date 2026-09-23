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
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { materializeNpmBinShims } from '../npm/bin-links.js';
import type { SessionInternal } from './internal.js';

type InstallHost = Pick<SessionInternal, 'ensureSqliteFs' | 'ensureNpmInstaller' | 'ensureGlobalPrefixDirs'>;

export function createNpmInstallPort(self: InstallHost): NpmInstallPort {
  return {
    async install(spec) {
      const globalPrefix = spec.global ? spec.globalPrefix : undefined;
      const globalBinDir = globalPrefix ? `${globalPrefix}/bin` : undefined;
      const sqliteFs = self.ensureSqliteFs();
      const installer = await self.ensureNpmInstaller();
      if (globalPrefix) self.ensureGlobalPrefixDirs(globalPrefix);
      const installCwd = globalPrefix ? `${globalPrefix}/lib` : spec.projectDir;

      const result = await installer.install(installCwd, {
        packages: spec.packages.length > 0 ? [...spec.packages] : undefined,
        production: spec.production,
        fromLockfile: spec.fromLockfile,
        pid: spec.pid,
        registry: spec.registry,
        npmLog: spec.npmLog ?? undefined,
        onProgress: spec.onProgress,
      });

      let linkedBins = 0;
      if (globalPrefix && globalBinDir) {
        // Materialise on-PATH bin shims even for partial installs — the
        // bin linker already skips entries whose target never landed, so
        // a partial tree safely exposes exactly the bins that installed.
        const vfs: Pick<CredentialedVfs, 'exists' | 'isDirectory' | 'readFileString' | 'readdir' | 'mkdir' | 'writeFile' | 'chmod'> =
          sqliteFs.as(CRED_KERNEL);
        linkedBins = materializeNpmBinShims(
          vfs,
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
