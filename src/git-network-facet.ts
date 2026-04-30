/**
 * git-network-facet.ts — Facet-based git clone/fetch/pull.
 *
 * Runs isomorphic-git's network operations (clone/fetch/pull) inside a
 * dynamic worker (LOADER.load) to escape the supervisor DO's CPU budget
 * and to avoid the known DO fetch() hang in wrangler local dev.
 *
 * Architecture:
 *   - Facet holds a buffered fs adapter: writes accumulate in memory
 *   - When buffer reaches WAVE_SIZE files or WAVE_BYTES bytes, flush
 *     via ONE supervisor.writeBatch() RPC (atomic transactionSync).
 *   - At clone end, a final flush commits remaining buffered state.
 *   - Reads fall through: buffer → supervisor.readFile / supervisor.stat.
 *
 * Why this fixes the hang:
 *   - CPU-heavy packfile delta resolution runs in facet (own CPU budget)
 *   - No per-file RPC round-trips — ~1 writeBatch per 500 files
 *   - Packfile network fetch works (facet fetch is reliable, DO fetch hangs)
 *   - cf-git's nonBlocking=true option yields to event loop between batches
 *
 * See docs/analysis in git-network-facet plan — the canonical write-up lives
 * in the PR that introduced this file.
 */

import { getCtxExports } from './ctx-exports.js';
import { CF_COMPAT_DATE } from './constants.js';
import { GIT_BUNDLE_CODE } from './git-bundle.generated.js';

export type GitNetworkOp = 'clone' | 'fetch' | 'pull' | 'push';

export interface GitNetworkOpts {
  op: GitNetworkOp;
  /** Absolute working tree directory (e.g. "/home/user/project") */
  dir: string;
  /** For clone: repository URL */
  url?: string;
  /** For fetch/pull: remote name (default "origin") */
  remote?: string;
  /** For pull: branch name (default current) */
  ref?: string;
  /** Shallow depth; default 1 for clone */
  depth?: number;
  /** Username + password/token */
  auth?: { username: string; password: string };
  /** Author (for pull merges) */
  author?: { name: string; email: string };
  /** Timeout (ms). Default 300_000 (5 min). */
  timeout?: number;
}

export interface GitNetworkResult {
  success: boolean;
  error?: string;
  elapsed: number;
  filesWritten: number;
  bytesWritten: number;
}

/**
 * Run a git network op inside a facet. Returns when complete or timed out.
 */
