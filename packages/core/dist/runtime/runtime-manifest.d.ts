/**
 * runtime-manifest.ts — what an installed language runtime IS.
 *
 * A manifest names the files a runtime is made of, the shell commands it
 * provides, and the runner that answers them. `nimbus install <name>` writes
 * one into `~/.nimbus/runtimes/<name>/<version>/manifest.json`; every runner
 * reads its own out of the session filesystem from there.
 *
 * The data contract only. Where the bytes come FROM is the publisher's
 * problem, and the Cloudflare deployment's answer to it — an R2 bucket, a
 * per-colo cache, and a digest chain rooted at a build-time pin — lives in
 * `@nimbus-sh/worker`'s `runtime/runtime-catalog.ts`. A runtime that has been
 * installed is the same runtime whichever tier fetched it, so nothing below
 * this point knows there were tiers.
 */
import { z } from 'zod/v4';
import { PYODIDE_PACKAGE_ABI } from './os-contracts.js';
export interface ManifestFile {
    /** VFS path relative to ~/.nimbus/runtimes/<name>/<version>/. */
    path: string;
    /** Publisher-side key for the content blob. */
    content: string;
    /** Hex sha256 of the content blob bytes. */
    sha256: string;
    /** Byte size. */
    size: number;
    /** Optional file mode hint ("exec" → registered as a shell bin). */
    mode?: 'exec';
}
export interface ManifestEntrypoint {
    /** Shell command name. */
    binName: string;
    /** Runner key (e.g. "clang-runner") — package manager dispatches to
     *  the right runner factory by this. */
    runner: string;
    /** Default args prepended to user args at invocation. */
    args: string[];
    /** Optional secondary classification (e.g. "linker" for wasm-ld). */
    kind?: string;
}
export interface RuntimeArtifactMetadata {
    path: string;
    kind: string;
    id: string;
    source_sha256?: string;
    sha256: string;
}
export type RuntimePythonPackageAbi = typeof PYODIDE_PACKAGE_ABI;
export interface RuntimePythonExtensionModuleMetadata {
    /** Path inside Python site-packages, as stored in the wheel. */
    path: string;
    /** Path inside the installed Nimbus runtime root. */
    runtimePath: string;
    sha256: string;
}
export interface RuntimePythonPackageArtifactMetadata extends RuntimeArtifactMetadata {
    kind: 'python-package';
    language: 'python';
    packageName: string;
    version: string;
    abi: RuntimePythonPackageAbi;
    pyodideVersion: string;
    pythonVersion: string;
    wheelFileName: string;
    wheelSha256: string;
    loadMode: 'startup-module';
    imports: string[];
    dependencies: string[];
    extensionModules: RuntimePythonExtensionModuleMetadata[];
}
export interface RuntimeManifest {
    name: string;
    version: string;
    license: string;
    /** Which WASI namespace the binaries import — `wasi_unstable` for
     *  binji clang. `null` for non-WASI runtimes (e.g. Pyodide). */
    wasi_namespace: string | null;
    files: ManifestFile[];
    entrypoints: ManifestEntrypoint[];
    runtime_artifacts?: RuntimeArtifactMetadata[];
}
export declare const HexSha256Schema: z.ZodString;
export declare const RuntimePythonPackageArtifactMetadataSchema: z.ZodType<RuntimePythonPackageArtifactMetadata>;
export declare function parseRuntimeManifest(value: unknown): RuntimeManifest;
export declare function isRuntimePythonPackageArtifactMetadata(artifact: RuntimeArtifactMetadata): artifact is RuntimePythonPackageArtifactMetadata;
//# sourceMappingURL=runtime-manifest.d.ts.map