/**
 * The walk beneath a root (RESOLVE_BENEATH, a WASI preopen) and the two
 * rules it reads — POSIX permission bits and Node's error for a failed call —
 * in a module that imports no filesystem, so a facet that answers lookups
 * from its own copy of the namespace (wasi/resident-filesystem.ts) walks with
 * exactly the code the authority walks with (sqlite-runtime-fs-bridge.ts).
 */

import type { RuntimeFsPath } from './os-contracts.js';
import { fsError as nodeFsError, type FsError } from '../vfs/vfs-error.js';
import { modeAllows } from '../vfs/posix-access.js';
import {
  arrayJoin, arrayPop, SafeList, SafeMap, safeGenerator, stringEndsWith, stringSlice, stringSplit, stringStartsWith, type SafeGenerator,
} from '../_shared/primordials.js';

export type { FsError };

/** Links followed before ELOOP (Linux MAXSYMLINKS). */
export const MAX_LINK_HOPS = 40;

/** vfs-error.ts's fsError for a call on a runtime path, named by its path. */
export function fsError(
  code: string, syscall: string, path: RuntimeFsPath, dest?: RuntimeFsPath, options: { detail?: string; cause?: unknown } = {},
): FsError {
  const name = typeof path === 'string' ? path : path.path;
  const second = dest === undefined ? undefined : typeof dest === 'string' ? dest : dest.path;
  return nodeFsError(code, syscall, name, second, options);
}


/** One lookup a walk beneath a root asks of its filesystem: a stat that does not follow a link (null when absent), or a link's target. */
export type BeneathLookup = { readonly stat: string } | { readonly readlink: string };

/**
 * What a walk reached: `reached`, the name it resolved to (normalized,
 * relative to the namespace's root), and `spelling`, the name to hand the
 * namespace for it (absolute). Where the walk handed names to a backend that
 * resolves its own paths, with no link it followed after, the spelling is
 * the name reached up to there, then the rest as written, so that backend
 * walks it (CompositeVFS's Resolution.operand); else it is the reached name.
 */
export interface BeneathReached {
  readonly reached: string;
  readonly spelling: string;
}

/**
 * Where a walk began handing names over (`base`, absolute, and the rest as
 * written from there), as BeneathReached.spelling, else `reached` (absolute);
 * `trailing`: the name the walk was given ends in a separator.
 */
export function handedSpelling(handoff: { base: string; rest: readonly string[] } | null, reached: string, trailing: boolean): string {
  if (handoff === null) return reached;
  const spelling = `${handoff.base === '/' ? '' : handoff.base}/${arrayJoin(handoff.rest, '/')}`;
  return trailing && !stringEndsWith(spelling, '/') ? spelling + '/' : spelling;
}
type BeneathAnswer = { type: string; mode?: number; uid?: number; gid?: number } | string | null;

/** A name's parts between its separators, by name: a walk reads them and never changes them. A bound on what is kept, then forgotten all at once. */
const SEGMENTS = new SafeMap<string, SafeList<string>>();
const SEGMENTS_KEPT = 4096;
function segmentsOf(name: string): SafeList<string> {
  let segments = SEGMENTS.get(name);
  if (segments === undefined) {
    if (SEGMENTS.size >= SEGMENTS_KEPT) SEGMENTS.clear();
    SEGMENTS.set(name, segments = stringSplit(name, '/'));
  }
  return segments;
}
/** For each start in `segments`, those from it on that are not empty, joined by '/' (the last, past them all, ''). */
function suffixesOf(segments: SafeList<string>): SafeList<string> {
  const suffixes = new SafeList<string>();
  let joined = '';
  suffixes[segments.length] = joined;
  for (let at = segments.length - 1; at >= 0; at--) {
    const segment = segments[at]!;
    if (segment !== '') joined = joined === '' ? segment : `${segment}/${joined}`;
    suffixes[at] = joined;
  }
  return suffixes;
}

/**
 * A lookup beneath `root` (RESOLVE_BENEATH, a WASI preopen), as the
 * namespace walk does it (VFS-COMP-006): the root must be reachable (every
 * directory above it searchable); an absolute path and `..` at the root are
 * ENOTCAPABLE; each component needs the directory it leaves to be a
 * searchable directory; a missing component is ENOENT unless it is the last.
 * Links resolve (the last only when `follow`), 40 hops, then null (ELOOP):
 * a relative one from its directory, an absolute one from the namespace's
 * `/`, as the unrestricted walk resolves them, and what the walk reaches
 * must lie at or under the root, else ENOTCAPABLE. A path the namespace
 * hands to its backend whole beneath this root (`handedOver`, asked with
 * where the lookup goes on to lexically: CompositeVFS.resolvedByBackend
 * within the root, a resolvesPaths mount whose point lies at or under it, so
 * the backend's own links stay beneath it) is neither looked up nor searched
 * here, nor are its links read: its components are taken lexically, `..`
 * included, and that backend answers for them. The one walk for every face: it yields
 * its lookups, which the synchronous bridge answers at once and a face over
 * asynchronous mounts awaits. `root` is normalized; the answer is the
 * resolved path, normalized, and the spelling to hand the namespace
 * (BeneathReached). `rootSpelling`: the root's own name for its lookups (a
 * directory opened past a `..` a backend walks, HeldFile.name), which every
 * lookup beneath it starts from until an absolute link leaves it; its
 * confinement is the normalized `root`'s.
 */
