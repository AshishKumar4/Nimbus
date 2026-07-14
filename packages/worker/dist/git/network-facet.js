/**
 * git-network-facet.ts — Facet-based git clone/fetch/pull.
 *
 * Runs isomorphic-git's network operations (clone/fetch/pull) inside a
 * dynamic worker (LOADER.load) to escape the supervisor DO's CPU budget
 * and to avoid the known DO fetch() hang in wrangler local dev.
 *
 * Architecture:
 *   - Facet holds a buffered fs adapter: writes accumulate in memory
 *   - Pre-flush before an ordinary wave crosses 128 paths or 4 MiB
 *     via ONE supervisor.writeBatchStream() RPC. Each published path is
 *     atomic; a later publish-group failure may leave a committed prefix.
 *   - At clone end, a final flush commits remaining buffered state.
 *   - Reads fall through: buffer → supervisor.readFile / supervisor.stat.
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
            };
        }
        const ctxExports = getCtxExports();
        const supervisorBinding = ctxExports?.SupervisorRPC
            ? ctxExports.SupervisorRPC({ props: { doId: ctx.id.toString(), pid: 0 } })
            : undefined;
        if (!supervisorBinding) {
            return {
                success: false,
                error: 'SupervisorRPC binding not available',
                elapsed: Date.now() - start,
                filesWritten: 0,
                bytesWritten: 0,
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
            //     W7 v2 emits one bounded record per pull; the receiver owns
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
            body: JSON.stringify(opts),
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
        };
    }
    catch (e) {
        return {
            success: false,
            error: e?.message || String(e),
            elapsed: Date.now() - start,
            filesWritten: 0,
            bytesWritten: 0,
        };
    }
}
/**
 * Generate the dynamic worker code for the git network facet.
 *
 * Exports `default { async fetch(request, workerEnv) { ... } }`.
 * Reads op args from the POST body, runs isomorphic-git with a buffered
 * fs adapter, and flushes writes through W7 v2.
 */
