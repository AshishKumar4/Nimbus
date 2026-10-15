/**
 * npm's engine checks over a planned tree, by npm-install-checks' own
 * checkEngine against this runtime's Node (NODE_VERSION) and npm
 * (NPM_VERSION): arborist build-ideal-tree's #checkEngineAndPlatform for
 * what the tree requires, and reify's for an optional package, which leaves
 * it out.
 */
import { NODE_VERSION, NPM_VERSION } from '../../constants.js';
import { checkEngine } from '../npm-libs.js';
/**
 * The tree `plan` holds for `project` (its root manifest; null under a
 * global prefix), checked as npm checks it, in the inventory's order:
 * - an optional package whose engines exclude this runtime is left out with
 *   its optional set (plan.fail), as reify leaves it out, whatever --force
 *   or --engine-strict say, and nothing is said of it;
 * - the project, unless it declares devEngines (the command's own preflight
 *   checks those), and every package the tree requires: each mismatch is
 *   answered, for npm's warning, or under --engine-strict its error; `force`
 *   checks npm alone.
 */
export function checkEngines(project, plan, force) {
    for (const [at, node] of plan.nodes) {
        if (plan.required.has(at) || plan.skipped.has(at))
            continue;
        if (mismatchOf(node.pkg, false) !== null)
            plan.fail(at, 'Unsupported engine');
    }
    const mismatches = [];
    const check = (target) => {
        const mismatch = mismatchOf(target, force);
        if (mismatch !== null)
            mismatches.push(mismatch);
    };
    if (project !== null && project.devEngines === undefined)
        check({ engines: project.engines, _id: idOf(project.name, project.version) });
    for (const [at, node] of plan.nodes)
        if (plan.required.has(at) && !plan.skipped.has(at))
            check(node.pkg);
    return mismatches;
}
/** checkEngine's EBADENGINE for `target` (a package, or a target npm names by `_id`), or null. */
function mismatchOf(target, force) {
    const named = 'version' in target ? { engines: target.engines, _id: idOf(target.registryName ?? target.name, target.version) } : target;
    try {
        checkEngine(named, NPM_VERSION, NODE_VERSION, force);
        return null;
    }
    catch (error) {
        const engine = error;
        if (engine.code !== 'EBADENGINE')
            throw error;
        return { pkgid: engine.pkgid, required: engine.required, current: engine.current };
    }
}
/** A manifest's _id, as npm's package.json normalization makes it: `name@version`, where it states both. */
function idOf(name, version) {
    return typeof name === 'string' && name !== '' && typeof version === 'string' && version !== '' ? `${name}@${version}` : undefined;
}
