// Host harness for testing the node-shims.ts child_process surface
// without spinning up workerd.
//
// generateShimsCode() produces a string of code that's normally embedded
// inside a facet's run() method, with closure-locals like cwd, stdout,
// stderr, exitCode, env, argv, __vfsBundle, __vfsManifest, __vfsWrites,
// __pendingIO, __supervisor, __ProcessExit etc.
//
// We synthesize those closures here, evaluate the shim string via new
// Function(), and return the resulting __childProcessMod and any
// auxiliaries the tests need (__pendingIO drain, etc.).

import { generateShimsCode } from '../../../src/node-shims.ts';

class __ProcessExit extends Error {
  constructor(code) { super(`process.exit(${code})`); this.code = code; }
}

/**
 * Build a fresh shim host bound to the given mock supervisor.
 * Returns: {
 *   childProcessMod, processMod, eventsMod, streamMod, BufferMod,
 *   pendingIO, getStdout(), getStderr(), getExitCode(),
 *   drainPending(),
 * }
 */
export async function makeShimHost(mockSupervisor, opts = {}) {
  const SHIMS = generateShimsCode();

  // Closure inputs we provide to the wrapper.
  const argv = opts.argv || [];
  const env = opts.env || {};
  let cwd = opts.cwd || '/home/user';
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  const __vfsBundle = opts.vfsBundle || {};
  const __vfsManifest = opts.vfsManifest || {};
  const __vfsWrites = {};
  const __vfsDirs = {};
  const __pendingIO = [];
  const __supervisor = mockSupervisor;
  const __onRpcDrop = () => {};

  // Wrap SHIMS in a function exposing the modules we want to inspect.
  // The shim code defines: __fsMod, __pathMod, __osMod, __eventsMod,
  // __streamMod, __BufferMod, __utilMod, __urlMod, __cryptoMod,
  // __assertMod, __qsMod, __stringDecoderMod, __childProcessMod,
  // __consoleMod, __processMod, builtins, __require, etc.
  //
  // We append a return statement to lift the bits we want.
  const SUFFIX = `
    return {
      childProcessMod: __childProcessMod,
      processMod: __processMod,
      eventsMod: __eventsMod,
      streamMod: __streamMod,
      BufferMod: __BufferMod,
      consoleMod: __consoleMod,
      utilMod: __utilMod,
      builtins,
      __require,
    };
  `;

  // Real node:* imports the SHIMS expects. In the unit test context we
  // can pass undefined for most — the SHIMS code contains forwarding
  // logic that gracefully degrades (per W3 retro). For child_process
  // specifically we don't need any real node:* imports, but if the
  // SHIMS body uses them at top level we must satisfy the bindings.
  // The wrapper signature must match what real-node-imports.ts injects
  // PLUS our closure locals.
  const fn = new Function(
    // All `__real_*` imports the shim might forward to. Pass undefined.
    '__real_crypto', '__real_http2', '__real_repl', '__real_dc',
    '__real_tls', '__real_async_hooks', '__real_vm', '__real_fs',
    '__real_fs_promises', '__real_path', '__real_os', '__real_buffer',
    '__real_events', '__real_stream', '__real_url', '__real_querystring',
    '__real_string_decoder', '__real_child_process',
    // Closure locals
    'argv', 'env', 'cwd', 'stdout', 'stderr', 'exitCode',
    '__vfsBundle', '__vfsManifest', '__vfsWrites', '__vfsDirs',
    '__pendingIO', '__supervisor', '__onRpcDrop', '__ProcessExit',
    SHIMS + SUFFIX,
  );

  const realCrypto = (await import('node:crypto'));
  const realPath = (await import('node:path'));
  const realOs = (await import('node:os'));
  const realEvents = (await import('node:events'));
  const realStream = (await import('node:stream'));
  const realUrl = (await import('node:url'));
  const realBuffer = (await import('node:buffer'));
  const realQs = (await import('node:querystring'));
  const realSd = (await import('node:string_decoder'));

  const out = fn(
    realCrypto,                  // __real_crypto
    undefined,                   // __real_http2 — unused in child_process probes
    undefined,                   // __real_repl
    undefined,                   // __real_dc
    undefined,                   // __real_tls
    undefined,                   // __real_async_hooks
    undefined,                   // __real_vm
    undefined,                   // __real_fs (shim has fallback)
    undefined,                   // __real_fs_promises
    realPath,                    // __real_path
    realOs,                      // __real_os
    realBuffer,                  // __real_buffer
    realEvents,                  // __real_events
    realStream,                  // __real_stream
    realUrl,                     // __real_url
    realQs,                      // __real_querystring
    realSd,                      // __real_string_decoder
    undefined,                   // __real_child_process (we replace)
    argv, env, cwd, stdout, stderr, exitCode,
    __vfsBundle, __vfsManifest, __vfsWrites, __vfsDirs,
    __pendingIO, __supervisor, __onRpcDrop, __ProcessExit,
  );

  return {
    ...out,
    pendingIO: __pendingIO,
    drainPending: async () => {
      // Drain repeatedly with a bounded race so an infinite read-loop
      // (e.g., long-running child whose cpWait never resolves) doesn't
      // hang the test host. Each pass yields after a short timeout.
      // Mirrors facet-manager.ts two-pass drain but with a hard cap.
      const MAX_PASSES = 8;
      const PASS_TIMEOUT_MS = 30;
      for (let i = 0; i < MAX_PASSES; i++) {
        const snapshot = __pendingIO.slice();
        if (snapshot.length === 0) break;
        await Promise.race([
          Promise.allSettled(snapshot),
          new Promise(r => setTimeout(r, PASS_TIMEOUT_MS)),
        ]);
        await new Promise(r => setTimeout(r, 0));
      }
    },
    pause: (ms) => new Promise(r => setTimeout(r, ms)),
  };
}

