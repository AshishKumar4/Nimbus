import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { materializeNpmBinShims } from '../npm/bin-links.js';
import { withRecall } from '@nimbus-sh/core/vfs/recall.js';
export function createNpmInstallPort(self) {
    return {
        async install(spec) {
            const globalPrefix = spec.global ? spec.globalPrefix : undefined;
            const globalBinDir = globalPrefix ? `${globalPrefix}/bin` : undefined;
            const sqliteFs = self.ensureSqliteFs();
            const installer = await self.ensureNpmInstaller();
            // The session's own engine calls here wait for a delegation they meet: each is repeatable.
            if (globalPrefix)
                await withRecall(() => self.ensureGlobalPrefixDirs(globalPrefix));
            const installCwd = globalPrefix ? `${globalPrefix}/lib` : spec.projectDir;
            const result = await installer.install(installCwd, {
                packages: spec.packages.length > 0 ? [...spec.packages] : undefined,
                production: spec.production,
                fromLockfile: spec.fromLockfile,
                pid: spec.pid,
                // The project is read and written as the running command.
                cred: self.processes.cred(spec.pid),
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
                whileHeld: globalBinDir === undefined ? undefined : () => withRecall(() => materializeNpmBinShims(sqliteFs.as(CRED_KERNEL), `${installCwd}/node_modules`, globalBinDir)),
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
