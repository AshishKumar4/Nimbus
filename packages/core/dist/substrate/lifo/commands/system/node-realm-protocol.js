import { isEgressGuestEvent, isEgressHostEvent } from '../../../../runtime/realm-egress.js';
// ── The protocol's messages, narrowed where they arrive ─────────────────────
// Each side receives a structured clone it must narrow: a guard per shape.
export const record = (value) => typeof value === 'object' && value !== null;
const stringRecord = (value) => record(value) && Object.values(value).every((entry) => typeof entry === 'string');
const isOutputSource = (value) => value === 'stream' || value === 'console';
const isResponse = (value) => value === null || (record(value) && typeof value.status === 'number' && stringRecord(value.headers)
    && (typeof value.body === 'string' || value.body instanceof Uint8Array));
export function isGuestEvent(value) {
    if (isEgressGuestEvent(value))
        return true;
    if (!record(value))
        return false;
    switch (value.type) {
        case 'output': return (value.fd === 1 || value.fd === 2) && isOutputSource(value.source) && Number.isSafeInteger(value.writer) && (typeof value.data === 'string' || value.data instanceof Uint8Array);
        case 'settle': return Number.isSafeInteger(value.upTo);
        case 'settle-mark': return Number.isSafeInteger(value.round) && Number.isSafeInteger(value.after);
        case 'fetch':
            return Number.isSafeInteger(value.id) && Number.isSafeInteger(value.port) && typeof value.url === 'string'
                && typeof value.method === 'string' && stringRecord(value.headers)
                && (value.body === null || typeof value.body === 'string' || value.body instanceof Uint8Array);
        case 'served': return Number.isSafeInteger(value.id) && isResponse(value.response);
        case 'exit': return Number.isSafeInteger(value.code) && typeof value.ended === 'boolean';
        case 'heard': return (value.fd === 1 || value.fd === 2) && Number.isSafeInteger(value.writer);
        case 'stdin-read':
        case 'stdin-cancel': return Number.isSafeInteger(value.id);
        default: return false;
    }
}
export function isOutputFailures(value) {
    return Array.isArray(value) && value.every((failure) => record(failure) && Number.isSafeInteger(failure.seq) && (failure.fd === 1 || failure.fd === 2)
        && typeof failure.code === 'string' && typeof failure.pipe === 'boolean' && isOutputSource(failure.source) && Number.isSafeInteger(failure.writer));
}
export function isHostEvent(value) {
    if (isEgressHostEvent(value))
        return true;
    if (!record(value))
        return false;
    switch (value.type) {
        case 'fetched': return typeof value.id === 'number' && isResponse(value.response);
        case 'serve': return typeof value.id === 'number' && typeof value.port === 'number' && record(value.request);
        case 'changed':
            return Number.isSafeInteger(value.id) && record(value.event)
                && (value.event.type === 'add' || value.event.type === 'change' || value.event.type === 'unlink'
                    || value.event.type === 'addDir' || value.event.type === 'unlinkDir' || value.event.type === 'rename')
                && typeof value.event.path === 'string'
                && (value.event.oldPath === undefined || typeof value.event.oldPath === 'string')
                && typeof value.event.timestamp === 'number';
        case 'output-failed':
            return Number.isSafeInteger(value.seq) && (value.fd === 1 || value.fd === 2) && typeof value.code === 'string' && typeof value.pipe === 'boolean' && isOutputSource(value.source) && Number.isSafeInteger(value.writer);
        case 'output-settled': return Number.isSafeInteger(value.seq);
        case 'stdin':
            return Number.isSafeInteger(value.id) && (value.data === null || value.data instanceof Uint8Array || value.withdrawn === true
                || (record(value.error) && typeof value.error.name === 'string' && typeof value.error.message === 'string' && record(value.error.properties)));
        default: return false;
    }
}
const identityId = (value) => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
export function isNodeRealmPayload(value) {
    if (!record(value) || !record(value.program) || typeof value.program.source !== 'string')
        return false;
    const identity = value.program.identity;
    return record(identity) && identityId(identity.pid) && identityId(identity.uid) && identityId(identity.gid) && identityId(identity.umask)
        && Array.isArray(identity.groups) && identity.groups.every(identityId)
        && (value.hosts === undefined || typeof value.hosts === 'string') && typeof value.egress === 'boolean';
}
export function isStat(value) {
    return record(value) && typeof value.type === 'string' && typeof value.mode === 'number' && typeof value.size === 'number';
}
export function isDirEntries(value) {
    return Array.isArray(value) && value.every((entry) => record(entry) && typeof entry.name === 'string' && typeof entry.type === 'string');
}
