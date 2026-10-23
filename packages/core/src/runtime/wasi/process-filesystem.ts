/**
 * The resident filesystem a process runs on, over its supervisor: one
 * construction for every runtime that has one (a WASI guest's, a node
 * program's). The session's filesystem answers what the process does not
 * hold (supervisorFilesystem), its client sends what the process decides
 * (supervisorSession), and its store's view (`view`) answers the rest.
 */
import { sqlJournal, type JournalSql } from '../../_shared/process-fs-journal.js';
import { answeringSupervisor, supervisorFilesystem, supervisorSession } from '../vfs-supervisor.js';
import type { WasiSupervisorStub } from './types.js';
import { residentFilesystem, type ResidentDelegation, type ResidentFilesystem, type ResidentNamespace } from './resident-filesystem.js';
import { ownValue, reflectApply, reflectDeleteProperty, reflectGet, stringIncludes, stringSlice, stringStartsWith } from '../../_shared/primordials.js';

/** What a runtime gives the process's filesystem beyond its supervisor and view. */
export type ProcessFilesystemOptions = Omit<ResidentDelegation, 'session' | 'journal' | 'readDirectories' | 'isHomeRoot'> & {
  /** The process's own store, where it has one (a resident's facet): its write log (process-fs-journal.ts). */
  readonly journalSql?: JournalSql;
  /** False for a process that cannot answer a recall (a runner, between its calls): it holds no subtree. */
  readonly holdsGrants?: boolean;
};

/** Whether `key` is a home directory itself (`home/<name>`, root's `root`): never held, so the editor and shell there recall nothing. */
export function isHomeDirectory(key: string): boolean {
  return key === 'root' || (stringStartsWith(key, 'home/') && key.length > 'home/'.length && !stringIncludes(stringSlice(key, 'home/'.length), '/'));
}

/**
 * The process's filesystem over `supervisor` (an RPC stub, or one already
 * answering) and its store's `view`.
 */
export function processFilesystem(supervisor: WasiSupervisorStub, view: ResidentNamespace, options: ProcessFilesystemOptions = {}): ResidentFilesystem {
  const authority = supervisorFilesystem(supervisor);
  const journalSql = ownValue(options, 'journalSql');
  const holdsGrants = ownValue(options, 'holdsGrants');
  const { ...delegation } = options;
  reflectDeleteProperty(delegation, 'journalSql');
  reflectDeleteProperty(delegation, 'holdsGrants');
  // Its refusals rethrown as the errors they are, as the authority's are.
  const directories = answeringSupervisor(supervisor);
  return residentFilesystem(authority, view, {
    ...delegation,
    session: supervisorSession(supervisor, authority, undefined, holdsGrants !== false),
    isHomeRoot: isHomeDirectory,
    ...(typeof reflectGet(directories, 'fsReadDirectories') === 'function'
      ? { readDirectories: (request) => reflectApply(reflectGet(directories, 'fsReadDirectories') as Function, directories, [request]) } : {}),
    ...(journalSql === undefined ? {} : { journal: sqlJournal(journalSql) }),
  });
}
