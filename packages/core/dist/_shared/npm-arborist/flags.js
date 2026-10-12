/**
 * flags.ts — what the project reaches, and through which edges
 * (calc-dep-flags.js). A node is dev when no path to it starts at a prod
 * edge, optional when every path has an optional edge, devOptional when no
 * path is both, and peer when every path has a peer edge. A folder holding
 * a node is kept with it (resetParents), but only edges are followed.
 */
export function calcDepFlags(project) {
    const reached = new Set();
    const required = new Set();
    const prod = new Set();
    const prodRequired = new Set();
    const nonPeer = new Set();
    const mark = (flagged, start, follow) => {
        const pending = [start];
        for (let each = pending.pop(); each; each = pending.pop()) {
            if (flagged.has(each))
                continue;
            flagged.add(each);
            for (const edge of each.edgesOut.values())
                if (edge.to && follow(edge))
                    pending.push(edge.to);
        }
    };
    for (const edge of project.edgesOut.values()) {
        if (!edge.to)
            continue;
        mark(reached, edge.to, () => true);
        if (!edge.optional)
            mark(required, edge.to, (e) => !e.optional);
        if (edge.type !== 'dev')
            mark(prod, edge.to, () => true);
        if (edge.type !== 'dev' && !edge.optional)
            mark(prodRequired, edge.to, (e) => !e.optional);
        if (!edge.peer)
            mark(nonPeer, edge.to, (e) => !e.peer);
    }
    for (const flagged of [reached, required, prod, prodRequired, nonPeer]) {
        for (const each of [...flagged])
            for (let up = each.parent; up && !up.isProjectRoot; up = up.parent)
                flagged.add(up);
    }
    return { reached, required, prod, prodRequired, nonPeer };
}
