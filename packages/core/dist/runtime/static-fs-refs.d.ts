export interface StaticFsRefs {
    /** Absolute paths named exactly (files or directories). */
    exact: string[];
    /** Directories a module lists (readdir), whose files it then reads. */
    listed: string[];
    /** `dir/prefix*suffix`: names with one unknown part in the last segment. */
    patterns: {
        dir: string;
        prefix: string;
        suffix: string;
    }[];
    /** Paths relative to the process's working directory, read at a call site. */
    cwdRelative: string[];
    /** `require.resolve(spec)` / `createRequire(..).resolve(spec)` from `from`. */
    resolves: {
        from: string;
        spec: string;
    }[];
}
/**
 * Every statically named path in `source`, a module whose own path is
 * `filename` (absolute). Unparseable sources name nothing.
 */
export declare function findStaticFsReferences(source: string, filename: string): StaticFsRefs;
//# sourceMappingURL=static-fs-refs.d.ts.map