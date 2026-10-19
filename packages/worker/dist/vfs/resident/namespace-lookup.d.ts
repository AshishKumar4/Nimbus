/**
 * The namespace's read path: the row at a key, and the walk of a name to
 * where the table holds it. Module loading reads every file through these
 * (node-shims _nsWalk, _entry), after the program may have replaced any
 * built-in, so they call only the launch's captures (core _shared
 * primordials.ts; design-guest-loader-primordials.md §3.5), as Node's loader
 * reads files on its primordials.
 */
import { type SafeSet } from '@nimbus-sh/core/_shared/primordials.js';
import { type NsRow, type ResidentTables } from './tables.js';
/** Symlink hops before a resolution is ELOOP, as Linux's MAXSYMLINKS. */
export declare const NS_MAX_HOPS = 40;
/**
 * What the process's own effects say of a name, ahead of the table (the
 * shims' overlay): it removed it (`absent`); it made a symlink there
 * (`target`); it renamed the table's entry at `from` to it (`from` undefined:
 * a moved link that resolves to nothing; `link`: the moved entry is a symlink,
 * whose own row is at that key; `ino`, `dev`: the entry moved; `via`: names
 * an earlier rename of it, not yet landed, left it under); or it made a
 * directory or file there (`made`; `hide`: rows the table holds beneath it
 * are not this directory's).
 */
export type OwnWord = {
    readonly absent: true;
} | {
    readonly target: string;
} | {
    readonly from: string | undefined;
    readonly link?: string;
    readonly ino?: number;
    readonly dev?: number;
    readonly via?: readonly string[];
} | {
    readonly made: 'directory' | 'file';
    readonly hide?: boolean;
};
/** The process's word on a name (by the name the walk reached), or undefined. */
export type OwnView = (k: string) => OwnWord | undefined;
/**
 * Where a walk lands: the name reached (the process's own naming, links
 * followed), where the table holds it (`table`, null where no row of the
 * table's can be: under a directory the process made, or at its own entry),
 * the table's row there, and the process's own word on the name.
 */
export interface Lookup {
    path: string;
    table: string | null;
    row: NsRow | undefined;
    own?: OwnWord;
}
/** The directory part of key `k`: '' at the top. */
export declare function nsParent(k: string): string;
/** The last name of key `k`. */
export declare function nsName(k: string): string;
/** Key `k` as its directory and its last name. */
export declare function nsSplit(k: string): [string, string];
/** A path as the namespace keys it: no leading '/'. */
export declare function nsKey(path: unknown): string;
/** The row at exactly `k` (no symlink resolution), or undefined. */
export declare function nsRowAt(t: ResidentTables, k: string): NsRow | undefined;
/**
 * A link's `target` resolved lexically against the directory of the name it
 * was reached by (`linkPath`): its names after that directory's, an absolute
 * target's from the top, `.` and empty names dropped, each `..` taking back
 * the name before it and staying at the top (platform lexical-path's
 * rootClampedSegments).
 */
export declare function joinTarget(linkPath: string, target: unknown): string;
/**
 * The walk of `k` (lookup): the process's own effects (`own`) applied at
 * each name it reaches, ahead of the table: a name it removed ends the walk,
 * its links and renames redirect it, and beneath a directory it made only
 * its own names are there. The leaf is followed only when `followLeaf`. A
 * link's target is joined to the name it was reached by. `visit`: told each
 * name the walk looks up, in order; false stops the walk there, EACCES.
 */
export declare function walkNamespace(t: ResidentTables, links: SafeSet<string>, k: string, followLeaf: boolean, own: OwnView | undefined, visit: ((name: string) => boolean) | undefined): Lookup | 'ELOOP' | 'EACCES';
//# sourceMappingURL=namespace-lookup.d.ts.map