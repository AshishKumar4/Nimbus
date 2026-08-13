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
export const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestFileSchema = z.object({
    path: z.string().min(1),
    content: z.string().min(1),
    sha256: HexSha256Schema,
    size: z.number().int().nonnegative(),
    mode: z.literal('exec').optional(),
});
const ManifestEntrypointSchema = z.object({
    binName: z.string().min(1),
    runner: z.string().min(1),
    args: z.array(z.string()),
    kind: z.string().optional(),
});
const RuntimeArtifactMetadataSchema = z.object({
    path: z.string().min(1),
    kind: z.string().min(1),
    id: z.string().min(1),
    source_sha256: HexSha256Schema.optional(),
    sha256: HexSha256Schema,
}).passthrough();
export const RuntimePythonPackageArtifactMetadataSchema = RuntimeArtifactMetadataSchema.and(z.object({
    kind: z.literal('python-package'),
    language: z.literal('python'),
    packageName: z.string().min(1),
    version: z.string().min(1),
    abi: z.literal(PYODIDE_PACKAGE_ABI),
    pyodideVersion: z.string().min(1),
    pythonVersion: z.string().min(1),
    wheelFileName: z.string().min(1),
    wheelSha256: HexSha256Schema,
    loadMode: z.literal('startup-module'),
    imports: z.array(z.string()),
    dependencies: z.array(z.string()),
    extensionModules: z.array(z.object({
        path: z.string().min(1),
        runtimePath: z.string().min(1),
        sha256: HexSha256Schema,
    })),
}));
const RuntimeManifestSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string(),
    wasi_namespace: z.string().nullable(),
    files: z.array(ManifestFileSchema),
    entrypoints: z.array(ManifestEntrypointSchema),
    runtime_artifacts: z.array(RuntimeArtifactMetadataSchema).optional(),
});
export function parseRuntimeManifest(value) {
    return RuntimeManifestSchema.parse(value);
}
export function isRuntimePythonPackageArtifactMetadata(artifact) {
    return RuntimePythonPackageArtifactMetadataSchema.safeParse(artifact).success;
}
