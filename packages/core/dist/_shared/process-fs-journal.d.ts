/**
 * process-fs-journal.ts — a process's write log, kept where the death of
 * the process does not reach (process-fs-client.ts).
 *
 * Every change the process makes is appended here in the turn it is made,
 * before the program is told it succeeded: a process's facet keeps it in its
 * own SQLite (sqlJournal), local and synchronous, which outlives the facet's
 * isolate, and the facet's output gate holds anything the program does after
 * the change (its output, its network) until the row is durable. The waves
 * the client sends are cut from it, and an entry is forgotten once the
 * session has answered it. What a process held when it died, the session
 * drains (drainProcessFsJournal): sent again under the numbers it was given,
 * so the session's cursor answers what already landed and applies the rest
 * once.
 *
 * Entries are numbered in the order they were appended (jid). The numbers
 * the session knows them by are a function of it: from the entry at `jid`
 * on, entries are numbered under `writer` from `seq`, one each, in order
 * (number()). A new numbering is recorded only when the client opens a new
 * writer epoch, so the journal writes one row per change, and deletes it.
 */
import type { ProcessFsOp } from './process-fs-client.js';
/** Where a numbering of the log starts: from `jid` on, numbered under `writer` from `seq`. */
export interface ProcessFsNumbering {
    writer: string | null;
    seq: number;
    jid: number;
}
export interface ProcessFsJournal {
    /** Whether it outlives the process (its facet's SQLite), or only its heap. */
    readonly durable: boolean;
    /** Append `op` as the next entry, in this turn: its jid. */
    append(op: ProcessFsOp): number;
    /** The entry `jid`, still held. */
    read(jid: number): ProcessFsOp;
    /** The entry `jid` (not yet sent) is now `op`: a later change folded into it. */
    replace(jid: number, op: ProcessFsOp): void;
    /** Every entry held, in order. */
    entries(): {
        jid: number;
        op: ProcessFsOp;
    }[];
    /** Forget every entry up to `jid` (answered: committed, refused, or failed). */
    dropThrough(jid: number): void;
    /** From the entry `jid` on, entries are numbered under `writer` from `seq`. */
    number(numbering: ProcessFsNumbering): void;
    /** The numberings that cover entries held, oldest first. */
    numberings(): ProcessFsNumbering[];
    /** Data bytes held. */
    readonly bytes: number;
}
/** The SqlStorage a Durable Object (a process's facet) has: exec answers its rows. */
export interface JournalSql {
    exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
}
/**
 * The journal in a process's own SQLite. Two tables: the entries (one row
 * each, deleted once answered) and the numberings (one row per writer
 * epoch). A facet that restarts after a crash opens the same tables, and the
 * entries it finds are what its process left unanswered.
 */
export declare function sqlJournal(sql: JournalSql): ProcessFsJournal;
/** The journal in the process's heap: for a process with no storage of its own, it dies with it. */
export declare function memoryJournal(): ProcessFsJournal;
//# sourceMappingURL=process-fs-journal.d.ts.map