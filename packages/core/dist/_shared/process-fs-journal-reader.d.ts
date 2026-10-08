/**
 * process-fs-journal-reader.ts — the class a process's facet is opened with,
 * once the process is gone, to hand its write log to the session's drain
 * (process-fs-journal.ts, drainProcessFsJournal).
 *
 * The facet's SQLite outlives its isolate (killed, out of memory, out of CPU),
 * and opening the facet again with this class reads the same store. Bundled
 * by the worker's bundle-facet-workers into PROCESS_FS_JOURNAL_READER_SOURCE,
 * the module the session loads (LOADER.load) for it: the same sqlJournal the
 * process wrote through, so the two never disagree about the tables.
 */
import { DurableObject } from 'cloudflare:workers';
import { sqlJournal, type ProcessFsNumbering } from './process-fs-journal.js';
export declare class NimbusFsJournalReader extends DurableObject {
    private journal;
    numberings(): ProcessFsNumbering[];
    number(numbering: ProcessFsNumbering): void;
    readAfter(after: number, maxBytes: number): ReturnType<ReturnType<typeof sqlJournal>['readAfter']>;
    dropThrough(jid: number): void;
}
declare const _default: {
    fetch(): Response;
};
export default _default;
//# sourceMappingURL=process-fs-journal-reader.d.ts.map