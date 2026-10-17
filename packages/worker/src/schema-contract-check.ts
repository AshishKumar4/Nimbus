// TEMPORARY (X-B): the interfaces as main declared them, each checked both
// ways against the type its schema now derives. Deleted in the same branch.
import type { PYODIDE_PACKAGE_ABI } from '@nimbus-sh/core/runtime/os-contracts.js';
import type {
  ManifestFile, ManifestEntrypoint, RuntimeArtifactMetadata, RuntimePythonExtensionModuleMetadata,
  RuntimePythonPackageArtifactMetadata, RuntimeManifest,
} from '@nimbus-sh/core/runtime/runtime-manifest.js';
import type { CatalogVersionEntry, CatalogRuntimeEntry, RuntimeCatalog } from './runtime/runtime-catalog.js';
import type { NpmBinEntry, NpmBinManifest } from './npm/bin-links.js';
import type { NimbusAgentOAuthCookie } from './session/agent-oauth.js';

interface OldManifestFile { path: string; content: string; sha256: string; size: number; mode?: 'exec'; }
interface OldManifestEntrypoint { binName: string; runner: string; args: string[]; kind?: string; }
interface OldRuntimeArtifactMetadata { path: string; kind: string; id: string; source_sha256?: string; sha256: string; }
interface OldRuntimePythonExtensionModuleMetadata { path: string; runtimePath: string; sha256: string; }
interface OldRuntimePythonPackageArtifactMetadata extends OldRuntimeArtifactMetadata {
  kind: 'python-package'; language: 'python'; packageName: string; version: string; abi: typeof PYODIDE_PACKAGE_ABI;
  pyodideVersion: string; pythonVersion: string; wheelFileName: string; wheelSha256: string; loadMode: 'startup-module';
  imports: string[]; dependencies: string[]; extensionModules: OldRuntimePythonExtensionModuleMetadata[];
}
interface OldRuntimeManifest {
  name: string; version: string; license: string; wasi_namespace: string | null;
  files: OldManifestFile[]; entrypoints: OldManifestEntrypoint[]; runtime_artifacts?: OldRuntimeArtifactMetadata[];
}
interface OldCatalogVersionEntry { manifest: string; manifest_sha256?: string; size_bytes: number; license: string; }
interface OldCatalogRuntimeEntry { default: string; versions: Record<string, OldCatalogVersionEntry>; }
interface OldRuntimeCatalog { version: 1; runtimes: Record<string, OldCatalogRuntimeEntry>; }
interface OldNpmBinEntry { name: string; packageName: string; packageVersion: string; packagePath: string; targetPath: string; }
interface OldNpmBinManifest { version: 1; bins: Record<string, OldNpmBinEntry>; }
interface OldNimbusAgentOAuthCookie {
  mode: 'oauth'; accessToken: string; refreshToken?: string; tokenType: string; expiresAt: number | null;
  connectedAt: number; accountId: string | null; sessionId: string; tenantSegment: string;
}

type Assignable<A, B> = [A] extends [B] ? true : false;
type TwoWay<Old, New> = [oldToNew: Assignable<Old, New>, newToOld: Assignable<New, Old>];

export const schemaContract = {
  ManifestFile: [true, true] satisfies TwoWay<OldManifestFile, ManifestFile>,
  ManifestEntrypoint: [true, true] satisfies TwoWay<OldManifestEntrypoint, ManifestEntrypoint>,
  RuntimeArtifactMetadata: [true, true] satisfies TwoWay<OldRuntimeArtifactMetadata, RuntimeArtifactMetadata>,
  RuntimePythonExtensionModuleMetadata: [true, true] satisfies TwoWay<OldRuntimePythonExtensionModuleMetadata, RuntimePythonExtensionModuleMetadata>,
  RuntimePythonPackageArtifactMetadata: [true, true] satisfies TwoWay<OldRuntimePythonPackageArtifactMetadata, RuntimePythonPackageArtifactMetadata>,
  RuntimeManifest: [true, true] satisfies TwoWay<OldRuntimeManifest, RuntimeManifest>,
  CatalogVersionEntry: [true, true] satisfies TwoWay<OldCatalogVersionEntry, CatalogVersionEntry>,
  CatalogRuntimeEntry: [true, true] satisfies TwoWay<OldCatalogRuntimeEntry, CatalogRuntimeEntry>,
  RuntimeCatalog: [true, true] satisfies TwoWay<OldRuntimeCatalog, RuntimeCatalog>,
  NpmBinEntry: [true, true] satisfies TwoWay<OldNpmBinEntry, NpmBinEntry>,
  NpmBinManifest: [true, true] satisfies TwoWay<OldNpmBinManifest, NpmBinManifest>,
  NimbusAgentOAuthCookie: [true, true] satisfies TwoWay<OldNimbusAgentOAuthCookie, NimbusAgentOAuthCookie>,
};
