import type { VfsCred } from '../runtime/os-contracts.js';

export interface UnixAccountReader {
  readFileString(path: string): string | Promise<string>;
}

export interface UnixUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export interface UnixGroup {
  name: string;
  gid: number;
  members: readonly string[];
}

export function parseUnixId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

async function users(vfs: UnixAccountReader): Promise<UnixUser[]> {
  const result: UnixUser[] = [];
  for (const line of (await vfs.readFileString('/etc/passwd')).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length < 7) continue;
    const uid = parseUnixId(fields[2]);
    const gid = parseUnixId(fields[3]);
    if (uid === null || gid === null || !fields[0]) continue;
    result.push({
      name: fields[0],
      uid,
      gid,
      home: fields[5],
      shell: fields[6],
    });
  }
  return result;
}

async function groups(vfs: UnixAccountReader): Promise<UnixGroup[]> {
  const result: UnixGroup[] = [];
  for (const line of (await vfs.readFileString('/etc/group')).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length < 4) continue;
    const gid = parseUnixId(fields[2]);
    if (gid === null || !fields[0]) continue;
    result.push({
      name: fields[0],
      gid,
      members: fields[3] ? fields[3].split(',').filter(Boolean) : [],
    });
  }
  return result;
}

export async function findUnixUser(vfs: UnixAccountReader, identity: string | number): Promise<UnixUser | null> {
  const entries = (await users(vfs));
  if (typeof identity === 'number') return entries.find((entry) => entry.uid === identity) ?? null;
  const numeric = parseUnixId(identity);
  return entries.find((entry) => entry.name === identity)
    ?? (numeric === null ? null : entries.find((entry) => entry.uid === numeric) ?? null);
}

export async function findUnixGroupName(vfs: UnixAccountReader, gid: number): Promise<string | null> {
  return (await findUnixGroup(vfs, gid))?.name ?? null;
}

export async function findUnixGroup(vfs: UnixAccountReader, identity: string | number): Promise<UnixGroup | null> {
  const entries = (await groups(vfs));
  if (typeof identity === 'number') return entries.find((entry) => entry.gid === identity) ?? null;
  const numeric = parseUnixId(identity);
  return entries.find((entry) => entry.name === identity)
    ?? (numeric === null ? null : entries.find((entry) => entry.gid === numeric) ?? null);
}

export async function findUnixUserName(vfs: UnixAccountReader, uid: number): Promise<string | null> {
  return (await findUnixUser(vfs, uid))?.name ?? null;
}

export async function parseChownOwnership(
  vfs: UnixAccountReader,
  specification: string,
): Promise<{ uid: number | null; gid: number | null }> {
  const separator = specification.indexOf(':');
  const ownerToken = separator === -1 ? specification : specification.slice(0, separator);
  const groupToken = separator === -1 ? null : specification.slice(separator + 1);
  if (!ownerToken && !groupToken) throw new Error(`invalid spec: '${specification}'`);

  const numericUid = ownerToken ? parseUnixId(ownerToken) : null;
  const owner = ownerToken && numericUid === null ? (await findUnixUser(vfs, ownerToken)) : null;
  if (ownerToken && numericUid === null && !owner) throw new Error(`invalid user: '${ownerToken}'`);

  let gid: number | null = null;
  if (groupToken) {
    const numericGid = parseUnixId(groupToken);
    const group = numericGid === null ? (await findUnixGroup(vfs, groupToken)) : null;
    if (numericGid === null && !group) throw new Error(`invalid group: '${groupToken}'`);
    gid = numericGid ?? group?.gid ?? null;
  } else if (separator !== -1 && owner) {
    gid = owner.gid;
  }
  return { uid: numericUid ?? owner?.uid ?? null, gid };
}

export async function credForUnixUser(
  vfs: UnixAccountReader,
  user: UnixUser,
  umask: number,
): Promise<VfsCred> {
  const gids = new Set<number>([user.gid]);
  for (const group of (await groups(vfs))) {
    if (group.members.includes(user.name)) gids.add(group.gid);
  }
  return {
    uid: user.uid,
    gid: user.gid,
    groups: [...gids],
    umask,
  };
}
