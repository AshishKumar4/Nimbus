/**
 * A path a module names. `sync` marks a synchronous content read of it
 * (`readFileSync`, or `openSync` with no flags or a read-only literal flag):
 * the call cannot wait for the bytes, so their size says nothing about
 * whether the process needs them held.
 */
export interface PathRef {
    path: string;
    sync: boolean;
}
export interface StaticFsRefs {
    /** Absolute paths named exactly (files or directories). */
    exact: PathRef[];
    /** Directories a module lists (readdir), whose files it then reads. */
    listed: string[];
    /** `dir/prefix*suffix`: names with one unknown part in the last segment. */
    patterns: {
        dir: string;
        prefix: string;
        suffix: string;
    }[];
    /** Paths relative to the process's working directory, read at a call site. */
    cwdRelative: PathRef[];
    /** `require.resolve(spec)` / `createRequire(..).resolve(spec)` from `from`: what Node's require resolves. */
    resolves: {
        from: string;
        spec: string;
    }[];
    /**
     * Package subpaths spelled as data (BARE_SUBPATH: "astro/runtime/client/x.js"
     * in a bundler's include list) from `from`: read by whatever resolves them.
     */
    subpaths: {
        from: string;
        spec: string;
    }[];
    /**
     * Absolute paths spelled as string literals anywhere (ABSOLUTE_LITERAL),
     * named by no call this analysis follows: a guess at a file the module
     * reads, which a launch stages when it is there.
     */
    literals: string[];
}
/**
 * Every statically named path in `source`, a module whose own path is
 * `filename` (absolute). Unparseable sources name nothing.
 */
export declare function findStaticFsReferences(source: string, filename: string): StaticFsRefs;
/**
 * Sources larger than this are scanned token by token instead of parsed.
 *
 * An AST costs the heap a multiple of its source — measured with acorn: 13 MB
 * for a 1.5 MB module, 94 MB for a 4.3 MB one — and the analysis runs in the
 * session's Durable Object, whose isolate has 128 MiB for everything. A
 * single-file CLI bundle past a few megabytes reset the session outright.
 */
export declare const STATIC_AST_MAX_SOURCE: number;
/**
 * The same references, found in a token stream with O(1) memory: the
 * literal shapes that need no bindings. `join|resolve(__dirname | import.meta.
 * dirname, 'lit', ...)` (a synchronous read when it is readFileSync's first
 * argument), `new URL('lit', import.meta.url)`, a read call on an absolute
 * literal, and package-subpath and absolute-path literals, a template with
 * no substitution being the string it spells. What folding through bindings
 * would add is not found here.
 */
export declare function scanStaticFsTokens(source: string, filename: string): StaticFsRefs;
//# sourceMappingURL=static-fs-refs.d.ts.map