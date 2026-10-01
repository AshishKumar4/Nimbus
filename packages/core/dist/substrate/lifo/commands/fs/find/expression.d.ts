/**
 * find's command line, parsed as findutils 4.10 parses it (parser.c, tree.c):
 * leading options, start points, then an expression built in two passes. The
 * first turns arguments into a list of predicates, inserting the implicit
 * -a and running each predicate's own parser (which may stat a reference
 * file or look up a user, and may fail the command); the second builds the
 * tree by precedence, with GNU's messages for every malformed shape.
 *
 * GNU predicates this find does not implement are refused by name rather
 * than skipped: skipping one answers a different question.
 */
import type { ProcessView } from '../../../../../runtime/process-files.js';
import { type CompiledFormat, type FileTypeLetter } from './format.js';
export type Comparison = 'lt' | 'eq' | 'gt';
export type SymlinkMode = 'P' | 'H' | 'L';
export type TimeField = 'atime' | 'ctime' | 'mtime';
/** -type's letters: a mode's, and Solaris's door, which GNU on Linux refuses. */
export type TypeLetter = FileTypeLetter | 'D';
export type Primary = {
    readonly kind: 'true' | 'false' | 'empty' | 'nouser' | 'nogroup' | 'prune' | 'quit' | 'delete';
} | {
    readonly kind: 'name' | 'path' | 'lname';
    readonly pattern: string;
    readonly fold: boolean;
}
/** -type, or with `target` -xtype: the type of what the other kind of stat sees. */
 | {
    readonly kind: 'type';
    readonly types: Readonly<Partial<Record<TypeLetter, true>>>;
    readonly target: boolean;
} | {
    readonly kind: 'size';
    readonly cmp: Comparison;
    readonly count: number;
    readonly unit: number;
}
/** -[acm]time, -[acm]min: findutils' pred_timewindow against `reference` (ms), `window` seconds wide. */
 | {
    readonly kind: 'time';
    readonly field: TimeField;
    readonly cmp: Comparison;
    readonly reference: number;
    readonly window: number;
}
/** -used: the same window over how long after its last change the file was last read. */
 | {
    readonly kind: 'used';
    readonly cmp: Comparison;
    readonly reference: number;
} | {
    readonly kind: 'newer';
    readonly field: TimeField;
    readonly reference: number;
} | {
    readonly kind: 'perm';
    readonly match: 'exact' | 'all' | 'any';
    readonly file: number;
    readonly directory: number;
} | {
    readonly kind: 'number';
    readonly field: 'uid' | 'gid' | 'nlink' | 'ino';
    readonly cmp: Comparison;
    readonly value: number;
} | {
    readonly kind: 'access';
    readonly mode: number;
} | {
    readonly kind: 'samefile';
    readonly dev: number;
    readonly ino: number;
} | {
    readonly kind: 'print';
    readonly terminator: '\n' | '\0';
} | {
    readonly kind: 'printf';
    readonly format: CompiledFormat;
} | {
    readonly kind: 'exec';
    readonly argv: readonly string[];
    readonly batch: boolean;
    readonly inDirectory: boolean;
};
export type Expression = {
    readonly kind: 'and' | 'or' | 'comma';
    readonly left: Expression;
    readonly right: Expression;
} | {
    readonly kind: 'not';
    readonly operand: Expression;
} | {
    readonly kind: 'primary';
    readonly primary: Primary;
};
export interface FindPlan {
    readonly kind: 'walk';
    readonly startPoints: readonly string[];
    readonly expression: Expression;
    readonly symlinks: SymlinkMode;
    readonly maxDepth: number;
    readonly minDepth: number;
    readonly depthFirst: boolean;
    readonly sameDevice: boolean;
    /** -ignore_readdir_race: a file gone between the listing and its use is not an error. */
    readonly ignoreVanished: boolean;
}
/** -help and -version answer at once, whatever else is on the line. */
export type FindCommand = FindPlan | {
    readonly kind: 'info';
    readonly text: string;
};
export interface ParseEnvironment {
    readonly vfs: ProcessView;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    /** When find started, in ms: the origin of every relative time. */
    readonly now: number;
    /** GNU's default for -warn: whether standard input is a terminal. */
    readonly warnings: boolean;
    readonly version: string;
    warn(message: string): void;
}
/** Parse find's arguments into what to walk and what to evaluate at each file. */
export declare function parseFindCommand(args: readonly string[], environment: ParseEnvironment): Promise<FindCommand>;
//# sourceMappingURL=expression.d.ts.map