export async function execGitNetwork(
  ctx: DurableObjectState,
  env: any,
  opts: GitNetworkOpts,
): Promise<GitNetworkResult> {
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
      // Facet gets both its own code AND the pre-bundled isomorphic-git.
      // The facet imports the bundle at runtime — NO node_modules access
      // is needed in the dynamic worker. Both modules are siblings.
      modules: {
        'git-network-worker.js': generateGitNetworkFacetCode(),
        'git-bundle.js': GIT_BUNDLE_CODE,
      },
      env: { SUPERVISOR: supervisorBinding },
    });
    const entrypoint = worker.getEntrypoint();

    // Every one of (worker, entrypoint, response, supervisorBinding) may be
    // a cross-isolate RPC stub. Without explicit disposal they accumulate
    // in the supervisor's live-reference set until the enclosing DO request
    // returns — and during an npm install that request lives for tens of
    // seconds, during which git clone + 200 packument resolves can each
    // contribute stubs. When enough pile up, workerd's isolate-shutdown
    // queue trips `queueState != ACTIVE` (see WORKERD-CRASH.md).
    //
    // Helper: best-effort Symbol.dispose. ES2023 added the symbol; the
    // tsconfig target is ES2022, so we reach for it via any-cast. Non-RPC
    // objects have no dispose handler and the call is a no-op.
    const disposerKey = (Symbol as any).dispose;
    const dispose = (obj: unknown) => {
      if (!obj || !disposerKey) return;
      const fn = (obj as any)[disposerKey];
      if (typeof fn === 'function') {
        try { fn.call(obj); } catch { /* best-effort */ }
      }
    };

    const timeoutMs = opts.timeout ?? 300_000;
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`git ${opts.op} timed out after ${timeoutMs / 1000}s`)), timeoutMs),
    );
    // Parse the facet's response and dispose its RPC stub before the
    // caller sees the value. A bare `.then(r => r.json())` drops the `r`
    // reference but leaves the stub live until the surrounding event
    // handler completes.
    const call = entrypoint.fetch(new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify(opts),
    })).then(async (r: Response) => {
      try {
        return await r.json();
      } finally {
        dispose(r);
      }
    });

    let result: any;
    try {
      result = await Promise.race([call, timeout]);
    } finally {
      // Tear down the facet's RPC stubs regardless of success / timeout.
      // `entrypoint` and `worker` are both cross-isolate stubs; disposing
      // them lets workerd reclaim the dynamic worker's memory eagerly.
      // `supervisorBinding` is the SupervisorRPC stub we minted above —
      // it's from ctxExports (local to the supervisor's own isolate) so
      // in theory it doesn't leak across isolates, but disposing is cheap
      // and symmetric with how the facet's env.SUPERVISOR is handled on
      // the other side.
      dispose(entrypoint);
      dispose(worker);
      dispose(supervisorBinding);
    }
    return {
      success: !!result?.success,
      error: result?.error,
      elapsed: Date.now() - start,
      filesWritten: Number(result?.filesWritten ?? 0),
      bytesWritten: Number(result?.bytesWritten ?? 0),
    };
  } catch (e: any) {
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
 * fs adapter, flushes writes to supervisor via writeBatch RPC.
 */
function generateGitNetworkFacetCode(): string {
  return `
const CHUNK_SIZE = 65536; // must match sqlite-vfs.ts
const WAVE_FILES = 500;   // flush every N buffered files
const WAVE_BYTES = 4 * 1024 * 1024; // or every 4MB

function normalizePath(p) {
  const parts = String(p || '').split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '..' && out.length > 0) out.pop();
    else if (seg !== '.' && seg !== '' && seg !== undefined) out.push(seg);
  }
  return out.join('/');
}

function parentOf(p) {
  return p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
}

function enoent(filepath) {
  const err = new Error('ENOENT: no such file or directory, ' + filepath);
  err.code = 'ENOENT'; err.errno = -2;
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

  async function flushWave() {
    if (writeBuffer.size === 0 && dirBuffer.size === 0 && deleteBuffer.size === 0) return;
    const payload = buildPayload(writeBuffer, dirBuffer, deleteBuffer);
    try {
      await supervisor.writeBatch(payload);
      stats.filesWritten += writeBuffer.size;
      stats.bytesWritten += bufferBytes;
    } finally {
      writeBuffer.clear();
      dirBuffer.clear();
      deleteBuffer.clear();
      bufferBytes = 0;
    }
  }

  async function maybeFlush() {
    if (writeBuffer.size >= WAVE_FILES || bufferBytes >= WAVE_BYTES) {
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
        // Fall through to supervisor — use byte-preserving RPC for binary safety
        // (git object files, packfiles must NOT round-trip through TextDecoder)
        const content = await supervisor.readFileBytes(p);
        if (content === null || content === undefined) throw enoent(filepath);
        const data = content instanceof Uint8Array ? content : new Uint8Array(content);
        if (opts && opts.encoding === 'utf8') return new TextDecoder().decode(data);
        return data;
      },

      async writeFile(filepath, data, opts) {
        const p = normalizePath(filepath);
        const buf = typeof data === 'string'
          ? new TextEncoder().encode(data)
          : (data instanceof Uint8Array ? data : new Uint8Array(data));
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
          const entries = await supervisor.readdir(p);
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
      },

      async stat(filepath) {
        const p = normalizePath(filepath);
        if (writeBuffer.has(p)) return fileStatObj(writeBuffer.get(p).length);
        if (dirBuffer.has(p)) return dirStatObj();
        if (deleteBuffer.has(p)) throw enoent(filepath);
        if (!p) return dirStatObj();
        const st = await supervisor.stat(p);
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
      try { supervisor.stdout(msg).catch(() => {}); } catch {}
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
