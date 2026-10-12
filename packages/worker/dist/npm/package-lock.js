/**
 * npm's package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 and 3),
 * read for `npm ci`: the `packages` map keyed by install path.
 */
/** A parsed JSON object or array: a value whose fields can be read and set. */
export function isJsonObject(value) {
    return value !== null && typeof value === 'object';
}
export function parsePackageLock(text, lockName) {
    const lock = JSON.parse(text);
    const version = typeof lock.lockfileVersion === 'number' ? lock.lockfileVersion : 0;
    if (version < 2 || lock.packages === null || typeof lock.packages !== 'object') {
        throw new Error(`${lockName} has lockfileVersion ${version || 'unknown'}; \`npm ci\` here reads lockfileVersion 2 or 3. ` +
            'Run `npm install` with npm 7 or newer to upgrade it.');
    }
    return { lockfileVersion: version, packages: lock.packages };
}
export function stringRecord(value) {
    const out = {};
    if (value === null || typeof value !== 'object')
        return out;
    for (const [key, v] of Object.entries(value))
        if (typeof v === 'string')
            out[key] = v;
    return out;
}
export function stringList(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : undefined;
}
