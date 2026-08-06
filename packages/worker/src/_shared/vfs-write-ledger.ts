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
  const result = previous.then(mutation);
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
      if (snapshot.append &&
          value === __nimbusVfsAppendRangeResult &&
          typeof __vfsBundle !== "undefined" &&
          __vfsBundle) {
        delete __vfsBundle[snapshot.key];
      }
      delete __vfsWrites[snapshot.key];
    }
    return value;
  }, retainFailure);
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
      await supervisor.fsAppend(
        path,
        __nimbusVfsModuleIncarnation(),
        operation.id,
        operation.bytes,
      );
      __nimbusCommitVfsAppendOperation(snapshot, operation);
      try {
        await supervisor.fsAppendAck(__nimbusVfsModuleIncarnation(), operation.id);
      } catch {
        // The client has already relinquished retry ownership after the
        // append success. A lost acknowledgement may retain a receipt, but
        // must never turn a committed append into a failed/retried write.
      }
    }
    return __nimbusVfsAppendRangeResult;
  }
  await supervisor.writeFile(path, content);
  return undefined;
}

/**
 * Write back everything parked, keeping any failure for the exit drain.
 *
 * The write-back sites that are not the exit drain — the debounce below and
 * the RELEASE barrier ahead of egress — have no caller who could act on a
 * failure: there is no user frame to throw into, and rejecting the fetch that
 * happened to trigger the flush would blame the wrong operation. Retaining
 * the failure in the channel \`__nimbusDrainVfsMutations\` already drains means
 * the exit path still reports it, so a lost write is loud exactly once and
 * never silent.
 */
async function __nimbusFlushVfsWriteBack(supervisor) {
  if (!supervisor) return;
  try {
    await __nimbusDrainVfsWrites(supervisor);
  } catch (error) {
    if (!__nimbusHasPendingVfsMutationFailure) {
      __nimbusHasPendingVfsMutationFailure = true;
      __nimbusPendingVfsMutationFailure = error;
    }
  }
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

export const VFS_WRITE_LEDGER_SOURCE = `
const __vfsWriteGenerations = Object.create(null);
const __vfsAppendWrites = Object.create(null);
const __vfsWrites = new Proxy(Object.create(null), {
  set(target, path, value) {
    target[path] = value;
    delete __vfsAppendWrites[path];
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
    if (Object.prototype.hasOwnProperty.call(target, path)) {
      delete target[path];
      __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
    }
    return true;
  },
});

${VFS_WRITE_MUTATION_QUEUE_SOURCE}
`.trim();
