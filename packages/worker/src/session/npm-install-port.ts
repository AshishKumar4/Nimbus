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
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ProcessFiles, ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import { materializeNpmBinShims } from '../npm/bin-links.js';
import { handKernelArtifact } from '../runtime/project-fs.js';
import { withRecall } from '@nimbus-sh/core/vfs/recall.js';
import type { SessionInternal } from './internal.js';

type InstallHost = Pick<SessionInternal, 'ensureSqliteFs' | 'ensureNpmInstaller' | 'ensureGlobalPrefixDirs' | 'processes'>;

export function createNpmInstallPort(self: InstallHost, filesystem: ProcessFiles): NpmInstallPort {
  return {
    async install(spec) {
      const globalPrefix = spec.global ? spec.globalPrefix : undefined;
      const globalBinDir = globalPrefix ? `${globalPrefix}/bin` : undefined;
      const sqliteFs = self.ensureSqliteFs();
      const installer = await self.ensureNpmInstaller();
      // The prefix, the project and the bin shims are read and written as the running command.
      const cred = self.processes.cred(spec.pid);
      // The session's own engine calls here wait for a delegation they meet: each is repeatable.
      if (globalPrefix) await withRecall(() => self.ensureGlobalPrefixDirs(globalPrefix, cred));
      if (globalBinDir) await handKernelBins(filesystem, filesystem.view({ pid: spec.pid, cred }), cred, globalBinDir);
      const installCwd = globalPrefix ? `${globalPrefix}/lib` : spec.projectDir;

      const result = await installer.install(installCwd, {
        packages: spec.packages.length > 0 ? [...spec.packages] : undefined,
        production: spec.production,
        fromLockfile: spec.fromLockfile,
        pid: spec.pid,
        cred,
        registry: spec.registry,
        npmLog: spec.npmLog ?? undefined,
        onProgress: spec.onProgress,
        saveDev: spec.saveDev,
        saveOptional: spec.saveOptional,
        force: spec.force,
        strictPeerDeps: spec.strictPeerDeps,
        legacyPeerDeps: spec.legacyPeerDeps,
        omitOptional: spec.omitOptional,
        omitPeer: spec.omitPeer,
        preferDedupe: spec.preferDedupe,
        save: spec.save,
        savePrefix: spec.savePrefix,
        global: globalPrefix !== undefined,
        signal: spec.signal,
        // On-PATH bin shims, under the install's hold: even for a partial
        // install the linker skips what never landed, so a partial tree
        // exposes exactly the bins that installed.
        whileHeld: globalBinDir === undefined ? undefined : () => withRecall(() => materializeNpmBinShims(
          sqliteFs.as(cred),
          `${installCwd}/node_modules`,
          globalBinDir,
        )),
      });

      return {
        installed: result.installed,
        failed: result.failed,
        totalFiles: result.totalFiles,
        fromCacheHits: result.cachedHits,
        linkedBins: result.linkedBins ?? 0,
      };
    },
  };
}

/**
 * Releases through worker 0.17.0 wrote the shims in `binDir` and their
 * manifest as root: each still root's is handed to the directory's owner
 * (handKernelArtifact), so an install, as its process, can replace it.
 */
async function handKernelBins(filesystem: ProcessFiles, view: ProcessView, cred: VfsCred, binDir: string): Promise<void> {
  let entries: readonly { name: string }[];
  try { entries = await view.readdir(binDir); } catch { return; }
  for (const { name } of entries) await handKernelArtifact(filesystem, view, cred, `${binDir}/${name}`);
}
