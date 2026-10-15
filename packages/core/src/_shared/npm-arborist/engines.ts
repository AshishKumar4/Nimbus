/**
 * npm's engine check over a planned tree (arborist build-ideal-tree's
 * #checkEngineAndPlatform), by npm-install-checks' own checkEngine against
 * this runtime's Node (NODE_VERSION) and npm (NPM_VERSION).
 */
import { NODE_VERSION, NPM_VERSION } from '../../constants.js';
import { checkEngine } from '../npm-libs.js';
import type { ProjectManifest, TreePackage } from '../npm-tree.js';
import type { TreePlan } from './plan.js';

/** npm's EBADENGINE: the package, what its engines ask, and what this runtime is. */
export interface EngineMismatch {
  readonly pkgid: string | undefined;
  readonly required: unknown;
  readonly current: { readonly node: string | null; readonly npm: string };
}

/**
 * Each EBADENGINE of the tree `plan` holds for `project` (its root
 * manifest; null under a global prefix): the project's own, unless it
 * declares devEngines, then every package a path of required edges reaches,
 * in placement order. An optional one is not checked; `force` checks npm
 * alone.
 */
export function engineMismatches<P extends TreePackage, I extends TreePackage>(
  project: ProjectManifest | null,
  plan: Pick<TreePlan<P, I>, 'nodes' | 'required' | 'skipped'>,
  force: boolean,
): EngineMismatch[] {
  const targets: Array<{ engines?: unknown; _id?: string }> = [];
  if (project !== null && project.devEngines === undefined) targets.push({ engines: project.engines, _id: idOf(project.name, project.version) });
  for (const [at, node] of plan.nodes) {
    if (!plan.required.has(at) || plan.skipped.has(at)) continue;
    targets.push({ engines: node.pkg.engines, _id: idOf(node.pkg.registryName ?? node.pkg.name, node.pkg.version) });
  }
  const mismatches: EngineMismatch[] = [];
  for (const target of targets) {
    try {
      checkEngine(target, NPM_VERSION, NODE_VERSION, force);
    } catch (error) {
      const engine = error as { code?: unknown; pkgid?: string; required?: unknown; current?: EngineMismatch['current'] };
      if (engine.code !== 'EBADENGINE') throw error;
      mismatches.push({ pkgid: engine.pkgid, required: engine.required, current: engine.current! });
    }
  }
  return mismatches;
}

/** A manifest's _id, as npm's package.json normalization makes it: `name@version`, where it states both. */
function idOf(name: unknown, version: unknown): string | undefined {
  return typeof name === 'string' && name !== '' && typeof version === 'string' && version !== '' ? `${name}@${version}` : undefined;
}
