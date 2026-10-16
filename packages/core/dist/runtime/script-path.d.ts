/** The VFS surface script resolution needs. */
export interface ScriptResolutionFs {
    isFile(path: string): boolean | Promise<boolean>;
    readFileString(path: string): string | Promise<string>;
}
/**
 * Resolve a runtime target — `./cli.ts`, `sub/x`, `.`, or a bare name — to a
 * canonical VFS key, or null when nothing runnable sits there.
 *
 * A directory never resolves to itself: it falls through to the index
 * candidates, so `bun ./tools` finds `tools/index.js` the way real bun does
 * rather than trying to read the directory as source.
 */
export declare function resolveRuntimeScriptPath(fs: ScriptResolutionFs, cwd: string, target: string, opts?: {
    preferModuleField?: boolean;
}): Promise<string | null>;
//# sourceMappingURL=script-path.d.ts.map