export const walkBeneath = safeGenerator(function* (
  root: string, path: RuntimeFsPath, follow: boolean, cred: { uid: number; gid: number; groups: readonly number[] },
  handedOver: (path: string, to: string) => boolean, rootSpelling: string = '/' + root,
): Generator<BeneathLookup, BeneathReached | null, BeneathAnswer> {
  const name = typeof path === 'string' ? path : path.path;
  // Below a root with a spelling of its own, by descent from it (no absolute link since), a
  // name is that spelling, then the rest; else (every walk but one anchored so) the name itself.
  const anchored = rootSpelling !== '/' + root;
  let fromRoot = true;
  const named = (reached: string): string => (!anchored || !fromRoot ? '/' + reached
    : reached.length === root.length ? rootSpelling : `${rootSpelling === '/' ? '' : rootSpelling}${stringSlice(reached, root.length)}`);
  if (root !== '') yield { stat: rootSpelling };
  if (name[0] === '/') throw fsError('ENOTCAPABLE', 'path', path);
  // What is left to walk: pending's parts from `next` on (and, past each start, those not empty, joined).
  let pending = segmentsOf(name);
  let suffixes = suffixesOf(pending);
  let next = 0;
  const resolved = new SafeList<string>();
  if (root !== '') {
    const rooted = segmentsOf(root);
    for (let i = 0; i < rooted.length; i++) resolved[i] = rooted[i]!;
  }
  // resolved, joined by '/'.
  let joined = arrayJoin(resolved, '/');
  let hops = 0;
  let handoff: { base: string; rest: string[] } | null = null;
  while (next < pending.length) {
    const segment = pending[next++];
    if (segment === undefined) break;
    const dir = joined;
    const candidate = dir === '' ? segment : `${dir}/${segment}`;
    let spelled = segment === '' ? dir : candidate;
    const after = suffixes[next]!;
    if (after !== '') spelled = spelled === '' ? after : `${spelled}/${after}`;
    const to = '/' + spelled;
    const handed = handedOver('/' + dir, to) || (segment !== '.' && segment !== '..' && handedOver('/' + candidate, to));
    if (!handed) {
      const searched = (yield { stat: named(dir) }) as Exclude<BeneathAnswer, string>;
      if (searched === null) throw fsError('ENOENT', 'path', path);
      if (searched.type !== 'directory') throw fsError('ENOTDIR', 'path', path);
      if (!modeAllows({ ...searched, type: 'directory' }, 1, cred)) throw fsError('EACCES', 'path', path);
    }
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (dir === root) throw fsError('ENOTCAPABLE', 'path', path);
      arrayPop(resolved);
      joined = arrayJoin(resolved, '/');
      continue;
    }
    if (handed) {
      if (handoff === null) {
        const rest = new SafeList<string>();
        rest[0] = segment;
        for (let i = next; i < pending.length; i++) rest[rest.length] = pending[i]!;
        handoff = { base: named(dir), rest };
      }
      resolved[resolved.length] = segment;
      joined = candidate;
      continue;
    }
    // Every component already walked is a directory, not a link, so a
    // lookup by its literal name is the walk's own.
    const isFinal = next === pending.length;
    const stat = (yield { stat: named(candidate) }) as Exclude<BeneathAnswer, string>;
    if (stat === null && !isFinal) throw fsError('ENOENT', 'path', path);
    if (stat === null || stat.type !== 'symlink' || (isFinal && !follow)) {
      resolved[resolved.length] = segment;
      joined = candidate;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return null;
    const target = (yield { readlink: named(candidate) }) as string | null;
    // A link whose target the namespace has no name for (a mount nested in
    // its backend covers it) cannot be followed beneath the root.
    if (target === null) throw fsError('ENOTCAPABLE', 'path', path);
    if (target[0] === '/') { resolved.length = 0; joined = ''; fromRoot = false; }
    const parts = stringSplit(target, '/');
    for (let i = next; i < pending.length; i++) parts[parts.length] = pending[i]!;
    pending = parts;
    suffixes = suffixesOf(pending);
    next = 0;
    // A link followed after a handoff: the rest as written is no longer what is reached.
    handoff = null;
  }
  const reached = joined;
  if (root !== '' && reached !== root && !stringStartsWith(reached, root + '/')) throw fsError('ENOTCAPABLE', 'path', path);
  return { reached, spelling: handedSpelling(handoff, named(reached), name.length > 0 && name[name.length - 1] === '/') };
}) as (
  root: string, path: RuntimeFsPath, follow: boolean, cred: { uid: number; gid: number; groups: readonly number[] },
  handedOver: (path: string, to: string) => boolean, rootSpelling?: string,
) => SafeGenerator<BeneathLookup, BeneathReached | null, BeneathAnswer>;
