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
export declare function checkEngines<P extends TreePackage, I extends TreePackage>(project: ProjectManifest | null, plan: Pick<TreePlan<P, I>, 'nodes' | 'required' | 'skipped' | 'fail'>, force: boolean): EngineMismatch[];
//# sourceMappingURL=engines.d.ts.map