import { PROCESS_FS_CLIENT_SOURCE } from './process-fs-client-source.generated.js';

export const VFS_WRITE_MUTATION_QUEUE_SOURCE = `
const __vfsMutationTails = new Map();
const __nimbusPendingVfsMutations = new Set();
let __nimbusPendingVfsMutationFailure;
let __nimbusHasPendingVfsMutationFailure = false;
const __vfsWriteClaims = new Map();
// Per path: this facet's own writes and mutations the authority has been
// asked to apply whose acknowledgement is not adjudicated yet
// (__nimbusOwnAcknowledgement). Each entry settles, never rejects.
const __vfsOwnAcks = new Map();
// What a logged change answers when the parked cell is not the file's
// whole content (an append to a file the process never held): retired by
// eviction, never stamped. And what one answers when the session refused it.
const __nimbusVfsAppendRangeResult = {};
const __nimbusVfsRefusedResult = {};

function __nimbusVfsPathKey(path) {
  return String(path).replace(/^\\/+/, "");
}

/**
 * The process's filesystem client (core _shared/process-fs-client.ts,
 * spliced ahead of this ledger as __nimbusProcessFsModule): every mutation
 * the program makes reaches the session through it, as a numbered call in
 * its waves, in the order the program made them. Made at first use, with
 * the supervisor read at each call (the opencode runner binds __supervisor
 * late), its timers the raw ones captured below, and published for the
 * runtime's effect and exit boundaries (globalThis.__nimbusProcessFs).
 */
// The platform's timers, captured before the shims wrap setTimeout with the
// VFS resumption barrier: the client's resends and watches are the shim's own
// infrastructure, not a user resumption.
const __nimbusRawTimer = globalThis.setTimeout;
const __nimbusRawClearTimer = globalThis.clearTimeout;
let __nimbusProcessFsInstance = null;
function __nimbusProcessFs() {
  if (__nimbusProcessFsInstance !== null) return __nimbusProcessFsInstance;
  const supervisor = () => {
    const bound = typeof __supervisor !== "undefined" ? __supervisor : null;
    if (!bound) throw Object.assign(new Error("EIO: this process has no supervisor to write to"), { code: "EIO" });
    return bound;
  };
  __nimbusProcessFsInstance = __nimbusProcessFsModule.processFsClient({
    session: {
      // Called as methods of the stub, never through .call/.apply: on an RPC stub those are remote method names too.
      openWriter: (first) => {
        const bound = supervisor();
        return typeof bound.openWaveWriter === "function" ? bound.openWaveWriter(first) : Promise.resolve(null);
      },
      writeBatchStream: (stream, fence, owner) => (owner === undefined
        ? supervisor().writeBatchStream(stream, fence)
        : supervisor().writeBatchStream(stream, fence, owner)),
      retireWriter: async (writer) => {
        const bound = supervisor();
        if (typeof bound.retireWaveWriter === "function") await bound.retireWaveWriter(writer);
      },
      // The subtrees the process writes often enough: decided here
      // (__nimbusDecidedHere), sent in its waves, recalled by another's access.
      grants: {
        acquire: (path, delegate) => supervisor().fsAcquireExclusiveMutation(path, { delegate }),
        release: async (owner) => { await supervisor().fsReleaseExclusiveMutation(owner); },
        awaitRecall: (owner, waitMs) => supervisor().fsAwaitRecall(owner, waitMs),
        recalled: async (owner, kind) => { await supervisor().fsRecalled(owner, kind); },
      },
    },
    // Home directories themselves are never held: the shell and the editor live there.
    isHomeRoot: (key) => (key.startsWith("home/") && key.length > 5 && !key.includes("/", 5)) || key === "root",
    timers: { setTimeout: __nimbusRawTimer, clearTimeout: __nimbusRawClearTimer },
    // The process's own SQLite, where it has one (a resident's facet:
    // __nimbusFsJournalSql): every change is there before the program is told
    // it succeeded, and what it holds when it dies the session drains from it.
    ...(globalThis.__nimbusFsJournalSql ? { journal: __nimbusProcessFsModule.sqlJournal(globalThis.__nimbusFsJournalSql) } : {}),
  });
  globalThis.__nimbusProcessFs = __nimbusProcessFsInstance;
  return __nimbusProcessFsInstance;
}

/**
 * Log a mutation into the process's client: answered once the session has
 * it (its receipt for a data call), rejected with its errno. Counted as an
 * operation in flight until then (__nimbusPendingOps), so the program is not
 * taken for finished while its write is out.
 */
function __nimbusSubmitVfs(op, acknowledged = false) {
  if (typeof globalThis.__nimbusPendingOps !== "number") globalThis.__nimbusPendingOps = 0;
  // The program's own change, named as it made it: what a run that waits for
  // stdin cannot do twice (the runner's stop-replay, where it has one).
  if (typeof __nimbusStopReplay !== "undefined") __nimbusStopReplay.effect(op.type === "call" ? op.call.call : op.type);
  const answer = __nimbusProcessFs().submit(op, { acknowledged });
  globalThis.__nimbusPendingOps++;
  const settled = () => { globalThis.__nimbusPendingOps--; globalThis.__nimbusHandleReleased?.(); };
  answer.then(settled, settled);
  return answer;
}

/**
 * Log \`op\`, the change a synchronous call (or an async one) just made to
 * the parked cell at \`path\`, in the client's log now, in the order the
 * program made it, and claim the cell with its answer: once the session has
 * it, the cell retires (stamped with the revision it made, or evicted when
 * it was not the file's whole content: \`partial\`); refused, it is dropped.
 * Answers the session's answer; \`acknowledged\`: the program was already
 * told it succeeded, so a refusal is reported, never thrown.
 */
function __nimbusLogVfsWrite(path, op, options = {}) {
  const acknowledged = options.acknowledged === true;
  const answer = __nimbusSubmitVfs(op, acknowledged);
  const claimed = __nimbusClaimVfsWrite(path, () => answer.then((answered) => {
    if (answered.failed) return __nimbusVfsRefusedResult;
    if (options.partial) return __nimbusVfsAppendRangeResult;
    return answered.receipt?.revision ?? answered.mutation?.after;
  }), false, acknowledged);
  // The claim settles with the answer; a refusal is the answer's to report.
  claimed.catch(() => {});
  return { answer, claimed };
}

/**
 * Whether a change at \`path\` is decided here: in a subtree the process
 * holds, its async form is answered once it is logged (its sync view is
 * already changed), and the session's answer comes with the log's waves; a
 * refusal then is reported as an acknowledged change's is. Counts the change
 * toward taking the subtree when none is held.
 */
function __nimbusDecidedHere(path, bytes = 0) {
  if (typeof __supervisor === "undefined" || __supervisor === null) return false;
  // What it decided and the session has not answered yet (logged or not)
  // stays under the client's bound: past it, the change waits for its own
  // answer. A process that dies holds at most that, unsent.
  if (__nimbusDecidedOps >= __nimbusProcessFsModule.DECIDED_BACKLOG_OPS
      || __nimbusDecidedBytes + bytes > __nimbusProcessFsModule.DECIDED_BACKLOG_BYTES) return false;
  return __nimbusProcessFs().holder(__nimbusVfsPathKey(path)) !== undefined;
}

/** Changes decided here (__nimbusDecidedHere) the session has not answered: their count and bytes. */
let __nimbusDecidedOps = 0;
let __nimbusDecidedBytes = 0;

/** \`work\`, a change decided here of \`bytes\`: counted until the session answers it. */
function __nimbusDecided(work, bytes = 0) {
  __nimbusDecidedOps++;
  __nimbusDecidedBytes += bytes;
  const settled = () => { __nimbusDecidedOps--; __nimbusDecidedBytes -= bytes; };
  Promise.resolve(work).then(settled, settled);
  return work;
}

/**
 * \`work\`, a change the program was already told succeeded (a synchronous
 * call, or an async one decided here): not awaited, and its refusal or
 * unknown fate reported as the client reports its own, at the next effect
 * and when the process settles.
 */
function __nimbusAcknowledged(work, syscall, path) {
  if (!work || typeof work.then !== "function") return;
  work.then(undefined, (error) => {
    if (typeof __supervisor === "undefined" || __supervisor === null) return;
    const code = error && typeof error.code === "string" ? error.code : "EIO";
    __nimbusProcessFs().noteFailure({ op: syscall, path: __nimbusVfsPathKey(path), errno: code, message: error && error.message ? error.message : String(error) });
  });
}

/** A cell's bytes, as a data call carries them. */
function __nimbusVfsCellBytes(content) {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/**
 * Errno values that are the filesystem ANSWERING the syscall: the path is not
 * there, it is a directory, the descriptor is closed. The operation did not
 * apply, no bytes were in flight, and nothing the program believes is saved
 * has been lost. Node hands these to the caller and lets it decide — which is
 * why \`fs.truncate(missing).catch(() => {})\` is ordinary, correct code.
 *
 * ENOSPC is one of them: the session's storage ledger (N18) refuses a write
 * before any of it is made. So are EROFS (a read-only mount) and EBUSY (an
 * exclusive-mutation lease): the namespace refuses those before the backend
 * is called.
 *
 * Everything else — EIO, a dropped RPC, an authority that died, an
 * error carrying no errno at all — is not an answer. It means the outcome of
 * a write is UNKNOWN, and that is a durability event no matter what the
 * program caught. Unrecognised is treated as durability-class on purpose: the
 * safe direction is to surface.
 */
const __NIMBUS_SYSCALL_VERDICT_CODES = new Set([
  "ENOENT", "EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY",
  "EBADF", "EINVAL", "EPERM", "EACCES", "ELOOP", "ENAMETOOLONG", "ENOSPC",
  "EROFS", "EBUSY",
]);

function __nimbusIsDurabilityFailure(error) {
  if (error && typeof error === "object" && error.nimbusRefusedWriteBack === true) return true;
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

/**
 * Run \`work\` as an acknowledgement in flight for \`path\`: one of this
 * facet's own writes or mutations of it, from being issued to the authority
 * through adjudicating what the authority answered — the stamp that dates
 * the cell, or the eviction when a barrier's report outran it.
 *
 * Until then the facet cannot tell whether the authority has applied it, or
 * at which revision, and a barrier that reported the path cannot tell whether
 * that report was this very write or a peer's after it. Served, the facet's
 * own bytes would then be read past a peer that overwrote them — beside
 * another path the same peer wrote afterwards, read new. So no resumption
 * runs while such a report is outstanding against one of these
 * (__nimbusReportedOwnAcknowledgements). A write that is only parked is not
 * in flight: it has not reached the authority, cannot have been applied
 * before any report, and will be applied after every one it has missed.
 *
 * \`generation\` is the parked cell a whole-file write-back carries
 * (__vfsWriteGenerations): once a newer one is parked over it, that newer
 * cell is what the facet serves, and this acknowledgement no longer says
 * anything about the bytes a resumption would read.
 */
function __nimbusOwnAcknowledgement(path, work, generation) {
  const key = __nimbusVfsPathKey(path);
  const acked = work();
  const ack = { settled: acked.then(() => undefined, () => undefined), generation };
  let held = __vfsOwnAcks.get(key);
  if (!held) {
    held = new Set();
    __vfsOwnAcks.set(key, held);
  }
  held.add(ack);
  ack.settled.then(() => {
    held.delete(ack);
    if (held.size === 0 && __vfsOwnAcks.get(key) === held) __vfsOwnAcks.delete(key);
  });
  return acked;
}

/**
 * The own acknowledgements in flight for every path that carries a report
 * noted while its write or mutation was out (__nimbusNoteVfsReport) — by the
 * barrier asking or by any before it — as of NOW, settling together; null
 * when there are none. A barrier waits on these before its resumption runs.
 *
 * The reports an answer names are noted before it is admitted, so they are
 * among them. So is one an earlier barrier noted and is still waiting on:
 * that barrier moved the cursor past it, and an answer asked for from there
 * does not name it again, but the own bytes are no fresher for that.
 * Once an acknowledgement lands, its adjudication has decided — a report at
 * or below its revision was this facet's own write coming back and the cell
 * is dated; one above it was a peer writing after, and the cell is evicted
 * and owed a refetch — and the report is retired with it.
 *
 * A write-back whose cell has been superseded is left out: a newer write of
 * the path is parked over it, and no mutation of the path is out beside it.
 * The facet serves that newer cell, which is only parked, so it will be
 * applied above every report made so far. Waiting on the older one would
 * stall a program that writes and yields in a loop on each of its own writes
 * coming back, for nothing it reads.
 */
function __nimbusReportedOwnAcknowledgements() {
  const pending = [];
  for (const [key, held] of __vfsOwnAcks) {
    const lease = __vfsOwnLeases[key];
    if (__vfsParkedReports[key] === undefined && !(lease && lease.reported !== -1)) continue;
    const parkedOver = lease === undefined && Object.prototype.hasOwnProperty.call(__vfsWrites, key);
    for (const ack of held) {
      if (parkedOver && ack.generation !== undefined && ack.generation !== __vfsWriteGenerations[key]) continue;
      pending.push(ack.settled);
    }
  }
  return pending.length === 0 ? null : Promise.all(pending);
}

/**
 * Note a report no answer could name, on every path with an own
 * acknowledgement in flight. A poison, a barrier with no answer, a repair
 * that vouched for nothing: each moves on without saying what changed, so
 * each of those writes is adjudicated as though a peer wrote after it — a
 * refetch, never a stale byte.
 */
function __nimbusNoteUnnamedReports() {
  for (const key of __vfsOwnAcks.keys()) __nimbusNoteVfsReport(key, Infinity);
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

/**
 * Put \`next\` in the parked cell at \`path\` as the view of a change already
 * logged (a ranged write's overlay, a truncate's trim): the same generation,
 * so the change's claim still retires it.
 */
function __nimbusReplaceParkedCell(path, next) {
  const key = __nimbusVfsPathKey(path);
  if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key)) return;
  const generation = __vfsWriteGenerations[key];
  __vfsWrites[key] = next;
  __vfsWriteGenerations[key] = generation;
}

function __nimbusCaptureVfsWrite(path) {
  const key = __nimbusVfsPathKey(path);
  if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key)) return null;
  return {
    key,
    content: __vfsWrites[key],
    generation: __vfsWriteGenerations[key],
  };
}

/**
 * The authority refused a parked write outright (a syscall verdict:
 * EACCES, EPERM, EISDIR...). The bytes are not the file's and never will
 * be, so the process stops serving them: the parked cell of that generation
 * and any resident copy go, and the shims forget what they recorded of the
 * path, so the next read asks the authority. When no caller will see the
 * rejection (\`unseen\`: a sync write carried across later), the refusal is
 * retained and reported at exit; an async writer gets it as its verdict.
 */
function __nimbusRefuseParkedWrite(snapshot, error, unseen) {
  if (__vfsWriteGenerations[snapshot.key] === snapshot.generation) {
    delete __vfsWrites[snapshot.key];
    if (typeof __vfsBundle !== "undefined" && __vfsBundle) delete __vfsBundle[snapshot.key];
    const refused = globalThis.__nimbusVfsWriteRefused;
    if (typeof refused === "function") refused(snapshot.key);
  }
  if (unseen && error && typeof error === "object") {
    try { error.nimbusRefusedWriteBack = true; } catch {}
  }
  return error;
}

function __nimbusRunVfsWriteMutation(snapshot, mutation, retainFailure, unseen) {
  return __nimbusQueueVfsMutation(snapshot.key, () => __nimbusOwnAcknowledgement(snapshot.key, async () => {
    let value;
    try {
      value = await mutation(snapshot.content, snapshot);
    } catch (error) {
      throw __nimbusRefuseParkedWrite(snapshot, error, unseen);
    }
    // Refused (an acknowledged change: the client reports it): the bytes are not the file's.
    if (value === __nimbusVfsRefusedResult) {
      __nimbusRefuseParkedWrite(snapshot, null, false);
      return value;
    }
    if (__vfsWriteGenerations[snapshot.key] === snapshot.generation) {
      // What the barriers reported for this path while the write was in
      // flight. Read before the parked cell is retired below, which drops it.
      const reported = __vfsParkedReports[snapshot.key];
      // Past the own changes logged after it (__nimbusFollowOwnWrite).
      value = __nimbusFollowedRevision(snapshot.key, value);
      if (value === __nimbusVfsAppendRangeResult &&
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
  }, snapshot.generation), retainFailure);
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
 * \`__nimbusNoteVfsReport\` for a report that covers a subtree: a
 * subtree-scoped or structural delta entry, which stands for changes at or
 * under \`prefix\` that it does not name. Every path there that one of this
 * facet's own writes or mutations is in flight for gets the report.
 */
function __nimbusNoteVfsReportUnder(prefix, revision) {
  const under = prefix + "/";
  const keys = new Set([...Object.keys(__vfsOwnLeases), ...Object.keys(__vfsWrites)]);
  for (const key of keys) {
    if (key === prefix || key.startsWith(under)) __nimbusNoteVfsReport(key, revision);
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
  if (!held) { __nimbusFollowOwnWrite(key, receipt); return; }
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
 * Own mutations of a path made while its cell was PARKED (a chownSync right
 * after a writeFileSync: both logged at once, in order): no lease could be
 * taken, the cell having no stamp yet. Their receipts are chained here
 * (\`before\` of each is the \`after\` of the one before it, or nothing can be
 * said) and the parked write's claim folds them into the revision it
 * stamps: its own revision R, then every own change whose chain starts at
 * or below R, so the barrier reporting the last of them reads it as this
 * facet's own. \`null\`: a gap in the chain (or an unknown outcome).
 */
const __vfsOwnFollowers = Object.create(null);

function __nimbusFollowOwnWrite(key, receipt) {
  const known = receipt && typeof receipt.before === "number" && typeof receipt.after === "number";
  if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key)) {
    // Its write's claim already stamped the cell: carried past this change
    // as a lease's end would (nobody else between: the stamp is its before).
    if (!known) return;
    if (__nimbusResidentRows()) {
      const dated = __residentLease(key);
      if (dated === undefined) return;
      __residentStamp(key, dated >= receipt.before ? receipt.after : dated);
      return;
    }
    const stamp = __vfsBundleRevisions[key];
    if (typeof stamp === "number" && stamp !== Infinity && stamp >= receipt.before) __vfsBundleRevisions[key] = receipt.after;
    return;
  }
  const chain = __vfsOwnFollowers[key];
  if (!known) { __vfsOwnFollowers[key] = null; return; }
  if (chain === undefined) { __vfsOwnFollowers[key] = { before: receipt.before, after: receipt.after }; return; }
  if (chain === null) return;
  __vfsOwnFollowers[key] = chain.after >= receipt.before ? { before: chain.before, after: Math.max(chain.after, receipt.after) } : null;
}

/** The revision a parked write's claim stamps: its own, carried past the own changes that followed it. */
function __nimbusFollowedRevision(key, revision) {
  const chain = __vfsOwnFollowers[key];
  delete __vfsOwnFollowers[key];
  if (typeof revision !== "number" || !chain) return revision;
  return chain.before <= revision ? Math.max(revision, chain.after) : revision;
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

/**
 * Wait for the parked cell at \`path\` to be answered: its change was
 * logged when it was made (__nimbusLogVfsWrite), and this is its claim.
 * Resolves at once when nothing of the path is out.
 */
function __nimbusFlushVfsWrite(path) {
  const claim = __vfsWriteClaims.get(__nimbusVfsPathKey(path));
  return claim ? claim.promise : Promise.resolve(undefined);
}

/**
 * Claim the parked cell at \`path\` as it is now with \`mutation\`, whose
 * answer retires it (__nimbusRunVfsWriteMutation). \`unseen\`: no caller
 * awaits it, so a refusal must be retained to be heard.
 */
function __nimbusClaimVfsWrite(path, mutation, retainFailure = true, unseen = false) {
  const snapshot = __nimbusCaptureVfsWrite(path);
  if (!snapshot) return Promise.resolve(undefined);
  const existing = __vfsWriteClaims.get(snapshot.key);
  if (existing && existing.generation === snapshot.generation) {
    return existing.promise;
  }
  const result = __nimbusRunVfsWriteMutation(snapshot, mutation, retainFailure, unseen);
  const claim = { generation: snapshot.generation, promise: result };
  __vfsWriteClaims.set(snapshot.key, claim);
  const release = () => {
    if (__vfsWriteClaims.get(snapshot.key) === claim) {
      __vfsWriteClaims.delete(snapshot.key);
    }
  };
  result.then(() => {
    release();
    // The authority accepted the bytes: the shims learn what it made of the
    // path (owner, mode) for their sync view.
    const landed = globalThis.__nimbusVfsWriteLanded;
    if (typeof landed === "function") landed(snapshot.key);
  }, release);
  return result;
}

/**
 * The end of the process: every change it made is already in its client's
 * log (taken there when it was made); what is left is their answers.
 */
async function __nimbusDrainVfsWrites(supervisor) {
  void supervisor;
  const outcomes = await Promise.allSettled([__nimbusDrainVfsMutations()]);
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  // Everything the process made, answered; a change it was told succeeded
  // that the session refused or never answered fails the run, by name.
  if (__nimbusProcessFsInstance !== null) await __nimbusProcessFsInstance.settle();
}
`.trim();

/**
 * The write ledger every node facet splices ahead of the shims, carrying the
 * process's filesystem client it sends through (PROCESS_FS_CLIENT_SOURCE)
 * ahead of its own text. It reaches the facet as a staged asset
 * (@nimbus-sh/worker scripts/bundle-node-shims.mjs), not through the Worker
 * bundle.
 */
export const VFS_WRITE_LEDGER_SOURCE = `
${PROCESS_FS_CLIENT_SOURCE}
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
const __vfsWrites = new Proxy(Object.create(null), {
  set(target, path, value) {
    target[path] = value;
    delete __vfsParkedReports[path];
    __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
    return true;
  },
  deleteProperty(target, path) {
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
