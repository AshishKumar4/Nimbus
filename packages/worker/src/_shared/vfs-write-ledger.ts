export const VFS_WRITE_MUTATION_QUEUE_SOURCE = `
const __vfsMutationTails = new Map();
const __vfsWriteClaims = new Map();
const __nimbusVfsAppendRangeResult = {};
// Operation sequences reset when this generated module is evaluated again.
// The nonce namespaces those retries without pretending a new application
// request is the same logical append.
const __nimbusVfsModuleIncarnation = crypto.randomUUID();
let __nimbusVfsAppendOperationSequence = 0;

function __nimbusVfsPathKey(path) {
  return String(path).replace(/^\\/+/, "");
}

function __nimbusQueueVfsMutation(path, mutation) {
  const key = __nimbusVfsPathKey(path);
  const previous = __vfsMutationTails.get(key) || Promise.resolve();
  const result = previous.then(mutation);
  // A failed mutation rejects its own caller but must not poison later writes
  // for the same path or become an unhandled queue-cleanup rejection.
  let tail;
  const clearTail = () => {
    if (__vfsMutationTails.get(key) === tail) {
      __vfsMutationTails.delete(key);
    }
  };
  tail = result.then(clearTail, clearTail);
  __vfsMutationTails.set(key, tail);
  return result;
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

function __nimbusRunVfsWriteMutation(snapshot, mutation) {
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
  });
}

function __nimbusFlushVfsWrite(path, mutation) {
  const snapshot = __nimbusCaptureVfsWrite(path);
  if (!snapshot) return Promise.resolve(undefined);
  const existing = __vfsWriteClaims.get(snapshot.key);
  if (existing && existing.generation === snapshot.generation) {
    return existing.promise;
  }
  if (snapshot.append) snapshot.append.claimed = true;
  const result = __nimbusRunVfsWriteMutation(snapshot, mutation);
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
        __nimbusVfsModuleIncarnation,
        operation.id,
        operation.bytes,
      );
      __nimbusCommitVfsAppendOperation(snapshot, operation);
      try {
        await supervisor.fsAppendAck(__nimbusVfsModuleIncarnation, operation.id);
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
`.trim();

export const VFS_WRITE_LEDGER_SOURCE = `
const __vfsWriteGenerations = Object.create(null);
const __vfsAppendWrites = Object.create(null);
const __vfsWrites = new Proxy(Object.create(null), {
  set(target, path, value) {
    target[path] = value;
    delete __vfsAppendWrites[path];
    __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
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
