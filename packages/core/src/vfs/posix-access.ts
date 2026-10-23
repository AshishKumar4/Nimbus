import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import { arrayIncludes, mathTrunc } from '../_shared/primordials.js';

/** What an entry is, as its filesystem says: the type every access check is given. */
export type PosixNodeType = 'file' | 'directory' | 'symlink';

/**
 * POSIX permission classes: the one calculation of whether a credential
 * holds `want` (r=4, w=2, x=1) on an entry whose mode, owner and type are
 * known. The owner class when the uid matches, else the group class when the
 * gid or a supplementary group does, else other. Root holds Linux's
 * CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH: it reads and writes anything and
 * searches every directory, and executes a file only when some execute bit
 * is set on it. The type is the entry's own, never read from its mode: a
 * stored mode may carry no file-type bits (mkdir keeps the bits it is
 * given). A caller keeps its own policy for an entry whose metadata is absent
 * (the runtime bridge allows, a facet's shim denies).
 */
export function posixAccess(
  entry: { readonly mode: number; readonly uid: number; readonly gid: number; readonly type: PosixNodeType },
  want: number,
  cred: { readonly uid: number; readonly gid: number; readonly groups: readonly number[] },
): boolean {
  const requested = want & 0o7;
  if (requested === 0) return true;
  const permissions = entry.mode & 0o777;
  if (cred.uid === 0) return (requested & 0o1) === 0 || (permissions & 0o111) !== 0 || entry.type === 'directory';
  // A program's Array.prototype.includes is not asked (module loading checks access: design-guest-loader-primordials).
  const shift = cred.uid === entry.uid ? 6 : cred.gid === entry.gid || arrayIncludes(cred.groups, entry.gid) ? 3 : 0;
  return ((permissions >> shift) & requested) === requested;
}

/**
 * posixAccess for a filesystem's stat, as the session's views judge one: a
 * stat without a mode (a backend that keeps none) is not judged, and an
 * owner or group it keeps none of is no one's.
 */
export function modeAllows(
  stat: { readonly mode?: number; readonly uid?: number; readonly gid?: number; readonly type: PosixNodeType },
  want: number,
  cred: { readonly uid: number; readonly gid: number; readonly groups: readonly number[] },
): boolean {
  if (stat.mode === undefined) return true;
  return posixAccess({ mode: stat.mode, uid: stat.uid ?? -1, gid: stat.gid ?? -1, type: stat.type }, want, cred);
}

/** The caller a metadata rule judges: its uid, its primary group and its supplementary groups. */
export interface PosixCred {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
}

/** chmod(2)'s rule: only the owner or root changes a mode (EPERM). */
export function chmodRefusal(entry: { readonly uid: number }, cred: Pick<PosixCred, 'uid'>): 'EPERM' | null {
  return cred.uid !== 0 && cred.uid !== entry.uid ? 'EPERM' : null;
}

/**
 * The mode change a confined principal may not make (EPERM): granting a
 * setuid, setgid, group or other bit the entry lacks, or clearing its sticky
 * bit. A confined principal owns its own triad and nothing else.
 */
export function confinedModeRefusal(current: number, next: number): 'EPERM' | null {
  const held = current & 0o7777;
  const granted = (next & 0o6077) & ~held;
  const unstuck = held & ~next & 0o1000;
  return granted === 0 && unstuck === 0 ? null : 'EPERM';
}

/**
 * chown(2)'s rule (EPERM): root changes anything; the owner may keep its
 * owner and set the group to the entry's own or one in `cred.groups`; no one else
 * may name an owner or group at all. A null id leaves it as it is.
 */
export function chownRefusal(
  entry: { readonly uid: number; readonly gid: number },
  uid: number | null,
  gid: number | null,
  cred: PosixCred,
): 'EPERM' | null {
  if (cred.uid === 0) return null;
  const owner = cred.uid === entry.uid;
  if (uid !== null && (uid !== entry.uid || !owner)) return 'EPERM';
  if (gid !== null && (!owner || (gid !== entry.gid && !arrayIncludes(cred.groups, gid)))) return 'EPERM';
  return null;
}

/** The mode a chown leaves: a caller other than root clears the setuid and setgid bits. */
export function chownedMode(mode: number, cred: Pick<PosixCred, 'uid'>): number {
  return cred.uid === 0 ? mode : mode & ~0o6000;
}

/** Whether a utimes asks for an explicit time on either side: what utimesRefusal's `explicit` is. */
export function explicitTimes(atime: FsTime, mtime: FsTime): boolean {
  return typeof atime === 'number' || typeof mtime === 'number';
}

/** `time` as the filesystem committing it lands it: an explicit one in whole ms, 'now' at `now`, 'omit' as `kept`. */
export function timeAt(time: FsTime, kept: number, now: number): number {
  return time === 'omit' ? kept : time === 'now' ? now : mathTrunc(time);
}

/**
 * utimensat(2)'s rule: explicit times only by the owner or root (EPERM); the
 * current time (and an omitted one) by the owner, root or anyone who may
 * write the entry (EACCES).
 */
export function utimesRefusal(
  entry: { readonly mode: number; readonly uid: number; readonly gid: number; readonly type: PosixNodeType },
  explicit: boolean,
  cred: PosixCred,
): 'EPERM' | 'EACCES' | null {
  if (!explicit) return cred.uid === 0 || cred.uid === entry.uid || posixAccess(entry, 0o2, cred) ? null : 'EACCES';
  return cred.uid !== 0 && cred.uid !== entry.uid ? 'EPERM' : null;
}
