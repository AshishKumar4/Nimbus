/**
 * Shared npm resolution types, cache serialization, and hoisting.
 *
 * Registry resolution runs in fanout facets; this module contains only the
 * supervisor-side contracts and computations consumed after resolution.
 */
/** Every placement in the plan, root first. */
export function hoistPlacements(plan) {
    const out = [];
    for (const [name, pkg] of plan.root)
        out.push({ placement: name, pkg });
    for (const [placement, pkg] of plan.nested)
        out.push({ placement, pkg });
    return out;
}