// ── Mock supervisor that records cp* RPC calls ───────────────────────────

export function makeMockSupervisor() {
  const calls = [];                  // [{method, args, t}]
  const childState = new Map();      // childPid → {stdout, stderr, exitCode, signal, stdinClosed, stdinChunks, seq, sinceSeqByFd}

  let nextChildPid = 1000;

  return {
    calls,
    childState,
    // Spawn — by default echoes args back as stdout.
    cpSpawn: async (req) => {
      calls.push({ method: 'cpSpawn', args: req, t: Date.now() });
      const childPid = nextChildPid++;
      const state = {
        command: req.command, args: req.args || [],
        stdoutChunks: [], stderrChunks: [], seq: 0,
        exitCode: null, signal: null,
        stdinClosed: false, stdinChunks: [],
      };
      childState.set(childPid, state);
      // Synthesize: emit one stdout chunk = args.join(' ') + '\n', then exit 0.
      // Tests can override behavior by substituting a different cpSpawn.
      // But we do schedule it on a microtask so 'data' listeners can attach
      // after spawn().
      queueMicrotask(() => {
        if (req.command === 'echo') {
          state.stdoutChunks.push({ seq: ++state.seq, data: (req.args || []).join(' ') + '\n' });
        } else if (req.command === 'sh' && (req.args || [])[0] === '-c') {
          // Simulate `sh -c <cmd>` — parse a tiny set of patterns the
          // tests use (`echo X`, `echo X; echo Y`).
          const script = (req.args || [])[1] || '';
          // Run each ; or && separated piece as `echo` or pass-through
          for (const piece of script.split(/;|&&/)) {
            const p = piece.trim();
            const m = p.match(/^echo\s+(.*)$/);
            if (m) {
              state.stdoutChunks.push({ seq: ++state.seq, data: m[1].replace(/^["']|["']$/g, '') + '\n' });
            }
          }
        } else if (req.command === 'true') {
          state.exitCode = 0;
        } else if (req.command === 'false') {
          state.exitCode = 1;
        } else if (req.command === 'cat') {
          // Wait for stdin to be closed, then echo it
          // We simulate by polling stdinClosed in the wait/drain loop.
        } else if (req.command === 'node') {
          // Simulate `node -e "console.log(42)"` for execFile probe
          const args = req.args || [];
          if (args[0] === '-e') {
            const m = String(args[1] || '').match(/console\.log\(([^)]+)\)/);
            if (m) state.stdoutChunks.push({ seq: ++state.seq, data: m[1].replace(/['"]/g, '') + '\n' });
          } else {
            // `node script.js` — keep the child "running" so fork's IPC
            // probe can send messages before exit fires. Real node would
            // run the script; the mock leaves exitCode=null until kill.
            state.exitCode = null;
            state._longRunning = true;
          }
        } else if (req.command === '__custom') {
          // Tests may override by setting state.exitCode/stdoutChunks/etc.
        }
        if (state.exitCode === null && req.command !== 'cat' && !state._longRunning) {
          state.exitCode = 0;
        }
      });
      return { childPid };
    },
    cpStdinWrite: async (childPid, data) => {
      calls.push({ method: 'cpStdinWrite', args: { childPid, data }, t: Date.now() });
      const s = childState.get(childPid);
      if (!s) return { ok: false };
      s.stdinChunks.push(data);
      return { ok: true };
    },
    cpStdinEnd: async (childPid) => {
      calls.push({ method: 'cpStdinEnd', args: { childPid }, t: Date.now() });
      const s = childState.get(childPid);
      if (!s) return;
      s.stdinClosed = true;
      // For `cat`, complete now.
      if (s.command === 'cat') {
        for (const d of s.stdinChunks) {
          s.stdoutChunks.push({ seq: ++s.seq, data: d });
        }
        s.exitCode = 0;
      }
    },
    cpReadOutput: async (childPid, fd, sinceSeq, waitMs) => {
      calls.push({ method: 'cpReadOutput', args: { childPid, fd, sinceSeq, waitMs }, t: Date.now() });
      const s = childState.get(childPid);
      if (!s) return { chunks: [], closed: true };
      const arr = fd === 1 ? s.stdoutChunks : s.stderrChunks;
      const fresh = arr.filter(c => c.seq > sinceSeq);
      if (fresh.length === 0 && s.exitCode === null) {
        // Long-poll
        await new Promise(r => setTimeout(r, Math.min(waitMs, 50)));
        const fresh2 = arr.filter(c => c.seq > sinceSeq);
        return { chunks: fresh2, closed: s.exitCode !== null };
      }
      return { chunks: fresh, closed: s.exitCode !== null };
    },
    cpDrainOutput: async (childPid) => {
      calls.push({ method: 'cpDrainOutput', args: { childPid }, t: Date.now() });
      const s = childState.get(childPid);
      if (!s) return { stdout: '', stderr: '', stdoutClosed: true, stderrClosed: true };
      // For `cat`, if not yet ended, drain stdin synthesis now.
      if (s.command === 'cat' && s.exitCode === null) {
        for (const d of s.stdinChunks) s.stdoutChunks.push({ seq: ++s.seq, data: d });
        s.exitCode = 0;
      }
      return {
        stdout: s.stdoutChunks.map(c => c.data).join(''),
        stderr: s.stderrChunks.map(c => c.data).join(''),
        stdoutClosed: true, stderrClosed: true,
      };
    },
    cpKill: async (childPid, signal) => {
      calls.push({ method: 'cpKill', args: { childPid, signal }, t: Date.now() });
      const s = childState.get(childPid);
      if (!s) return false;
      if (s.exitCode !== null) return false;
      s.signal = signal;
      s.exitCode = signal === 'SIGKILL' ? 137 : 143;
      return true;
    },
    cpWait: async (childPid, waitMs) => {
      calls.push({ method: 'cpWait', args: { childPid, waitMs }, t: Date.now() });
      const s = childState.get(childPid);
      if (!s) return { done: true, exitCode: 1, signal: null };
      const t0 = Date.now();
      while (s.exitCode === null && Date.now() - t0 < waitMs) {
        await new Promise(r => setTimeout(r, 10));
      }
      if (s.exitCode === null) return { done: false, exitCode: null, signal: null };
      return { done: true, exitCode: s.exitCode, signal: s.signal };
    },
  };
}
