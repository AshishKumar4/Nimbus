/**
 * Delegations, the session's half of the protocol (spike/delegation/MEMO.md):
 * a process holds a subtree as a recallable exclusive-mutation lease
 * (SqliteVFS, ExclusiveMutationOptions.delegation), decides its operations
 * itself, and sends them later as writes under the lease. When another
 * caller's access needs them, the engine recalls the delegation; this is
 * where that recall reaches the holder and where its answer comes back.
 *
 * The holder keeps one recall request outstanding (awaitRecall, a long poll
 * answered with the next recall, or with nothing after `waitMs`). A recall
 * asks it to send what it decided and then either keep sending each
 * operation as it decides it ('share': another caller reads the subtree) or
 * give the subtree up ('revoke': another caller writes it); the holder says
 * it has (recalled). A holder that has not answered within the recall
 * timeout is revoked anyway: its lease ends, so every write it sends later
 * is ESTALE (the lease is the fence), `revoked` is told so the host can stop
 * it, and the caller that recalled it goes on. What it had not sent is lost,
 * as a process's unflushed writes are when it dies: no one observed them.
 *
 * A delegation ends with its holder: releasing the process's scope releases
 * it (its subscriptions are the scope's to dispose).
 */
import { pathsOverlap } from '../vfs/path.js';
/**
 * How long a holder has to answer a recall (T): send what it decided and
 * say so. A holder making syscalls answers within one recall round trip and
 * one wave's flush; one that has not answered by then is taken to be unable
 * to (a long computation with nothing sent, the documented limit), and is
 * revoked. See the core README's process model for its measurement.
 */
export const DELEGATION_RECALL_TIMEOUT_MS = 5_000;
/**
 * The session's own stores (engine keys): a process may not hold them, so
 * the session's synchronous use of them (durable launch images, inline wasm
 * images, staged bindings) never meets a delegation. A subtree at or above
 * one is not delegated (EPERM).
 */
export const SESSION_KERNEL_ROOTS = ['.nimbus', 'var/lib/nimbus'];
/** How long one awaitRecall waits before it answers that nothing is asked (the holder asks again). */
export const DELEGATION_RECALL_POLL_MS = 25_000;
const NONE = new Set();
export class Delegations {
    options;
    held = new Map();
    /** Each holder's leases. */
    byPid = new Map();
    recallTimeoutMs;
    constructor(options) {
        this.options = options;
        this.recallTimeoutMs = options.recallTimeoutMs ?? DELEGATION_RECALL_TIMEOUT_MS;
    }
    /**
     * Delegate to process `pid`: `acquire` takes the lease with the terms this
     * makes (the process's own bridge, so its path and permission are checked
     * as any lease's). `scope` disposes of it when the process ends.
     */
    grant(pid, reads, acquire, scope) {
        let held = null;
        const terms = {
            reads,
            admit: (root) => {
                const kernelRoot = SESSION_KERNEL_ROOTS.find((store) => pathsOverlap(root, store));
                if (kernelRoot !== undefined) {
                    throw Object.assign(new Error(`EPERM: /${root} holds the session's own /${kernelRoot}; it is not delegated`), { code: 'EPERM' });
                }
            },
            recall: (kind) => {
                if (held === null || this.held.get(held.owner) !== held)
                    return Promise.resolve();
                return this.recall(held, kind);
            },
        };
        const lease = acquire(terms);
        const end = () => {
            if (this.held.get(lease.owner) !== held)
                return;
            this.forget(held);
            if (held.pending !== null) {
                held.pending.cancel();
                held.pending.done();
            }
            this.options.release(lease.owner);
        };
        held = { pid, owner: lease.owner, root: lease.root, asked: [], waiter: null, pending: null, end, scope };
        this.held.set(lease.owner, held);
        let owned = this.byPid.get(pid);
        if (owned === undefined)
            this.byPid.set(pid, owned = new Set());
        owned.add(lease.owner);
        scope.subscriptions.add(end);
        return { root: lease.root, owner: lease.owner, recallTimeoutMs: this.recallTimeoutMs };
    }
    /** The next recall of `owner`'s delegation, as soon as one is asked; null after `waitMs` with none, or once it has ended. */
    awaitRecall(pid, owner, waitMs = DELEGATION_RECALL_POLL_MS) {
        const held = this.holderOf(pid, owner);
        const asked = held.asked.shift();
        if (asked !== undefined)
            return Promise.resolve(asked);
        held.waiter?.(null);
        // The executor form: core's TypeScript lib (ES2022) has no Promise.withResolvers.
        return new Promise((resolve) => {
            const answer = (kind) => {
                clearTimeout(timer);
                if (held.waiter === answer)
                    held.waiter = null;
                resolve(kind);
            };
            const timer = setTimeout(() => answer(null), Math.max(0, waitMs));
            held.waiter = answer;
        });
    }
    /** The holder has sent what it decided, and done what recall `kind` asked. */
    recalled(pid, owner, kind) {
        const held = this.holderOf(pid, owner);
        const pending = held.pending;
        if (pending === null || pending.kind !== kind)
            return;
        held.pending = null;
        pending.cancel();
        pending.done();
        // Revoked: the engine ends the lease; this forgets it.
        if (kind === 'revoke')
            this.forget(held);
    }
    /** The holder gives the delegation up (what it decided is sent). */
    release(pid, owner) {
        this.holderOf(pid, owner).end();
    }
    /** Whether `owner` is a delegation `pid` holds (its lease is released here, not by a plain release). */
    holds(pid, owner) {
        return this.held.get(owner)?.pid === pid;
    }
    /** The leases of every delegation `pid` holds: what its own calls are made by. */
    heldBy(pid) {
        return this.byPid.get(pid) ?? NONE;
    }
    get size() {
        return this.held.size;
    }
    recall(held, kind) {
        let resolve;
        const promise = new Promise((settle) => { resolve = settle; });
        const timer = setTimeout(() => {
            // Unanswered: revoked, its lease ended (its later writes are ESTALE),
            // and the caller that recalled it goes on.
            held.pending = null;
            held.end();
            this.options.revoked?.({ pid: held.pid, root: held.root, kind, reason: `no answer to a ${kind} recall within ${this.recallTimeoutMs} ms` });
            resolve();
        }, this.recallTimeoutMs);
        held.pending = { kind, done: resolve, cancel: () => clearTimeout(timer) };
        if (held.waiter !== null)
            held.waiter(kind);
        else
            held.asked.push(kind);
        return promise;
    }
    forget(held) {
        if (this.held.get(held.owner) !== held)
            return;
        this.held.delete(held.owner);
        const owned = this.byPid.get(held.pid);
        owned?.delete(held.owner);
        if (owned?.size === 0)
            this.byPid.delete(held.pid);
        held.scope.subscriptions.delete(held.end);
        held.waiter?.(null);
    }
    holderOf(pid, owner) {
        const held = this.held.get(owner);
        if (held === undefined || held.pid !== pid) {
            throw Object.assign(new Error('ESTALE: no delegation of this process under that lease'), { code: 'ESTALE' });
        }
        return held;
    }
}
