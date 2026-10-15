import type { ProjectManifest, TreePackage } from '../npm-tree.js';
import type { TreePlan } from './plan.js';
/** npm's EBADENGINE: the package, what its engines ask, and what this runtime is. */
export interface EngineMismatch {
    readonly pkgid: string | undefined;
    readonly required: unknown;
    readonly current: {
        readonly node: string | null;
        readonly npm: string;
    };
}
/**
 * Each EBADENGINE of the tree `plan` holds for `project` (its root
 * manifest; null under a global prefix): the project's own, unless it
 * declares devEngines, then every package a path of required edges reaches,
 * in the order npm's ideal tree takes them in (breadth first: by how many
 * edges from the project, then by placement). An optional one is not
 * checked; `force` checks npm alone.
 */
export declare function engineMismatches<P extends TreePackage, I extends TreePackage>(project: ProjectManifest | null, plan: Pick<TreePlan<P, I>, 'nodes' | 'required' | 'skipped'>, force: boolean): EngineMismatch[];
//# sourceMappingURL=engines.d.ts.map