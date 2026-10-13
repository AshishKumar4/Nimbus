/**
 * npm/browser-prebundle.ts — a bare specifier's browser bundle (Vite's
 * dependency pre-bundle), one path for the installer's warming and the dev
 * server's /@modules requests.
 *
 * A specifier is bundled from its package's entry (resolvePrebundleEntry),
 * or, for a barrel package imported whole, from an entry synthesized from
 * the names the project imports of it (runtime/barrel-synthesizer.ts). The
 * build runs in the session's build facet from a slice the supervisor walks
 * under the shared allocation budget, or, with no pool and where the caller
 * allows it, by the EsbuildService's build. A bundle is keyed by what built
 * it and the manifests it read (cache-keys.ts) and stored raw, the same row
 * for both callers, when those manifests are still current. A stored row
 * answers a request whose barrel input it was built for, whose sources the
 * principal may read, and whose key the code serving now would give it.
 */
import { type EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { BundlePoolProvider } from '../facets/prebundle-pool.js';
import { type ProjectImports, type SourceParser } from '../runtime/barrel-synthesizer.js';
import type { NpmCache } from './cache.js';
/** Who builds, where, and what it may read. */
export interface PrebundleContext {
    /** The principal's view: what it may read is what a bundle may be built from and served to it. */
    vfs: CredentialedVfs;
    /** The project directory, whose node_modules the bundles come from. */
    root: string;
    cache: NpmCache | null;
    pool: BundlePoolProvider | null;
    parse: SourceParser;
    esbuild: EsbuildService;
    /**
     * Whether the EsbuildService's build serves when no pool does (the dev
     * server: a request must be answered). The installer's background warming
     * builds only in the facet.
     */
    serviceFallback: boolean;
}
/** A barrel package imported whole: bundled from an entry of the names the project imports. */
export interface BarrelInput {
    pkgName: string;
    fileCount: number;
    /** The names the project imports from it; null for none found. */
    names: ReadonlySet<string> | null;
    /** namedImportSignature of them: what a row synthesized from them is stored with. */
    inputHash: string;
}
/**
 * The barrel input of `specifier` for the project's imports (`scan`, asked
 * only for a barrel package), or null for a specifier bundled whole: a
 * subpath, a package of few files, or a barrel whose scan left files unread
 * (an entry from what it found could miss a name), which `unread` reports.
 */
export declare function barrelInput(ctx: PrebundleContext, specifier: string, scan: () => Promise<ProjectImports>, unread?: (pkgName: string, fileCount: number, left: string) => void): Promise<BarrelInput | null>;
/** The project's imports, within PROJECT_SCAN, as both callers scan them. */
export declare function scanProject(ctx: PrebundleContext): Promise<ProjectImports>;
/**
 * Whether a bundle stored with `inputHash` answers a request with `barrel`:
 * one synthesized from some names answers only a barrel request for those
 * names; any other request takes only a whole bundle.
 */
export declare function answersBarrel(inputHash: string | undefined, barrel: BarrelInput | null): boolean;
/**
 * The stored bundle of `specifier` that answers this request, raw: built for
 * its barrel input, from sources the principal may all read (one that names
 * none is never served), keyed as the code serving now keys this request
 * from those manifests as they read now (by the facet, or by the service).
 */
export declare function storedPrebundle(ctx: PrebundleContext, specifier: string, barrel: BarrelInput | null): Promise<{
    esmCode: string;
    inputHash: string;
} | null>;
/** What a build of a specifier came to. */
export type PrebundleOutcome<T> = 
/**
 * Built: `served` is what `serve` made of it, under the build's
 * allocation. Its row is written unless `changed` (a manifest it read
 * changed while it was built) or the write failed (`storeFailure`).
 */
{
    kind: 'built';
    served: T;
    inputHash: string;
    changed: boolean;
    storeFailure: string | null;
    warnings: readonly string[];
}
/** Not built, for a reason the request can say: `names` what its importers ask of it, where known. */
 | {
    kind: 'refused';
    status: 'no-static-imports' | 'synth-null' | 'vfs-write-failed' | 'native';
    message: string;
    names: ReadonlySet<string>;
}
/** No entry resolves in node_modules. */
 | {
    kind: 'unresolved';
}
/** No pool, and the caller builds only in one. */
 | {
    kind: 'unavailable';
    message: string;
} | {
    kind: 'failed';
    message: string;
};
/**
 * Build `specifier`'s bundle for a request with `barrel`, store it when the
 * manifests it was built from are still current, and give it to `serve`
 * while the slice's allocation is still held (the response is made beside
 * nothing else that claimed the same headroom).
 */
export declare function buildPrebundle<T>(ctx: PrebundleContext, specifier: string, barrel: BarrelInput | null, serve: (esmCode: string) => T): Promise<PrebundleOutcome<T>>;
/** Packages that run in Vite's server, never in a browser: the installer does not warm them. */
export declare function isServerToolPackage(pkgName: string): boolean;
/**
 * The file a bare specifier (with a subpath or not) is bundled from, under
 * the first of the project's, the user's and the system's node_modules that
 * has its package:
 *   1. its package's exports, for the subpath, with the browser conditions;
 *   2. a subpath as a file or a directory index, or a directory with its own
 *      package.json (module, main);
 *   3. the root's module or main field;
 *   4. the package's index.
 * Paths are normalized: a nested package.json may point out of its directory.
 */
export declare function resolvePrebundleEntry(vfs: CredentialedVfs, root: string, specifier: string): string | null;
//# sourceMappingURL=browser-prebundle.d.ts.map