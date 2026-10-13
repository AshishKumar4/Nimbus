import { materializeNpmBinShims } from '../npm/bin-links.js';
import { handKernelArtifact } from '../runtime/project-fs.js';
import { withRecall } from '@nimbus-sh/core/vfs/recall.js';
export function createNpmInstallPort(self, filesystem) {
    return {
        async install(spec) {
            const globalPrefix = spec.global ? spec.globalPrefix : undefined;
            const globalBinDir = globalPrefix ? `${globalPrefix}/bin` : undefined;
            const sqliteFs = self.ensureSqliteFs();
            const installer = await self.ensureNpmInstaller();
            // The prefix, the project and the bin shims are read and written as the running command.
            const cred = self.processes.cred(spec.pid);
            // The session's own engine calls here wait for a delegation they meet: each is repeatable.
            if (globalPrefix)
                await withRecall(() => self.ensureGlobalPrefixDirs(globalPrefix, cred));
            if (globalBinDir)
                await handKernelBins(filesystem, filesystem.view({ pid: spec.pid, cred }), cred, globalBinDir);
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
                whileHeld: globalBinDir === undefined ? undefined : () => withRecall(() => materializeNpmBinShims(sqliteFs.as(cred), `${installCwd}/node_modules`, globalBinDir)),
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
async function handKernelBins(filesystem, view, cred, binDir) {
    let entries;
    try {
        entries = await view.readdir(binDir);
    }
    catch {
        return;
    }
    for (const { name } of entries)
        await handKernelArtifact(filesystem, view, cred, `${binDir}/${name}`);
}
