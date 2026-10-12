/**
 * plan.ts — npm's one install engine, as its hosts use it (worker
 * npm/installer.ts, lifo commands/system/npm.ts): the ideal tree an install
 * reifies, built as npm 10.9.8's arborist builds it over the tree a host
 * says is installed and from what it resolves (build.ts), its dependency
 * flags found (flags.ts), and what cannot be installed failed or left out.
 *
 * What the project does not reach is extraneous, and goes where a tree was
 * installed before; a tree built from nothing keeps what its build left
 * unreached, as npm installs it. A package that failed to load, or that the
 * host refuses (EBADPLATFORM), fails the install where it is required and is
 * left out with its optional set where it is optional.
 *
 * npm ci plans over the lock's tree as an install does, and the plan must
 * be the lock's (validate-lockfile): `lockMismatches` names what it is not.
 * The lock's own flags are kept, unless the build changed the tree or the
 * lock's root declares other dependencies than the project; then they are
 * found again, and what the project does not reach goes.
 */
import { depthOf } from '../npm-tree.js';
import { Builder } from './build.js';
import { calcDepFlags } from './flags.js';
import { descendants, Node, Tree } from './model.js';
import { PeerConflict } from './place-dep.js';
import { optionalSet } from './sets.js';
/** The required failures of `plan`: any fails the install. */
export function requiredFailures(plan) {
    return plan.failures.filter(({ id }) => plan.required.has(id));
}
/** Plan the tree `roots` need over what is `installed`, from what `host` answers. */
export async function planTree(roots, installed, host, options = {}) {
    const project = new Node('', { kind: 'project' }, roots.map(({ name, range, type, explicit }) => ({ name, range, type, explicit })));
    const tree = new Tree(project, options.global === true);
    const builder = new Builder(tree, host, options);
    // The installed tree, each package in its folder.
    const installedAt = new Map([['', project]]);
    for (const entry of [...installed].sort((a, b) => depthOf(a.at) - depthOf(b.at))) {
        const slash = entry.at.lastIndexOf('/node_modules/');
        const parent = installedAt.get(slash < 0 ? '' : entry.at.slice(0, slash));
        if (!parent)
            continue;
        const name = slash < 0 ? entry.at : entry.at.slice(slash + '/node_modules/'.length);
        const node = 'failed' in entry
            ? new Node(name, { kind: 'failed', reason: entry.failed }, [])
            : new Node(name, { kind: 'installed', pkg: entry.pkg, refused: entry.refused, skipIfOptional: entry.skipIfOptional, lock: entry.lock }, builder.edgesOf(entry.pkg));
        tree.attach(node, parent);
        installedAt.set(entry.at, node);
        if (node.failed !== undefined)
            builder.loadFailures.add(node);
    }
    const failures = new Map();
    try {
        await builder.build();
    }
    catch (error) {
        if (!(error instanceof PeerConflict))
            throw error;
        failures.set('!ERESOLVE', { edge: error.edge, reason: error.message, refused: false, id: '!ERESOLVE' });
    }
    for (const message of builder.placer.warnings)
        await host.warn?.(message);
    // npm ci: every package the build placed is one the lock lacks, or holds at another version.
    const lockMismatches = [];
    if (options.locked) {
        for (const each of tree.nodes()) {
            if (each.payload.kind !== 'placed')
                continue;
            const locked = installedAt.get(each.location)?.pkg;
            if (!locked)
                lockMismatches.push(`Missing: ${each.name}@${each.version} from lock file`);
            else if (locked.version !== each.version)
                lockMismatches.push(`Invalid: lock file's ${each.name}@${locked.version} does not satisfy ${each.name}@${each.version}`);
        }
    }
    // ── calc-dep-flags; a lock's own flags where the build changed nothing (npm ci) ──
    const { reached, required, prod, prodRequired, nonPeer } = calcDepFlags(project);
    const lockFlags = options.locked === 'trusted' && !builder.mutated;
    const lockOf = (each) => (each.payload.kind === 'installed' && lockFlags ? each.payload.lock : undefined);
    const flagsOf = (each) => lockOf(each) ?? { dev: !prod.has(each), optional: !required.has(each), devOptional: !prodRequired.has(each), peer: !nonPeer.has(each) };
    const isRequired = (each) => {
        const lock = lockOf(each);
        return lock ? !lock.optional && !lock.devOptional : required.has(each);
    };
    // What the project does not reach is extraneous: it goes from a tree
    // installed before, but a lock's tree npm ci installs as it is.
    if (installed.length > 0 && !lockFlags)
        for (const each of [...tree.nodes()])
            if (each.tree === tree && !reached.has(each))
                tree.detach(each);
    const extraneous = new Set();
    for (const [at, each] of installedAt)
        if (at !== '' && each.tree !== tree)
            extraneous.add(at);
    // The tree, as the hosts get it, before anything is left out of it.
    const nodes = new Map();
    const requiredAt = new Set();
    const flagsAt = new Map();
    for (const each of tree.nodes()) {
        const at = each.location;
        if (isRequired(each))
            requiredAt.add(at);
        flagsAt.set(at, flagsOf(each));
        const { payload } = each;
        if (payload.kind === 'placed')
            nodes.set(at, { at, planned: true, pkg: payload.pkg, edge: payload.placedFor });
        else if (payload.kind === 'installed')
            nodes.set(at, { at, planned: false, pkg: payload.pkg });
    }
    // ── A package that failed to load, or is refused: a required one fails the install, an optional one goes with its optional set ──
    const skipped = new Set();
    const reasons = new Map();
    const leaveOut = (start, reason) => {
        if (isRequired(start))
            return null;
        reasons.set(start.location, reason);
        // The set, and what is beneath each member's folder, which goes with it.
        const set = optionalSet(start);
        for (const member of set)
            for (const each of [member, ...descendants(member)])
                skipped.add(each.location);
        for (const member of set)
            tree.detach(member);
        return skipped;
    };
    const failure = (each, reason, refused) => {
        const id = each.location;
        const { payload } = each;
        const placedFor = payload.kind === 'placed' || payload.kind === 'failed' ? payload.placedFor : undefined;
        failures.set(id, {
            edge: placedFor ?? { name: each.name, range: '*', from: each.parent?.location ?? '', type: 'prod', explicit: false },
            reason, refused, id,
        });
        if (isRequired(each))
            requiredAt.add(id);
        else
            leaveOut(each, reason);
    };
    for (const each of [...builder.loadFailures])
        if (each.tree === tree && each.failed !== undefined)
            failure(each, each.failed, false);
    for (const each of [...tree.nodes()]) {
        const { refused } = each.verdicts;
        if (each.tree === tree && refused !== undefined)
            failure(each, refused, true);
    }
    for (const each of [...tree.nodes()]) {
        const { skipIfOptional } = each.verdicts;
        if (each.tree === tree && skipIfOptional !== undefined && !isRequired(each))
            leaveOut(each, skipIfOptional);
    }
    if (failures.has('!ERESOLVE'))
        requiredAt.add('!ERESOLVE');
    const byPlacement = new Map([...tree.nodes()].map((each) => [each.location, each]));
    return {
        nodes,
        resolvedAny: builder.resolutions.size > 0,
        failures: [...failures.values()],
        lockMismatches,
        required: requiredAt,
        omits: (at, omit) => {
            const flags = flagsAt.get(at);
            // Under a global prefix every node's top is a top-level package, not the project: nothing is omitted (reify's trash list).
            if (!flags || options.global)
                return false;
            return (omit.dev === true && flags.dev === true) || (omit.optional === true && flags.optional === true)
                || (omit.dev === true && omit.optional === true && flags.devOptional === true) || (omit.peer === true && flags.peer === true);
        },
        skipped,
        reasons,
        extraneous,
        fail: (at, reason) => {
            const each = byPlacement.get(at);
            if (!each || each.tree !== tree)
                return skipped.has(at) ? skipped : null;
            return leaveOut(each, reason);
        },
    };
}
