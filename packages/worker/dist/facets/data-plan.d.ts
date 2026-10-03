import type { RuntimeFsBridge } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { StaticFsRefs } from '@nimbus-sh/core/runtime/static-fs-refs.js';
export interface DataPlanEntry {
    path: string;
    kind: string;
    size: number;
    linkTarget?: string;
}
export interface DataPlanSource {
    /** One page of the namespace in path order; `next === null` ends it. */
    list(after: string | null): Promise<{
        entries: DataPlanEntry[];
        next: string | null;
    }>;
    /** A file's text, or null when it cannot be read. */
    readText(path: string): Promise<string | null>;
    /**
     * Where the symlink at a path leads, as the namespace follows it (its
     * stored target, re-rooted on a mount that reads its links from its own
     * root: RuntimeFsBridge.linkLeadsTo), or null when the path is not a symlink.
     */
    linkTarget(path: string): Promise<string | null>;
    /** What is at a path, following symlinks, or null. */
    stat(path: string): Promise<{
        kind: string;
        size: number;
    } | null>;
}
export interface DataPlanInput {
    cwd: string;
    home: string;
    /** Module map paths. */
    closure: Iterable<string>;
    refs: readonly StaticFsRefs[];
    /** Paths learned from earlier misses (absolute or keys). */
    learned?: Iterable<string>;
    /** Called with the bytes of each listed page, to pace a long walk. */
    spend?: (units: number) => Promise<void>;
}
export type DataPlanRule = 'package-json' | 'project' | 'convention' | 'package-data' | 'home' | 'typescript' | 'static' | 'entries' | 'learned';
export interface DataPlan {
    paths: string[];
    bytes: number;
    rules: Record<DataPlanRule, {
        files: number;
        bytes: number;
    }>;
}
/** Package data this size or larger is a bundle or a binary, not configuration. */
export declare const PACKAGE_DATA_MAX_BYTES: number;
/** The package directory a path sits in: up to the name after its last node_modules. */
export declare function packageRootOf(k: string): string | null;
/**
 * DataPlanSource.linkTarget over a process's bridge: where the symlink at
 * `path` leads as the namespace follows it, or null when it is no link. A
 * missing or unreadable component is not a link: the lookup ends there.
 */
export declare function linkTargetOf(fs: Pick<RuntimeFsBridge, 'readlink' | 'linkLeadsTo'>, path: string): Promise<string | null>;
/**
 * The plan for one launch. Walks the namespace once, in pages.
 */
export declare function planFacetData(source: DataPlanSource, input: DataPlanInput): Promise<DataPlan>;
//# sourceMappingURL=data-plan.d.ts.map