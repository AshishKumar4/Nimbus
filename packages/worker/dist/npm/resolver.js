/**
 * Shared npm resolution types, cache serialization, and hoisting.
 *
 * Registry resolution runs in fanout facets; this module contains only the
 * supervisor-side contracts and computations consumed after resolution.
 */
/** The walk's placement decisions carried forward: first version per name at root, the rest nested. */
export function computeHoistPlan(resolved, nested = new Map()) {
    return {
        root: new Map(resolved),
        nested: new Map(nested),
    };
}
/** Every placement in the plan, root first. */
export function hoistPlacements(plan) {
    const out = [];
    for (const [name, pkg] of plan.root)
        out.push({ placement: name, pkg });
    for (const [placement, pkg] of plan.nested)
        out.push({ placement, pkg });
    return out;
}
