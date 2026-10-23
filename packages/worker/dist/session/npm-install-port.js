import { materializeNpmBinShims, NPM_BIN_MANIFEST_NAME, npmBinDirPath, unlinkNpmBins } from '../npm/bin-links.js';
import { handKernelArtifact, projectFs } from '../runtime/project-fs.js';
import { withRecall } from '@nimbus-sh/core/vfs/recall.js';
import { canonicalTreePath, holdTree } from '@nimbus-sh/core/_shared/npm-tree.js';
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
                await withRecall(() => self.ensureGlobalPrefixDirs(globalPrefix, cred, spec.pid));
            if (globalBinDir)
                await handKernelBins(filesystem, filesystem.view({ pid: spec.pid, cred }), cred, globalBinDir);
            const installCwd = globalPrefix ? `${globalPrefix}/lib` : spec.projectDir;
            // The spec whole, but for what the port settles itself.
            const { projectDir: _projectDir, packages, global: _global, globalPrefix: _globalPrefix, npmLog, ...asked } = spec;
            const result = await installer.install(installCwd, {
                ...asked,
                packages: packages.length > 0 ? [...packages] : undefined,
                cred,
                npmLog: npmLog ?? undefined,
                global: globalPrefix !== undefined,
                // On-PATH bin shims, under the install's hold: even for a partial
                // install the linker skips what never landed, so a partial tree
                // exposes exactly the bins that installed.
                whileHeld: globalBinDir === undefined ? undefined : () => withRecall(() => materializeNpmBinShims(sqliteFs.as(cred, { pid: spec.pid }), `${installCwd}/node_modules`, globalBinDir)),
            });
            return {
                installed: result.installed,
                failed: result.failed,
                totalFiles: result.totalFiles,
                fromCacheHits: result.cachedHits,
                linkedBins: result.linkedBins ?? 0,
                engines: result.engines ?? [],
            };
        },
        // The tree as the installer holds it while it installs (installer.ts
        // install): its canonical path, in the session's engine.
        async hold({ modulesDir, pid, signal }) {
            const view = filesystem.view({ pid, cred: self.processes.cred(pid) });
            const held = holdTree(filesystem.engine, await canonicalTreePath((path) => view.realpath(path), modulesDir), signal);
            return typeof held === 'function' ? held : await held;
        },
        // The bins the installer linked for what `npm uninstall` removed: in the
        // tree's .bin, and for a global one on PATH, each with its manifest.
        async unlinkBins({ modulesDir, globalBinDir, pid, packages }) {
            const cred = self.processes.cred(pid);
            const view = filesystem.view({ pid, cred });
            for (const binDir of [npmBinDirPath(modulesDir), ...(globalBinDir === undefined ? [] : [globalBinDir])]) {
                // Releases through worker 0.17.0 wrote the manifest as root.
                await handKernelArtifact(filesystem, view, cred, `${binDir}/${NPM_BIN_MANIFEST_NAME}`);
                await unlinkNpmBins(projectFs(view), binDir, packages);
            }
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
