/**
 * runtime-manifest.ts — what an installed language runtime IS.
 *
 * A manifest names the files a runtime is made of, the shell commands it
 * provides, and the runner that answers them. `nimbus install <name>` writes
 * one into `/usr/lib/nimbus/<name>/<version>/manifest.json`; every runner
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
export type RuntimePythonPackageAbi = typeof PYODIDE_PACKAGE_ABI;
export declare const HexSha256Schema: z.ZodString;
/** Where `manifest` installs `rel` under `installRoot`; null when the manifest has no such file. */
export declare function installedPath(manifest: RuntimeManifest, installRoot: string, rel: string): string | null;
declare const ManifestFileSchema: z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
    sha256: z.ZodString;
    size: z.ZodNumber;
    mode: z.ZodOptional<z.ZodLiteral<"exec">>;
}, z.core.$strip>;
/**
 * A file a runtime is made of: `path`, relative to
 * /usr/lib/nimbus/<name>/<version>/; `content`, the publisher-side key of its
 * blob; `sha256` (hex) and `size` of the blob's bytes; and `mode`, 'exec' to
 * register it as a shell bin.
 */
export type ManifestFile = z.output<typeof ManifestFileSchema>;
declare const ManifestEntrypointSchema: z.ZodObject<{
    binName: z.ZodString;
    runner: z.ZodString;
    args: z.ZodArray<z.ZodString>;
    kind: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * A shell command a runtime provides: `binName`, the command; `runner`, the
 * runner factory the package manager dispatches it to (e.g. "clang-runner");
 * `args`, prepended to the user's args at invocation; and `kind`, an optional
 * secondary classification (e.g. "linker" for wasm-ld).
 */
export type ManifestEntrypoint = z.output<typeof ManifestEntrypointSchema>;
/** The fields every runtime artifact names; an artifact parsed keeps any others it carries. */
declare const RuntimeArtifactMetadataFields: z.ZodObject<{
    path: z.ZodString;
    kind: z.ZodString;
    id: z.ZodString;
    source_sha256: z.ZodOptional<z.ZodString>;
    sha256: z.ZodString;
}, z.core.$strip>;
export type RuntimeArtifactMetadata = z.output<typeof RuntimeArtifactMetadataFields>;
declare const RuntimePythonExtensionModuleMetadataSchema: z.ZodObject<{
    path: z.ZodString;
    runtimePath: z.ZodString;
    sha256: z.ZodString;
}, z.core.$strip>;
/** A Python extension module: `path` inside site-packages, as the wheel stores it, and `runtimePath` inside the installed Nimbus runtime root. */
export type RuntimePythonExtensionModuleMetadata = z.output<typeof RuntimePythonExtensionModuleMetadataSchema>;
declare const RuntimePythonPackageArtifactFields: z.ZodObject<{
    kind: z.ZodLiteral<"python-package">;
    language: z.ZodLiteral<"python">;
    packageName: z.ZodString;
    version: z.ZodString;
    abi: z.ZodLiteral<"pyodide-emscripten-2025_0-wasm32">;
    pyodideVersion: z.ZodString;
    pythonVersion: z.ZodString;
    wheelFileName: z.ZodString;
    wheelSha256: z.ZodString;
    loadMode: z.ZodLiteral<"startup-module">;
    imports: z.ZodArray<z.ZodString>;
    dependencies: z.ZodArray<z.ZodString>;
    extensionModules: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        runtimePath: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const RuntimePythonPackageArtifactMetadataSchema: z.ZodIntersection<z.ZodObject<{
    path: z.ZodString;
    kind: z.ZodString;
    id: z.ZodString;
    source_sha256: z.ZodOptional<z.ZodString>;
    sha256: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    kind: z.ZodLiteral<"python-package">;
    language: z.ZodLiteral<"python">;
    packageName: z.ZodString;
    version: z.ZodString;
    abi: z.ZodLiteral<"pyodide-emscripten-2025_0-wasm32">;
    pyodideVersion: z.ZodString;
    pythonVersion: z.ZodString;
    wheelFileName: z.ZodString;
    wheelSha256: z.ZodString;
    loadMode: z.ZodLiteral<"startup-module">;
    imports: z.ZodArray<z.ZodString>;
    dependencies: z.ZodArray<z.ZodString>;
    extensionModules: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        runtimePath: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>>;
export type RuntimePythonPackageArtifactMetadata = RuntimeArtifactMetadata & z.output<typeof RuntimePythonPackageArtifactFields>;
declare const RuntimeManifestSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodString;
    license: z.ZodString;
    wasi_namespace: z.ZodNullable<z.ZodString>;
    files: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        content: z.ZodString;
        sha256: z.ZodString;
        size: z.ZodNumber;
        mode: z.ZodOptional<z.ZodLiteral<"exec">>;
    }, z.core.$strip>>;
    entrypoints: z.ZodArray<z.ZodObject<{
        binName: z.ZodString;
        runner: z.ZodString;
        args: z.ZodArray<z.ZodString>;
        kind: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    runtime_artifacts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        kind: z.ZodString;
        id: z.ZodString;
        source_sha256: z.ZodOptional<z.ZodString>;
        sha256: z.ZodString;
    }, z.core.$loose>>>;
}, z.core.$strip>;
/**
 * What an installed runtime is. `wasi_namespace` is the WASI namespace its
 * binaries import (`wasi_unstable` for binji clang), or null for a non-WASI
 * runtime (e.g. Pyodide).
 */
export type RuntimeManifest = z.output<typeof RuntimeManifestSchema>;
export declare function parseRuntimeManifest(value: unknown): RuntimeManifest;
export declare function isRuntimePythonPackageArtifactMetadata(artifact: RuntimeArtifactMetadata): artifact is RuntimePythonPackageArtifactMetadata;
export {};
//# sourceMappingURL=runtime-manifest.d.ts.map