/**
 * find's -printf: the format compiled once into segments (findutils'
 * insert_fprintf), and each segment rendered for one file (do_fprintf).
 *
 * GNU works in bytes: an escape names a byte, and a field's width and
 * precision count bytes. So does this.
 */
import type { ProcessStat } from '../../../../../runtime/process-files.js';
import type { VfsDirentType } from '../../../../../vfs/vfs.js';
/** printf's flags, width and precision as GNU passes them through (it never takes `0` as a flag; a width starting with 0 is). */
interface FieldSpec {
    readonly left: boolean;
    readonly plus: boolean;
    readonly space: boolean;
    readonly alternate: boolean;
    readonly zero: boolean;
    readonly width: number;
    readonly precision: number | null;
}
type PathDirectiveKind = 'name' | 'dirname' | 'path' | 'relative' | 'start' | 'depth';
type StatDirectiveKind = 'target-type' | 'link' | 'size' | 'inode' | 'links' | 'uid' | 'gid' | 'device' | 'user' | 'group' | 'mode' | 'mode-string';
/** The directives this find renders; a time directive carries its strftime letter. */
export type Directive = {
    readonly kind: PathDirectiveKind;
} | {
    readonly kind: 'type';
} | {
    readonly kind: StatDirectiveKind;
} | {
    readonly kind: 'ctime-format';
    readonly field: TimeField;
} | {
    readonly kind: 'time';
    readonly field: TimeField;
    readonly letter: string;
};
export type TimeField = 'atime' | 'ctime' | 'mtime';
export type FormatSegment = {
    readonly kind: 'bytes';
    readonly bytes: Uint8Array;
}
/** `\c`: what came before is printed, and nothing after it, for this file. */
 | {
    readonly kind: 'stop';
} | {
    readonly kind: 'field';
    readonly field: FieldSpec;
    readonly directive: Directive;
};
export interface CompiledFormat {
    readonly segments: readonly FormatSegment[];
    /**
     * What rendering reads beyond the path (findutils' need_type, need_stat):
     * a file whose type or stat cannot be had prints nothing.
     */
    readonly needs: 'path' | 'type' | 'stat';
}
/**
 * Compile a -printf format. Warnings GNU prints and goes on from (an unknown
 * escape or directive is printed as written) go to `warn`; what GNU refuses
 * throws, and so does a directive GNU knows but Nimbus cannot answer.
 */
export declare function compileFormat(format: string, warn: (message: string) => void): CompiledFormat;
/** One file's facts, as a -printf directive asks for them. */
export interface FormatSubject {
    readonly path: string;
    readonly start: string;
    readonly depth: number;
    /** The file's stat as the walk sees it (links followed or not, per -P/-H/-L); present when the format needs it. */
    readonly stat: ProcessStat | null;
    /** %y: the file's type letter; present when the format needs it. */
    readonly type: FileTypeLetter | null;
    /** readlink of the file, for %l on a link; null when it cannot be read (and the failure has been reported). */
    linkTarget(): Promise<string | null>;
    /** %Y's letter for a link: its target's type, N when it dangles, L for a loop. */
    targetType(): Promise<string>;
    userName(uid: number): Promise<string | null>;
    groupName(gid: number): Promise<string | null>;
}
/** The -type letters a file can have. */
export type FileTypeLetter = 'f' | 'd' | 'l' | 's' | 'b' | 'c' | 'p';
/** The -type letter readdir's d_type gives an entry, or null where it cannot tell. */
export declare function direntTypeLetter(type: VfsDirentType): FileTypeLetter | null;
/** findutils' mode_to_filetype: the -type letter for a file a stat describes. */
export declare function fileTypeLetter(stat: Pick<ProcessStat, 'mode' | 'type'>): FileTypeLetter;
/** gnulib's base_name: the last component, with a run of trailing slashes kept as one. */
export declare function baseName(path: string): string;
/** One file's -printf output; `subject.stat` must be present when the format needs it. */
export declare function renderFormat(format: CompiledFormat, subject: FormatSubject): Promise<Uint8Array[]>;
export {};
//# sourceMappingURL=format.d.ts.map