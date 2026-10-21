/**
 * Read-only directory prefetch is an account of real descriptions, not
 * another descriptor table. All I/O uses the process's existing bridge;
 * its DescriptorScope remains the only owner, including on release/kill.
 */
import { z } from 'zod';
import { RuntimeFsPathSchema } from './filesystem-path.js';
import { FeedPositionSchema } from './feed-position-schema.js';
import { withRecall } from '../vfs/recall.js';
import { DIRECTORY_PREFETCH_LIMIT, DIRECTORY_BATCH_LIMIT, DIRECTORY_SEQUENCE_WINDOW } from '../constants.js';
export const DIRECTORY_READ_RPC = 'fsReadDirectories';
const Ids = z.array(z.number().int().nonnegative()).max(DIRECTORY_PREFETCH_LIMIT);
const Request = z.object({
    channel: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    position: FeedPositionSchema.nullable(),
    open: z.array(RuntimeFsPathSchema).max(DIRECTORY_BATCH_LIMIT),
    retire: Ids,
    claim: Ids,
    lease: z.boolean(),
    /**
     * The run's last exchange on the channel: what it retires is closed, and
     * so is every other description of the channel, and the channel is gone.
     * A shell's commands share its pid and descriptor scope, which would
     * otherwise keep each run's channel until the shell ends.
     */
    end: z.boolean().optional(),
});
const scopes = new WeakMap();
const bridges = new WeakMap();
/** Called only by ProcessFiles where each face is bound to its actual descriptor scope. */
export function registerDirectoryReadBridge(fs, scope, place) {
    bridges.set(fs, { scope, place });
}
/** A normal close also retires a prefetched handle's accounting. */
export function directoryReadHandleClosed(scope, id) { scopes.get(scope)?.tracked.delete(id); }
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
    const { scope } = bound;
    if (scope.closed)
        throw refusal('ESTALE', 'directory descriptor scope ended');
    let budget = scopes.get(scope);
    if (budget === undefined) {
        const created = { ended: false, reserved: 0, channels: new Map(), endedChannels: new Map(), tracked: new Map(), tail: Promise.resolve() };
        scopes.set(scope, created);
        // The scope closes its descriptions; the account ends on the same release, before the scope is marked closed.
        scope.subscriptions.add(() => {
            created.ended = true;
            created.channels.clear();
            created.endedChannels.clear();
            created.tracked.clear();
            scopes.delete(scope);
        });
        budget = created;
    }
    const live = () => { if (scope.closed || budget.ended)
        throw refusal('ESTALE', 'directory descriptor scope ended'); };
    const run = async () => {
        live();
        const outstanding = budget.endedChannels.get(request.channel);
        if (outstanding !== undefined) {
            outstanding.delete(request.sequence);
            if (outstanding.size === 0)
                budget.endedChannels.delete(request.channel);
            throw refusal('ESTALE', 'directory prefetch channel ended');
        }
        let channel = budget.channels.get(request.channel);
        if (!channel) {
            // A late request from a rewound run cannot close reused descriptor numbers.
            // A close-only, id-free recovery can also establish a channel when
            // its first request never arrived. A late first request is then
            // superseded, and cannot allocate after that recovery acknowledged.
            if (request.retire.length || request.claim.length || (request.sequence !== 1 && request.open.length > 0))
                throw refusal('ESTALE', 'unknown directory prefetch channel');
            if (budget.channels.size + budget.endedChannels.size >= DIRECTORY_PREFETCH_LIMIT)
                throw refusal('ENOSPC', 'too many directory prefetch channels');
            if (request.sequence > DIRECTORY_SEQUENCE_WINDOW)
                throw refusal('ESTALE', 'directory batch numbered past the channel\'s window');
            channel = { sequence: 0, missing: 1, ahead: new Set() };
            budget.channels.set(request.channel, channel);
        }
        if (request.sequence >= channel.missing + DIRECTORY_SEQUENCE_WINDOW)
            throw refusal('ESTALE', 'directory batch numbered past the channel\'s window');
        if (request.sequence === channel.missing) {
            channel.missing++;
            while (channel.ahead.delete(channel.missing))
                channel.missing++;
        }
        else if (request.sequence > channel.missing)
            channel.ahead.add(request.sequence);
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
        if (request.end === true) {
            for (const [id, record] of [...budget.tracked]) {
                if (record.channel === request.channel) {
                    try {
                        await close(id);
                    }
                    catch (error) {
                        closeErrors.push(error);
                    }
                }
            }
            budget.channels.delete(request.channel);
            // The run's requests are numbered from 1 without gaps: those that have
            // not arrived (within the window) are refused when they do.
            const missing = new Set();
            for (let sequence = channel.missing; sequence < request.sequence; sequence++)
                if (!channel.ahead.has(sequence))
                    missing.add(sequence);
            if (missing.size > 0)
                budget.endedChannels.set(request.channel, missing);
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
                    // The open answers its stat (RuntimeOpenedFile); the description carries the handle alone.
                    const { stat, ...bare } = await withRecall(() => fs.open(path, { read: true, directory: true, followSymlinks: true }));
                    handle = bare;
                    live();
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
                        opened: before?.dev === stat.dev && before.ino === stat.ino
                            ? { mode: before.mode ?? 0, uid: before.uid ?? 0, gid: before.gid ?? 0, ctime: before.ctime ?? 0 } : null });
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
            const acquire = await withRecall(() => fs.acquire(request.position, { namespace: true, lease: request.lease }));
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
