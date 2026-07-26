export const VFS_WRITE_MUTATION_QUEUE_SOURCE = `
const __vfsMutationTails = new Map();

function __nimbusVfsPathKey(path) {
  return String(path).replace(/^\\/+/, "");
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

function __nimbusRunVfsWriteMutation(snapshot, mutation) {
  const previous = __vfsMutationTails.get(snapshot.key) || Promise.resolve();
  const operation = previous.then(() => mutation(snapshot.content));
  const result = operation.then((value) => {
    if (__vfsWriteGenerations[snapshot.key] === snapshot.generation) {
      delete __vfsWrites[snapshot.key];
    }
    return value;
  });
  // A failed mutation rejects its own caller but must not poison later writes
  // for the same path or become an unhandled queue-cleanup rejection.
  let tail;
  const clearTail = () => {
    if (__vfsMutationTails.get(snapshot.key) === tail) {
      __vfsMutationTails.delete(snapshot.key);
    }
  };
  tail = result.then(clearTail, clearTail);
  __vfsMutationTails.set(snapshot.key, tail);
  return result;
}

function __nimbusFlushVfsWrite(path, mutation) {
  const snapshot = __nimbusCaptureVfsWrite(path);
  return snapshot
    ? __nimbusRunVfsWriteMutation(snapshot, mutation)
    : Promise.resolve(undefined);
}
`.trim();

export const VFS_WRITE_LEDGER_SOURCE = `
const __vfsWriteGenerations = Object.create(null);
const __vfsWrites = new Proxy(Object.create(null), {
  set(target, path, value) {
    target[path] = value;
    __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
    return true;
  },
  deleteProperty(target, path) {
    if (Object.prototype.hasOwnProperty.call(target, path)) {
      delete target[path];
      __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
    }
    return true;
  },
});

${VFS_WRITE_MUTATION_QUEUE_SOURCE}
`.trim();
