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

export class NimbusFsJournalReader extends DurableObject {
  private journal() {
    return sqlJournal(this.ctx.storage.sql);
  }

  numberings(): ProcessFsNumbering[] {
    return this.journal().numberings();
  }

  number(numbering: ProcessFsNumbering): void {
    this.journal().number(numbering);
  }

  readAfter(after: number, maxBytes: number): ReturnType<ReturnType<typeof sqlJournal>['readAfter']> {
    return this.journal().readAfter(after, maxBytes);
  }

  dropThrough(jid: number): void {
    this.journal().dropThrough(jid);
  }
}

export default {
  fetch(): Response {
    return new Response('nimbus fs journal reader');
  },
};
