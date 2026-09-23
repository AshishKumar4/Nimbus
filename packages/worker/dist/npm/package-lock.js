/**
 * npm's package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 and 3),
 * read for `npm ci`: the `packages` map keyed by install path, and the check
 * that the lock still describes what package.json declares.
 */
import { isSemverRange, satisfiesRange } from './semver.js';
import { parseRegistryRequest } from './resolve-one-facet.js';
export function parsePackageLock(text, lockName) {
    const lock = JSON.parse(text);
    const version = typeof lock.lockfileVersion === 'number' ? lock.lockfileVersion : 0;
    if (version < 2 || lock.packages === null || typeof lock.packages !== 'object') {
        throw new Error(`${lockName} has lockfileVersion ${version || 'unknown'}; \`npm ci\` here reads lockfileVersion 2 or 3. ` +
            'Run `npm install` with npm 7 or newer to upgrade it.');
    }
    return { lockfileVersion: version, packages: lock.packages };
}
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
/**
 * Why the lock no longer describes package.json, one line per disagreement;
 * empty when they agree. Every declared dependency must be locked at a
 * version its range accepts, and the lock's root must declare the same
 * dependency set, so a dependency removed from package.json is caught too.
 */
export function packageLockMismatches(pkgJson, lock) {
    const out = [];
    const root = lock.packages[''] ?? {};
    for (const field of DEPENDENCY_FIELDS) {
        const declared = stringRecord(pkgJson[field]);
        const locked = stringRecord(root[field]);
        for (const [name, spec] of Object.entries(declared)) {
            if (locked[name] !== spec) {
                out.push(`Invalid: lock file's root ${field} has ${name}@${locked[name] ?? '(none)'}, package.json has ${name}@${spec}`);
                continue;
            }
            const entry = lock.packages[`node_modules/${name}`];
            if (!entry) {
                if (field !== 'peerDependencies' && field !== 'optionalDependencies')
                    out.push(`Missing: ${name}@${spec} from lock file`);
                continue;
            }
            const range = parseRegistryRequest(name, spec).range;
            const version = typeof entry.version === 'string' ? entry.version : '';
            if (isSemverRange(range) && !satisfiesRange(version, range)) {
                out.push(`Invalid: lock file's ${name}@${version || '(none)'} does not satisfy ${name}@${spec}`);
            }
        }
        for (const name of Object.keys(locked)) {
            if (!Object.hasOwn(declared, name))
                out.push(`Invalid: lock file's root ${field} has ${name}, which package.json does not declare`);
        }
    }
    return out;
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
