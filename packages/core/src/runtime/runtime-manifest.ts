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

export const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Where `manifest` installs `rel` under `installRoot`; null when the manifest has no such file. */
export function installedPath(manifest: RuntimeManifest, installRoot: string, rel: string): string | null {
  return manifest.files.some((f) => f.path === rel) ? `${installRoot}/${rel}` : null;
}

/**
 * One name of a path (a runtime's name or version, which name its directory
 * in the store): no `/`, and not `.` or `..`, so it names a directory below
 * the store's and none above.
 */
const PathNameSchema = z.string().regex(/^(?!\.\.?$)[^/\0]+$/, 'must be one path name: no "/", and not "." or ".."');

/** A path below a runtime's root: relative, each of its names one such name. */
const RelativePathSchema = z.string().refine(
  (path) => path.split('/').every((name) => PathNameSchema.safeParse(name).success),
  'must be a relative path of path names: no leading "/", empty name, "." or ".."',
);

const ManifestFileSchema = z.object({
  path: RelativePathSchema,
  content: z.string().min(1),
  sha256: HexSha256Schema,
  size: z.number().int().nonnegative(),
  mode: z.literal('exec').optional(),
});
/**
 * A file a runtime is made of: `path`, relative to
 * /usr/lib/nimbus/<name>/<version>/; `content`, the publisher-side key of its
 * blob; `sha256` (hex) and `size` of the blob's bytes; and `mode`, 'exec' to
 * register it as a shell bin.
 */
export type ManifestFile = z.output<typeof ManifestFileSchema>;

const ManifestEntrypointSchema = z.object({
  binName: z.string().min(1),
  runner: z.string().min(1),
  args: z.array(z.string()),
  kind: z.string().optional(),
});
/**
 * A shell command a runtime provides: `binName`, the command; `runner`, the
 * runner factory the package manager dispatches it to (e.g. "clang-runner");
 * `args`, prepended to the user's args at invocation; and `kind`, an optional
 * secondary classification (e.g. "linker" for wasm-ld).
 */
export type ManifestEntrypoint = z.output<typeof ManifestEntrypointSchema>;

/** The fields every runtime artifact names; an artifact parsed keeps any others it carries. */
const RuntimeArtifactMetadataFields = z.object({
  path: z.string().min(1),
  kind: z.string().min(1),
  id: z.string().min(1),
  source_sha256: HexSha256Schema.optional(),
  sha256: HexSha256Schema,
});
const RuntimeArtifactMetadataSchema = RuntimeArtifactMetadataFields.passthrough();
export type RuntimeArtifactMetadata = z.output<typeof RuntimeArtifactMetadataFields>;

const RuntimePythonExtensionModuleMetadataSchema = z.object({
  path: z.string().min(1),
  runtimePath: z.string().min(1),
  sha256: HexSha256Schema,
});
/** A Python extension module: `path` inside site-packages, as the wheel stores it, and `runtimePath` inside the installed Nimbus runtime root. */
export type RuntimePythonExtensionModuleMetadata = z.output<typeof RuntimePythonExtensionModuleMetadataSchema>;

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
export type RuntimePythonPackageArtifactMetadata = RuntimeArtifactMetadata & z.output<typeof RuntimePythonPackageArtifactFields>;

const RuntimeManifestSchema = z.object({
  name: PathNameSchema,
  version: PathNameSchema,
  license: z.string(),
  wasi_namespace: z.string().nullable(),
  files: z.array(ManifestFileSchema),
  entrypoints: z.array(ManifestEntrypointSchema),
  runtime_artifacts: z.array(RuntimeArtifactMetadataSchema).optional(),
});
/**
 * What an installed runtime is. `wasi_namespace` is the WASI namespace its
 * binaries import (`wasi_unstable` for binji clang), or null for a non-WASI
 * runtime (e.g. Pyodide).
 */
export type RuntimeManifest = z.output<typeof RuntimeManifestSchema>;

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  return RuntimeManifestSchema.parse(value);
}

export function isRuntimePythonPackageArtifactMetadata(
  artifact: RuntimeArtifactMetadata,
): artifact is RuntimePythonPackageArtifactMetadata {
  return RuntimePythonPackageArtifactMetadataSchema.safeParse(artifact).success;
}
