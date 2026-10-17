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
    /** A file's text, a byte order mark kept (require-resolution.ts fileText), or null when it cannot be read. */
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
    /** The entries directly in a directory, a symlink's kind 'symlink' and unfollowed, or null when it is none. */
    readdir(dir: string): Promise<DataPlanEntry[] | null>;
}
export interface DataPlanInput {
    cwd: string;
    home: string;
    /** Module map paths. */
    closure: Iterable<string>;
    /** Of those, the files the map carries only as their emit, not as themselves. */
    codeOnly?: Iterable<string>;
    refs: readonly StaticFsRefs[];
    /** Paths learned from earlier misses (absolute or keys). */
    learned?: Iterable<string>;
    /** The program's own conditions (`node --conditions`), which its resolutions use beside Node's. */
    conditions?: readonly string[];
    /** Called with the bytes of each listed page, to pace a long walk. */
    spend?: (units: number) => Promise<void>;
}
export type DataPlanRule = 'package-json' | 'project' | 'convention' | 'package-data' | 'home' | 'typescript' | 'static' | 'entries' | 'learned' | 'stylesheet-source';
export interface DataPlan {
    paths: string[];
    bytes: number;
    rules: Record<DataPlanRule, {
        files: number;
        bytes: number;
    }>;
    /** The stylesheet sources outside the working tree it planned (stylesheet-source), as absolute paths. */
    sourceRoots: string[];
    /** The names the namespace listed, once however many walks the plan took: what a store holding it holds a row for. */
    names: number;
}
/** Package data this size or larger is a bundle or a binary, not configuration. */
export declare const PACKAGE_DATA_MAX_BYTES: number;
/** The `package-json` rule: a package.json anywhere but in a git directory. */
export declare function isManifestKey(k: string): boolean;
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
/** Whether a closure carries Tailwind's oxide scanner, whose reads cannot wait (the stylesheet-source rule). */
export declare function carriesOxide(closure: Iterable<string>): boolean;
/**
 * The stylesheet-source rule, for a resident's plan and a one-shot's alike:
 * from `sheets`, through the `@import`s Tailwind inlines (a path's, not a
 * package's), each sheet read once, every `@source` outside the working tree
 * `cwd`, each brace alternative's directory prefix taken whole, through its
 * links; and the files under those roots, walked a directory at a time with
 * the project rule's exclusions, which are of a path as it is named below its
 * root, whatever a link makes of it. The roots it returns are what the
 * facet's barriers push: those, and wherever a link below one leads.
 */
export declare function planStylesheetSources(source: Pick<DataPlanSource, 'readText' | 'stat' | 'linkTarget' | 'readdir'>, input: {
    cwd: string;
    home: string;
    sheets: Iterable<string>;
    spend?: (units: number) => Promise<void> | void;
}): Promise<{
    roots: string[];
    files: DataPlanEntry[];
}>;
//# sourceMappingURL=data-plan.d.ts.map