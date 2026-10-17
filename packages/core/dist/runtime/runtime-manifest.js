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
export const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * One name of a path (a runtime's name or version, which name its directory
 * in the store): no `/`, and not `.` or `..`, so it names a directory below
 * the store's and none above.
 */
const PathNameSchema = z.string().regex(/^(?!\.\.?$)[^/\0]+$/, 'must be one path name: no "/", and not "." or ".."');
/** A path below a runtime's root: relative, each of its names one such name. */
const RelativePathSchema = z.string().refine((path) => path.split('/').every((name) => PathNameSchema.safeParse(name).success), 'must be a relative path of path names: no leading "/", empty name, "." or ".."');
const ManifestFileSchema = z.object({
    /** VFS path relative to /usr/lib/nimbus/<name>/<version>/. */
    path: RelativePathSchema,
    /** Publisher-side key for the content blob. */
    content: z.string().min(1),
    /** Hex sha256 of the content blob bytes. */
    sha256: HexSha256Schema,
    /** Byte size. */
    size: z.number().int().nonnegative(),
    /** Optional file mode hint ("exec" → registered as a shell bin). */
    mode: z.literal('exec').optional(),
});
const ManifestEntrypointSchema = z.object({
    /** Shell command name. */
    binName: z.string().min(1),
    /** Runner key (e.g. "clang-runner") — package manager dispatches to
     *  the right runner factory by this. */
    runner: z.string().min(1),
    /** Default args prepended to user args at invocation. */
    args: z.array(z.string()),
    /** Optional secondary classification (e.g. "linker" for wasm-ld). */
    kind: z.string().optional(),
});
/** The fields every runtime artifact names; an artifact parsed keeps any others it carries. */
const RuntimeArtifactMetadataFields = z.object({
    path: z.string().min(1),
    kind: z.string().min(1),
    id: z.string().min(1),
    source_sha256: HexSha256Schema.optional(),
    sha256: HexSha256Schema,
});
const RuntimeArtifactMetadataSchema = RuntimeArtifactMetadataFields.passthrough();
const RuntimePythonExtensionModuleMetadataSchema = z.object({
    /** Path inside Python site-packages, as stored in the wheel. */
    path: z.string().min(1),
    /** Path inside the installed Nimbus runtime root. */
    runtimePath: z.string().min(1),
    sha256: HexSha256Schema,
});
const RuntimePythonPackageArtifactFields = z.object({
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
    extensionModules: z.array(RuntimePythonExtensionModuleMetadataSchema),
});
export const RuntimePythonPackageArtifactMetadataSchema = RuntimeArtifactMetadataSchema.and(RuntimePythonPackageArtifactFields);
const RuntimeManifestSchema = z.object({
    name: PathNameSchema,
    version: PathNameSchema,
    license: z.string(),
    /** Which WASI namespace the binaries import — `wasi_unstable` for
     *  binji clang. `null` for non-WASI runtimes (e.g. Pyodide). */
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
