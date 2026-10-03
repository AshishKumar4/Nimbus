/**
 * Which file contents a resident node process holds from its first
 * instruction, besides its module map.
 *
 * A synchronous read cannot wait for bytes, so whatever a process reads
 * synchronously has to be in its facet before it runs; the namespace (every
 * name and stat) is always there, content is not. This decides content by
 * rule, from the namespace and the module closure, without reading file
 * contents except a few package.json files:
 *
 *   package-json   every package.json
 *   project        the working tree, minus dependency, VCS and build-cache dirs
 *   convention     config and lockfile names in the working dir and above it
 *   package-data   non-code files under 256 KiB in every package the closure uses
 *   home           $HOME's dot entries (tool config, skills), minus caches
 *   typescript     when the closure has typescript: its lib .d.ts, @types/**,
 *                  and the declaration files of the packages @types depends on
 *   static         what the closure's own code names by a foldable path
 *                  (static-fs-refs.ts), resolved against the namespace:
 *                  under 256 KiB, or any size when the code reads it with
 *                  readFileSync (or a read-only openSync) by that path,
 *                  through any symlinks on it
 *   entries        the entry files the working dir's own dependencies name
 *                  (exports under every condition, module, main, browser),
 *                  under 256 KiB: a dev server reads them synchronously to
 *                  pre-bundle what the app imports (Vite's optimizer reads
 *                  each with readFileSync), and the process never loads them
 *   learned        paths earlier launches of the same package versions missed
 *
 * Code the closure loads is in the module map already; the store adopts it,
 * so it is readable as data too.
 */
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