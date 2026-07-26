export const VFS_WRITE_MUTATION_QUEUE_SOURCE = `
const __vfsMutationTails = new Map();
const __nimbusVfsAppendRangeResult = {};

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
  const chain = previous ? previous.chain : { failed: false };
  __vfsAppendWrites[key] = {
    generation: __vfsWriteGenerations[key],
    delta: previous && !previous.claimed
      ? __nimbusConcatVfsBytes(previous.delta, delta)
      : delta,
    fragment,
    chain,
    claimed: false,
    promise: null,
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

function __nimbusVfsAppendBytes(snapshot) {
  return snapshot.append.chain.failed
    ? snapshot.append.fragment
    : snapshot.append.delta;
}

function __nimbusUnsupportedVfsAppend(path) {
  const error = new Error(
    "ENOSYS: preserving a nonresident append requires stat and fsWriteRange: " + path,
  );
  error.code = "ENOSYS";
  return error;
}

function __nimbusRunVfsWriteMutation(snapshot, mutation) {
  return __nimbusQueueVfsMutation(snapshot.key, async () => {
    const value = await mutation(snapshot.content, snapshot);
    if (snapshot.append) snapshot.append.chain.failed = false;
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
  if (snapshot.append && snapshot.append.claimed) {
    return snapshot.append.promise;
  }
  if (snapshot.append) snapshot.append.claimed = true;
  const result = __nimbusRunVfsWriteMutation(snapshot, mutation);
  if (snapshot.append) {
    snapshot.append.promise = result;
    result.then(
      () => undefined,
      () => {
        snapshot.append.chain.failed = true;
        if (__vfsAppendWrites[snapshot.key] === snapshot.append) {
          snapshot.append.claimed = false;
          snapshot.append.promise = null;
        }
      },
    );
  }
  return result;
}

async function __nimbusPersistVfsWrite(supervisor, path, content, snapshot) {
  if (snapshot.append) {
    if (typeof supervisor.stat !== "function" ||
        typeof supervisor.fsWriteRange !== "function") {
      throw __nimbusUnsupportedVfsAppend(path);
    }
    const meta = await supervisor.stat(path);
    if (meta && meta.type === "file") {
      await supervisor.fsWriteRange(
        path,
        Number(meta.size) || 0,
        __nimbusVfsAppendBytes(snapshot),
      );
      return __nimbusVfsAppendRangeResult;
    }
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
