/**
 * The resident filesystem a process runs on, over its supervisor: one
 * construction for every runtime that has one (a WASI guest's, a node
 * program's). The session's filesystem answers what the process does not
 * hold (supervisorFilesystem), its client sends what the process decides
 * (supervisorSession), and its store's view (`view`) answers the rest.
 */
import { sqlJournal } from '../../_shared/process-fs-journal.js';
import { answeringSupervisor, supervisorFilesystem, supervisorSession } from '../vfs-supervisor.js';
import { residentFilesystem } from './resident-filesystem.js';
/** Whether `key` is a home directory itself (`home/<name>`, root's `root`): never held, so the editor and shell there recall nothing. */
export function isHomeDirectory(key) {
    return key === 'root' || (key.startsWith('home/') && key.length > 'home/'.length && !key.slice('home/'.length).includes('/'));
}
/**
 * The process's filesystem over `supervisor` (an RPC stub, or one already
 * answering) and its store's `view`.
 */
export function processFilesystem(supervisor, view, options = {}) {
    const authority = supervisorFilesystem(supervisor);
    const { journalSql, holdsGrants, ...delegation } = options;
    // Its refusals rethrown as the errors they are, as the authority's are.
    const directories = answeringSupervisor(supervisor);
    return residentFilesystem(authority, view, {
        ...delegation,
        session: supervisorSession(supervisor, authority, undefined, holdsGrants !== false),
        isHomeRoot: isHomeDirectory,
        ...(typeof directories.fsReadDirectories === 'function' ? { readDirectories: (request) => directories.fsReadDirectories(request) } : {}),
        ...(journalSql === undefined ? {} : { journal: sqlJournal(journalSql) }),
    });
}
