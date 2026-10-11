/**
 * npm-journal.ts — how the shell's npm publishes an install: every rename it
 * makes in node_modules, recorded at `<node_modules>/.nimbus-install-journal`
 * before it starts and once its outcome is known, then committed once every
 * package is in place. An install that does not finish (a failure, a crash,
 * a lost isolate) is undone from the journal, by itself or by the next
 * install, and only from what the journal records.
 */
import type { CommandOutputStream } from '../types.js';
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
/** A rename publication makes: `kind` says whose content `from` holds. */
interface JournalStep {
    /** retire: the installed copy moved aside; publish: a staged package moved in; carry: a kept package moved from a retired copy into the new tree. */
    readonly kind: 'retire' | 'publish' | 'carry';
    readonly from: string;
    readonly to: string;
    /** begun: not known to have finished; done: `to` holds all of it (what is left at `from` is residue); none: nothing moved. */
    state: 'begun' | 'done' | 'none';
}
/** One install's publication into a node_modules tree. */
export declare class InstallJournal {
    private readonly vfs;
    private readonly path;
    private readonly run;
    private readonly steps;
    private committed;
    private constructor();
    /** A journal for the install `run` into `modulesDir`. */
    static begin(vfs: VFS, modulesDir: string, run: string): InstallJournal;
    /**
     * Finish what an earlier install into `modulesDir` left: an uncommitted
     * one undone (saying what it puts back), a committed one's retired copies
     * removed. Answers false when it could not be undone, its copies kept as
     * the errors it wrote name them.
     */
    static recover(vfs: VFS, modulesDir: string, stderr: CommandOutputStream): Promise<boolean>;
    /** Where `target`'s installed copy is moved aside while this install publishes. */
    retired(target: string): string;
    /** Rename `from` to `to` as a step of `kind`, recorded before it starts and once its outcome is known. */
    move(kind: JournalStep['kind'], from: string, to: string): Promise<void>;
    /** Undo every move, newest first; the journal goes once the tree is as it was. Answers whether it is. */
    undo(stderr: CommandOutputStream): Promise<boolean>;
    /** Every package is published: the journal says so, and the retired copies (the old tree's) go, then the journal. */
    commit(stderr: CommandOutputStream): Promise<void>;
    private write;
    private removeRetired;
    /**
     * Newest first: a published package goes (its content is new), and a
     * retired or carried copy moves back, over any residue a rename left
     * where it came from. A step that may have moved part of an installed
     * copy (begun, its outcome unknown, both names there) is not guessed at:
     * both are kept, and named. `recovering`: an install that did not finish
     * is undone, and what is put back is said.
     */
    private undoSteps;
}
export {};
//# sourceMappingURL=npm-journal.d.ts.map