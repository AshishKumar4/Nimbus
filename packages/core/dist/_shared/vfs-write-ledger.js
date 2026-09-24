export const VFS_WRITE_MUTATION_QUEUE_SOURCE = `
const __vfsMutationTails = new Map();
const __nimbusPendingVfsMutations = new Set();
let __nimbusPendingVfsMutationFailure;
let __nimbusHasPendingVfsMutationFailure = false;
const __vfsWriteClaims = new Map();
const __nimbusVfsAppendRangeResult = {};
// Operation sequences reset when this generated module is evaluated again.
// The nonce namespaces those retries without pretending a new application
// request is the same logical append. Minted lazily: this source is spliced
// into the opencode runner's module scope, where workerd forbids global-scope
// RNG; the first append always runs in handler context.
let __nimbusVfsModuleIncarnationNonce;
function __nimbusVfsModuleIncarnation() {
  return (__nimbusVfsModuleIncarnationNonce ??= crypto.randomUUID());
}
let __nimbusVfsAppendOperationSequence = 0;

function __nimbusVfsPathKey(path) {
  return String(path).replace(/^\\/+/, "");
}

// Write-backs in flight at once. Unbounded, a burst of ~250 left some
// SupervisorRPC-to-DO calls undelivered with no error, so the process never
// exited (measured 2026-09-22); capped at 6, none stalled.
const __NIMBUS_VFS_RPC_MAX_IN_FLIGHT = 6;
let __nimbusVfsRpcInFlight = 0;
const __nimbusVfsRpcWaiters = [];

/**
 * A supervisor round trip the ledger issues on its own account.
 *
 * A facet's event loop exits when no handle is live, and an in-flight
 * supervisor RPC is one of the handles it counts — but the debounced
 * write-back runs from a raw timer, outside any call the program is awaiting,
 * so nothing else was counting it. Measured: a template copy parked a cell,
 * the debounce fired 10ms later and issued the write, the explicit flush
 * behind it joined that same in-flight promise rather than starting its own,
 * and the loop saw zero handles and ended the program with two files copied
 * out of twenty-eight — silently, exit 0. fs.promises.cp is how
 * create-cloudflare copies its template.
 *
 * The counter is the shims' __nimbusPendingOps, reached through globalThis
 * rather than by calling their RPC helper: this source is spliced ahead of
 * them and into embeddings that are not the one-shot entrypoint, and an
 * absent counter must not be an error.
 */
async function __nimbusVfsRpc(issue) {
  if (typeof globalThis.__nimbusPendingOps !== "number") globalThis.__nimbusPendingOps = 0;
  globalThis.__nimbusPendingOps++;
  try {
    if (__nimbusVfsRpcInFlight < __NIMBUS_VFS_RPC_MAX_IN_FLIGHT) {
      __nimbusVfsRpcInFlight++;
    } else {
      const slot = Promise.withResolvers();
      __nimbusVfsRpcWaiters.push(slot.resolve);
      await slot.promise;
    }
    try { return await issue(); }
    finally {
      // Hand the slot straight to the next waiter; the count only drops when none waits.
      const next = __nimbusVfsRpcWaiters.shift();
      if (next) next();
      else __nimbusVfsRpcInFlight--;
    }
  } finally { globalThis.__nimbusPendingOps--; }
}

/**
 * Errno values that are the filesystem ANSWERING the syscall: the path is not
 * there, it is a directory, the descriptor is closed. The operation did not
 * apply, no bytes were in flight, and nothing the program believes is saved
 * has been lost. Node hands these to the caller and lets it decide — which is
 * why \`fs.truncate(missing).catch(() => {})\` is ordinary, correct code.
 *
 * Everything else — EIO, a dropped RPC, a quota, an authority that died, an
 * error carrying no errno at all — is not an answer. It means the outcome of
 * a write is UNKNOWN, and that is a durability event no matter what the
 * program caught. Unrecognised is treated as durability-class on purpose: the
 * safe direction is to surface.
 */
const __NIMBUS_SYSCALL_VERDICT_CODES = new Set([
  "ENOENT", "EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY",
  "EBADF", "EINVAL", "EPERM", "EACCES", "ELOOP", "ENAMETOOLONG",
]);

function __nimbusIsDurabilityFailure(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code !== "string" || !__NIMBUS_SYSCALL_VERDICT_CODES.has(code);
}

/**
 * Everything already queued for \`path\` and for every proper ancestor of it,
 * as of NOW — a snapshot, not a subscription.
 *
 * The queue orders mutations per path and nothing else, so \`mkdirSync(a)\`
 * followed by anything under \`a\` — \`mkdirSync(a/b)\`, a flushed write of
 * \`a/f\`, an \`fs.promises.open(a/f, "w")\` — could reach the authority
 * ahead of the directory it lives in and be answered ENOENT for a parent
 * the program had demonstrably created. node-tar does exactly this for
 * every entry it extracts.
 *
 * Snapshotting at call time is what keeps the graph acyclic: a mutation
 * only ever waits on mutations that were queued before it, in program
 * order. Capturing the tails inside the mutation body instead would let a
 * rename queued behind a slow ancestor pick up a descendant that was
 * queued after it — and that descendant is already waiting on the rename.
 *
 * Map lookups only; resolves on the next tick when nothing is pending.
 * Tails never reject, so neither does this.
 */
function __nimbusAwaitAncestorMutations(path) {
  const pending = [];
  let prefix = "";
  for (const segment of __nimbusVfsPathKey(path).split("/")) {
    if (!segment) continue;
    prefix = prefix ? prefix + "/" + segment : segment;
    const tail = __vfsMutationTails.get(prefix);
    if (tail) pending.push(tail);
  }
  return pending.length === 0 ? Promise.resolve() : Promise.all(pending).then(() => undefined);
}

/**
 * Everything already queued strictly BELOW \`path\`, as of now. The
 * complement of the ancestor wait, for the two mutations that act on a
 * whole subtree: rmdir needs the children gone first, and a rename must
 * not carry the old name across while a mutation under it is still bound
 * for the old name.
 */
function __nimbusAwaitSubtreeMutations(path) {
  const prefix = __nimbusVfsPathKey(path) + "/";
  const pending = [];
  for (const [key, tail] of __vfsMutationTails) {
    if (key.startsWith(prefix)) pending.push(tail);
  }
  return pending.length === 0 ? Promise.resolve() : Promise.all(pending).then(() => undefined);
}

/**
 * Order a mutation behind the others queued for the same path.
 *
 * A rejection is ALSO reported to the drain when it is durability-class. That
 * second channel is not redundancy: the tail handler below marks \`result\`
 * handled, which suppresses the platform's own \`unhandledrejection\` signal,
 * so retention is the only thing that can reach a durability boundary. Losing
 * it is how a handler whose write failed still answers 200 — silent wrong
 * data, which is what this ledger exists to prevent.
 *
 * What must NOT be retained is a plain syscall verdict. The queue used to
 * retain those too, so an error the program had already caught was delivered
 * a second time at teardown and killed the process: \`opencode --help\`
 * rendered its whole help surface and then exited 1 on the
 * \`fs.truncate(logfile).catch(() => {})\` in its logger init.
 *
 * The seam is the ERROR, not the call site. The same source line —
 * \`fs.promises.truncate(p).catch(() => {})\` — must exit 0 when the file was
 * simply absent, and must fail the response when the authority could not say
 * whether the write landed. No per-call-site flag can express that, because
 * both cases arrive through the same call site.
 */
function __nimbusQueueVfsMutation(path, mutation, retainFailure = true) {
  const key = __nimbusVfsPathKey(path);
  const previous = __vfsMutationTails.get(key) || Promise.resolve();
  // Every queued mutation is ordered behind the structural mutations
  // pending for its ancestors — one place, so a flushed write, an fd write
  // and a queued mkdir all obey the same rule without each site knowing it.
  const ancestors = __nimbusAwaitAncestorMutations(key);
  const result = previous.then(() => ancestors).then(mutation);
  __nimbusPendingVfsMutations.add(result);
  // A failed mutation rejects its own caller but must not poison later writes
  // for the same path or become an unhandled queue-cleanup rejection.
  let tail;
  const clearTail = () => {
    __nimbusPendingVfsMutations.delete(result);
    if (__vfsMutationTails.get(key) === tail) {
      __vfsMutationTails.delete(key);
    }
  };
  tail = result.then(clearTail, (error) => {
    if (retainFailure
        && __nimbusIsDurabilityFailure(error)
        && !__nimbusHasPendingVfsMutationFailure) {
      __nimbusHasPendingVfsMutationFailure = true;
      __nimbusPendingVfsMutationFailure = error;
    }
    clearTail();
  });
  __vfsMutationTails.set(key, tail);
  return result;
}

async function __nimbusDrainVfsMutations() {
  while (__nimbusPendingVfsMutations.size > 0) {
    await Promise.allSettled([...__nimbusPendingVfsMutations]);
  }
  if (__nimbusHasPendingVfsMutationFailure) {
    const failure = __nimbusPendingVfsMutationFailure;
    __nimbusHasPendingVfsMutationFailure = false;
    __nimbusPendingVfsMutationFailure = undefined;
    throw failure;
  }
}

function __nimbusCapturePendingVfsAppend(path) {
  const key = __nimbusVfsPathKey(path);
  const append = __vfsAppendWrites[key];
  return append && append.generation === __vfsWriteGenerations[key]
    ? append
    : null;
}

function __nimbusConcatVfsBytes(left, right) {
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(left, 0);
  bytes.set(right, left.byteLength);
  return bytes;
}

function __nimbusRecordVfsAppend(path, delta, fragment, previous) {
  const key = __nimbusVfsPathKey(path);
  const chain = previous ? previous.chain : { pending: [] };
  let operation;
  if (previous &&
      !previous.claimed &&
      !chain.pending.includes(previous.operation)) {
    operation = previous.operation;
    operation.bytes = __nimbusConcatVfsBytes(operation.bytes, delta);
  } else {
    operation = {
      id: String(++__nimbusVfsAppendOperationSequence),
      bytes: delta.slice(),
    };
  }
  __vfsAppendWrites[key] = {
    generation: __vfsWriteGenerations[key],
    fragment,
    chain,
    operation,
    claimed: false,
  };
}

function __nimbusCaptureVfsWrite(path) {
  const key = __nimbusVfsPathKey(path);
  if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key)) return null;
  return {
    key,
    content: __vfsWrites[key],
    generation: __vfsWriteGenerations[key],
    append: __nimbusCapturePendingVfsAppend(key),
  };
}

function __nimbusVfsAppendOperations(snapshot) {
  const operations = snapshot.append.chain.pending.slice();
  if (!operations.includes(snapshot.append.operation)) {
    operations.push(snapshot.append.operation);
  }
  return operations;
}

function __nimbusBeginVfsAppendOperation(snapshot, operation) {
  if (!snapshot.append.chain.pending.includes(operation)) {
    snapshot.append.chain.pending.push(operation);
  }
}

function __nimbusCommitVfsAppendOperation(snapshot, operation) {
  const index = snapshot.append.chain.pending.indexOf(operation);
  if (index !== -1) snapshot.append.chain.pending.splice(index, 1);
}

function __nimbusUnsupportedVfsAppend(path) {
  const error = new Error(
    "ENOSYS: preserving a nonresident append requires fsAppend and fsAppendAck: " + path,
  );
  error.code = "ENOSYS";
  return error;
}

function __nimbusRunVfsWriteMutation(snapshot, mutation, retainFailure) {
  return __nimbusQueueVfsMutation(snapshot.key, async () => {
    const value = await mutation(snapshot.content, snapshot);
    if (__vfsWriteGenerations[snapshot.key] === snapshot.generation) {
      // What the barriers reported for this path while the write was in
      // flight. Read before the parked cell is retired below, which drops it.
      const reported = __vfsParkedReports[snapshot.key];
      if (snapshot.append &&
          value === __nimbusVfsAppendRangeResult &&
          typeof __vfsBundle !== "undefined" &&
          __vfsBundle) {
        delete __vfsBundle[snapshot.key];
      } else if (typeof value === "number" &&
                 typeof __vfsBundle !== "undefined" &&
                 __vfsBundle &&
                 !(snapshot.key in __vfsBundle) &&
                 !(reported > value)) {
        // The barrier that evicted the resident copy was answered AHEAD of
        // this very write (see __nimbusBeginOwnMutation for why that
        // ordering is ordinary): it reported the path at the revision this
        // write produced, which is the revision about to be stamped, and
        // the bytes in hand are the authority's content AT that revision.
        // So reinstall them rather than let the identity check below
        // decline and leave the facet holding nothing — a sync read of a
        // file the program just wrote whole would fail EAGAIN.
        //
        // A peer's earlier write was overwritten by this whole-file write.
        // A peer's LATER one is reported ABOVE this revision, and the guard
        // above is that test: reported later, the bytes in hand are not
        // what the authority serves and the eviction stands — a refetch,
        // never a stale byte. The parked cell is dropped right after, so a
        // reinstalled copy is the one the sync view serves.
        __vfsBundle[snapshot.key] = snapshot.content;
      }
      delete __vfsWrites[snapshot.key];
      __nimbusStampFlushedCell(snapshot, value, reported);
    }
    return value;
  }, retainFailure);
}

/**
 * Whether this facet's resident set is the SQLite store
 * (vfs/facet-resident-store.ts), which the resident node body splices ahead
 * of this ledger. Its rows carry their own revision, so a stamp is written
 * into the row, and __vfsBundleRevisions — which describes heap cells — says
 * nothing about them.
 */
function __nimbusResidentRows() {
  return typeof __residentStamp === "function"
    && typeof __residentReady !== "undefined"
    && __residentReady === true;
}

/**
 * Record the authority revision a just-flushed cell is known-good at.
 *
 * The barrier reports back every path mutated since the facet's cursor,
 * which includes the facet's OWN writes — the invalidation log has no way
 * to know who caused an entry. Without a stamp the facet drops the cells it
 * authored the instant it flushes them, and a resumption then refetches
 * bytes it is already holding: a self-inflicted cold cache on exactly the
 * files a scaffolder or a build just wrote.
 *
 * A "skip paths I wrote" rule would be unsound — a peer may write the same
 * path after us, and that invalidation is real. The revision separates
 * them: a report AT our revision is our own write coming back, a report
 * ABOVE it is somebody else's and still evicts.
 *
 * Guarded on cell identity rather than on the flush alone. A read that
 * raced the flush may have refilled the cell from an older revision, and
 * stamping that with our newer one would pin a stale byte — the one
 * outcome this whole protocol exists to prevent.
 *
 * Only the written path is stamped, never its parent — deliberately, and it
 * is why a batch of writes still costs ONE invalidation rather than none.
 * Every mutation reports its parent directory too, so stamping the parent
 * here looks like the obvious way to reach zero. It is not: the same
 * revision on the directory would also vouch for a peer's earlier change to
 * the DIRECTORY ITSELF — a chmod at a revision this facet never acquired —
 * and that stale mode would then survive the barrier. The write knows what
 * it did to the file and nothing about the directory. Do not "finish" this
 * by stamping the parent.
 */
function __nimbusStampFlushedCell(snapshot, revision, reported) {
  if (typeof revision !== "number") return;
  if (typeof __vfsBundle === "undefined" || !__vfsBundle) return;
  if (__nimbusResidentRows()) {
    // The row held this write's bytes as the store's own-write revision,
    // which no barrier evicts, so every barrier inside the window KEPT it and
    // consumed its report. Those reports are judged here, against the
    // revision this write produced: at or below it is this write coming
    // back, or a write it overwrote; above it, a peer wrote after, and the
    // eviction those barriers could not perform is owed now. The store dates
    // only a row still holding own bytes, which is the identity guard below
    // in the form rows allow: a fill never replaces own bytes, and a later
    // write of the path fails the generation test before this is reached.
    if (reported > revision) {
      __nimbusEvictLeasedCell(snapshot.key);
      return;
    }
    __residentStamp(snapshot.key, revision);
    return;
  }
  if (__vfsBundle[snapshot.key] !== snapshot.content) return;
  __vfsBundleRevisions[snapshot.key] = revision;
}

/**
 * Take an own-mutation lease on a held cell.
 *
 * One of the facet's OWN partial mutations (ranged write, truncate, utimes,
 * chmod, chown) bumps the path's revision exactly as a flush does, and the
 * ACQUIRE barrier that reports it back cannot tell who caused it. Stamping
 * once the RPC answers is not enough, because the two are CONCURRENT: the
 * supervisor answers \`fsAcquire\` from memory at once, while a write's
 * response waits on the Durable Object's output gate for durability. So a
 * barrier issued AFTER this facet's own write can be ANSWERED BEFORE that
 * write's response arrives. Its delta lists the path at the write's new
 * revision, the facet's stamp is still the old one, the cell the facet is
 * about to overlay is evicted out from under it, and the next
 * \`readFileSync\` fails EAGAIN on bytes the program wrote itself.
 * Intermittent, and it is what create-astro shows on staging — the README
 * its extract wrote, read synchronously right after.
 *
 * So the cell is HELD for the whole window instead, and the receipt decides
 * at the end (\`__nimbusEndOwnMutation\`). \`Infinity\` is what the barrier's
 * \`stamp >= entry.rev\` reads as "mine" for every revision it could report
 * while the RPC is in flight.
 *
 * An UNSTAMPED cell is not leased: it keeps today's evict-and-refetch, so a
 * mutation path that never stamps still costs a refetch and never a stale
 * byte. \`false\` says no lease was taken and the end is a no-op.
 *
 * In the resident store the row is the stamp, so the store holds the row as
 * own bytes for the window (\`__residentLease\`, which the barrier keeps the
 * way it keeps an Infinity stamp) and hands back the revision it was dated
 * at; the lease record carries that revision exactly as it does here.
 */
function __nimbusBeginOwnMutation(key) {
  if (__nimbusResidentRows()) {
    const open = __vfsOwnLeases[key];
    if (open) { open.pending++; return true; }
    const dated = __residentLease(key);
    if (dated === undefined) return false;
    __vfsOwnLeases[key] = { stamp: dated, pending: 1, peer: false, reported: -1 };
    return true;
  }
  const stamp = __vfsBundleRevisions[key];
  if (stamp === undefined) return false;
  const lease = __vfsOwnLeases[key]
    || (__vfsOwnLeases[key] = { stamp, pending: 0, peer: false, reported: -1 });
  lease.pending++;
  __vfsBundleRevisions[key] = Infinity;
  return true;
}

/**
 * Remember a revision the ACQUIRE barrier has just reported for a path one
 * of this facet's own writes is in flight for. Called for every reported
 * path; a no-op for the ones nothing of ours is touching.
 *
 * A barrier answered inside that window is the whole problem this file is
 * solving, and its report is CONSUMED — the cursor advances past it and
 * nothing will ever raise that revision again. Whether it was this facet's
 * own write coming back or a peer's cannot be decided then, so the number
 * is kept until the write's own revision arrives and can decide it:
 *
 *  - a leased cell had the report SUPPRESSED (the stamp reads Infinity for
 *    every revision), so \`__nimbusEndOwnMutation\` applies the barrier's own
 *    test against the stamp the receipt settles on.
 *  - a PARKED cell is unstamped, so the barrier evicted it legitimately;
 *    \`__nimbusRunVfsWriteMutation\` uses this to tell a report of its own
 *    write (put the bytes back) from a peer's later one (leave them gone).
 *
 * Neither can be answered by the receipt alone: it is read in the
 * mutation's own turn, so a peer writing after the mutation landed and
 * before its response arrived is invisible to it.
 */
function __nimbusNoteVfsReport(key, revision) {
  const lease = __vfsOwnLeases[key];
  if (lease && revision > lease.reported) lease.reported = revision;
  if (Object.prototype.hasOwnProperty.call(__vfsWrites, key) &&
      !(__vfsParkedReports[key] >= revision)) {
    __vfsParkedReports[key] = revision;
  }
}

/**
 * End one own-mutation lease, and settle the stamp when it was the last.
 *
 * The receipt carries the path's revision on either side of the mutation,
 * both read in the RPC's own synchronous turn:
 *
 *  - \`before\` at or below the stamp the lease began with — nobody else
 *    touched the path in the window, so the cell with the local effect
 *    applied IS what the authority serves at \`after\`, and the stamp
 *    advances there.
 *  - \`before\` past it — a peer wrote inside the window, and the barrier
 *    that would have evicted was suppressed by this lease. The end owes
 *    that eviction, so it performs it.
 *  - no receipt at all (the RPC threw) — the outcome is unknown, which is
 *    handled exactly as a peer's write is.
 *
 * Then every report the lease suppressed is adjudicated against the stamp
 * it settled on: a report ABOVE it is a mutation this receipt does not
 * account for, so the eviction the barrier did not perform is performed
 * here (see \`__nimbusNoteVfsReport\`).
 *
 * A cell that stopped being held during the window (a poison drop, a
 * parked sync write retiring the stamp) has nothing left to vouch for, so
 * no stamp is restored for it. In the resident store a write parked over
 * the row inside the window owns it from then on, and its flush dates it.
 */
function __nimbusEndOwnMutation(key, held, receipt) {
  if (!held) return;
  const lease = __vfsOwnLeases[key];
  if (!lease) return;
  lease.pending--;
  if (receipt && typeof receipt.before === "number" && typeof receipt.after === "number") {
    if (lease.stamp >= receipt.before) lease.stamp = receipt.after;
    else lease.peer = true;
  } else {
    lease.peer = true;
  }
  if (lease.pending > 0) return;
  delete __vfsOwnLeases[key];
  const evict = lease.peer || lease.reported > lease.stamp;
  if (__nimbusResidentRows()) {
    if (evict) __nimbusEvictLeasedCell(key);
    else if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key)) __residentStamp(key, lease.stamp);
    return;
  }
  const resident = typeof __vfsBundle !== "undefined" && __vfsBundle && key in __vfsBundle;
  if (evict || !resident) {
    delete __vfsBundleRevisions[key];
    if (evict) __nimbusEvictLeasedCell(key);
    return;
  }
  __vfsBundleRevisions[key] = lease.stamp;
}

/**
 * Drop a cell the way the shims' own invalidation does.
 *
 * Content view, stat view and the invalidation count move together in the
 * shims' \`_evictResident\`, and this source is spliced AHEAD of that
 * closure, so the lease asks through the hook it publishes rather than
 * keeping a second eviction path in step with it. A ledger embedded without
 * the shims has no stat view to keep coherent, and the content view is then
 * all there is to drop.
 */
function __nimbusEvictLeasedCell(key) {
  const evict = globalThis.__nimbusEvictResidentCell;
  if (typeof evict === "function") { evict(key); return; }
  if (typeof __vfsBundle !== "undefined" && __vfsBundle) delete __vfsBundle[key];
}

function __nimbusFlushVfsWrite(path, mutation, retainFailure = true) {
  const snapshot = __nimbusCaptureVfsWrite(path);
  if (!snapshot) return Promise.resolve(undefined);
  const existing = __vfsWriteClaims.get(snapshot.key);
  if (existing && existing.generation === snapshot.generation) {
    return existing.promise;
  }
  if (snapshot.append) snapshot.append.claimed = true;
  const result = __nimbusRunVfsWriteMutation(snapshot, mutation, retainFailure);
  const claim = { generation: snapshot.generation, promise: result };
  __vfsWriteClaims.set(snapshot.key, claim);
  const release = () => {
    if (__vfsWriteClaims.get(snapshot.key) === claim) {
      __vfsWriteClaims.delete(snapshot.key);
    }
  };
  result.then(release, () => {
    release();
    if (snapshot.append &&
        __vfsAppendWrites[snapshot.key] === snapshot.append) {
      snapshot.append.claimed = false;
    }
  });
  return result;
}

async function __nimbusPersistVfsWrite(supervisor, path, content, snapshot) {
  if (snapshot.append) {
    if (typeof supervisor.fsAppend !== "function" ||
        typeof supervisor.fsAppendAck !== "function") {
      throw __nimbusUnsupportedVfsAppend(path);
    }
    for (const operation of __nimbusVfsAppendOperations(snapshot)) {
      __nimbusBeginVfsAppendOperation(snapshot, operation);
      await __nimbusVfsRpc(() => supervisor.fsAppend(
        path,
        __nimbusVfsModuleIncarnation(),
        operation.id,
        operation.bytes,
      ));
      __nimbusCommitVfsAppendOperation(snapshot, operation);
      try {
        await __nimbusVfsRpc(() => supervisor.fsAppendAck(__nimbusVfsModuleIncarnation(), operation.id));
      } catch {
        // The client has already relinquished retry ownership after the
        // append success. A lost acknowledgement may retain a receipt, but
        // must never turn a committed append into a failed/retried write.
      }
    }
    return __nimbusVfsAppendRangeResult;
  }
  // The revision this write produced. It is what lets the ACQUIRE barrier
  // tell this facet's own mutation apart from a peer's.
  return __nimbusVfsRpc(() => supervisor.writeFile(path, content));
}

/**
 * Write back the cells parked at THIS instant, and only those.
 *
 * Bounded on purpose, and deliberately not routed through
 * \`__nimbusDrainVfsWrites\`, whose \`while (pending > 0)\` waits for the mutation
 * queue to be EMPTY. That wait is correct at process exit, where no new writes
 * are coming. Anywhere else it is a livelock: a facet unpacking a tarball adds
 * mutations faster than the loop retires them, so the loop never returns.
 * Sited ahead of egress — where it was — that stopped the request from ever
 * leaving the facet, and \`npx sv create\` ran, printed its intro, and then
 * never reported an exit at all. A barrier may delay a request; it may not
 * wait on a condition a busy process never reaches.
 *
 * Failures are retained rather than thrown. The two callers — the debounce
 * below, and the RELEASE barrier ahead of egress — have no frame that could
 * act on one: rejecting the fetch that happened to trigger the flush would
 * blame the wrong operation. The exit drain reports what is retained, so a
 * lost write is loud exactly once and never silent.
 */
async function __nimbusFlushVfsWriteBack(supervisor) {
  if (!supervisor) return;
  const paths = Object.keys(__vfsWrites);
  if (paths.length === 0) return;
  await Promise.allSettled(paths.map((path) => __nimbusFlushVfsWrite(
    path,
    (content, snapshot) => __nimbusPersistVfsWrite(supervisor, path, content, snapshot),
  )));
}

/**
 * A synchronous write can only park bytes in \`__vfsWrites\`: a sync syscall
 * has no channel to the authority. Something else therefore has to carry
 * them across, and the only thing that did was the drain at process exit —
 * so a resident server that writes synchronously never wrote back at all,
 * and a peer reading the same path got the pre-write bytes for the whole
 * life of the process. Measured, not theorised: \`writeFileSync\` then 50 ms
 * left the authority at null with zero write RPCs issued.
 *
 * Flushing on every write is not the repair — 500 sync writes would become
 * 500 round trips, and an npm install writes thousands. Debounce instead:
 * parking a cell schedules one write-back, and every write that lands before
 * it fires joins that same batch. Steady state costs no more round trips
 * than the exit drain already paid; what changes is when they happen.
 *
 * The timer is the raw platform one, captured before the shims wrap
 * \`setTimeout\` with the VFS resumption barrier: a write-back is the shim's
 * own infrastructure, not a user resumption, and must not pay an ACQUIRE to
 * deliver an ACQUIRE.
 */
const __NIMBUS_VFS_WRITE_BACK_DELAY_MS = 10;
const __nimbusRawTimer = globalThis.setTimeout;
let __nimbusVfsWriteBackTimer = null;
function __nimbusScheduleVfsWriteBack() {
  if (__nimbusVfsWriteBackTimer !== null) return;
  if (typeof __nimbusRawTimer !== 'function') return;
  __nimbusVfsWriteBackTimer = __nimbusRawTimer(() => {
    __nimbusVfsWriteBackTimer = null;
    const supervisor = typeof __supervisor !== 'undefined' ? __supervisor : null;
    if (!supervisor) return;
    // Not registered in __nimbusPendingVfsMutations: each write it starts
    // registers itself there through __nimbusQueueVfsMutation, so the exit
    // drain already awaits the work. Registering the orchestration too would
    // add an entry nothing ever removes, and that set is drained by a
    // while-loop on its size.
    void __nimbusFlushVfsWriteBack(supervisor);
  }, __NIMBUS_VFS_WRITE_BACK_DELAY_MS);
}

async function __nimbusDrainVfsWrites(supervisor) {
  const paths = Object.keys(__vfsWrites);
  const outcomes = await Promise.allSettled([
    ...paths.map(async (path) => {
      const persist = () => __nimbusFlushVfsWrite(
        path,
        (content, snapshot) =>
          __nimbusPersistVfsWrite(supervisor, path, content, snapshot),
        false,
      );
      try {
        await persist();
      } catch (error) {
        // The authority may have committed before the RPC response was lost.
        // One retry is safe: full writes are idempotent, while appends retain
        // the same module/operation identity and are deduplicated by authority.
        if (error && typeof error.code === "string") throw error;
        await persist();
      }
    }),
    __nimbusDrainVfsMutations(),
  ]);
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
}
`.trim();
/**
 * The write ledger every node facet splices ahead of the shims. It reaches the
 * facet as a staged asset (@nimbus-sh/worker scripts/bundle-node-shims.mjs),
 * not through the Worker bundle.
 */
