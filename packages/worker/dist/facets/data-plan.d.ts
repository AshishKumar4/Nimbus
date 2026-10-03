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
    /** A symlink's target as stored, or null when the path is not a symlink. */
    readlink(path: string): Promise<string | null>;
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
 * The plan for one launch. Walks the namespace once, in pages.
 */
export declare function planFacetData(source: DataPlanSource, input: DataPlanInput): Promise<DataPlan>;
//# sourceMappingURL=data-plan.d.ts.map