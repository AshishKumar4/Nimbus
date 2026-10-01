/**
 * gnulib's modechange: a chmod(1) mode, octal or symbolic, compiled once and
 * then applied to any file's mode. chmod applies it to the file's own mode;
 * find's -perm applies it to 0 to get the bits it compares against.
 *
 * The grammar is gnulib's: an octal number, or comma-separated clauses of
 * `[ugoa]*([-+=]([rwxXst]*|[ugo]))+` and `[-+=][0-7]+`.
 */
export type ModeOperator = '=' | '+' | '-';
/**
 * One operation: `affected` is the who-mask (0 when no who was given, which
 * means the umask decides), `mentioned` the bits the clause names, which
 * keeps a directory's set-id bits unless the clause names them.
 */
export interface ModeChange {
    readonly op: ModeOperator;
    readonly flag: 'ordinary' | 'x-if-any-x' | 'copy-existing';
    readonly affected: number;
    readonly value: number;
    readonly mentioned: number;
}
/** The changes `spec` describes, or null where gnulib's mode_compile refuses it. */
export declare function compileMode(spec: string): ModeChange[] | null;
/** gnulib's mode_adjust: `oldMode`'s permission bits after `changes`. */
export declare function adjustMode(oldMode: number, isDir: boolean, umask: number, changes: readonly ModeChange[]): number;
//# sourceMappingURL=mode-change.d.ts.map