export const VFS_WRITE_LEDGER_SOURCE = `
const __vfsWriteGenerations = Object.create(null);
// Per-path: the authority revision the resident cell in __vfsBundle is
// known-good at. Only a flush of this facet's own bytes sets one, this
// facet's own partial mutations of a stamped cell advance it, and the
// ACQUIRE barrier is the only reader. An unstamped cell is simply evicted,
// so a mutation path that forgets to stamp costs a refetch and never a
// stale byte. Infinity is not a revision: it is the lease below, held
// while one of this facet's own mutations of the path is in flight.
// Heap cells only: the resident store dates each row in the row itself
// (__nimbusResidentRows), and this map says nothing about those.
const __vfsBundleRevisions = Object.create(null);
// Own mutations in flight per path: the stamp the first lease began with,
// how many are outstanding, whether a receipt has already proven a peer
// wrote inside the window, and the highest revision a barrier reported for
// the path while the lease suppressed it.
//
// Overlapping own mutations of one path are legal — chown and the chmod
// ride-along are not queued behind each other — so a second begin reuses
// the record rather than opening a second window, and an end whose receipt
// reports a \`before\` past the record's stamp marks \`peer\`. That verdict
// cannot distinguish a stranger's write from the sibling own mutation still
// in flight, and does not try to: it is a conservative refetch, never
// staleness.
const __vfsOwnLeases = Object.create(null);
// Per path with a PARKED write: the highest revision a barrier reported for
// it while that write was in flight. A parked cell is unstamped, so the
// barrier evicts it and consumes the report; the flush's own revision is
// what finally says whether that report was its own write coming back.
// Bounded by the parked set — the entry is retired with the cell below.
const __vfsParkedReports = Object.create(null);
const __vfsAppendWrites = Object.create(null);
const __vfsWrites = new Proxy(Object.create(null), {
  set(target, path, value) {
    target[path] = value;
    delete __vfsAppendWrites[path];
    delete __vfsParkedReports[path];
    __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
    // Parking a cell is the only signal a synchronous write leaves. It is
    // therefore the one place a write-back can be scheduled from, and it
    // covers every sync mutation — writeFileSync, appendFileSync, the fd
    // writes, rename — with no per-call-site duplication.
    __nimbusScheduleVfsWriteBack();
    return true;
  },
  deleteProperty(target, path) {
    delete __vfsAppendWrites[path];
    delete __vfsParkedReports[path];
    if (Object.prototype.hasOwnProperty.call(target, path)) {
      delete target[path];
      __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
    }
    return true;
  },
});

${VFS_WRITE_MUTATION_QUEUE_SOURCE}
`.trim();
