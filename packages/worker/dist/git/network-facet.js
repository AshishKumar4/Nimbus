/**
 * git-network-facet.ts — Facet-based git clone/fetch/pull.
 *
 * Runs isomorphic-git's network operations (clone/fetch/pull) inside a
 * dynamic worker (LOADER.load) to escape the supervisor DO's CPU budget
 * and to avoid the known DO fetch() hang in wrangler local dev.
 *
 * Architecture:
 *   - Facet holds a buffered fs adapter: writes accumulate in memory
 *   - Pre-flush ordinary waves with headroom below W7's 128-path limit or
 *     before 4 MiB via ONE supervisor.writeBatchStream() RPC. Each published
 *     path is atomic; a later publish-group failure may leave a committed prefix.
 *   - At clone end, a final flush commits remaining buffered state.
 *   - Fresh clones retain a metadata-only closed-world overlay across waves;
 *     regular-file bytes still fall through to the supervisor after flush.
 *
 * Why this fixes the hang:
 *   - CPU-heavy packfile delta resolution runs in facet (own CPU budget)
 *   - No per-file RPC round-trips — bounded path waves
 *   - Packfile network fetch works (facet fetch is reliable, DO fetch hangs)
 *   - cf-git's nonBlocking=true option yields to event loop between batches
 *
 * See docs/analysis in git-network-facet plan — the canonical write-up lives
 * in the PR that introduced this file.
 */
import { getCtxExports } from '../session/ctx-exports.js';
import { CF_COMPAT_DATE, MAX_RPC_SAFE_PAYLOAD_BYTES } from '../constants.js';
import { GIT_BUNDLE_CODE } from '../git-bundle.generated.js';
import { W7_FRAME_PREAMBLE } from '../loaders/generated-workers.js';
import { disposeRpcResource } from '../_shared/rpc-dispose.js';
import { W7_MAX_OWNED_PATH_BYTES, W7_MAX_PATHS_PER_BATCH, } from '../_shared/w7-frame.js';
const EMPTY_SUPERVISOR_RPC_COUNTERS = {
    stat: 0,
    lstat: 0,
    readdir: 0,
    readFile: 0,
    fsReadRange: 0,
    writeBatchStream: 0,
    readlink: 0,
    symlink: 0,
    legacySymlinkSubtree: 0,
    stdout: 0,
};
const EMPTY_METADATA_OVERLAY_STATS = {
    entries: 0,
    accountedBytes: 0,
    maxEntries: 0,
    maxAccountedBytes: 0,
};
function nonNegativeCounter(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
function parseSupervisorRpcCounters(value) {
    const counters = value && typeof value === 'object'
        ? value
        : {};
    return {
        stat: nonNegativeCounter(counters.stat),
        lstat: nonNegativeCounter(counters.lstat),
        readdir: nonNegativeCounter(counters.readdir),
        readFile: nonNegativeCounter(counters.readFile),
        fsReadRange: nonNegativeCounter(counters.fsReadRange),
        writeBatchStream: nonNegativeCounter(counters.writeBatchStream),
        readlink: nonNegativeCounter(counters.readlink),
        symlink: nonNegativeCounter(counters.symlink),
        legacySymlinkSubtree: nonNegativeCounter(counters.legacySymlinkSubtree),
        stdout: nonNegativeCounter(counters.stdout),
    };
}
function parseMetadataOverlayStats(value) {
    const stats = value && typeof value === 'object'
        ? value
        : {};
    return {
        entries: nonNegativeCounter(stats.entries),
        accountedBytes: nonNegativeCounter(stats.accountedBytes),
        maxEntries: nonNegativeCounter(stats.maxEntries),
        maxAccountedBytes: nonNegativeCounter(stats.maxAccountedBytes),
    };
}
/**
 * Run a git network op inside a facet. Returns when complete or timed out.
 */
export async function execGitNetwork(ctx, env, opts) {
    const start = Date.now();
    try {
        if (!env?.LOADER?.load) {
            return {
                success: false,
                error: 'env.LOADER.load not available — cannot spawn git facet',
                elapsed: Date.now() - start,
                filesWritten: 0,
                bytesWritten: 0,
                supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
                metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
            };
        }
        const { mutationOwner, ...facetOpts } = opts;
        const ctxExports = getCtxExports();
        const supervisorBinding = ctxExports?.SupervisorRPC
            ? ctxExports.SupervisorRPC({
                props: { doId: ctx.id.toString(), pid: 0, mutationOwner },
            })
            : undefined;
        if (!supervisorBinding) {
            return {
                success: false,
                error: 'SupervisorRPC binding not available',
                elapsed: Date.now() - start,
                filesWritten: 0,
                bytesWritten: 0,
                supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
                metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
            };
        }
        const worker = env.LOADER.load({
            compatibilityDate: CF_COMPAT_DATE,
            compatibilityFlags: ['nodejs_compat'],
            mainModule: 'git-network-worker.js',
            // Facet gets:
            //   - its own worker code (git-network-worker.js), with the
            //     W7 frame helpers (encodeWriteBatchStream + supporting
            //     state) prepended so the buffered fs adapter can call
            //     them as bare identifiers — the same shape NimbusLoaderPool's
            //     `preamble` option provides for npm install. This is the
            //     W7 v3 emits one bounded record per pull; the receiver owns
            //     the aggregate 8 MiB payload-credit and transaction limits.
            //   - the pre-bundled isomorphic-git (git-bundle.js)
            modules: {
                'git-network-worker.js': assembleGitNetworkFacetSource(),
                'git-bundle.js': GIT_BUNDLE_CODE,
            },
            env: { SUPERVISOR: supervisorBinding },
        });
        const entrypoint = worker.getEntrypoint();
        const timeoutMs = opts.timeout ?? 300_000;
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`git ${opts.op} timed out after ${timeoutMs / 1000}s`)), timeoutMs));
        // Parse the facet's response and dispose its RPC stub before the
        // caller sees the value. A bare `.then(r => r.json())` drops the `r`
        // reference but leaves the stub live until the surrounding event
        // handler completes.
        const call = entrypoint.fetch(new Request('http://git/op', {
            method: 'POST',
            body: JSON.stringify(facetOpts),
        })).then(async (r) => {
            try {
                return await r.json();
            }
            finally {
                disposeRpcResource(r);
            }
        });
        let result;
        try {
            result = await Promise.race([call, timeout]);
        }
        finally {
            // Tear down the facet's RPC stubs regardless of success / timeout.
            // `entrypoint` and `worker` are both cross-isolate stubs; disposing
            // them lets workerd reclaim the dynamic worker's memory eagerly.
            // `supervisorBinding` is the SupervisorRPC stub we minted above —
            // it's from ctxExports (local to the supervisor's own isolate) so
            // in theory it doesn't leak across isolates, but disposing is cheap
            // and symmetric with how the facet's env.SUPERVISOR is handled on
            // the other side.
            disposeRpcResource(entrypoint);
            disposeRpcResource(worker);
            disposeRpcResource(supervisorBinding);
        }
        return {
            success: !!result?.success,
            error: result?.error,
            elapsed: Date.now() - start,
            filesWritten: Number(result?.filesWritten ?? 0),
            bytesWritten: Number(result?.bytesWritten ?? 0),
            supervisorRpc: parseSupervisorRpcCounters(result?.supervisorRpc),
            metadataOverlay: parseMetadataOverlayStats(result?.metadataOverlay),
        };
    }
    catch (e) {
        return {
            success: false,
            error: e?.message || String(e),
            elapsed: Date.now() - start,
            filesWritten: 0,
            bytesWritten: 0,
            supervisorRpc: { ...EMPTY_SUPERVISOR_RPC_COUNTERS },
            metadataOverlay: { ...EMPTY_METADATA_OVERLAY_STATS },
        };
    }
}
/**
 * Generate the dynamic worker code for the git network facet.
 *
 * Exports `default { async fetch(request, workerEnv) { ... } }`.
 * Reads op args from the POST body, runs isomorphic-git with a buffered
 * fs adapter, and flushes writes through W7 v3.
 */
