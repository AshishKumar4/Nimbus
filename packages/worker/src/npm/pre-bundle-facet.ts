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

import type { CredentialedVfs, VfsStat } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { recallOf } from '@nimbus-sh/core/vfs/recall.js';
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

export type PrebundleReadFs = Pick<CredentialedVfs, 'exists' | 'isDirectory' | 'access' | 'stat' | 'readdir' | 'readFile' | 'readFileString' | 'revision'>;

/** Only consulted answers guard a plan: sibling package/synthetic writes are not inputs. */
export class PrebundleInputs {
  readonly fs: PrebundleReadFs;
  private readonly checks = new Map<string, () => boolean>();
  private checkedRevision: number;

  constructor(private readonly vfs: PrebundleReadFs) {
    this.checkedRevision = vfs.revision();
    this.fs = {
      revision: (path) => vfs.revision(path),
      exists: (path) => {
        const exists = vfs.exists(path);
        this.remember(`exists:${path}`, () => vfs.exists(path) === exists);
        return exists;
      },
      isDirectory: (path) => {
        const directory = vfs.isDirectory(path);
        this.remember(`directory:${path}`, () => vfs.isDirectory(path) === directory);
        return directory;
      },
      access: (path, mode) => {
        let allowed = false;
        try { vfs.access(path, mode); allowed = true; }
        finally {
          this.remember(`access:${mode}:${path}`, () => {
            return unavailable(() => vfs.access(path, mode)) !== allowed;
          });
        }
      },
      stat: (path) => {
        try {
          const stat = vfs.stat(path);
          const observed = { ...stat };
          this.remember(`stat:${path}`, () => sameStat(vfs.stat(path), observed));
          return stat;
        } catch (error) {
          this.remember(`stat:${path}`, () => unavailable(() => { vfs.stat(path); }));
          throw error;
        }
      },
      readdir: (path) => {
        try {
          const entries = vfs.readdir(path);
          const observed = entries.map(({ name, type }) => ({ name, type }));
          this.remember(`readdir:${path}`, () => sameDirectory(vfs.readdir(path), observed));
          return entries;
        } catch (error) {
          this.remember(`readdir:${path}`, () => unavailable(() => { vfs.readdir(path); }));
          throw error;
        }
      },
      readFile: (path) => { this.file(path); return vfs.readFile(path); },
      readFileString: (path) => { this.file(path); return vfs.readFileString(path); },
    };
  }

  private remember(key: string, check: () => boolean): void {
    // First observation wins, including a missing resolution candidate that appears later.
    if (!this.checks.has(key)) this.checks.set(key, check);
  }

  private file(path: string): void {
    const key = `file:${path}`;
    if (this.checks.has(key)) return;
    const revision = this.vfs.revision(path);
    this.remember(key, () => this.vfs.revision(path) === revision);
  }

  current(): boolean {
    const revision = this.vfs.revision();
    if (revision === this.checkedRevision) return true;
    try {
      for (const check of this.checks.values()) if (!check()) return false;
    } catch (error) {
      if (recallOf(error) !== null) throw error;
      return false;
    }
    this.checkedRevision = revision;
    return true;
  }
}

function unavailable(read: () => void): boolean {
  try { read(); return false; } catch (error) {
    if (recallOf(error) !== null) throw error;
    return true;
  }
}

function sameStat(now: VfsStat, observed: VfsStat): boolean {
  // A directory's subtree generation/mtime changes when an unrelated descendant is written.
  return now.dev === observed.dev && now.ino === observed.ino && now.type === observed.type
    && now.mode === observed.mode && now.uid === observed.uid && now.gid === observed.gid
    && (now.type === 'directory' || (now.gen === observed.gen && now.size === observed.size
      && now.ctime === observed.ctime && now.mtime === observed.mtime));
}

function sameDirectory(now: ReturnType<PrebundleReadFs['readdir']>, observed: ReturnType<PrebundleReadFs['readdir']>): boolean {
  // CredentialedVfs.readdir already supplies a stable UTF-16 name order.
  return now.length === observed.length && now.every((entry, i) => entry.name === observed[i]?.name && entry.type === observed[i]?.type);
}

export interface SlicePlanEntry { path: string; isDir: boolean; size: number }
export interface PrebundleSlicePlan {
  inputs: PrebundleInputs;
  entries: SlicePlanEntry[];
  totalBytes: number;
  allocationBytes: number;
}
export class PrebundlePlanChanged extends Error {
  constructor() { super('the package changed while its prebundle was being prepared'); }
}
const DependencyManifest = z.object({ dependencies: z.record(z.string(), z.json()).optional().catch(undefined) });

export function buildSliceForSpecifierWithCap(vfs: PrebundleReadFs, specifier: string, nmDir: string, capBytes: number): { slice: SliceEntry[]; totalBytes: number } | null {
  const plan = planSliceForSpecifierWithCap(vfs, specifier, nmDir, capBytes);
  return plan === null ? null : { slice: materializePrebundleSlice(vfs, plan), totalBytes: plan.totalBytes };
}

/** Discover names and sizes without retaining a slice; metadata parsing owns only its current input. */
export function planSliceForSpecifierWithCap(
  vfs: PrebundleReadFs,
  specifier: string,
  nmDir: string,
  capBytes: number,
  inputs = new PrebundleInputs(vfs),
): PrebundleSlicePlan | null {
  vfs = inputs.fs;
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

  return { inputs, entries, totalBytes, allocationBytes };
}

/** A discovered scoped graph, including the same directories its old slice carried. */
export function planSliceFromPaths(vfs: PrebundleReadFs, paths: ReadonlyArray<{ path: string; isDir: boolean }>, capBytes: number, inputs = new PrebundleInputs(vfs)): PrebundleSlicePlan | null {
  vfs = inputs.fs;
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
  return { inputs, entries, totalBytes, allocationBytes };
}

/** Synchronous and admitted by its caller: no parser/RPC wait can retain a partial slice. */
export function materializePrebundleSlice(vfs: PrebundleReadFs, plan: PrebundleSlicePlan): SliceEntry[] {
  const turn = vfs.revision();
  if (!plan.inputs.current()) throw new PrebundlePlanChanged();
  const slice: SliceEntry[] = [];
  for (const entry of plan.entries) {
    const path = '/' + entry.path.replace(/^\/+/, '');
    if (entry.isDir) { slice.push({ path, isDir: true }); continue; }
    try {
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
