/**
 * pre-bundle-facet.ts — the supervisor's half of pre-bundling npm packages
 * (the `Pre-bundling N modules…` step in npm/installer.ts, and the Vite dev
 * server's on-demand /@modules/ bundles).
 *
 * Bundling runs in the Durable Object's build facet (facets/build-facet.ts:
 * `prebundle`, rolldown, core runtime/prebundle-slice.ts), never in the
 * supervisor: a bundle's working set (the engine's wasm memory plus the
 * input and output graph) would not fit beside the supervisor's own heap.
 *
 * File-slice strategy (zero per-read RPC)
 * ──────────────────────────────────────
 * A VFS plugin would naturally call back to the supervisor for every
 * resolve and load. With workerd's ~5–20 ms RPC latency and 50–200 reads
 * per bundle that is seconds of pure RPC overhead per install. Instead the
 * supervisor walks the spec's transitive non-external dependency tree once
 * (fast — direct VFS access) and ships the entire `{path → bytes}` slice as
 * part of the spec; the bundler reads from that in-memory map.
 */

import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { getSharedRuntimeExternals } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
import { prebundleEntryBytes } from '@nimbus-sh/core/runtime/prebundle-slice.js';
import { packageNameFromSpecifier } from '@nimbus-sh/core/runtime/barrel-detect.js';
import { z } from 'zod';

export type { PrebundleResult, PrebundleSpec, SlicedDir, SlicedFile, SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';

// ── Supervisor-side: build the slice for one specifier ──────────────────

/**
 * A file or directory removed (or replaced) between the walk listing it and
 * reading it: the one read failure a walk passes over. Any other (the store
 * unreadable, the session's storage gone) fails the walk, so a slice is never
 * silently missing a file it lists, its entry least of all.
 */
function vanished(error: unknown): boolean {
  const code: unknown = Reflect.get(Object(error), 'code');
  return code === 'ENOENT' || code === 'ENOTDIR';
}





export interface SlicePlanEntry { path: string; isDir: boolean; size: number }
export interface PrebundleSlicePlan {
  revision: number;
  fences: Array<{ path: string; revision: number }>;
  entries: SlicePlanEntry[];
  totalBytes: number;
  allocationBytes: number;
}
export class PrebundlePlanChanged extends Error {
  constructor() { super('the package changed while its prebundle was being prepared'); }
}
const DependencyManifest = z.object({ dependencies: z.record(z.string(), z.json()).optional().catch(undefined) });

export function buildSliceForSpecifierWithCap(vfs: CredentialedVfs, specifier: string, nmDir: string, capBytes: number): { slice: SliceEntry[]; totalBytes: number } | null {
  const plan = planSliceForSpecifierWithCap(vfs, specifier, nmDir, capBytes);
  return plan === null ? null : { slice: materializePrebundleSlice(vfs, plan), totalBytes: plan.totalBytes };
}

/** Discover names and sizes without retaining a slice; metadata parsing owns only its current input. */
export function planSliceForSpecifierWithCap(
  vfs: CredentialedVfs,
  specifier: string,
  nmDir: string,
  capBytes: number,
): PrebundleSlicePlan | null {
  const revision = vfs.revision();
  const fences = new Map<string, number>([[nmDir, vfs.revision(nmDir)]]);
  const externals = new Set<string>();
  for (const e of getSharedRuntimeExternals(specifier)) {
    // strip glob suffix: "react/*" → "react"
    if (e.endsWith('/*')) externals.add(e.slice(0, -2));
    else externals.add(e);
  }

  const entries: SlicePlanEntry[] = [];
  let totalBytes = 0;
  let allocationBytes = 0;
  const visitedPkgs = new Set<string>();

  const addFile = (path: string): boolean => {
    try {
      const stat = vfs.stat(path);
      const slicePath = '/' + path.replace(/^\/+/, '');
      if (stat.type === 'directory') {
        entries.push({ path, isDir: true, size: 0 });
        allocationBytes += prebundleEntryBytes(slicePath);
        return allocationBytes <= capBytes;
      }
      totalBytes += stat.size + path.length;
      if (totalBytes > capBytes) return false; // caller bails
      entries.push({ path, isDir: false, size: stat.size });
      allocationBytes += prebundleEntryBytes(slicePath, stat.size);
      return allocationBytes <= capBytes;
    } catch (error) {
      if (vanished(error)) return true;
      throw error;
    }
  };

  /**
   * Walk every file under `pkgDir`, depth-limited to keep us out of
   * pathological tarballs (tests have seen 30-deep trees but not 100).
   * Skip nested node_modules — those are dependencies handled separately
   * by the recursive descent below, and including them here would cause
   * double-shipping for many large libraries.
   */
  const walkDir = (dir: string, depth: number): boolean => {
    if (depth > 12) return true;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(dir); } catch (error) {
      if (vanished(error)) return true;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue; // handled by dep recursion
      const child = dir + '/' + entry.name;
      if (entry.type === 'directory') {
        if (!addFile(child)) return false;
        if (!walkDir(child, depth + 1)) return false;
      } else {
        if (!addFile(child)) return false;
      }
    }
    return true;
  };

  /**
   * Recurse into a package: ship its files, then descend into each
   * non-external `dependencies` entry. Idempotent via visitedPkgs.
   *
   * `isRoot=true` for the FIRST call (the spec's own package). The
   * spec's own package is ALWAYS walked even when its pkgName is also
   * in the externals set — this is required for subpath specs like
   * `react/jsx-runtime` (pkgName = 'react', externals = ['react']).
   * Without this, the slice was empty for jsx-runtime, esbuild got
   * nothing to bundle, the on-demand bundler returned an empty body,
   * and serveModule fell through to the CDN fallback (esm.sh) which
   * shipped a DIFFERENT React instance and broke the dual-React
   * invariant. Verified on prod: jsx-runtime served 178B CDN wrapper
   * instead of a real bundle.
   */
  const visitPkg = (pkgName: string, isRoot: boolean): boolean => {
    if (visitedPkgs.has(pkgName)) return true;
    visitedPkgs.add(pkgName);

    // External specifiers' files are deliberately omitted (esbuild will
    // mark them external; the bundle leaves the import unresolved for
    // the browser to fetch from /preview/@modules/) — UNLESS this is
    // the spec's own package, which we always need to walk so the
    // entry point and its non-external internals are in the slice.
    if (externals.has(pkgName) && !isRoot) return true;

    const pkgDir = nmDir + '/' + pkgName;
    fences.set(pkgDir, vfs.revision(pkgDir));
    if (!vfs.exists(pkgDir) || !vfs.isDirectory(pkgDir)) return true;

    if (!addFile(pkgDir)) return false;
    if (!walkDir(pkgDir, 0)) return false;

    // Read deps; recurse. Recursion is never `isRoot` — only the
    // outermost spec gets that exemption.
    let deps: string[] = [];
    const pkgJsonPath = pkgDir + '/package.json';
    if (vfs.exists(pkgJsonPath)) {
      let text: string | null = null;
      try { text = vfs.readFileString(pkgJsonPath); } catch (error) {
        if (!vanished(error)) throw error;
      }
      // A manifest that is not JSON names no dependencies.
      try {
        const parsed = DependencyManifest.safeParse(text === null ? null : JSON.parse(text));
        if (parsed.success) deps = Object.keys(parsed.data.dependencies ?? {});
      } catch {}
    }
    for (const dep of deps) {
      if (!visitPkg(dep, false)) return false;
    }
    return true;
  };

  const pkgName = packageNameFromSpecifier(specifier);
  if (!visitPkg(pkgName, true)) {
    // Cap exceeded — caller bails out. Empty caller = caller will fall
    // back to legacy in-supervisor path or skip pre-bundling entirely.
    return null;
  }

  return { revision, fences: [...fences].map(([path, revision]) => ({ path, revision })), entries, totalBytes, allocationBytes };
}

