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
import { ownValue, reflectApply, reflectDeleteProperty, reflectGet, stringIncludes, stringSlice, stringStartsWith } from '../../_shared/primordials.js';
/** Whether `key` is a home directory itself (`home/<name>`, root's `root`): never held, so the editor and shell there recall nothing. */
export function isHomeDirectory(key) {
    return key === 'root' || (stringStartsWith(key, 'home/') && key.length > 'home/'.length && !stringIncludes(stringSlice(key, 'home/'.length), '/'));
}
/**
 * The process's filesystem over `supervisor` (an RPC stub, or one already
 * answering) and its store's `view`.
 */
export function processFilesystem(supervisor, view, options = {}) {
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
            ? { readDirectories: (request) => reflectApply(reflectGet(directories, 'fsReadDirectories'), directories, [request]) } : {}),
        ...(journalSql === undefined ? {} : { journal: sqlJournal(journalSql) }),
    });
}
