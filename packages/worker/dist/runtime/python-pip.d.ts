import { z } from 'zod/v4';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { type RuntimeArtifactMetadata, type RuntimePythonPackageArtifactMetadata } from './runtime-catalog.js';
export declare const PYTHON_SITE_PACKAGES_ROOT = "home/user/.nimbus-python/site-packages";
export declare const PYTHON_PYODIDE_PACKAGE_MANIFEST = "home/user/.nimbus-python/site-packages/.nimbus-pyodide-packages.json";
export interface PythonPipRuntimeContext {
    pyodideLockfileText?: string | null;
    runtimeArtifacts?: RuntimeArtifactMetadata[];
}
export interface InstalledPyodidePackageManifest {
    version: 1;
    packages: RuntimePythonPackageArtifactMetadata[];
}
export interface PipInvocation {
    mode: 'pip' | 'none';
    code: string;
    error?: string;
    exitCode: number;
    pyodidePackages?: RuntimePythonPackageArtifactMetadata[];
}
export declare const InstalledPyodidePackageManifestSchema: z.ZodType<InstalledPyodidePackageManifest>;
export declare function parseInstalledPyodidePackageManifest(text: string): InstalledPyodidePackageManifest;
export declare function buildPipInvocation(argv: string[], binName: string, cwd: string, vfs: SqliteVFS, runtimeContext?: PythonPipRuntimeContext): Promise<PipInvocation>;
//# sourceMappingURL=python-pip.d.ts.map