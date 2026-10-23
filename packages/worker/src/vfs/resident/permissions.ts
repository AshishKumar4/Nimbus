/**
 * The namespace's permission checks, by the one POSIX calculation (core
 * posixAccess): what is here is only what the namespace makes of metadata or
 * a credential that is absent.
 */

import { posixAccess, type PosixNodeType } from '@nimbus-sh/core/vfs/posix-access.js';
import { arrayIsArray, NumberOf, ownValue, SafeList } from '@nimbus-sh/core/_shared/primordials.js';

/** The credential a process runs as, as its launch carries it. */
export interface ResidentCred {
  uid: number;
  gid: number;
  groups?: readonly number[];
  umask?: number;
}

/** What a check reads of a name: a namespace row, or a listing's or a delta's stat. */
export interface ModeMeta {
  readonly mode?: unknown;
  readonly uid?: unknown;
  readonly gid?: unknown;
}

/** The credential's groups, as numbers. */
export const groupsOf = (cred: ResidentCred): readonly number[] => {
  const groups = ownValue(cred, 'groups');
  const out = new SafeList<number>();
  if (arrayIsArray(groups)) for (let i = 0; i < groups.length; i++) out[i] = NumberOf(groups[i]);
  return out;
};

/**
 * Whether the namespace's credential may `want` (r=4, w=2, x=1) what `meta`
 * describes, an entry of `type`, as the session's own check answers a read
 * (SqliteVFS.checkAccess). No credential judges nothing: everything is
 * allowed. Missing fields are read as numbers (absent mode grants nothing,
 * absent owner matches no one).
 */
export function namespaceAllows(cred: ResidentCred | null, meta: ModeMeta | undefined, type: PosixNodeType, want: number): boolean {
  if (!cred) return true;
  return posixAccess(
    { mode: NumberOf(meta === undefined ? undefined : ownValue(meta, 'mode')), uid: NumberOf(meta === undefined ? undefined : ownValue(meta, 'uid')), gid: NumberOf(meta === undefined ? undefined : ownValue(meta, 'gid')), type },
    want,
    { uid: NumberOf(cred.uid), gid: NumberOf(cred.gid), groups: groupsOf(cred) },
  );
}
