import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { materializeNpmBinShims } from '../npm/bin-links.js';
export function createNpmInstallPort(self) {
    return {
        async install(spec) {
            const globalPrefix = spec.global ? spec.globalPrefix : undefined;
            const globalBinDir = globalPrefix ? `${globalPrefix}/bin` : undefined;
            const sqliteFs = self.ensureSqliteFs();
            const installer = await self.ensureNpmInstaller();
            if (globalPrefix)
                self.ensureGlobalPrefixDirs(globalPrefix);
            const installCwd = globalPrefix ? `${globalPrefix}/lib` : spec.projectDir;
            const result = await installer.install(installCwd, {
                packages: spec.packages.length > 0 ? [...spec.packages] : undefined,
                production: spec.production,
                pid: spec.pid,
                npmLog: spec.npmLog ?? undefined,
                onProgress: spec.onProgress,
            });
            let linkedBins = 0;
            if (globalPrefix && globalBinDir) {
                // Materialise on-PATH bin shims even for partial installs — the
                // bin linker already skips entries whose target never landed, so
                // a partial tree safely exposes exactly the bins that installed.
                const vfs = sqliteFs.as(CRED_KERNEL);
                linkedBins = materializeNpmBinShims(vfs, `${installCwd}/node_modules`, globalBinDir);
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