/** A discovered scoped graph, including the same directories its old slice carried. */
export function planSliceFromPaths(vfs: CredentialedVfs, paths: ReadonlyArray<{ path: string; isDir: boolean }>, capBytes: number, roots: readonly string[] = ['']): PrebundleSlicePlan | null {
  const revision = vfs.revision();
  const fences = [...new Set(roots)].map((path) => ({ path, revision: vfs.revision(path) }));
  const entries: SlicePlanEntry[] = [];
  let totalBytes = 0;
  let allocationBytes = 0;
  for (const entry of paths) {
    const size = entry.isDir ? 0 : vfs.stat(entry.path).size;
    if (!entry.isDir) totalBytes += size + entry.path.length;
    if (totalBytes > capBytes) return null;
    entries.push({ ...entry, size });
    allocationBytes += prebundleEntryBytes('/' + entry.path.replace(/^\/+/, ''), size);
    if (allocationBytes > capBytes) return null;
  }
  return { revision, fences, entries, totalBytes, allocationBytes };
}

/** Synchronous and admitted by its caller: no parser/RPC wait can retain a partial slice. */
export function materializePrebundleSlice(vfs: CredentialedVfs, plan: PrebundleSlicePlan): SliceEntry[] {
  const turn = vfs.revision();
  if (turn !== plan.revision && plan.fences.some(({ path, revision }) => vfs.revision(path) !== revision)) throw new PrebundlePlanChanged();
  const slice: SliceEntry[] = [];
  for (const entry of plan.entries) {
    const path = '/' + entry.path.replace(/^\/+/, '');
    if (entry.isDir) { slice.push({ path, isDir: true }); continue; }
    try {
      // No yield in this loop. Only a moved clock requires rechecking a file's stat before allocating it.
      if (turn !== plan.revision && vfs.stat(entry.path).size > entry.size) throw new PrebundlePlanChanged();
      const bytes = vfs.readFile(entry.path);
      if (bytes.byteLength > entry.size) throw new PrebundlePlanChanged();
      slice.push({ path, isDir: false, bytes });
    } catch (error) {
      if (!vanished(error)) throw error;
    }
  }
  if (vfs.revision() !== turn) throw new PrebundlePlanChanged();
  return slice;
}
