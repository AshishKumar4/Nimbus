/**
 * N18: the session's storage ledger admits a process store's growth before
 * it happens. The supervisor grants an allowance (the ledger records it under
 * the facet's name); the store never grows its database past the cap, and
 * asks for more, asynchronously, when it would. What does not fit is not
 * held: a fill degrades to reads through the session, and an own write goes
 * to the session only. A null cap: no ledger (no cap).
 *
 * A one-shot's heap (store.bindInMemory) is one fixed budget: its tables, the
 * own writes held beside them, the namespace's overlay and reserve, and what
 * a WASI process pins, all count against the same cap, and there is no one
 * to ask for more.
 */
import { residentBytes, residentCellCost } from './cell-cost.js';
import { SafeMap } from '@nimbus-sh/core/_shared/primordials.js';
export function createAdmission(coherence) {
    let cap = null;
    let facet = null;
    let supervisor = null;
    let grantAsk = null;
    let inHeap = false;
    let heldBytes = 0;
    let namespaceOverlayBytes = 0;
    let namespaceReserveBytes = 0;
    /**
     * Heap a WASI process holds outside the tables, charged to the same budget:
     * file bytes a descriptor keeps for its lifetime, and writes held for the
     * session (core runtime/wasi/resident-filesystem.ts). pin refuses what does
     * not fit, and the caller then reads through the session instead.
     */
    let pinnedBytes = 0;
    let available = null;
    /**
     * Room promised to fills in flight. A fault-in asks for its file's room
     * before the bytes arrive (reserve), and the room is its own until the put
     * that lands them spends it (store.put) or the fill gives it up (release).
     * Every other fit counts it as taken: a grant measured against the database
     * alone went to whichever of a batch of fills landed first, and the rest
     * were refused.
     */
    // A SafeMap: a fill's settle releases its reservation, after the program may have replaced Map's methods.
    const reservations = new SafeMap();
    let reservedBytes = 0;
    /**
     * Reservations waiting for room, in the order they were asked for. Room that
     * comes is held for them in that order as it comes, and one ask covers what
     * they all still need: when each ask was for its asker's own room, and a
     * waiter that saw room free took it without holding it, a grant served one
     * fill of a batch, and the batch's tail gave up with the ledger granting
     * every byte asked (astro dev: a hundred of zod's locales at once).
     */
    const reserveQueue = [];
    let reserveServing = false;
    const tablesBytes = () => coherence.tables('a storage measure').bytes();
    const dbBytes = () => tablesBytes()
        + (inHeap ? heldBytes + namespaceOverlayBytes + namespaceReserveBytes + pinnedBytes : 0);
    const refusal = (total) => (inHeap && cap !== null && total > cap
        ? 'namespace storage budget exceeded (' + cap + ' bytes)' : null);
    /** Hold room for `path` if `bytes` fit now: true once it is held. */
    const holdRoom = (path, bytes) => {
        if (dbBytes() + reservedBytes + bytes > cap)
            return false;
        // A second fill of the path in line holds the room the first held, not twice it.
        release(path);
        reservations.set(path, bytes);
        reservedBytes += bytes;
        return true;
    };
    /**
     * The waiting reservations' one asker. It holds room for those that fit, in
     * order, then asks the ledger for what the rest need, until none waits. An
     * ask that raises the cap not at all is the ledger's refusal (it admits a
     * fill whole or not at all): the reservations still waiting are refused, and
     * their fills are not fetched. Rounds whose room others took are bounded.
     */
    const serveReserves = async () => {
        if (reserveServing)
            return;
        reserveServing = true;
        try {
            for (let idle = 0;;) {
                const waiting = reserveQueue.length;
                while (reserveQueue.length > 0 && holdRoom(reserveQueue[0].path, reserveQueue[0].bytes)) {
                    reserveQueue.shift().resolve(true);
                }
                if (reserveQueue.length === 0)
                    return;
                idle = reserveQueue.length < waiting ? 0 : idle + 1;
                const before = cap;
                if (idle <= 8) {
                    let need = 0;
                    for (const reservation of reserveQueue)
                        need += reservation.bytes;
                    await askGrant(need);
                }
                if (cap === before) {
                    for (const reservation of reserveQueue.splice(0))
                        reservation.resolve(false);
                    return;
                }
            }
        }
        finally {
            reserveServing = false;
        }
    };
    /** Give up the room reserved for `path`, if any. */
    const release = (path) => {
        const bytes = reservations.get(path);
        if (bytes === undefined)
            return;
        reservations.delete(path);
        reservedBytes -= bytes;
    };
    /**
     * Ask the ledger for `bytes` more, reporting what the database measures.
     * Exactly what is needed: room granted and unused is room the session's own
     * writes cannot have. Resolves to whether `bytes` now fit.
     */
    const askGrant = (bytes) => {
        const asked = supervisor;
        if (cap === null)
            return Promise.resolve(true);
        // A store with no ledger row (a one-shot's heap) has a fixed budget: no one to ask.
        if (facet === null || !asked || typeof asked.fsStorageGrant !== 'function')
            return Promise.resolve(false);
        // Another ask is out: wait for it, and ask for this one's room after it if
        // that grant did not cover it too. Giving up there left all but the first
        // of a batch of fills at the cap refused.
        if (grantAsk) {
            return grantAsk.then(() => dbBytes() + reservedBytes + bytes <= cap || askGrant(bytes));
        }
        const want = Math.max(0, dbBytes() + reservedBytes + bytes - cap);
        const named = facet;
        grantAsk = (async () => {
            try {
                const answer = await asked.fsStorageGrant(named, want, dbBytes());
                cap += Number(answer && answer.granted) || 0;
                if (answer && typeof answer.available === 'number')
                    available = answer.available;
            }
            catch { }
        })().finally(() => { grantAsk = null; });
        return grantAsk.then(() => dbBytes() + reservedBytes + bytes <= cap);
    };
    /**
     * Whether the store may grow by `bytes` now; when not, and `ask`, more room
     * is asked for. A copy of an own write never asks: the session's copy is the
     * one that must have the room, and the cache must not take it first.
     */
    const fits = (bytes, ask = true) => {
        if (cap === null)
            return true;
        if (dbBytes() + reservedBytes + bytes <= cap)
            return true;
        if (ask)
            void askGrant(bytes);
        return false;
    };
    /** Room for `bytes` before an asynchronous fill writes them: true when they fit. */
    const ensureRoom = async (bytes) => {
        if (cap === null || dbBytes() + reservedBytes + bytes <= cap)
            return true;
        return askGrant(bytes);
    };
    return {
        get inHeap() { return inHeap; },
        get cap() { return cap; },
        dbBytes,
        bindHeap(budget) {
            inHeap = true;
            facet = null;
            cap = Number(budget);
            namespaceOverlayBytes = 0;
            namespaceReserveBytes = 0;
            pinnedBytes = 0;
        },
        setStorage(storage, given) {
            supervisor = given || null;
            const allowance = storage;
            available = allowance && typeof allowance.available === 'number' ? allowance.available : null;
            if (!allowance || typeof allowance.facet !== 'string' || typeof allowance.grant !== 'number')
                return;
            facet = allowance.facet;
            cap = dbBytes() + allowance.grant;
        },
        storageCap() { return cap; },
        get available() { return available; },
        pin(bytes) {
            if (!inHeap || !fits(bytes, false))
                return false;
            pinnedBytes += bytes;
            return true;
        },
        unpin(bytes) {
            pinnedBytes = Math.max(0, pinnedBytes - bytes);
        },
        get heldBytes() { return heldBytes; },
        addHeld(bytes) { heldBytes += bytes; },
        heldLimit(maxBytes) {
            // In a facet the held cells have their own bound. In a one-shot's heap they
            // share the store's: what the cap leaves beside the tables.
            return inHeap ? Math.max(0, Number(cap) - tablesBytes() - namespaceOverlayBytes - namespaceReserveBytes) : maxBytes;
        },
        namespaceRefusal(bytes) { return refusal(dbBytes() + bytes); },
        rowRefusal(growth) { return refusal(tablesBytes() + heldBytes + namespaceOverlayBytes + namespaceReserveBytes + growth); },
        addOverlay(bytes) { namespaceOverlayBytes += bytes; },
        reserveNamespace(bytes) {
            namespaceReserveBytes += bytes;
            return () => { namespaceReserveBytes -= bytes; };
        },
        /** Reserve room for a fill of `path` before its bytes arrive: true once it is held for it. */
        reserve(path, bytes) {
            release(path);
            if (cap === null)
                return Promise.resolve(true);
            if (reserveQueue.length === 0 && holdRoom(path, bytes))
                return Promise.resolve(true);
            return new Promise((resolve) => {
                reserveQueue.push({ path, bytes, resolve });
                void serveReserves();
            });
        },
        release,
        fits,
        ensureRoom,
        /** Room for what an ACQUIRE answer pushes, asked for before it is applied. */
        async roomForPushed(result) {
            const answer = result;
            if (cap === null || !answer || !Array.isArray(answer.paths))
                return;
            let bytes = 0;
            for (const entry of answer.paths) {
                if (entry && entry.bytes != null)
                    bytes += residentCellCost(residentBytes(entry.bytes));
            }
            if (bytes > 0)
                await ensureRoom(bytes);
        },
        /** What the database measures, after a fill batch: the ledger settles to it, or records overshoot. */
        async reportSize() {
            const asked = supervisor;
            if (cap === null || facet === null || !asked || typeof asked.fsStorageGrant !== 'function')
                return;
            try {
                const answer = await asked.fsStorageGrant(facet, 0, dbBytes());
                if (answer && typeof answer.available === 'number')
                    available = answer.available;
            }
            catch { }
        },
    };
}
