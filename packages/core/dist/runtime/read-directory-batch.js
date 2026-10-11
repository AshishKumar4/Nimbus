/**
 * Read-only directory prefetch is an account of real descriptions, not
 * another descriptor table. All I/O uses the process's existing bridge;
 * its DescriptorScope remains the only owner, including on release/kill.
 */
import { z } from 'zod';
import { RuntimeFsPathSchema } from './filesystem-path.js';
import { withRecall } from '../vfs/recall.js';
import { DIRECTORY_PREFETCH_LIMIT, DIRECTORY_BATCH_LIMIT } from '../constants.js';
export const DIRECTORY_READ_RPC = 'fsReadDirectories';
const Ids = z.array(z.number().int().nonnegative()).max(DIRECTORY_PREFETCH_LIMIT);
const Request = z.object({
    channel: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    epoch: z.string().nullable(),
    cursor: z.number().int().nonnegative(),
    open: z.array(RuntimeFsPathSchema).max(DIRECTORY_BATCH_LIMIT),
    retire: Ids,
    claim: Ids,
    lease: z.boolean(),
});
const scopes = new WeakMap();
const bridges = new WeakMap();
/** Called only by ProcessFiles where each face is bound to its actual descriptor scope. */
export function registerDirectoryReadBridge(fs, scope, place) {
    let budget = scopes.get(scope);
    if (!budget) {
        budget = { ended: false, reserved: 0, channels: new Map(), tracked: new Map(), tail: Promise.resolve() };
        scopes.set(scope, budget);
    }
    bridges.set(fs, { scope, budget, place });
}
/** A normal close also retires a prefetched handle's accounting. */
export function directoryReadHandleClosed(scope, id) { scopes.get(scope)?.tracked.delete(id); }
/** The authoritative scope closes descriptions; drop accounting at that same lifetime boundary. */
export function disposeDirectoryReadScope(scope) {
    const budget = scopes.get(scope);
    if (!budget)
        return;
    budget.ended = true;
    budget.channels.clear();
    budget.tracked.clear();
    scopes.delete(scope);
}
export function hasDirectoryReadBridge(fs) { return bridges.has(fs); }
function refusal(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }
function codeOf(error) { return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined; }
const SPECULATIVE_REFUSALS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENXIO', 'ESTALE']);
/**
 * Must be delivered once. Its cached answer keeps the ORIGINAL client's
 * ask time: replaying it never renews lease trust. IDs from an abandoned
 * answer remain charged until a later channel exchange or scope teardown.
 */
export async function readDirectoryBatch(fs, input) {
    const request = Request.parse(input);
    const bound = bridges.get(fs);
    if (!bound)
        throw refusal('ENOTSUP', 'directory prefetch needs a process descriptor scope');
    const { budget, scope } = bound;
    const live = () => { if (scope.closed || budget.ended)
        throw refusal('ESTALE', 'directory descriptor scope ended'); };
    const run = async () => {
        live();
        let channel = budget.channels.get(request.channel);
        if (!channel) {
            // A late request from a rewound run cannot close reused descriptor numbers.
            // A close-only, id-free recovery can also establish a channel when
            // its first request never arrived. A late first request is then
            // superseded, and cannot allocate after that recovery acknowledged.
            if (request.retire.length || request.claim.length || (request.sequence !== 1 && request.open.length > 0))
                throw refusal('ESTALE', 'unknown directory prefetch channel');
            if (budget.channels.size >= DIRECTORY_PREFETCH_LIMIT)
                throw refusal('ENOSPC', 'too many directory prefetch channels');
            channel = { sequence: 0 };
            budget.channels.set(request.channel, channel);
        }
        if (request.sequence <= channel.sequence)
            throw refusal('ESTALE', 'directory batch was already superseded');
        channel.sequence = request.sequence;
        const close = async (id) => {
            try {
                await withRecall(() => fs.close(id));
            }
            catch (error) {
                if (codeOf(error) !== 'EBADF')
                    throw error;
            }
            budget.tracked.delete(id);
        };
        // Close acknowledgements are idempotent. Process every retirement even
        // if another close reported a failure, then report that failure.
        const closeErrors = [];
        for (const id of request.retire) {
            try {
                await close(id);
            }
            catch (error) {
                closeErrors.push(error);
            }
        }
        for (const id of request.claim) {
            const record = budget.tracked.get(id);
            if (record?.channel === request.channel)
                record.claimed = true;
        }
        // Advancing the channel abandons unused entries from its older answer.
        // Already guest-owned descriptions stay open through recall/rename/unlink.
        for (const [id, record] of [...budget.tracked]) {
            if (record.channel === request.channel && !record.claimed) {
                try {
                    await close(id);
                }
                catch (error) {
                    closeErrors.push(error);
                }
            }
        }
        if (closeErrors.length)
            throw closeErrors[0];
        live();
        const opened = [];
        try {
            for (const path of request.open) {
                // Includes reservations for opens awaiting their backend, claimed
                // descriptions and descriptions closed locally but not yet retired.
                if (budget.tracked.size + budget.reserved >= DIRECTORY_PREFETCH_LIMIT)
                    break;
                budget.reserved++;
                let handle;
                try {
                    const before = await withRecall(() => fs.stat(path));
                    handle = await withRecall(() => fs.open(path, { read: true, directory: true, followSymlinks: true }));
                    live();
                    const stat = await withRecall(() => fs.fstat(handle.id));
                    let key;
                    try {
                        key = await withRecall(() => bound.place(path, handle));
                    }
                    catch (error) {
                        if (!SPECULATIVE_REFUSALS.has(String(codeOf(error))))
                            throw error;
                        key = null;
                    }
                    live();
                    if (key === null && opened.length > 0) {
                        await close(handle.id);
                        continue;
                    }
                    budget.tracked.set(handle.id, { channel: request.channel, claimed: false });
                    opened.push({ key, handle, dev: stat.dev, ino: stat.ino,
                        openedRevision: before?.dev === stat.dev && before.ino === stat.ino ? before.revision : null });
                }
                catch (error) {
                    if (handle) {
                        try {
                            await close(handle.id);
                        }
                        catch { }
                    }
                    live();
                    if (opened.length === 0 || !SPECULATIVE_REFUSALS.has(String(codeOf(error))))
                        throw error;
                }
                finally {
                    budget.reserved--;
                }
            }
            live();
            const acquire = await withRecall(() => fs.acquire(request.epoch, request.cursor, { namespace: true, lease: request.lease }));
            live();
            return { channel: request.channel, sequence: request.sequence, opened, acquire,
                retired: [...request.retire], claimed: [...request.claim], outstanding: budget.tracked.size + budget.reserved };
        }
        catch (error) {
            for (const entry of opened) {
                try {
                    await close(entry.handle.id);
                }
                catch { }
            }
            throw error;
        }
    };
    const result = budget.tail.then(run);
    budget.tail = result.then(() => { }, () => { });
    return result;
}