export function assembleGitNetworkFacetSource() {
    return W7_FRAME_PREAMBLE + '\n' + generateGitNetworkFacetCode();
}
function generateGitNetworkFacetCode() {
    return `
// CHUNK_SIZE is provided by the W7 frame preamble (from constants.ts),
// prepended to this facet worker — do not redeclare it here.
const WAVE_PATHS = 128;
const WAVE_BYTES = 4 * 1024 * 1024; // or every 4MB
const WHOLE_FILE_RPC_SAFE_BYTES = ${MAX_RPC_SAFE_PAYLOAD_BYTES};
const READ_RANGE_BYTES = 4 * 1024 * 1024;

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

function eio(filepath, detail) {
  const err = new Error('EIO: failed to read ' + filepath + ': ' + detail);
  err.code = 'EIO'; err.errno = -5;
  return err;
}

function dirStatObj() {
  const now = Date.now();
  const d = new Date(now);
  return {
    isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
    size: 0, mode: 0o755, type: 'dir',
    mtimeMs: now, mtime: d, ctimeMs: now, ctime: d, atimeMs: now, atime: d,
    uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
  };
}

function fileStatObj(size) {
  const now = Date.now();
  const d = new Date(now);
  return {
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
    size, mode: 0o644, type: 'file',
    mtimeMs: now, mtime: d, ctimeMs: now, ctime: d, atimeMs: now, atime: d,
    uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
  };
}

function convertSupervisorStat(st) {
  if (!st) return null;
  const mtimeMs = Number(st.mtime) || Date.now();
  const d = new Date(mtimeMs);
  const isDir = st.type === 'directory' || st.type === 'dir';
  return {
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    size: Number(st.size) || 0,
    mode: Number(st.mode) || (isDir ? 0o755 : 0o644),
    type: isDir ? 'dir' : 'file',
    mtimeMs, mtime: d, ctimeMs: mtimeMs, ctime: d, atimeMs: mtimeMs, atime: d,
    uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
  };
}

/**
 * Build a BatchWritePayload from the current write buffer.
 * Files + all their parent directories become inodes; file content is
 * chunked at CHUNK_SIZE boundaries to match sqlite-vfs.
 */
function buildPayload(writeBuffer, dirBuffer, deleteSet) {
  const inodes = [];
  const chunks = [];
  const dirs = new Set();
  const mtime = Date.now();

  // Collect all parent directories for files
  for (const [path] of writeBuffer) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (d) dirs.add(d);
    }
  }
  // Explicit mkdir entries
  for (const d of dirBuffer) {
    if (!d) continue;
    const parts = d.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const pd = parts.slice(0, i).join('/');
      if (pd) dirs.add(pd);
    }
  }

  for (const dir of dirs) {
    inodes.push({
      path: dir, parentPath: parentOf(dir), isDir: true,
      size: 0, mtime, mode: 0o755, chunkCount: 0,
    });
  }

  for (const [path, data] of writeBuffer) {
    const size = data.length;
    const chunkCount = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
    inodes.push({
      path, parentPath: parentOf(path), isDir: false,
      size, mtime, mode: 0o644, chunkCount,
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

/**
 * Create the buffered fs adapter isomorphic-git will use.
 * Writes buffer in-memory; reads check buffer then fall back to supervisor.
 */
function createBufferedFs(supervisor, stats) {
  const writeBuffer = new Map(); // path → Uint8Array (insertion ordered = FIFO)
  const dirBuffer = new Set();
  const deleteBuffer = new Set();
  let bufferBytes = 0;
  let flushInFlight = null;

  function bufferedPaths(extraFilePath) {
    const paths = new Set(deleteBuffer);
    for (const path of dirBuffer) {
      if (!path) continue;
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
    }
    for (const path of writeBuffer.keys()) {
      paths.add(path);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'));
    }
    if (extraFilePath) {
      paths.add(extraFilePath);
      const parts = extraFilePath.split('/');
      for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'));
    }
    return paths.size;
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
  // Producer waves are an optimization: they pre-flush before 4 MiB or
  // 128 paths and serialize RPCs. Oversize single files are permitted;
  // receiver-side weighted credit and transaction limits are the hard bound.
  async function doFlushWave() {
    if (writeBuffer.size === 0 && dirBuffer.size === 0 && deleteBuffer.size === 0) return;
    const payload = buildPayload(writeBuffer, dirBuffer, deleteBuffer);
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
    await useRpcResult(
      supervisor.writeBatchStream(stream),
      result => requireWriteBatchStreamSuccess(result),
    );
    stats.filesWritten += wavefilesWritten;
    stats.bytesWritten += wavebytesWritten;
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
    if (bufferedPaths() >= WAVE_PATHS || bufferBytes >= WAVE_BYTES) {
      await flushWave();
    }
  }

  const fs = {
    promises: {
      async readFile(filepath, opts) {
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
        // Fall through to the supervisor. Ordinary RPC values have a 32 MiB
        // structured-clone ceiling, so reconstruct larger files through the
        // existing bounded range RPC instead of sending one oversized value.
        // This is intentionally size-based rather than pack-path-specific: it
        // preserves the fs.readFile contract for every large binary file.
        const size = await useRpcResult(
          supervisor.stat(p),
          (result) => result === null || result === undefined ? null : Number(result.size),
        );
        if (size === null) throw enoent(filepath);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw eio(filepath, 'invalid file size ' + String(size));
        }

        let data;
        if (size > WHOLE_FILE_RPC_SAFE_BYTES) {
          data = new Uint8Array(size);
          for (let offset = 0; offset < size;) {
            const expected = Math.min(READ_RANGE_BYTES, size - offset);
            const bytesRead = await useRpcResult(
              supervisor.fsReadRange(p, offset, expected),
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
          data = await useRpcResult(supervisor.readFileBytes(p), (result) => {
            if (result === null || result === undefined) throw enoent(filepath);
            const content = result instanceof Uint8Array ? result : new Uint8Array(result);
            return content.slice();
          });
        }
        if (opts && opts.encoding === 'utf8') return new TextDecoder().decode(data);
        return data;
      },

      async writeFile(filepath, data, opts) {
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
        while (hasBufferedMutations() && (
          bufferBytes - (writeBuffer.get(p)?.length || 0) + buf.length > WAVE_BYTES
          || bufferedPaths(p) > WAVE_PATHS
        )) {
          await flushWave();
        }
        // Remove from deleteBuffer if previously deleted
        deleteBuffer.delete(p);
        // Replace in writeBuffer (size delta tracked)
        if (writeBuffer.has(p)) {
          bufferBytes -= writeBuffer.get(p).length;
        }
        writeBuffer.set(p, buf);
        bufferBytes += buf.length;
        await maybeFlush();
      },

      async unlink(filepath) {
        const p = normalizePath(filepath);
        if (writeBuffer.has(p)) {
          bufferBytes -= writeBuffer.get(p).length;
          writeBuffer.delete(p);
        }
        deleteBuffer.add(p);
        await maybeFlush();
      },

      async readdir(filepath) {
        const p = normalizePath(filepath);
        // Start with supervisor's view
        let names = [];
        try {
          const entries = await useRpcResult(supervisor.readdir(p), (result) => result);
          names = Array.isArray(entries) ? entries.map(e => e.name) : [];
        } catch { names = []; }
        const set = new Set(names);
        // Add buffered children: anything whose parent == p
        const prefix = p ? p + '/' : '';
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
        const p = normalizePath(filepath);
        if (!p) return;
        dirBuffer.add(p);
        deleteBuffer.delete(p);
        // Also add all ancestors
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) {
          const anc = parts.slice(0, i).join('/');
          if (anc) dirBuffer.add(anc);
        }
        await maybeFlush();
      },

      async rmdir(filepath) {
        const p = normalizePath(filepath);
        dirBuffer.delete(p);
        deleteBuffer.add(p);
        await maybeFlush();
      },

      async stat(filepath) {
        const p = normalizePath(filepath);
        if (writeBuffer.has(p)) return fileStatObj(writeBuffer.get(p).length);
        if (dirBuffer.has(p)) return dirStatObj();
        if (deleteBuffer.has(p)) throw enoent(filepath);
        if (!p) return dirStatObj();
        const st = await useRpcResult(supervisor.stat(p), (result) => result);
        if (!st) throw enoent(filepath);
        return convertSupervisorStat(st);
      },

      async lstat(filepath) { return this.stat(filepath); },

      async chmod() { /* no-op */ },
      async symlink() { /* no-op */ },
      async readlink(p) { return p; },
    },
  };

  return { fs, flushWave };
}

export default {
  async fetch(request, workerEnv) {
    const supervisor = workerEnv && workerEnv.SUPERVISOR;
    if (!supervisor) {
      return Response.json({
        success: false, error: 'SUPERVISOR binding missing in facet env',
        filesWritten: 0, bytesWritten: 0,
      }, { status: 500 });
    }

    let opts;
    try {
      opts = await request.json();
    } catch (e) {
      return Response.json({
        success: false, error: 'Invalid request body: ' + (e && e.message),
        filesWritten: 0, bytesWritten: 0,
      }, { status: 400 });
    }

    const log = (msg) => {
      try { useRpcResult(supervisor.stdout(msg), () => undefined).catch(() => {}); } catch {}
    };

    const stats = { filesWritten: 0, bytesWritten: 0 };
    const { fs, flushWave } = createBufferedFs(supervisor, stats);

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

    try {
      if (opts.op === 'clone') {
        if (!opts.url) throw new Error('clone: url required');
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
      });
    } catch (e) {
      // Best-effort flush of partial state so user can inspect what landed
      try { await flushWave(); } catch {}
      return Response.json({
        success: false,
        error: (e && e.message) || String(e),
        filesWritten: stats.filesWritten,
        bytesWritten: stats.bytesWritten,
      });
    }
  },
};
`;
}
