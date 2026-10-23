/**
 * The resident filesystem a process runs on, over its supervisor: one
 * construction for every runtime that has one (a WASI guest's, a node
 * program's). The session's filesystem answers what the process does not
 * hold (supervisorFilesystem), its client sends what the process decides
 * (supervisorSession), and its store's view (`view`) answers the rest.
 */
import { type JournalSql } from '../../_shared/process-fs-journal.js';
import type { WasiSupervisorStub } from './types.js';
import { type ResidentDelegation, type ResidentFilesystem, type ResidentNamespace } from './resident-filesystem.js';
/** What a runtime gives the process's filesystem beyond its supervisor and view. */
export type ProcessFilesystemOptions = Omit<ResidentDelegation, 'session' | 'journal' | 'readDirectories' | 'isHomeRoot'> & {
    /** The process's own store, where it has one (a resident's facet): its write log (process-fs-journal.ts). */
    readonly journalSql?: JournalSql;
};
/** Whether `key` is a home directory itself (`home/<name>`, root's `root`): never held, so the editor and shell there recall nothing. */
export declare function isHomeDirectory(key: string): boolean;
/**
 * The process's filesystem over `supervisor` (an RPC stub, or one already
 * answering) and its store's `view`.
 */
export declare function processFilesystem(supervisor: WasiSupervisorStub, view: ResidentNamespace, options?: ProcessFilesystemOptions): ResidentFilesystem;
//# sourceMappingURL=process-filesystem.d.ts.map