export function assembleGitNetworkFacetSource() {
    return W7_FRAME_PREAMBLE + '\n' + generateGitNetworkFacetCode();
}
function generateGitNetworkFacetCode() {
    return `
// CHUNK_SIZE is provided by the W7 frame preamble (from constants.ts),
// prepended to this facet worker — do not redeclare it here.
const WAVE_PATHS = ${W7_MAX_PATHS_PER_BATCH - 8};
const W7_PATH_LIMIT = ${W7_MAX_PATHS_PER_BATCH};
const WAVE_PATH_BYTES = ${W7_MAX_OWNED_PATH_BYTES - 4 * 1024};
const W7_PATH_BYTES_LIMIT = ${W7_MAX_OWNED_PATH_BYTES};
const WAVE_BYTES = 4 * 1024 * 1024; // or every 4MB
const WHOLE_FILE_RPC_SAFE_BYTES = ${MAX_RPC_SAFE_PAYLOAD_BYTES};
const READ_RANGE_BYTES = 4 * 1024 * 1024;
const METADATA_MAX_ENTRIES = 100_000;
const METADATA_MAX_ACCOUNTED_BYTES = 32 * 1024 * 1024;
const METADATA_ENTRY_OVERHEAD_BYTES = 256;

function disposeRpcResult(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === 'function') { try { dispose.call(value); } catch {} }
}

async function useRpcResult(promise, use) {
  const value = await promise;
  try { return await use(value); }
  finally { disposeRpcResult(value); }
}

function requireWriteBatchStreamSuccess(result) {
  if (result && result.ok === true) return result;
  const progress = result
    ? ' after group ' + result.committedGroupSequence +
      ' (' + result.committedPathCount + ' committed paths)'
    : '';
  const detail = result && result.error && result.error.message
    ? result.error.message
    : 'missing writeBatchStream result';
  throw new Error('writeBatchStream failed' + progress + ': ' + detail);
}

// normalizePath is provided by the W7 frame preamble (from _shared/w7-frame.ts),
// prepended to this facet worker — semantically identical, do not redeclare.

function parentOf(p) {
  return p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
}

function enoent(filepath) {
  const err = new Error('ENOENT: no such file or directory, ' + filepath);
  err.code = 'ENOENT'; err.errno = -2;
  return err;
}

function enotdir(filepath) {
  const err = new Error('ENOTDIR: not a directory, ' + filepath);
  err.code = 'ENOTDIR'; err.errno = -20;
  return err;
}

function einval(filepath) {
  const err = new Error('EINVAL: invalid argument, ' + filepath);
  err.code = 'EINVAL'; err.errno = -22;
  return err;
}

function eio(filepath, detail) {
  const err = new Error('EIO: failed to read ' + filepath + ': ' + detail);
  err.code = 'EIO'; err.errno = -5;
  return err;
}

function eloop(filepath) {
  const err = new Error('ELOOP: too many symbolic links encountered, ' + filepath);
  err.code = 'ELOOP'; err.errno = -40;
  return err;
}

function statObj(metadata, followSymlink) {
  const isLink = metadata.kind === 'symlink' && !followSymlink;
  const isDir = metadata.kind === 'dir';
  const isFile = metadata.kind === 'file' || (metadata.kind === 'symlink' && followSymlink);
  const mtimeMs = metadata.mtimeMs;
  const ctimeMs = metadata.ctimeMs;
  const atimeMs = metadata.atimeMs;
  return {
    isFile: () => isFile, isDirectory: () => isDir, isSymbolicLink: () => isLink,
    size: metadata.size,
    mode: (isLink ? 0o120000 : isDir ? 0o040000 : 0o100000) | (metadata.mode & 0o7777),
    type: isLink ? 'symlink' : isDir ? 'dir' : 'file',
    mtimeMs, mtime: new Date(mtimeMs),
    ctimeMs, ctime: new Date(ctimeMs),
    atimeMs, atime: new Date(atimeMs),
    uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
  };
}

function convertSupervisorStat(st) {
  if (!st) return null;
  const mtimeMs = Number(st.mtime) || Date.now();
  const ctimeMs = Number(st.ctime) || mtimeMs;
  const atimeMs = Number(st.atime) || mtimeMs;
  const isDir = st.type === 'directory' || st.type === 'dir';
  const isLink = st.type === 'symlink';
  return {
    isFile: () => !isDir && !isLink,
    isDirectory: () => isDir,
    isSymbolicLink: () => isLink,
    size: Number(st.size) || 0,
    mode: (isLink ? 0o120000 : isDir ? 0o040000 : 0o100000) |
      ((Number(st.mode) || (isDir ? 0o755 : isLink ? 0o777 : 0o644)) & 0o7777),
    type: isDir ? 'dir' : isLink ? 'symlink' : 'file',
    mtimeMs, mtime: new Date(mtimeMs),
    ctimeMs, ctime: new Date(ctimeMs),
    atimeMs, atime: new Date(atimeMs),
    uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
  };
}

function metadataFromSupervisorStat(st) {
  if (!st) return null;
  const converted = convertSupervisorStat(st);
  return {
    kind: converted.isDirectory() ? 'dir' : converted.isSymbolicLink() ? 'symlink' : 'file',
    size: converted.size,
    mode: converted.mode & 0o7777,
    mtimeMs: converted.mtimeMs,
    ctimeMs: converted.ctimeMs,
    atimeMs: converted.atimeMs,
  };
}

function createSupervisorRpcCounters() {
  return {
    stat: 0, lstat: 0, readdir: 0, readFile: 0,
    fsReadRange: 0, writeBatchStream: 0, readlink: 0, symlink: 0,
    legacySymlinkSubtree: 0, stdout: 0,
  };
}

function emptyMetadataOverlayStats() {
  return {
    entries: 0,
    accountedBytes: 0,
    maxEntries: METADATA_MAX_ENTRIES,
    maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES,
  };
}

/**
 * Build a BatchWritePayload from the current write buffer.
 * Files + all their parent directories become inodes; file content is
 * chunked at CHUNK_SIZE boundaries to match sqlite-vfs.
 */
function buildPayload(writeBuffer, dirBuffer, deleteSet, metadata, authoritativeRoot) {
  const inodes = [];
  const chunks = [];
  const dirs = new Set();
  const mtime = Date.now();

  // Collect all parent directories for files.
  for (const [path] of writeBuffer) {
    collectDirectoryPaths(dirs, parentOf(path), authoritativeRoot);
  }
  // Explicit mkdir entries
  for (const d of dirBuffer) {
    if (!d) continue;
    collectDirectoryPaths(dirs, d, authoritativeRoot);
  }

  for (const dir of dirs) {
    const entry = metadata.get(dir);
    if (entry && entry.kind === 'dir') {
      entry.atimeMs = mtime;
      entry.mtimeMs = mtime;
      entry.ctimeMs = mtime;
    }
    inodes.push({
      path: dir, parentPath: parentOf(dir), kind: 'directory', isDir: true,
      size: 0,
      mtime,
      mode: entry && entry.kind === 'dir' ? entry.mode : 0o755,
      chunkCount: 0,
    });
  }

  for (const [path, data] of writeBuffer) {
    const size = data.length;
    const chunkCount = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
    const entry = metadata.get(path);
    if (entry && (entry.kind === 'file' || entry.kind === 'symlink')) {
      entry.atimeMs = mtime;
      entry.mtimeMs = mtime;
      entry.ctimeMs = mtime;
    }
    inodes.push({
      path, parentPath: parentOf(path),
      kind: entry && entry.kind === 'symlink' ? 'symlink' : 'file',
      isDir: false,
      size,
      mtime,
      mode: entry && (entry.kind === 'file' || entry.kind === 'symlink')
        ? entry.mode
        : 0o644,
      chunkCount,
    });
    if (size === 0) continue;
    if (size <= CHUNK_SIZE) {
      chunks.push({ path, chunkId: 0, data });
    } else {
      for (let i = 0; i < chunkCount; i++) {
        chunks.push({
          path, chunkId: i,
          data: data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        });
      }
    }
  }

  const deletePaths = deleteSet && deleteSet.size > 0 ? [...deleteSet] : undefined;
  return { inodes, chunks, deletePaths };
}

function collectDirectoryPaths(paths, path, authoritativeRoot) {
  let current = path;
  while (current) {
    if (authoritativeRoot &&
        current !== authoritativeRoot &&
        !current.startsWith(authoritativeRoot + '/')) break;
    paths.add(current);
    if (current === authoritativeRoot) break;
    current = parentOf(current);
  }
}

/**
 * Create the buffered fs adapter isomorphic-git will use.
 * Writes buffer in-memory; reads check buffer then fall back to supervisor.
 */
function createBufferedFs(supervisor, stats, authoritativeRoot, authoritativeRootMetadata) {
  const writeBuffer = new Map(); // path → Uint8Array (insertion ordered = FIFO)
  const pendingWriteMetadata = new Map();
  const dirBuffer = new Set();
  const deleteBuffer = new Set();
  const metadata = new Map();
  const children = new Map();
  const textEncoder = new TextEncoder();
  let metadataAccountedBytes = 0;
  let bufferBytes = 0;
  let flushInFlight = null;
  let flushFailure = null;
  let mutationQueue = Promise.resolve();

  function assertFlushHealthy() {
    if (flushFailure) throw flushFailure;
  }

  async function awaitPendingFlush() {
    if (flushInFlight) await flushInFlight;
    assertFlushHealthy();
  }

  async function awaitReadableOverlay() {
    for (const entry of pendingWriteMetadata.values()) {
      if (entry.kind !== 'symlink') continue;
      await flushWave();
      return;
    }
    await awaitPendingFlush();
  }

  function isAuthoritativePath(path) {
    return authoritativeRoot !== null &&
      (path === authoritativeRoot || path.startsWith(authoritativeRoot + '/'));
  }

  function metadataCost(path, entry) {
    const targetBytes = entry.kind === 'symlink'
      ? textEncoder.encode(entry.target).byteLength
      : 0;
    return METADATA_ENTRY_OVERHEAD_BYTES + textEncoder.encode(path).byteLength + targetBytes;
  }

  function addChild(path) {
    const parent = parentOf(path);
    let names = children.get(parent);
    if (!names) children.set(parent, names = new Set());
    const name = path.slice(parent ? parent.length + 1 : 0);
    if (name) names.add(name);
  }

  function removeChild(path) {
    const parent = parentOf(path);
    const names = children.get(parent);
    if (!names) return;
    const name = path.slice(parent ? parent.length + 1 : 0);
    names.delete(name);
    if (names.size === 0) children.delete(parent);
  }

  function setMetadata(path, entry) {
    if (!isAuthoritativePath(path)) return;
    const previous = metadata.get(path);
    const previousCost = previous ? metadataCost(path, previous) : 0;
    const nextCost = metadataCost(path, entry);
    const nextEntries = metadata.size + (previous ? 0 : 1);
    const nextBytes = metadataAccountedBytes - previousCost + nextCost;
    if (nextEntries > METADATA_MAX_ENTRIES || nextBytes > METADATA_MAX_ACCOUNTED_BYTES) {
      const error = new Error(
        'git clone metadata overlay exceeded its bound (' + nextEntries + ' entries, ' +
        nextBytes + ' accounted bytes)',
      );
      flushFailure = error;
      throw error;
    }
    metadata.set(path, entry);
    metadataAccountedBytes = nextBytes;
    if (!previous) addChild(path);
    if (entry.kind === 'dir' && !children.has(path)) children.set(path, new Set());
  }

  function removeMetadata(path, recursive) {
    if (!isAuthoritativePath(path)) return;
    const paths = [path];
    if (recursive) {
      for (let index = 0; index < paths.length; index++) {
        const parent = paths[index];
        for (const name of children.get(parent) || []) {
          paths.push(parent + '/' + name);
        }
      }
    }
    paths.sort((left, right) => right.length - left.length);
    for (const candidate of paths) {
      const previous = metadata.get(candidate);
      if (!previous) continue;
      metadataAccountedBytes -= metadataCost(candidate, previous);
      metadata.delete(candidate);
      children.delete(candidate);
      removeChild(candidate);
    }
  }

  function ensureMetadataParents(path, timestamp) {
    if (!isAuthoritativePath(path)) return;
    let parent = parentOf(path);
    while (isAuthoritativePath(parent)) {
      if (!metadata.has(parent)) {
        setMetadata(parent, {
          kind: 'dir', size: 0, mode: 0o755,
          mtimeMs: timestamp, ctimeMs: timestamp, atimeMs: timestamp,
        });
      }
      if (parent === authoritativeRoot) break;
      parent = parentOf(parent);
    }
  }

  function recordDirectory(path) {
    if (!isAuthoritativePath(path)) return;
    const existing = metadata.get(path);
    if (existing && existing.kind === 'dir') return;
    const now = Date.now();
    ensureMetadataParents(path, now);
    setMetadata(path, {
      kind: 'dir', size: 0, mode: 0o755,
      mtimeMs: now, ctimeMs: now, atimeMs: now,
    });
  }

  function resolveMetadataPath(path, followFinal = true) {
    const seen = new Set();
    let current = normalizePath(path);
    for (let depth = 0; depth < 40; depth++) {
      const parts = current.split('/').filter(Boolean);
      let prefix = '';
      let followed = false;
      for (let index = 0; index < parts.length; index++) {
        prefix = prefix ? prefix + '/' + parts[index] : parts[index];
        const entry = metadata.get(prefix);
        if (!entry) continue;
        const isFinal = index === parts.length - 1;
        if (entry.kind === 'symlink' && (followFinal || !isFinal)) {
          if (seen.has(prefix)) throw eloop(path);
          seen.add(prefix);
          const target = entry.target.startsWith('/')
            ? normalizePath(entry.target)
            : normalizePath(parentOf(prefix) + '/' + entry.target);
          const remainder = parts.slice(index + 1).join('/');
          current = remainder ? normalizePath(target + '/' + remainder) : target;
          followed = true;
          break;
        }
        if (!isFinal && entry.kind !== 'dir') throw enotdir(path);
      }
      if (!followed) return { path: current, entry: metadata.get(current) };
    }
    throw eloop(path);
  }

  function overlayStats() {
    return {
      entries: metadata.size,
      accountedBytes: metadataAccountedBytes,
      maxEntries: METADATA_MAX_ENTRIES,
      maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES,
    };
  }

  if (authoritativeRoot !== null && authoritativeRootMetadata) {
    setMetadata(authoritativeRoot, authoritativeRootMetadata);
  }

  function bufferedOwnership(extraPath, includeParents = true) {
    const paths = new Set(deleteBuffer);
    for (const path of dirBuffer) {
      if (!path) continue;
      collectDirectoryPaths(paths, path, authoritativeRoot);
    }
    for (const path of writeBuffer.keys()) {
      paths.add(path);
      collectDirectoryPaths(paths, parentOf(path), authoritativeRoot);
    }
    if (extraPath) {
      paths.add(extraPath);
      if (includeParents) {
        collectDirectoryPaths(paths, parentOf(extraPath), authoritativeRoot);
      }
    }
    let pathBytes = 0;
    for (const path of paths) pathBytes += textEncoder.encode(path).byteLength;
    return { pathCount: paths.size, pathBytes };
  }

  function hasBufferedMutations() {
    return writeBuffer.size > 0 || dirBuffer.size > 0 || deleteBuffer.size > 0;
  }

  // The supervisor's RPC class exposes the required W7
  // writeBatchStream() protocol.
  // encodeWriteBatchStream is a top-level function in the W7 frame
  // preamble that's been prepended to this worker's main module
  // source (see the modules map at the top of execGitNetwork).
  // It's a module-local identifier — referenced as a bare name
  // exactly like the npm install-batch-facet does at
  // src/npm/install-batch-facet.ts:429.
  //
  // Producer waves are an optimization: they pre-flush before 4 MiB or the
  // headroom threshold and serialize RPCs. Oversize single files are permitted;
  // receiver-side weighted credit and transaction limits are the hard bound.
  async function doFlushWave() {
    assertFlushHealthy();
    if (writeBuffer.size === 0 && dirBuffer.size === 0 && deleteBuffer.size === 0) return;
    try {
      const waveMetadataEntries = [...pendingWriteMetadata];
      const waveMetadata = new Map(metadata);
      for (const [path, entry] of waveMetadataEntries) waveMetadata.set(path, entry);
      const payload = buildPayload(
        writeBuffer,
        dirBuffer,
        deleteBuffer,
        waveMetadata,
        authoritativeRoot,
      );
    // Snapshot stats counters BEFORE clearing the buffers so the increments
    // below see the wave's true size, not zero.
    const wavefilesWritten = writeBuffer.size;
    const wavebytesWritten = bufferBytes;
    // Release facet-side buffer references BEFORE awaiting the RPC.
    //
    // After buildPayload, payload.chunks aliases each writeBuffer entry's
    // Uint8Array (the small-file path; large-file path uses fresh slices).
    // payload is the only consumer that needs those bytes for the duration
    // of the await. Holding them in writeBuffer too just doubles facet-side
    // residency during the await.
    //
    // Empirically (Q4 prod verification at probe-prod-post-fix-2026-05-09T14-54-31Z.txt)
    // the facet OOMs around the third long-clone wave on a real repo
    // with the buffers retained. Releasing them here means the writeBuffer
    // Map drops to size 0, the underlying Uint8Array entries are reachable
    // ONLY through payload.chunks, and as the W7 encoder advances past
    // each chunk the JS engine can collect the consumed entries. Net
    // facet-side residency during the await drops from ~2× wave bytes
    // to ~1× wave bytes.
    //
    // Safety: if the await throws, the outer fetch handler calls flushWave()
    // again best-effort. writeBuffer is already empty, so that is a no-op.
    // The typed result reports any path groups durably published before the
    // failure; replaying the git operation safely replaces those paths again.
    writeBuffer.clear();
    pendingWriteMetadata.clear();
    dirBuffer.clear();
    deleteBuffer.clear();
    bufferBytes = 0;
    // W7 streaming path. encodeWriteBatchStream is a top-level
    // function in the prepended W7_FRAME_PREAMBLE source. The pre-W7
    // structured-clone fallback (writeBatch) was deleted in the
    // legacy-cleanup wave — all live supervisors carry the streaming
    // RPC since 2026-05-09 (commit 89a64ef9).
    // @ts-ignore — preamble symbol injected at module-prepend time.
    const stream = encodeWriteBatchStream(payload);
    stats.supervisorRpc.writeBatchStream++;
      await useRpcResult(
        supervisor.writeBatchStream(stream),
        result => requireWriteBatchStreamSuccess(result),
      );
      for (const [path, entry] of waveMetadataEntries) setMetadata(path, entry);
      stats.filesWritten += wavefilesWritten;
      stats.bytesWritten += wavebytesWritten;
    } catch (error) {
      flushFailure = error;
      throw error;
    }
  }

  async function flushWave() {
    const prior = flushInFlight;
    const current = (async () => {
      if (prior) {
        try { await prior; } catch { /* this caller still drains its own wave */ }
      }
      await doFlushWave();
    })();
    flushInFlight = current;
    try { await current; }
    finally {
      if (flushInFlight === current) flushInFlight = null;
    }
  }

  async function maybeFlush() {
    const ownership = bufferedOwnership();
    if (ownership.pathCount >= WAVE_PATHS ||
        ownership.pathBytes >= WAVE_PATH_BYTES ||
        bufferBytes >= WAVE_BYTES) {
      await flushWave();
    }
  }

  function bufferMutation(path, nextBytes, includeParents, mutate) {
    const operation = mutationQueue.then(async () => {
      assertFlushHealthy();
      while (hasBufferedMutations()) {
        const ownership = bufferedOwnership(path, includeParents);
        const replacedBytes = writeBuffer.get(path)?.length || 0;
        if (bufferBytes - replacedBytes + nextBytes <= WAVE_BYTES &&
            ownership.pathCount < WAVE_PATHS &&
            ownership.pathBytes < WAVE_PATH_BYTES) break;
        await flushWave();
      }
      const ownership = bufferedOwnership(path, includeParents);
      if (ownership.pathCount > W7_PATH_LIMIT) {
        throw new Error('git write wave exceeds ' + W7_PATH_LIMIT + ' owned paths');
      }
      if (ownership.pathBytes > W7_PATH_BYTES_LIMIT) {
        throw new Error(
          'git write wave exceeds ' + W7_PATH_BYTES_LIMIT + ' owned path bytes',
        );
      }
      return mutate();
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  const fs = {
    promises: {
      async readFile(filepath, opts) {
        assertFlushHealthy();
        await awaitReadableOverlay();
        const p = normalizePath(filepath);
        // Check buffer first (FIFO insertion order preserves what git wrote)
        if (writeBuffer.has(p)) {
          const data = writeBuffer.get(p);
          if (opts && opts.encoding === 'utf8') return new TextDecoder().decode(data);
          return data;
        }
        if (deleteBuffer.has(p)) {
          throw enoent(filepath);
        }
        const resolved = resolveMetadataPath(p);
        const durablePath = resolved.path;
        if (durablePath !== p && writeBuffer.has(durablePath)) {
          const data = writeBuffer.get(durablePath);
          if (opts && opts.encoding === 'utf8') return new TextDecoder().decode(data);
          return data;
        }
        if (resolved.entry && resolved.entry.kind === 'dir') throw enoent(filepath);
        if (!resolved.entry && isAuthoritativePath(durablePath)) throw enoent(filepath);

        // Fall through to the supervisor. Ordinary RPC values have a 32 MiB
        // structured-clone ceiling, so reconstruct larger files through the
        // existing bounded range RPC instead of sending one oversized value.
        // This is intentionally size-based rather than pack-path-specific: it
        // preserves the fs.readFile contract for every large binary file.
        if (resolved.entry && flushInFlight) await flushInFlight;
        let size = resolved.entry && resolved.entry.kind === 'file'
          ? resolved.entry.size
          : null;
        if (size === null) {
          stats.supervisorRpc.stat++;
          size = await useRpcResult(
            supervisor.stat(durablePath),
            (result) => result === null || result === undefined ? null : Number(result.size),
          );
        }
        if (size === null) throw enoent(filepath);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw eio(filepath, 'invalid file size ' + String(size));
        }

        let data;
        if (size > WHOLE_FILE_RPC_SAFE_BYTES) {
          data = new Uint8Array(size);
          for (let offset = 0; offset < size;) {
            const expected = Math.min(READ_RANGE_BYTES, size - offset);
            stats.supervisorRpc.fsReadRange++;
            const bytesRead = await useRpcResult(
              supervisor.fsReadRange(durablePath, offset, expected),
              (result) => {
                if (result === null || result === undefined) {
                  throw eio(filepath, 'range ' + offset + '..' + (offset + expected) + ' is missing');
                }
                const chunk = result instanceof Uint8Array ? result : new Uint8Array(result);
                if (chunk.byteLength !== expected) {
                  throw eio(
                    filepath,
                    'range ' + offset + '..' + (offset + expected) +
                      ' returned ' + chunk.byteLength + ' bytes',
                  );
                }
                data.set(chunk, offset);
                return chunk.byteLength;
              },
            );
            offset += bytesRead;
          }
        } else {
          stats.supervisorRpc.readFile++;
          data = await useRpcResult(supervisor.readFileBytes(durablePath), (result) => {
            if (result === null || result === undefined) throw enoent(filepath);
            const content = result instanceof Uint8Array ? result : new Uint8Array(result);
            return content.slice();
          });
        }
        if (opts && opts.encoding === 'utf8') return new TextDecoder().decode(data);
        return data;
      },

      async writeFile(filepath, data, opts) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        // Single-ownership at ingress (fetch-once-consume-once).
        //
        // The W7 streaming path (writeBatchStream) enqueues each chunk's
        // Uint8Array into a type:'bytes' ReadableStream that traverses the
        // RPC boundary; workerd transfers each enqueued buffer's underlying
        // ArrayBuffer to the receiver. If ANY other live reference to that
        // ArrayBuffer (or any view over it) exists when transfer happens,
        // the next operation that constructs a typed-array view over the
        // detached buffer throws
        //   "Cannot perform Construct on a detached ArrayBuffer"
        // inside the byte-stream RPC machinery — the prod-only failure
        // (pre-fix prod d185e0d1).
        //
        // Aliasing sources observed (Q4-A first-deploy verification at
        // probe-prod-post-fix-2026-05-09T14-54-31Z.txt = OK,
        // Q4-B refined-fix verification at
        // probe-prod-post-fix-2026-05-09T15-04-00Z.txt = REGRESSED back
        // to detached-AB at 2 s):
        //   - isomorphic-git's pack indexer passes subarray() views of a
        //     packfile-sized parent ArrayBuffer to writeFile. Different
        //     paths share the same parent. Caught by a subarray-only
        //     copy strategy.
        //   - SAME parent ArrayBuffer can also be passed as a WHOLE-view
        //     Uint8Array (byteOffset=0, length=buffer.byteLength) by
        //     pako's inflate output reuse pattern (pako pools its output
        //     buffers). Two consecutive writeFile calls can then share
        //     a parent without ANY of them being a "subarray" by the
        //     isolated-view test. NOT caught by subarray-only copy —
        //     the Q4-B regression confirms this empirically.
        //
        // Fix: UNCONDITIONAL copy on the Uint8Array path. ONE invariant
        // at ONE ingress point: every writeBuffer entry has its own
        // dedicated ArrayBuffer, no shared parent with anything the
        // caller owns. Memory cost is real (one O(N) byte copy per
        // writeFile) but correctness is mandatory.
        //
        // Companion fix: flushWave above releases writeBuffer references
        // BEFORE awaiting the writeBatchStream RPC. Without that, the
        // copies here would double facet-side residency during the await
        // and surface a separate latent wrapper-isolate OOM during long
        // checkouts. Together, the writeFile copy + flushWave clear-
        // before-await keep the facet's heap bounded by ~1× wave bytes
        // (the live payload variable), not 2×.
        //
        // Q4 prod e2e verification:
        //   - probe-prod-post-fix-2026-05-09T14-54-31Z.txt: copy WITHOUT
        //     clear-before-await → OOM at frame 1450/1601, 46 568 ms wall.
        //     Same 1450 stop-point as the original P3-era freeze, but
        //     a different cause (now memory, not the OOM-on-stat dead-
        //     lock the original P3 fix addressed).
        //   - probe-prod-post-fix-2026-05-09T15-09-30Z.txt: copy WITH
        //     clear-before-await → CLONE PASS in 11.1 s, 1609 files,
        //     final frame 1601/1601 (loaded === total).
        let buf;
        if (typeof data === 'string') {
          buf = new TextEncoder().encode(data); // fresh ArrayBuffer
        } else if (data instanceof Uint8Array) {
          // new Uint8Array(N) + .set(data) allocates a fresh ArrayBuffer
          // of length N and copies bytes from data. The result has zero
          // aliasing relation to data.buffer.
          buf = new Uint8Array(data.length);
          buf.set(data);
        } else {
          // ArrayBuffer (or ArrayBufferView w/o Uint8Array). Construct a
          // Uint8Array over a fresh ArrayBuffer, copy bytes in.
          const src = new Uint8Array(data);
          buf = new Uint8Array(src.length);
          buf.set(src);
        }
        return bufferMutation(p, buf.length, true, async () => {
          const now = Date.now();
          ensureMetadataParents(p, now);
          const mode = opts && (Number(opts.mode) & 0o111) ? 0o755 : 0o644;
          const fileMetadata = {
            kind: 'file', size: buf.length, mode,
            mtimeMs: now, ctimeMs: now, atimeMs: now,
          };
          setMetadata(p, fileMetadata);
          pendingWriteMetadata.set(p, fileMetadata);
          // Remove from deleteBuffer if previously deleted
          deleteBuffer.delete(p);
          // Replace in writeBuffer (size delta tracked)
          if (writeBuffer.has(p)) {
            bufferBytes -= writeBuffer.get(p).length;
          }
          writeBuffer.set(p, buf);
          bufferBytes += buf.length;
          await maybeFlush();
        });
      },

      async unlink(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        return bufferMutation(p, 0, false, async () => {
          if (writeBuffer.has(p)) {
            bufferBytes -= writeBuffer.get(p).length;
            writeBuffer.delete(p);
          }
          pendingWriteMetadata.delete(p);
          deleteBuffer.add(p);
          removeMetadata(p, false);
          await maybeFlush();
        });
      },

      async readdir(filepath) {
        assertFlushHealthy();
        await awaitReadableOverlay();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p);
        const local = resolved.entry;
        if (local || isAuthoritativePath(resolved.path)) {
          if (!local) throw enoent(filepath);
          if (local.kind !== 'dir') throw enotdir(filepath);
          return [...(children.get(resolved.path) || [])];
        }
        // Start with supervisor's view
        let names = [];
        stats.supervisorRpc.readdir++;
        const entries = await useRpcResult(supervisor.readdir(resolved.path), (result) => result);
        names = Array.isArray(entries) ? entries.map(e => e.name) : [];
        const set = new Set(names);
        // Add buffered children: anything whose parent == p
        const prefix = resolved.path ? resolved.path + '/' : '';
        for (const [bp] of writeBuffer) {
          if (!bp.startsWith(prefix)) continue;
          const rest = bp.slice(prefix.length);
          if (!rest) continue;
          const firstSeg = rest.split('/')[0];
          if (firstSeg) set.add(firstSeg);
        }
        for (const bd of dirBuffer) {
          if (!bd.startsWith(prefix)) continue;
          const rest = bd.slice(prefix.length);
          if (!rest) continue;
          const firstSeg = rest.split('/')[0];
          if (firstSeg) set.add(firstSeg);
        }
        // Remove deleted
        for (const dp of deleteBuffer) {
          if (!dp.startsWith(prefix)) continue;
          const rest = dp.slice(prefix.length);
          if (rest.indexOf('/') < 0) set.delete(rest);
        }
        return [...set];
      },

      async mkdir(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        if (!p) return;
        return bufferMutation(p, 0, true, async () => {
          recordDirectory(p);
          dirBuffer.add(p);
          deleteBuffer.delete(p);
          // Also add all ancestors
          const parts = p.split('/');
          for (let i = 1; i < parts.length; i++) {
            const anc = parts.slice(0, i).join('/');
            if (anc) {
              dirBuffer.add(anc);
              recordDirectory(anc);
            }
          }
          await maybeFlush();
        });
      },

      async rmdir(filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        return bufferMutation(p, 0, false, async () => {
          dirBuffer.delete(p);
          deleteBuffer.add(p);
          removeMetadata(p, true);
          await maybeFlush();
        });
      },

      async stat(filepath) {
        assertFlushHealthy();
        await awaitReadableOverlay();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p);
        if (resolved.entry) return statObj(resolved.entry, true);
        if (isAuthoritativePath(resolved.path)) throw enoent(filepath);
        const now = Date.now();
        if (writeBuffer.has(p)) {
          const pending = pendingWriteMetadata.get(p);
          return statObj(pending || {
            kind: 'file', size: writeBuffer.get(p).length, mode: 0o644,
            mtimeMs: now, ctimeMs: now, atimeMs: now,
          }, true);
        }
        if (dirBuffer.has(p)) return statObj({
          kind: 'dir', size: 0, mode: 0o755,
          mtimeMs: now, ctimeMs: now, atimeMs: now,
        }, true);
        if (deleteBuffer.has(p)) throw enoent(filepath);
        if (!p) return statObj({
          kind: 'dir', size: 0, mode: 0o755,
          mtimeMs: now, ctimeMs: now, atimeMs: now,
        }, true);
        stats.supervisorRpc.stat++;
        const st = await useRpcResult(supervisor.stat(resolved.path), (result) => result);
        if (!st) throw enoent(filepath);
        return convertSupervisorStat(st);
      },

      async lstat(filepath) {
        assertFlushHealthy();
        await awaitReadableOverlay();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p, false);
        const local = resolved.entry;
        if (local) return statObj(local, false);
        if (isAuthoritativePath(resolved.path)) throw enoent(filepath);
        const now = Date.now();
        if (writeBuffer.has(resolved.path)) {
          const pending = pendingWriteMetadata.get(resolved.path);
          return statObj(pending || {
            kind: 'file', size: writeBuffer.get(resolved.path).length, mode: 0o644,
            mtimeMs: now, ctimeMs: now, atimeMs: now,
          }, false);
        }
        if (dirBuffer.has(resolved.path)) return statObj({
          kind: 'dir', size: 0, mode: 0o755,
          mtimeMs: now, ctimeMs: now, atimeMs: now,
        }, false);
        if (deleteBuffer.has(resolved.path)) throw enoent(filepath);
        if (!resolved.path) return statObj({
          kind: 'dir', size: 0, mode: 0o755,
          mtimeMs: now, ctimeMs: now, atimeMs: now,
        }, false);
        stats.supervisorRpc.lstat++;
        const st = await useRpcResult(supervisor.lstat(resolved.path), (result) => result);
        if (!st) throw enoent(filepath);
        return convertSupervisorStat(st);
      },

      async chmod() { /* no-op */ },
      async symlink(target, filepath) {
        assertFlushHealthy();
        const p = normalizePath(filepath);
        const value = String(target);
        const data = textEncoder.encode(value);
        return bufferMutation(p, data.length, true, async () => {
          const now = Date.now();
          ensureMetadataParents(p, now);
          const linkMetadata = {
            kind: 'symlink', target: value,
            size: data.byteLength,
            mode: 0o777,
            mtimeMs: now, ctimeMs: now, atimeMs: now,
          };
          setMetadata(p, linkMetadata);
          pendingWriteMetadata.set(p, linkMetadata);
          deleteBuffer.delete(p);
          if (writeBuffer.has(p)) bufferBytes -= writeBuffer.get(p).length;
          writeBuffer.set(p, data);
          bufferBytes += data.byteLength;
          await maybeFlush();
        });
      },
      async readlink(filepath) {
        assertFlushHealthy();
        await awaitReadableOverlay();
        const p = normalizePath(filepath);
        const resolved = resolveMetadataPath(p, false);
        const local = resolved.entry;
        if (local && local.kind === 'symlink') return local.target;
        if (local) throw einval(filepath);
        if (isAuthoritativePath(resolved.path)) throw enoent(filepath);
        stats.supervisorRpc.readlink++;
        return useRpcResult(supervisor.readlink(resolved.path), result => {
          if (result === null || result === undefined) throw enoent(filepath);
          return String(result);
        });
      },
    },
  };

  return { fs, flushWave, overlayStats };
}

export default {
  async fetch(request, workerEnv) {
    const supervisor = workerEnv && workerEnv.SUPERVISOR;
    if (!supervisor) {
      return Response.json({
        success: false, error: 'SUPERVISOR binding missing in facet env',
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 500 });
    }

    let opts;
    try {
      opts = await request.json();
    } catch (e) {
      return Response.json({
        success: false, error: 'Invalid request body: ' + (e && e.message),
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: createSupervisorRpcCounters(),
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 400 });
    }

    const stats = {
      filesWritten: 0,
      bytesWritten: 0,
      supervisorRpc: createSupervisorRpcCounters(),
    };
    const log = (msg) => {
      stats.supervisorRpc.stdout++;
      try { useRpcResult(supervisor.stdout(msg), () => undefined).catch(() => {}); } catch {}
    };

    // Import the pre-bundled isomorphic-git + http/web.
    // The bundle is provided via LOADER.load()'s modules record;
    // see scripts/bundle-git.mjs and src/git-bundle.generated.ts.
    let git, http;
    try {
      const bundle = await import('./git-bundle.js');
      git = bundle.git;
      // http/web has both { request } named and { default: { request } };
      // the namespace bundle.gitHttp exposes request directly, which is
      // what isomorphic-git looks for.
      http = bundle.gitHttp;
    } catch (e) {
      return Response.json({
        success: false, error: 'Failed to load bundled isomorphic-git: ' + (e && e.message),
        filesWritten: 0, bytesWritten: 0,
        supervisorRpc: stats.supervisorRpc,
        metadataOverlay: emptyMetadataOverlayStats(),
      }, { status: 500 });
    }

    // Throttle onProgress emissions to ≥100ms apart (audit R1).
    // isomorphic-git fires this callback per packfile object — thousands
    // of times for a medium repo. Each call does supervisor.stdout(...),
    // a facet→supervisor RPC that consumes input-gate time on the
    // supervisor DO and serialises behind other in-flight async work
    // (including shell keystrokes). Also emit unconditionally on phase
    // completion (loaded === total) so users still see the final frame
    // and any phase transition.
    let lastLogAt = 0;
    let lastLoggedPhase = '';
    const onProgress = async (e) => {
      if (!e || !e.phase) return;
      const now = Date.now();
      const phaseChanged = e.phase !== lastLoggedPhase;
      const phaseDone = e.total && e.loaded === e.total;
      const dueByTime = now - lastLogAt >= 100;
      if (!phaseChanged && !phaseDone && !dueByTime) return;
      lastLogAt = now;
      lastLoggedPhase = e.phase;
      log('\\r[git] ' + e.phase + ' ' + (e.loaded || 0) + '/' + (e.total || '?'));
    };
    const onAuth = () => opts.auth || { username: '', password: '' };

    let flushWave = async () => {};
    let overlayStats = emptyMetadataOverlayStats;
    try {
      if (typeof opts.dir !== 'string') throw new Error('git ' + opts.op + ': dir required');
      let authoritativeRoot = null;
      let authoritativeRootMetadata = null;
      if (opts.op === 'clone') {
        if (!opts.url) throw new Error('clone: url required');
        const cloneRoot = normalizePath(opts.dir);
        if (!cloneRoot) {
          throw new Error('fatal: destination path ' + JSON.stringify(opts.dir) +
            ' already exists and is not an empty directory.');
        }
        let existing = null;
        let firstMissing = null;
        const cloneRootParts = cloneRoot.split('/');
        for (let index = 0; index < cloneRootParts.length; index++) {
          const candidate = cloneRootParts.slice(0, index + 1).join('/');
          const isFinal = index === cloneRootParts.length - 1;
          stats.supervisorRpc.lstat++;
          const candidateStat = await useRpcResult(
            supervisor.lstat(candidate),
            result => result,
          );
          const isDirectory = candidateStat &&
            (candidateStat.type === 'directory' || candidateStat.type === 'dir');
          if ((!isFinal && candidateStat && !isDirectory) ||
              (isFinal && candidateStat && candidateStat.type === 'symlink')) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          if (!candidateStat && firstMissing === null) firstMissing = candidate;
          if (isFinal) existing = candidateStat;
        }
        const exclusiveRoot = normalizePath(opts.exclusiveMutationRoot || cloneRoot);
        if (opts.exclusiveDestination === true &&
            (exclusiveRoot !== (firstMissing || cloneRoot) ||
             (cloneRoot !== exclusiveRoot && !cloneRoot.startsWith(exclusiveRoot + '/')))) {
          throw new Error('git clone exclusive mutation root does not cover its destination');
        }
        stats.supervisorRpc.legacySymlinkSubtree++;
        const hasLegacySymlink = await useRpcResult(
          supervisor.hasLegacySymlinkUnder(exclusiveRoot),
          result => result === true,
        );
        if (hasLegacySymlink) {
          throw new Error("fatal: destination path '" + opts.dir +
            "' already exists and is not an empty directory.");
        }
        if (existing) {
          const isDirectory = existing.type === 'directory' || existing.type === 'dir';
          if (!isDirectory) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          stats.supervisorRpc.readdir++;
          const entries = await useRpcResult(supervisor.readdir(cloneRoot), result => result);
          if (!Array.isArray(entries) || entries.length !== 0) {
            throw new Error("fatal: destination path '" + opts.dir +
              "' already exists and is not an empty directory.");
          }
          if (opts.exclusiveDestination === true) {
            authoritativeRootMetadata = metadataFromSupervisorStat(existing);
          }
        }
        if (opts.exclusiveDestination === true) authoritativeRoot = exclusiveRoot;
      }

      const bufferedFs = createBufferedFs(
        supervisor,
        stats,
        authoritativeRoot,
        authoritativeRootMetadata,
      );
      const fs = bufferedFs.fs;
      flushWave = bufferedFs.flushWave;
      overlayStats = bufferedFs.overlayStats;

      if (opts.op === 'clone') {
        if (authoritativeRoot !== null && authoritativeRoot !== normalizePath(opts.dir)) {
          await fs.promises.mkdir(opts.dir);
          await flushWave();
        }
        await git.clone({
          fs, http,
          dir: opts.dir,
          url: opts.url,
          singleBranch: true,
          depth: opts.depth || 1,
          nonBlocking: true,
          batchSize: 50,
          onProgress,
          onAuth,
        });
      } else if (opts.op === 'fetch') {
        await git.fetch({
          fs, http,
          dir: opts.dir,
          remote: opts.remote || 'origin',
          depth: opts.depth,
          singleBranch: true,
          onProgress,
          onAuth,
        });
      } else if (opts.op === 'pull') {
        await git.pull({
          fs, http,
          dir: opts.dir,
          remote: opts.remote || 'origin',
          ref: opts.ref,
          singleBranch: true,
          author: opts.author || { name: 'user', email: 'user@nimbus.dev' },
          onProgress,
          onAuth,
        });
      } else if (opts.op === 'push') {
        await git.push({
          fs, http,
          dir: opts.dir,
          remote: opts.remote || 'origin',
          ref: opts.ref,
          onProgress,
          onAuth,
        });
      } else {
        throw new Error('Unknown op: ' + opts.op);
      }

      // Final flush — commit any remaining buffered writes
      await flushWave();
      log('\\n');

      return Response.json({
        success: true,
        filesWritten: stats.filesWritten,
        bytesWritten: stats.bytesWritten,
        supervisorRpc: stats.supervisorRpc,
        metadataOverlay: overlayStats(),
      });
    } catch (e) {
      // Best-effort flush of partial state so user can inspect what landed
      try { await flushWave(); } catch {}
      return Response.json({
        success: false,
        error: (e && e.message) || String(e),
        filesWritten: stats.filesWritten,
        bytesWritten: stats.bytesWritten,
        supervisorRpc: stats.supervisorRpc,
        metadataOverlay: overlayStats(),
      });
    }
  },
};
`;
}
