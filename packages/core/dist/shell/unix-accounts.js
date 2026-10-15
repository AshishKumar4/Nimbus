export function parseUnixId(value) {
    if (!/^\d+$/.test(value))
        return null;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
}
/** The accounts /etc/passwd's `text` holds, in its order: the one parser of it, the shell's and the runtimes' (nimbus_proc.account). */
export function unixUsers(text) {
    const result = [];
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#'))
            continue;
        const fields = line.split(':');
        if (fields.length < 7)
            continue;
        const uid = parseUnixId(fields[2]);
        const gid = parseUnixId(fields[3]);
        if (uid === null || gid === null || !fields[0])
            continue;
        result.push({
            name: fields[0],
            password: fields[1],
            uid,
            gid,
            gecos: fields[4],
            home: fields[5],
            shell: fields[6],
        });
    }
    return result;
}
/** The groups /etc/group's `text` holds, in its order. */
export function unixGroups(text) {
    const result = [];
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#'))
            continue;
        const fields = line.split(':');
        if (fields.length < 4)
            continue;
        const gid = parseUnixId(fields[2]);
        if (gid === null || !fields[0])
            continue;
        result.push({
            name: fields[0],
            password: fields[1],
            gid,
            members: fields[3] ? fields[3].split(',').filter(Boolean) : [],
        });
    }
    return result;
}
async function users(vfs) {
    return unixUsers(await vfs.readFileString('/etc/passwd'));
}
async function groups(vfs) {
    return unixGroups(await vfs.readFileString('/etc/group'));
}
export async function findUnixUser(vfs, identity) {
    const entries = (await users(vfs));
    if (typeof identity === 'number')
        return entries.find((entry) => entry.uid === identity) ?? null;
    const numeric = parseUnixId(identity);
    return entries.find((entry) => entry.name === identity)
        ?? (numeric === null ? null : entries.find((entry) => entry.uid === numeric) ?? null);
}
export async function findUnixGroupName(vfs, gid) {
    return (await findUnixGroup(vfs, gid))?.name ?? null;
}
export async function findUnixGroup(vfs, identity) {
    const entries = (await groups(vfs));
    if (typeof identity === 'number')
        return entries.find((entry) => entry.gid === identity) ?? null;
    const numeric = parseUnixId(identity);
    return entries.find((entry) => entry.name === identity)
        ?? (numeric === null ? null : entries.find((entry) => entry.gid === numeric) ?? null);
}
export async function findUnixUserName(vfs, uid) {
    return (await findUnixUser(vfs, uid))?.name ?? null;
}
export async function parseChownOwnership(vfs, specification) {
    const separator = specification.indexOf(':');
    const ownerToken = separator === -1 ? specification : specification.slice(0, separator);
    const groupToken = separator === -1 ? null : specification.slice(separator + 1);
    if (!ownerToken && !groupToken)
        throw new Error(`invalid spec: '${specification}'`);
    const numericUid = ownerToken ? parseUnixId(ownerToken) : null;
    const owner = ownerToken && numericUid === null ? (await findUnixUser(vfs, ownerToken)) : null;
    if (ownerToken && numericUid === null && !owner)
        throw new Error(`invalid user: '${ownerToken}'`);
    let gid = null;
    if (groupToken) {
        const numericGid = parseUnixId(groupToken);
        const group = numericGid === null ? (await findUnixGroup(vfs, groupToken)) : null;
        if (numericGid === null && !group)
            throw new Error(`invalid group: '${groupToken}'`);
        gid = numericGid ?? group?.gid ?? null;
    }
    else if (separator !== -1 && owner) {
        gid = owner.gid;
    }
    return { uid: numericUid ?? owner?.uid ?? null, gid };
}
export async function credForUnixUser(vfs, user, umask) {
    const gids = new Set([user.gid]);
    for (const group of (await groups(vfs))) {
        if (group.members.includes(user.name))
            gids.add(group.gid);
    }
    return {
        uid: user.uid,
        gid: user.gid,
        groups: [...gids],
        umask,
    };
}
