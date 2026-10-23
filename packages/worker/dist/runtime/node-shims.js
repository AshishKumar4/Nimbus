/**
 * node-shims.ts — Nimbus v2.0 Node.js runtime shims for dynamic workers.
 *
 * Generates a raw JS string embedded in facet code. Provides:
 *   - fs: full sync/async/promises/streams VFS-backed filesystem
 *   - path: complete POSIX path operations
 *   - os/process: Linux edge environment simulation
 *   - Buffer: Uint8Array wrapper with encoding support
 *   - events: workerd's native node:events
 *   - stream: the platform's node:stream; every stream here is one of its classes
 *   - crypto, zlib, tls, vm, repl, async_hooks, diagnostics_channel,
 *     inspector, string_decoder, perf_hooks: the platform's own, through the
 *     one native provider (__nativeBuiltin), with Nimbus's adapters over them
 *   - dns: real DNS resolution via Cloudflare DNS-over-HTTPS
 *   - http: virtual server with port registry for supervisor routing
 *   - https: fetch()-backed request/get
 *   - net: Socket/Server with connect/write/end
 *   - child_process: ChildProcess objects (execution requires supervisor RPC)
 *   - assert, querystring, punycode and util.inspect: Node's own modules
 *     (node-lib-source.ts) over node-lib-host.ts
 *   - util, url, string_decoder, readline, tty, timers
 *
 * VFS access: every fs call goes through the process's filesystem (core
 * runtime/wasi/resident-filesystem.ts) over the launch's store: a synchronous
 * call through its synchronous face, an asynchronous one through the
 * filesystem itself (__nimbusStartProcessFilesystem).
 */
/**
 * Generate the shared shim block that goes inside both the DO-facet and
 * entrypoint runner code.  The returned string is raw JS (no wrapping).
 *
 * At runtime the following variables must exist in scope:
 *   - __resident: the launch's store (vfs/resident), booted before the
 *     launch calls __nimbusStartProcessFilesystem
 *   - __supervisor: the SUPERVISOR binding, or null
 *   - cred: the process's credential
 *   - cwd: string
 *   - argv, env, filename, dirname: from args
 *   - nodeCommandLine: from args, the NodeLaunch (core runtime/node-cli.ts),
 *     or undefined where a host passes none
 *   - stdout, stderr, exitCode: capture variables
 */
import { generateSqliteShimCode } from './sqlite-shim.js';
import { REAL_NOW_SOURCE } from './stop-replay.js';
import { DECODE_JAVASCRIPT_STRING_LITERAL_SOURCE } from './javascript-string-literal.js';
import { CHILD_NEWS_SOURCE } from '@nimbus-sh/core/runtime/child-news.js';
import { generateUndiciShimCode } from '@nimbus-sh/core/runtime/undici-shim.js';
import { ESM_RESOLVER_PREAMBLE, HTTP2_MODULE_PREAMBLE, NODE_ARGUMENTS_PREAMBLE, NODE_ERROR_PREAMBLE, NODE_SHIM_RESOLUTION_PREAMBLE, NODE_WARNING_PREAMBLE, POSIX_PATH_PREAMBLE, PRIMORDIALS_PREAMBLE, RELATIVE_WASM_PATHS_PREAMBLE, TLS_IDENTITY_PREAMBLE, WASM_IMAGE_KEY_PREAMBLE, } from '../loaders/workers.generated.js';
import { NIMBUS_AI_CREDENTIAL_HEADERS, NIMBUS_AI_TOKEN_ENV } from '@nimbus-sh/core/_shared/ai-egress.js';
import { EGRESS_TLS_REFUSAL } from '@nimbus-sh/core/_shared/workspace-network.js';
import { EGRESS_TLS_CLIENT_SOURCE } from './egress-tls-client.js';
import { LOOPBACK_HOSTNAMES } from '@nimbus-sh/core/_shared/loopback.js';
import { ERRNO_DESCRIPTION } from '@nimbus-sh/core/vfs/vfs-error.js';
import { NODE_SYSTEM, SYSTEM_IDENTITY } from '@nimbus-sh/core/constants.js';
import { DIRENT_TYPES } from '@nimbus-sh/core/vfs/dirent-type.js';
import { STDIN_SYNC_READ_BYTES, STDIN_FILE_READ_PIECE_BYTES } from '@nimbus-sh/core/runtime/stdin-read.js';
import { COMMONJS_WRAPPER_NAMES } from '@nimbus-sh/core/runtime/javascript-ast.js';
import { NODE_SCHEME_ONLY_BUILTINS } from '@nimbus-sh/core/runtime/node-builtins.js';
import { ESM_STAR_CONFLICTS } from '@nimbus-sh/core/runtime/esm-interop.js';
import { ESM_BINDINGS_MODULE, ESM_BUN_SCOPE, ESM_FACADE_DIR, ESM_TOP_LEVEL_AWAIT, ESM_TYPELESS } from '@nimbus-sh/core/runtime/native-esm.js';
import { ESM_GRAPH_SOURCE, ESM_LOADER_POLICY_SOURCE, ESM_REQUIRED_SOURCE, UTF8_LENGTH_SOURCE } from '@nimbus-sh/core/runtime/compiled-bodies.generated.js';
import { FACET_PROVIDED_PACKAGES, FS_READ_BATCH_REQUEST_BYTES, NIMBUS_AI_GATEWAY_PORT, NODE_VERSION, NODE_VERSIONS, VFS_CAPACITY, } from '@nimbus-sh/core/constants.js';
import { PACKAGE_ABI_POLICY } from '../facets/wasm-swap-registry.js';
import { NATIVE_HTTP_SOURCE } from './native-http.js';
import { NODE_WS_UPGRADE_SOURCE } from './node-ws-upgrade.js';
import { NODE_SOURCE_MAPS_SOURCE } from './node-source-maps.js';
import { NODE_BUILTIN_FRONTS_SOURCE } from './node-builtin-fronts.js';
import { NODE_MINIMATCH_SOURCE } from './node-minimatch-source.js';
import { ENTRY_CHECKED, RUNTIME_ESM_LATE_MODULE, RUNTIME_INTERPRETER_MODULE, RUNTIME_NODE_LIB_MODULE, RUNTIME_PARSER_MODULE, RUNTIME_WASM_MAX_BYTES } from '@nimbus-sh/core/_shared/commonjs-cell.js';
import { STAGED_BINDING_ARTIFACTS } from '../napi-wasm-artifacts.generated.js';
const SQLITE_SHIM_CODE = generateSqliteShimCode();
const UNDICI_SHIM_CODE = generateUndiciShimCode();
const FACET_PROVIDED_PACKAGES_LITERAL = JSON.stringify(FACET_PROVIDED_PACKAGES);
// Node version fingerprint. Single source of truth in constants.ts.
// Interpolated as JS literals into the emitted process shim. See
// constants.ts for the rationale (create-astro preflight, etc.).
const NODE_VERSION_LITERAL = JSON.stringify(NODE_VERSION);
const NODE_VERSIONS_LITERAL = JSON.stringify(NODE_VERSIONS);
// AI-egress mediation policy and the loopback host list, interpolated for the
// same reason: the emitted shim is a string and cannot import, so the
// constants it decides with, and the credential predicate's own source, come
// from _shared/ai-egress.ts and _shared/loopback.ts at build time rather than
// being written twice.
const AI_TOKEN_ENV_LITERAL = JSON.stringify(NIMBUS_AI_TOKEN_ENV);
const AI_CREDENTIAL_HEADERS_LITERAL = JSON.stringify(NIMBUS_AI_CREDENTIAL_HEADERS);
const LOOPBACK_HOSTNAMES_LITERAL = JSON.stringify(LOOPBACK_HOSTNAMES);
const ABI_ADVISORIES_LITERAL = JSON.stringify(PACKAGE_ABI_POLICY.rejects.map((r) => [r.from, r.suggest ? `${r.reason} … try: ${r.suggest}` : r.reason]));
/**
 * The shims reach the platform's Node builtins through one provider,
 * `__nativeBuiltin`: the runner's static imports of them (node-shims-imports.ts),
 * else the host's `process.getBuiltinModule`, taken before the program's
 * process replaces the global one. A unit embedding's host (Bun) answers with
 * its own.
 */
export function generateShimsCode() {
    return `
// What this setup puts in front of a value the realm shares (a builtin, a
// global) stands in front of the realm's own value, never in front of an
// earlier run's: a warm isolate runs the setup again for each program it
// hosts, and a front of the last run's front made each call one layer deeper
// per program. The realm keeps each front's own value (__nimbusFronted); a
// front an earlier run made is taken back to it (__nimbusFrontBase).
const __nimbusFronts = globalThis[Symbol.for("nimbus.fronts")] ??= new WeakMap();
const __nimbusFrontRun = {};
function __nimbusFrontBase(value) {
  const front = __nimbusFronts.get(value);
  return front === undefined || front.run === __nimbusFrontRun ? value : front.own;
}
function __nimbusFronted(front, base) {
  __nimbusFronts.set(front, { own: __nimbusFronts.get(base)?.own ?? base, run: __nimbusFrontRun });
  return front;
}
// The platform's own builtins, which every native front below forwards to: a
// generated runner's static imports of them (NODE_SHIMS_IMPORTS), else the
// host's process.getBuiltinModule (the realm's own process, not a program's).
const __nimbusHostProcess = __nimbusFrontBase(globalThis.process);
const __nativeBuiltin = ((host) => typeof __nimbusNativeBuiltins === "undefined" ? host
  : (id) => (Object.hasOwn(__nimbusNativeBuiltins, id) ? __nimbusNativeBuiltins[id] : host(id)))(__nimbusHostProcess.getBuiltinModule.bind(__nimbusHostProcess));
// What process.exit throws to end the program where it stands; its host
// catches it as the exit.
class __ProcessExit extends Error {
  constructor(code) { super("process.exit(" + code + ")"); this.code = code & 255; }
}
// The built-ins the module loading calls, captured before any program code
// (core _shared/primordials.ts), which Node's errors, node:path's posix half
// (core _shared/posix-path.ts, Node's lib/path.js) and the module resolvers
// below call. Then Node's internal errors (core _shared/node-error.ts): the
// shims, the preambles below and the code they load make them by name, and
// the cell runtime and generated code reach them as __nimbusNodeError and
// __nimbusNodeSystemError.
${PRIMORDIALS_PREAMBLE}
${NODE_ERROR_PREAMBLE}
${NODE_ARGUMENTS_PREAMBLE}
${NODE_WARNING_PREAMBLE}
${POSIX_PATH_PREAMBLE}
${TLS_IDENTITY_PREAMBLE}
Object.defineProperties(globalThis, {
  __nimbusNodeError: { value: __nimbusGeneratedNodeError, configurable: true },
  __nimbusNodeSystemError: { value: nodeSystemError, configurable: true },
  __nimbusEvalIllegalReturn: { value: __nimbusEvalIllegalReturn, configurable: true },
});
// Generated code's: a \`decoration\` (null for none) marks the error as one whose
// report has no arrow of the generated code, nor its frame (Node's comes from
// its loader, with none of the file's), the decoration before its stack
// where Node shows the source there (decorateErrorStack).
function __nimbusGeneratedNodeError(Base, code, message, props, decoration) {
  const error = nodeError(Base, code, message, props, __nimbusGeneratedNodeError);
  if (decoration !== undefined) {
    // A program's Error.prepareStackTrace may make the stack anything: only a string's frame is trimmed.
    if (typeof error.stack === "string") error.stack = error.stack.replace(/\\n    at [^\\n]*/, "");
    if (decoration !== null) error.stack = decoration + "\\n" + error.stack;
    __nimbusDecorated.add(error);
  }
  return error;
}
// What the shims call a program's functions with, captured before any
// program runs: a program may replace Reflect's.
const __nimbusReflectApply = Reflect.apply;
// The realm's SyntaxError, which a program may replace as a global: the
// launch's capture (a runner that shares one scope with the cell runtime has
// its __nimbusSyntaxError too).
const __nimbusRealmSyntaxError = __nimbusPrimordials.SyntaxError;
// The runner's stop and replay (runtime/stop-replay.ts), private to its
// module: null in a runner without one.
const __nimbusReplay = typeof __nimbusStopReplay !== "undefined" ? __nimbusStopReplay : null;
// The clock for the shims' own reads (REAL_NOW_SOURCE): a program's reads
// are its tape, and these are not the program's.
const __nimbusOwnNow = ${REAL_NOW_SOURCE};
// A connection opened through workerd's own socket class, which a program
// reaches past every export of node:net and node:tls (it is the prototype of
// tls.TLSSocket), is something a second run would do again: counted where
// the class connects, so the read after it fails where the program can catch
// it. (The session counts every connection too, where the program cannot
// reach.) The TLS shim's carrier is counted as its tls.connect.
let __nimbusCarrierOpening = false;
let __nimbusCarrierGate = null;
let __nimbusCarrierFailure = null;
// What leaves by the platform's own network, which no gate of the session's
// sees, goes once what the process wrote is published (ProcessFsClient.published).
function __nimbusNetworkGate() {
  const client = __nimbusProcessFilesystem === null ? null : __nimbusProcessFilesystem.client;
  return client ? client.published() : null;
}
// A raw socket (one a connect opens, or a response upgrades to) carries
// whatever the process sends on it from then on: the session is told, whether
// or not the process wrote anything yet, and the socket opens once the session
// answered and what the process wrote before it is published
// (ProcessFsClient.rawSocket); refused when the session was not told.
function __nimbusRawSocket() {
  let bound = null;
  try { bound = typeof __supervisor !== "undefined" ? __supervisor : null; } catch {}
  const client = __nimbusProcessFilesystem === null ? null : __nimbusProcessFilesystem.client;
  return bound && client ? client.rawSocket() : null;
}

// The process's filesystem (core runtime/wasi/process-filesystem.ts): the
// launch's store's view of the session's, with what the process decides held
// over it and sent in its client's waves. Every fs call goes through it.
let __nimbusProcessFilesystem = null;
// Whether the process has a session to ask: one without answers from its store alone, owing it nothing.
let __nimbusProcessSupervised = false;
// The session a process started with no SUPERVISOR asks: none. Its
// filesystem answers what its store holds, and every call that needs the
// session fails (EIO), as S's did.
const __nimbusNoSupervisor = new Proxy({}, {
  get: (target, name) => (typeof name !== "string" || name === "answer" || name === "then" ? undefined
    : () => Promise.reject(Object.assign(new Error("EIO: this process has no supervisor to ask"), { code: "EIO" }))),
});
function __nimbusResidentFs() {
  if (__nimbusProcessFilesystem === null) throw Object.assign(new Error("EIO: this process has no filesystem to call"), { code: "EIO" });
  return __nimbusProcessFilesystem;
}
// Why a launch with a supervisor cannot make its filesystem, or null: it was
// handed no stat of the session's root (the device its view answers for).
// One without a supervisor answers from its store alone.
function __nimbusRootRefusal(supervisor, root) {
  return supervisor && !root ? "node: the process was not started: its launch did not carry the session's root" : null;
}
// Made once the launch's store has booted, over the session's root (\`root\`,
// its stat as of the store's cursor or after it): its client is the one the
// runtime's effect and exit boundaries gate on, and the host's settle before
// an abort logs what it holds (__nimbusSettle). Published for the code the
// launch runs at module scope (globalThis.__nimbusProcessFs: the runtime-code
// report reads its misses).
function __nimbusStartProcessFilesystem(root) {
  globalThis.__nimbusProcessFs = null;
  globalThis.__nimbusSettle = undefined;
  if (!root) return;
  const supervisor = (typeof __supervisor !== "undefined" && __supervisor) || __nimbusNoSupervisor;
  const fs = __nimbusResidentModule.processFilesystem(supervisor, __resident.view.namespaceView(supervisor, root, cred), {
    // The platform's timers and clock: its resends are the runtime's, not a program's resumption or tape.
    timers: { setTimeout: globalThis.__nimbusRawSetTimeout || setTimeout, clearTimeout: globalThis.__nimbusRawClearTimeout || clearTimeout },
    now: __nimbusOwnNow,
    umask: () => __processUmask,
    // A run replaying a stopped one asks no lease: when it asks, and what it is answered, are the run before's.
    // Nor does a runner, which runs only while a call holds it: it could not answer a lease's recall, nor a grant's.
    readLeases: () => typeof __nimbusAnswersNoRecall === "undefined" && (!__nimbusReplay || __nimbusReplay.final),
    ...(typeof __nimbusAnswersNoRecall === "undefined" ? {} : { holdsGrants: false }),
    // A mount without a change feed as its launch walked it, and changes on mounts its own (as node's fs answers them).
    walkedMounts: true,
    residency: {
      // An import()'s prefetch (__nimbusHydrated): its misses are its own, charged to its quota.
      speculation: () => globalThis.__nimbusVfsSpeculation || null,
      // The program's: reported for the next launch to stage (ResidentFilesystem.misses).
      missed: () => { if (typeof __nimbusNotifyRuntimeCode === "function") __nimbusNotifyRuntimeCode(); },
    },
    // A change the program made: a run that can stop does not wait for stdin after one (stop-replay.ts).
    ...(__nimbusReplay ? { logged: (op) => __nimbusReplay.mutation(op) } : {}),
    ...(globalThis.__nimbusFsJournalSql ? { journalSql: globalThis.__nimbusFsJournalSql } : {}),
  });
  __nimbusProcessFilesystem = fs;
  __nimbusProcessSupervised = supervisor !== __nimbusNoSupervisor;
  globalThis.__nimbusProcessFs = fs;
  globalThis.__nimbusSettle = () => fs.logHeld();
}
// What the process holds, sent; answered once everything it logged is (a
// live boundary: a response, a served process's flush). A change the program
// was told succeeded that the session refused is thrown here.
async function __nimbusFlushFilesystem() {
  if (__nimbusProcessFilesystem !== null) await __nimbusProcessFilesystem.flush();
}
// The run's end: everything held sent and answered, and the first refusal of
// what the program was told it wrote thrown, naming the file.
async function __nimbusSettleFilesystem() {
  if (__nimbusProcessFilesystem === null) return;
  const failures = await __nimbusProcessFilesystem.settle();
  if (failures.length > 0) throw failures[0].error;
}
// The run's filesystem cost for its exec telemetry: calls the session
// answered, and synchronous calls refused as not resident.
function __nimbusFilesystemDiag() {
  if (__nimbusProcessFilesystem === null) return { fsRpcReads: 0, namespaceRefusals: 0 };
  const stats = __nimbusProcessFilesystem.stats();
  let delegated = 0;
  for (const name in stats.delegated) delegated += stats.delegated[name];
  return { fsRpcReads: delegated, namespaceRefusals: stats.notResident };
}
{
  const __realNet = __nativeBuiltin("net");
  const __NativeSocket = __realNet.Socket;
  const __egressSocketHolds = new WeakMap();
  const __nativeConnect = __NativeSocket && __NativeSocket.prototype ? __NativeSocket.prototype.connect : undefined;
  // What a connect refuses before it opens anything (a bad port, a missing
  // one, a lookup that is no function), thrown from connect as Node throws
  // it: the native connect's own checks, made on a socket that opens
  // nothing, its host one to look up by a lookup that never answers.
  const __nativeConnectChecks = (options) => {
    const probe = new __NativeSocket();
    probe.on("error", () => {});
    const lookup = options.lookup == null || typeof options.lookup === "function" ? () => {} : options.lookup;
    try { Reflect.apply(__nativeConnect, probe, [{ ...options, host: "nimbus-checks.invalid", lookup }]); }
    finally { probe.destroy(); }
  };
  if (typeof __nativeConnect === "function") {
    Object.defineProperty(__NativeSocket.prototype, "connect", { configurable: true, writable: true, value: function connect(...args) {
      if (__nimbusReplay && !__nimbusCarrierOpening) {
        const first = args[0];
        const where = first !== null && typeof first === "object"
          ? String(first.host ?? "") + ":" + String(first.port ?? first.path ?? "")
          : String(typeof args[1] === "string" ? args[1] : "") + ":" + String(first ?? "");
        __nimbusReplay.effect("net.connect " + where);
      }
      // Already connecting: the native connect refuses it, opening nothing.
      if (this.connecting) return Reflect.apply(__nativeConnect, this, args);
      __nativeConnectChecks((Array.isArray(args[0]) ? args[0] : __realNet._normalizeArgs(args))[0]);
      if (globalThis.__nimbusEgress === true) {
        const socket = this;
        let state = __egressSocketHolds.get(socket);
        if (!state) {
          state = { hold: null };
          __egressSocketHolds.set(socket, state);
          const ref = socket.ref, unref = socket.unref;
          socket.ref = function () { state.hold?.(true); Reflect.apply(ref, this, arguments); return this; };
          socket.unref = function () { state.hold?.(false); Reflect.apply(unref, this, arguments); return this; };
        }
        if (!state.hold) {
          const hold = state.hold = __nimbusHoldSocket();
          socket.once('close', () => { hold(false); if (state.hold === hold) state.hold = null; });
        }
      }
      // A synchronous read crossed the replay boundary, but the session
      // must acknowledge its notice before any new native transport opens.
      // TLS's carrier joins that same gate AND its target registration.
      const replayed = !__nimbusReplay ? null : __nimbusCarrierOpening ? __nimbusCarrierGate : __nimbusReplay.afterBoundary();
      const raw = __nimbusRawSocket();
      const ready = replayed && raw ? Promise.all([replayed, raw]) : replayed || raw;
      if (ready) {
        const socket = this;
        const fail = __nimbusCarrierFailure || ((error) => socket.destroy(error));
        // Writes/TLS wrapping must see a connecting socket while it waits,
        // just as they do after an ordinary native connect was issued.
        socket.connecting = true;
        __nimbusTrackOp(Promise.resolve(ready).then(() => {
          if (socket.destroyed) return;
          // The native implementation owns its own false -> true transition
          // and refuses a second connect while already connecting.
          socket.connecting = false;
          // workerd's connect undestroys every stream it opens, Node's only a
          // destroyed one: what the program did to this one while it waited
          // (its end) stands.
          const undestroy = socket._undestroy;
          socket._undestroy = function () { if (this.destroyed) Reflect.apply(undestroy, this, arguments); };
          try { Reflect.apply(__nativeConnect, socket, args); }
          catch (error) { fail(error); }
        }, fail));
        return socket;
      }
      return Reflect.apply(__nativeConnect, this, args);
    } });
  }
}
function __nimbusDisposeRpcResult(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === "function") { try { dispose.call(value); } catch {} }
}

// ═══════════════════════════════════════════════════════════════════════
// ──  in-flight async operations ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Node keeps a process alive for its ACTIVE REQUESTS — a pending fetch, a
// pending fs call, a running child — not for pending promises. The facet's
// entry drain cannot learn that by watching promises: \`await\` resolves
// through PerformPromiseThen, which never calls the patched
// Promise.prototype.then, so a floating \`(async () => { await fetch(u);
// console.log(x); })()\` looks finished the instant its synchronous part
// returns and the rest of the program is dropped on the floor.
//
// Every external operation a facet can start crosses one of two seams:
// globalThis.fetch (network, in-session loopback, AI egress — plus reading
// the body of the Response it returns) and the supervisor RPC helper below
// (fs, child_process, ports, stdio). Counting there is the honest liveness
// signal, and it is what globalThis.__nimbusPendingOps reports.
const __nimbusOrigThen = Promise.prototype.then;
if (typeof globalThis.__nimbusPendingOps !== "number") globalThis.__nimbusPendingOps = 0;
function __nimbusTrackOp(promise) {
  if (!promise || typeof promise.then !== "function") return promise;
  // Counted from the start: the facet's supervisor counts its calls before
  // this module's own statements have run (the boot's fills and listings).
  globalThis.__nimbusPendingOps = (globalThis.__nimbusPendingOps || 0) + 1;
  const settled = () => { globalThis.__nimbusPendingOps--; globalThis.__nimbusHandleReleased?.(); };
  try { __nimbusOrigThen.call(promise, settled, settled); }
  catch { settled(); }
  return promise;
}

// A connection the program holds open keeps it alive, as its socket does in
// Node, until it closes or is unref'd: a WebSocket client, a tls.connect
// socket. The returned setter holds (true) or lets go (false); it is the one
// counter __nimbusLiveHandles reads for them, separate from startup work so a
// socket opened at boot does not hold a resident's boot answer.
function __nimbusHoldSocket() {
  let held = false;
  const hold = (want) => {
    if (want === held) return;
    held = want;
    globalThis.__nimbusOpenSockets = (globalThis.__nimbusOpenSockets || 0) + (want ? 1 : -1);
    if (!want) globalThis.__nimbusHandleReleased?.();
  };
  hold(true);
  return hold;
}

// Node's minimatch (node-minimatch-source.ts), the matcher fs.glob uses, as
// Node loads it: a CommonJS module, evaluated the first time a program globs.
function __nimbusMinimatch() {
  const module = { exports: {} };
  (function (exports, module, process) {
${NODE_MINIMATCH_SOURCE}
  })(module.exports, module, builtins.process);
  return module.exports;
}

async function __nimbusUseRpcResult(promise, use) {
  globalThis.__nimbusPendingOps++;
  try { return await __nimbusUseRpcResultUnref(promise, use); }
  finally { globalThis.__nimbusPendingOps--; globalThis.__nimbusHandleReleased?.(); }
}
// Facet infrastructure that long-polls the supervisor for as long as the
// facet lives — the attached-process stdin pump — is the analogue of an
// unref'd handle: real I/O, but never a reason to keep the program alive.
async function __nimbusUseRpcResultUnref(promise, use) {
  const value = await promise;
  try { return await use(value); }
  finally { __nimbusDisposeRpcResult(value); }
}

/**
 * The ACQUIRE barrier, taken before the program sees anything that arrived
 * from outside it: a response or body from the network, a relayed socket
 * frame, a request routed to one of its ports, a stdin packet or signal, a
 * child's output or exit. Each of those can be the second half of a causal
 * chain that began with a write somewhere else — \`echo v2 > f; curl :3000\`,
 * a child that writes a file and then exits — and the handler's synchronous
 * reads must see that write. Nothing but this barrier carries it.
 *
 * What the supervisor delivers — a request, a stdin packet, a child's output
 * or exit — carries the answer to this barrier with it (\`delivered\`,
 * session/rpc.ts _acquireOnDelivery), computed after the thing delivered was
 * queued, so the barrier applies that answer instead of asking, and the
 * program resumes with no round trip of its own. It asks when there is none
 * or it cannot use the one delivered. A resumption the supervisor does not
 * deliver — a timer, the network — always asks.
 *
 * The barrier is installed by the fs module, which is evaluated after this
 * point; a facet with no supervisor has none and nothing to be coherent with.
 */
async function __nimbusInboundBarrier(delivered, viaIo = false) {
  const acquire = globalThis.__nimbusVfsAcquireBarrier;
  if (typeof acquire === "function") await acquire(delivered, viaIo);
}

/**
 * The arguments this process asks its ACQUIRE with (the fs module's
 * _acquireArgs), for a delivery to be answered from: a long poll sends them,
 * and what it delivers comes back carrying fsAcquire's answer to them.
 */
function __nimbusVfsAcquireArgs() {
  const args = globalThis.__nimbusVfsAcquireArgs;
  return typeof args === "function" ? args() : undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// ──  Precompiled wasm ───────────────────────────────────────────────
// A wasm image can only become a WebAssembly.Module through the Worker
// Loader's module map; new WebAssembly.Module(bytes) at request time is
// refused by the runtime. A launch whose closure carries an image (its VFS
// path, or its content digest for an image inlined as base64) parks here the
// compile of its map member, which runs on first use (the runner's
// facetWasmImportsSource). fs.readFileSync tags the bytes it hands out for
// such a path, and the WebAssembly seam below answers a compile of tagged or
// digest-matched bytes with the module the loader builds for them — so a
// package's own new WebAssembly.Module(readFileSync(__dirname + '/x.wasm'))
// works unchanged.
const __nimbusPrecompiledWasm = globalThis.__nimbusPrecompiledWasm instanceof Map
  ? globalThis.__nimbusPrecompiledWasm : new Map();
const __nimbusWasmModuleTag = Symbol.for("nimbus.precompiledWasmModule");
/**
 * Precompiled modules keyed by a digest of their BYTES, for an image that
 * never passes through the filesystem.
 *
 * Vite inlines es-module-lexer's parser as a base64 literal in its own source
 * and compiles it at module top level — from a cell that is request time, and
 * the runtime refuses it. There is no path to tag, so the launch registers
 * the image by content instead and the seam recognises the same bytes when
 * they arrive.
 */
const __nimbusPrecompiledWasmByDigest = globalThis.__nimbusPrecompiledWasmByDigest instanceof Map
  ? globalThis.__nimbusPrecompiledWasmByDigest : new Map();
// The key a launch registers each image under: its own code
// (facets/wasm-image-key.ts wasmImageDigest), not a copy of it.
${WASM_IMAGE_KEY_PREAMBLE}
/**
 * The key of the bytes a compile was handed: an ArrayBuffer's, or the range
 * a view spans, whatever its kind (DataView, any typed array) and whatever
 * buffer it views, as WebAssembly reads a BufferSource; null for anything
 * else, a detached buffer's included, which the real compile then refuses
 * as it would.
 */
function __nimbusWasmDigest(bytes) {
  let view = null;
  try {
    view = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null);
  } catch {}
  return view === null ? null : wasmImageDigest(view);
}
(() => {
  const WA = globalThis.WebAssembly;
  if (!WA || WA.__nimbusPrecompiledSeam) return;
  const RealModule = WA.Module;
  // A parked image is its compile, run on first use; it keeps what it built.
  const built = (image) => (typeof image === "function" ? image() : image);
  const tagged = (bytes) => {
    if (!bytes || typeof bytes !== "object") return undefined;
    const byTag = bytes[__nimbusWasmModuleTag];
    if (byTag !== undefined) return built(byTag);
    if (__nimbusPrecompiledWasmByDigest.size === 0) return undefined;
    const digest = __nimbusWasmDigest(bytes);
    const image = digest === null ? undefined : __nimbusPrecompiledWasmByDigest.get(digest);
    return image === undefined ? undefined : built(image);
  };
  // The runtime compiles wasm only while the loader stages a module map; a
  // compile from bytes at any later point is refused with a message that names
  // neither the module nor the reason it cannot work. Say both: the caller is
  // an installed package whose image has to travel as a map member (the
  // closure walk registers it), or be inlined in module text the loader
  // itself evaluates.
  // A refused image Node would have compiled (it validates) is named, once,
  // and learned (commonjs-cell.ts recordWasm) for the next launch of the
  // command to carry by digest: an image built in memory comes from no file
  // the closure walk could record, and its caller often catches the refusal
  // and carries on without it, silently.
  const named = new Set();
  const name = (bytes) => {
    let valid = false;
    try { valid = WA.validate(bytes); } catch {}
    const digest = valid ? __nimbusWasmDigest(bytes) : null;
    if (digest === null || named.has(digest)) return;
    named.add(digest);
    const size = bytes.byteLength;
    const runtime = globalThis.__nimbusRuntimeCode;
    const learned = size <= ${RUNTIME_WASM_MAX_BYTES} && !!(runtime && typeof runtime.recordWasm === "function" && runtime.recordWasm(bytes));
    const where = globalThis.__currentModulePath ? " while loading " + globalThis.__currentModulePath : "";
    const line = "Nimbus: a WebAssembly module of " + size + " bytes" + where + " was compiled from bytes this launch does not carry,"
      + " and a Worker compiles wasm only from its launch's module map, so the compile was refused; "
      + (learned ? "it is staged, and the next launch of this command carries it."
        : "it is not staged" + (size > ${RUNTIME_WASM_MAX_BYTES} ? " (over the ${RUNTIME_WASM_MAX_BYTES}-byte limit a launch learns)" : "") + ".");
    try { globalThis.process.stderr.write(line + "\\n"); } catch { try { console.error(line); } catch {} }
  };
  const refusal = (e, bytes) => {
    name(bytes);
    const size = (bytes && typeof bytes === "object" && typeof bytes.byteLength === "number") ? bytes.byteLength : 0;
    const where = globalThis.__currentModulePath ? " while loading " + globalThis.__currentModulePath : "";
    return new Error(
      "Nimbus: WebAssembly cannot be compiled from bytes here" + where + " (" + size + " bytes): "
      + ((e && e.message) || String(e))
      + ". The runtime compiles wasm only when the module loader stages it, so the image must ride in the "
      + "process's module map — a launch names one via the closure's wasmImages — rather than be compiled at runtime."
      + " Images this launch does carry: " + (__nimbusPrecompiledWasm.size + __nimbusPrecompiledWasmByDigest.size) + ".",
    );
  };
  const Module = function Module(bytes) {
    const compiled = tagged(bytes);
    if (compiled !== undefined) return compiled;
    try { return new RealModule(bytes); } catch (e) { throw refusal(e, bytes); }
  };
  Module.prototype = RealModule.prototype;
  for (const k of ["exports", "imports", "customSections"]) Module[k] = RealModule[k];
  Object.defineProperty(WA, "Module", { value: Module, writable: true, configurable: true });
  const realCompile = WA.compile.bind(WA);
  WA.compile = (bytes) => {
    const compiled = tagged(bytes);
    if (compiled !== undefined) return Promise.resolve(compiled);
    return realCompile(bytes).catch((e) => { throw refusal(e, bytes); });
  };
  const realInstantiate = WA.instantiate.bind(WA);
  WA.instantiate = (source, imports) => {
    const compiled = tagged(source);
    if (compiled !== undefined) {
      return realInstantiate(compiled, imports).then((instance) => ({ module: compiled, instance }));
    }
    // A Module source instantiates; only BYTES are a compile, and only the
    // compile can be refused: an instantiate that fails after it (a link
    // failure, a trap in its start) keeps its own error.
    if (source instanceof RealModule) return realInstantiate(source, imports);
    return realCompile(source).then(
      (module) => realInstantiate(module, imports).then((instance) => ({ module, instance })),
      (e) => { throw refusal(e, source); },
    );
  };
  WA.__nimbusPrecompiledSeam = true;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  RequestInit.cache, as Node takes it ─────────────────────────────
// Node's fetch keeps no HTTP cache, so the modes it accepts all go to the
// network. workerd accepts only "no-store" and "no-cache" (measured:
// "default", "reload" and "force-cache" throw "Unsupported cache mode"), and
// axios's fetch adapter passes cache: "default" on every request. A Request
// or fetch drops those three: the request goes to the network, as Node's
// would. What Node refuses ("only-if-cached" outside same-origin mode, an
// unknown mode) workerd refuses too, and is left to it.
const __nodeCacheInit = (init) => {
  if (!init || typeof init !== "object") return init;
  const mode = init.cache;
  if (mode !== "default" && mode !== "reload" && mode !== "force-cache") return init;
  const { cache, ...rest } = init;
  return rest;
};
if (typeof globalThis.Request === "function" && !globalThis.__nimbusNodeRequestInstalled) {
  globalThis.__nimbusNodeRequestInstalled = true;
  // A Proxy, not a subclass: every Request stays the platform's, so
  // instanceof holds for the ones the runtime itself makes.
  globalThis.Request = new Proxy(globalThis.Request, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, [args[0], __nodeCacheInit(args[1])], newTarget);
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ──  fetch default User-Agent ───────────────────────────────────────
// workerd's global fetch sends no User-Agent by default, but Node's
// undici fetch adds \`User-Agent: node\`. Servers that require a UA
// (notably GitHub's API, used by giget/create-* template downloaders)
// answer 403 to a UA-less request. Match Node by injecting the default
// UA only when the caller supplied none, preserving any explicit value.
// This also covers the http/https \`request\`/\`get\` shims, which route
// through this same global fetch.
(() => {
  if (typeof globalThis.fetch !== "function" || globalThis.__nimbusFetchUaInstalled) return;
  globalThis.__nimbusFetchUaInstalled = true;
  const __origFetch = globalThis.fetch.bind(globalThis);
  const __recordingNetwork = !!(__nimbusReplay && __nimbusReplay.outbound);
  const __networkResponses = __recordingNetwork ? new WeakMap() : null;
  const __networkBodies = __recordingNetwork ? new WeakMap() : null;
  const __observeBody = (body) => {
    const record = body && __networkBodies && __networkBodies.get(body);
    if (record && !record.done) {
      record.done = true;
      if (__nimbusReplay) { __nimbusReplay.observed("fetchBody"); __nimbusReplay.bodyFinished(record.id); }
    }
  };
  const __hasUa = (h) => {
    if (!h) return false;
    if (typeof h.get === "function") return h.get("user-agent") != null;
    if (Array.isArray(h)) return h.some((p) => String(p?.[0]).toLowerCase() === "user-agent");
    return Object.keys(h).some((k) => k.toLowerCase() === "user-agent");
  };
  const __loopbackHosts = new Set(${LOOPBACK_HOSTNAMES_LITERAL});
  const __fetchUrl = (input) => {
    try {
      const href = typeof input === "string" ? input
        : (input && typeof input === "object" && input.url) ? input.url : String(input);
      return new URL(href);
    } catch { return null; }
  };
  // Read one header off whatever the caller passed without constructing a
  // Request: \`new Request(existing)\` marks the original's body disturbed, and a
  // request we inspect but do not claim must still be sendable by real fetch.
  // \`init.headers\` replaces a Request's own headers, so it is consulted first.
  const __headerOf = (input, init, name) => {
    const h = (init && init.headers) || (typeof Request !== "undefined" && input instanceof Request ? input.headers : null);
    if (!h) return null;
    if (typeof h.get === "function") return h.get(name);
    if (Array.isArray(h)) {
      for (const pair of h) if (String(pair?.[0]).toLowerCase() === name) return String(pair?.[1]);
      return null;
    }
    for (const key of Object.keys(h)) if (key.toLowerCase() === name) return String(h[key]);
    return null;
  };
  // Strip the caller's AbortSignal before the RPC hop: workerd JSRPC does not
  // serialize Request.signal ("AbortSignal serialization is not enabled"), and
  // the opencode SDK stamps timeout signals on its startup requests — which
  // made 4/5 attach boot calls fail. Cancellation across the hop is advisory;
  // an aborted caller simply drops the response.
  const __supervisorRequest = (url, input, init) => (
    (typeof Request !== "undefined" && input instanceof Request)
      ? new Request(input, { ...(init || {}), signal: null })
      : new Request(url.href, { ...(init || {}), signal: null })
  );
  // The port a loopback URL names, or 0: the one reading of it that the route
  // below and a process's own server (__ownPortOf) both go by.
  const __loopbackPortOf = (url) => {
    if (!__loopbackHosts.has(url.hostname)) return 0;
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    return Number.isFinite(port) && port > 0 ? port : 0;
  };
  // In-session loopback: a facet's fetch to 127.0.0.1/localhost:<port> is routed
  // to the facet that owns <port> through the supervisor's port registry (the
  // same routing the shell curl/node loopback uses), so a facet can reach another
  // facet's server in-session (opencode attach reaching opencode serve). Returns
  // the target's Response (streamed over RPC, so SSE flows). Anything non-
  // loopback, or when no supervisor is bound, falls through to real fetch.
  const __maybeRouteLoopback = (url, input, init) => {
    const port = __loopbackPortOf(url);
    if (!port) return null;
    return Promise.resolve(__supervisor.routeLoopback(port, __supervisorRequest(url, input, init)));
  };
  // The port of a request this process's own server may answer by itself: a
  // loopback http(s) request that the route would also take for ordinary HTTP.
  // The session's gateway port is not one, and neither is an upgrade, which is
  // the route's by its own rule (isWebSocketUpgradeRequest) on the Headers it
  // would be handed: those of init when given, else the Request's.
  const __ownPortOf = (input, init) => {
    const url = __fetchUrl(input);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return 0;
    const port = __loopbackPortOf(url);
    if (!port || port === ${NIMBUS_AI_GATEWAY_PORT}) return 0;
    const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    return isWebSocketUpgradeRequest(headers) ? 0 : port;
  };
  // AI-egress mediation: a request addressed anywhere on the network that
  // presents this session's AI capability token is inference the session owns,
  // so it is served by the session's own gateway (supervisor loopback port
  // ${NIMBUS_AI_GATEWAY_PORT}) instead of being sent out. That is how a tool holding a baked-in
  // vendor base URL — one that never reads OPENAI_BASE_URL — still reaches the
  // session's models with no configuration of its own.
  //
  // The match is on the credential, never on the destination: a request
  // carrying anything else (the user's own real provider key) is not ours, is
  // left alone, and goes to that provider. See _shared/ai-egress.ts.
  const __aiCredentialHeaders = ${AI_CREDENTIAL_HEADERS_LITERAL};
  const __maybeRouteAiEgress = (url, input, init) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    let token = "";
    try { token = (env && env[${AI_TOKEN_ENV_LITERAL}]) || ""; } catch { return null; }
    if (!token) return null;
    for (const name of __aiCredentialHeaders) {
      const raw = __headerOf(input, init, name);
      if (!raw) continue;
      if (presentedCredential(String(raw)) !== token) continue;
      return Promise.resolve(__supervisor.routeLoopback(${NIMBUS_AI_GATEWAY_PORT}, __supervisorRequest(url, input, init)));
    }
    return null;
  };
  const __dispatch = (input, init) => {
    try {
      if (__supervisor && typeof __supervisor.routeLoopback === "function") {
        const url = __fetchUrl(input);
        const routed = url && (__maybeRouteLoopback(url, input, init) || __maybeRouteAiEgress(url, input, init));
        if (routed) return routed;
      }
    } catch { /* fall through to real fetch */ }
    const reqHasUa = typeof Request !== "undefined" && input instanceof Request && __hasUa(input.headers);
    if (reqHasUa || __hasUa(init && init.headers)) return __origFetch(input, init);
    const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    headers.set("user-agent", "node");
    return __origFetch(input, { ...(init || {}), headers });
  };
  // Coherence at the outbound-fetch boundary (§0.2 witness 2 of the VFS
  // coherence protocol). A facet's fetch does not go through the supervisor:
  // the facet inherits the parent worker's network, so the response resumes
  // user code with no supervisor message an invalidation could ride on, and
  // an external third party can carry a happens-before edge between two
  // facets that never touches the authority.
  //
  // Both halves are sited here:
  //   RELEASE — this facet's parked writes are flushed before the request
  //     leaves, so nothing outside can observe an effect of a write the
  //     authority has not got yet.
  //   ACQUIRE — performed when the response lands, before the awaiting user
  //     code runs.
  //
  // ACQUIRE has to be AFTER the response, and the earlier design saying it
  // could ride concurrently with the request — free, hidden under the network
  // — was wrong, which a test caught rather than an argument. A concurrent
  // ACQUIRE is serviced at request time, so it reports the world as of when
  // the request left. The whole anomaly is that the RESPONSE encodes "the
  // write happened", so an ACQUIRE older than the response is exactly the one
  // that cannot see the write it is there to catch. That costs a real
  // supervisor round trip per outbound request, not a hidden one. It is the
  // price of the guarantee.
  //
  // The RELEASE barrier lives on globalThis because the fs module installs it
  // and is evaluated after this one; the ACQUIRE is __nimbusInboundBarrier.
  //
  // A request to a server this process itself runs (__barriered's claim) has
  // no outside to resume from: the client, the handler and the response are
  // one process's, and what the handler took in from outside took its own
  // barrier on the way in. Except a foreign body read raw (piped, through a
  // reader, by the native http client): no barrier covers its chunks, and a
  // response of the process's own can carry them to a reader owed the
  // ACQUIRE after them. So while a foreign body has not been read to the end
  // through a barriered method (below) nothing is skipped: the claim is not
  // made, and a response already on its way takes the ACQUIRE. A body read
  // raw, read by a method that failed, or never read, stays open for the life
  // of the process; a response with no body has nothing to carry.
  const __foreignBodies = new WeakSet();
  let __foreignOpen = 0;
  const __resumeCoherent = async (pending, own = false, viaIo = false) => {
    const value = await pending;
    if (!own || __foreignOpen !== 0) await __nimbusInboundBarrier(undefined, viaIo);
    return value;
  };
  const __barriered = async (input, init) => {
    // A request other than a read may change something a second run of the
    // program would change again (runtime/stop-replay.ts). A read goes
    // through the session when the run can stop (its outbound), which records
    // the response and answers a run after a stop with it; a run whose network
    // does not go through the session cannot be run again once it used it.
    if (__nimbusReplay && __nimbusReplay.armed) {
      const method = String((init && init.method) || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
      if (!__nimbusReplay.outbound) __nimbusReplay.effect("used the network (" + method + " " + __fetchUrl(input) + "), which Nimbus does not record for this process");
      else if (method !== "GET" && method !== "HEAD") __nimbusReplay.effect(method + " " + __fetchUrl(input));
    }
    // The outbound uses its own supervisor binding. Like post-read calls
    // through the guest's proxy, it cannot pass the replay boundary notice.
    const afterRead = __nimbusReplay && __nimbusReplay.afterBoundary();
    if (afterRead) await afterRead;
    // No transport or coherence boundary: the client, native HTTP handler and
    // response body all live in one process. Other ports still route.
    const own = __foreignOpen === 0 ? __nimbusTryOwnHttp(__ownPortOf(input, init), input, init) : null;
    if (own) return __resumeCoherent(own, true);
    const release = globalThis.__nimbusVfsReleaseBarrier;
    if (typeof release === "function") await release();
    const published = __nimbusNetworkGate();
    if (published !== null) await published;
    const pending = __resumeCoherent(__dispatch(input, init), false, true).then(async (response) => {
      const raw = response && response.webSocket ? __nimbusRawSocket() : null;
      if (raw !== null) await raw;
      if (response && response.body) { __foreignBodies.add(response); __foreignOpen++; }
      return response;
    });
    if (!__recordingNetwork) return pending;
    let response;
    try { response = await pending; }
    catch (error) { if (__nimbusReplay && __nimbusReplay.outbound) __nimbusReplay.observed("fetchHeader"); throw error; }
    if (__nimbusReplay && __nimbusReplay.outbound) {
      __nimbusReplay.observed("fetchHeader");
      if (response.body) {
        const record = { id: __nimbusReplay.bodyStarted(String(__fetchUrl(input))), done: false };
        __networkResponses.set(response, record);
        __networkBodies.set(response.body, record);
      }
    }
    return response;
  };
  globalThis.fetch = function fetch(input, init) {
    return __nimbusTrackOp(__barriered(input, __nodeCacheInit(init)));
  };
  // A fetch settles once the headers arrive; reading the body is a SECOND
  // in-flight operation on the same connection, and \`const r = await
  // fetch(u); const j = await r.json()\` is the shape most programs use.
  // It is also a second resumption from the network, so it takes the same
  // ACQUIRE: a program that reads a file after parsing a response body is no
  // less entitled to current bytes than one that reads after the headers.
  // Not \`viaIo\`: a body already received, or one the program made, ends
  // with no I/O, so a read lease does not answer for it (_acquireBarrier).
  for (const __name of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
    const __orig = Response.prototype[__name];
    if (typeof __orig !== "function") continue;
    try {
      Response.prototype[__name] = function(...args) {
        const own = __nimbusOwnHttpResponses.has(this);
        const drained = (value) => { if (__foreignBodies.delete(this)) __foreignOpen--; return value; };
        if (!__recordingNetwork) return __nimbusTrackOp(__resumeCoherent(__orig.apply(this, args), own).then(drained));
        const body = this.body;
        const pending = __orig.apply(this, args).then((value) => { __observeBody(body); return value; }, (error) => { __observeBody(body); throw error; });
        return __nimbusTrackOp(__resumeCoherent(pending, own).then(drained));
      };
    } catch { /* host object is sealed — the drain still sees the fetch itself */ }
  }
  // No stdin/outbound journal: keep native stream readers and cloning intact.
  if (!__recordingNetwork) return;
  const __getReader = ReadableStream.prototype.getReader;
  const __cloneResponse = Response.prototype.clone;
  Response.prototype.clone = function(...args) {
    const clone = __cloneResponse.apply(this, args);
    const record = __networkResponses.get(this);
    if (record && clone.body) { __networkResponses.set(clone, record); __networkBodies.set(clone.body, record); }
    return clone;
  };
  const __readerBodies = new WeakMap();
  ReadableStream.prototype.getReader = function(...args) {
    const reader = __getReader.apply(this, args);
    if (__networkBodies.has(this)) __readerBodies.set(reader, this);
    return reader;
  };
  for (const Reader of [ReadableStreamDefaultReader, typeof ReadableStreamBYOBReader === "function" ? ReadableStreamBYOBReader : null]) {
    if (!Reader) continue;
    const read = Reader.prototype.read;
    Reader.prototype.read = function(...args) {
      const body = __readerBodies.get(this);
      const pending = read.apply(this, args);
      if (!body) return pending;
      return __nimbusTrackOp(pending.then((value) => { if (value.done) __observeBody(body); return value; }, (error) => { __observeBody(body); throw error; }));
    };
  }
})();

let __nimbusLiveStdinPump = null;
let __nimbusProcessExitReported = false;
// Set when the program has exited: its timers are cleared and its writes refused.
let __nimbusProgramStopped = false;
let __nimbusExitEmitted = false;
// 'exit' listeners run once, synchronously, before the program is stopped.
function __nimbusEmitExit(code) {
  if (__nimbusExitEmitted) return;
  __nimbusExitEmitted = true;
  try { __processMod.emit("exit", code); } catch {}
}
// The news of this process's children, applied as each reply's effect is
// (__nimbusApplyNews), and what it says of itself to the session as that
// changes (facets/manager.ts __nimbusReportBlockedState): whether its only
// remaining work is waiting on its children, at which frontier (child-news.ts).
// A blocked program runs again only on news of a child (it has no timer,
// socket or read of its own), so the session takes the report only while
// the frontier is all the news it issued (fabric budgets.ts
// setProcessBlocked). Sent unref'd, in order: saying it is not work, and
// must not make the program look busy.
let __nimbusBlockedChain = Promise.resolve();
const __nimbusChildNews = (${CHILD_NEWS_SOURCE})((report) => {
  __nimbusBlockedChain = __nimbusBlockedChain
    .then(() => __nimbusUseRpcResultUnref(__supervisor.cpBlocked(report), () => undefined))
    .catch(() => {});
});
globalThis.__nimbusApplyNews = (numbers) => __nimbusChildNews.apply(numbers);
globalThis.__nimbusReportBlocked = (blocked) => {
  if (__nimbusProgramStopped) return;
  if (!__supervisor || typeof __supervisor.cpBlocked !== "function") return;
  __nimbusChildNews.say(blocked);
};
let __nimbusProcessExitResolve = null;
let __nimbusProcessExitCode = null;
const __nimbusProcessExitPromise = new Promise((resolve) => {
  __nimbusProcessExitResolve = resolve;
});

// ═══════════════════════════════════════════════════════════════════════
// ──  path module ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Module loading's path work, on the launch's captures (core _shared
// primordials.ts): by the time a program imports, it may have replaced
// String.prototype.split or Array.prototype.push, which Node's loader never
// asks (design-guest-loader-primordials.md §3.5).
const {
  stringSlice: __pathSlice, stringIndexOf: __pathIndexOf, stringStartsWith: __pathStartsWith,
  stringCharCodeAt: __pathCharCodeAt, arrayJoin: __pathJoin, SafeList: __PathList, SafeMap: __NimbusSafeMap,
  decodeURIComponentOf: __pathDecodeURIComponent, stringLastIndexOf: __pathLastIndexOf, stringToLowerCase: __pathToLowerCase,
  stringIncludes: __pathIncludes, stringEndsWith: __pathEndsWith, SafeSet: __NimbusSafeSet, SafeWeakSet: __NimbusSafeWeakSet,
  objectCreate: __nimbusObjectCreate, reflectDefineProperty: __nimbusDefine, dataDescriptor: __nimbusData,
  objectFreeze: __nimbusFreeze, objectPreventExtensions: __nimbusPreventExtensions, objectKeys: __nimbusKeys,
  arrayIsArray: __nimbusIsArray, arrayIndexOf: __nimbusIndexOf, arraySort: __nimbusSort, JSONParse: __nimbusJsonParse,
  mapGet: __nimbusMapGet, MapConstructor: __NimbusMap, reflectApply: __nimbusApply,
  promiseSettled: __nimbusSettled, promiseAll: __nimbusAll, PromiseConstructor: __NimbusPromise, arrayCopy: __nimbusArrayCopy,
} = __nimbusPrimordials;
/** A SafeSet's or a SafeMap's members (keys), in order, as a SafeList: never their iterator. */
function __nimbusListOf(collection) {
  const out = new __PathList();
  collection.forEach((_value, key) => { out[out.length] = key; });
  return out;
}
/**
 * builtins.url.pathToFileURL(path).href, as the loader names a module: its
 * characters encoded as that shim encodes them ('%', the backslash, and the
 * line and tab controls), on the launch's captures, then the URL made with
 * its captured constructor (newURL), its pathname set and href read live, as
 * Node's own are (package-map.ts).
 */
function __nimbusFileHref(path) {
  const input = String(path);
  let resolved = __pathMod.resolve(input);
  if (__pathEndsWith(input, "/") && !__pathEndsWith(resolved, "/")) resolved += "/";
  let encoded = "";
  let from = 0;
  for (let i = 0; i < resolved.length; i++) {
    const c = __pathCharCodeAt(resolved, i);
    const escape = c === 37 ? "%25" : c === 92 ? "%5C" : c === 10 ? "%0A" : c === 13 ? "%0D" : c === 9 ? "%09" : null;
    if (escape === null) continue;
    encoded += __pathSlice(resolved, from, i) + escape;
    from = i + 1;
  }
  encoded = from === 0 ? resolved : encoded + __pathSlice(resolved, from);
  const url = __nimbusPrimordials.newURL("file:///");
  url.pathname = encoded;
  return url.href;
}
/** \`text\`'s names, what lies between its slashes, empty ones dropped. */
function __vfsNames(text) {
  const out = new __PathList();
  let from = 0;
  while (from <= text.length) {
    let slash = __pathIndexOf(text, "/", from);
    if (slash < 0) slash = text.length;
    if (slash > from) out[out.length] = __pathSlice(text, from, slash);
    from = slash + 1;
  }
  return out;
}
/** \`text\` without its leading slashes: a VFS key. */
function __vfsKey(text) {
  let at = 0;
  while (at < text.length && __pathCharCodeAt(text, at) === 47) at++;
  return at === 0 ? text : __pathSlice(text, at);
}
// A VFS key's normalization: "." and "" segments dropped, ".." applied,
// no trailing slash. Nimbus's own fs and resolver keys, not userland's path.
function __vfsNormalizePath(p) {
  const parts = __vfsNames(p);
  const out = new __PathList();
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.length--; else out[out.length] = s; }
    else if (s !== ".") out[out.length] = s;
  }
  return (__pathCharCodeAt(p, 0) === 47 ? "/" : "") + __pathJoin(out, "/");
}
// Userland's path is workerd's node:path, Node's own lib/path.js
// (https://developers.cloudflare.com/workers/runtime-apis/nodejs/path/).
// A hand-rolled join kept empty segments, so totalist's
// \`join("", "hello.txt")\` was "/hello.txt" and sirv mapped every file under
// "//name" and answered 404. Only resolution is the process's: resolve and
// relative start from its cwd, not the Worker's.
// Its posix half is Node's own (createPosixPath), on built-ins captured
// before the program ran, as Node's path is: a program that replaces
// String.prototype.charCodeAt has its own path, and the loader's, answer as
// Node's do. matchesGlob is minimatch's, the platform's; win32 the platform's.
const __pathMod = (() => {
  const native = __nativeBuiltin("path");
  const mod = createPosixPath(() => cwd || "/home/user");
  mod.matchesGlob = (native.posix ?? native).matchesGlob;
  mod.win32 = native.win32;
  return mod;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  Native Buffer ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Workers' native Buffer is already used by crypto, zlib and node:http.
// Keep that one constructor everywhere: a second partial implementation lost
// offsets, UTF-16 writes and numeric/prototype APIs required by napi and Vite.
// Non-Workers embedders obtain the same native module through their Node API;
// there is deliberately no emulated Buffer fallback.
const __bufferModule = __nativeBuiltin("buffer");
const __BufferMod = __bufferModule.Buffer;

// ═══════════════════════════════════════════════════════════════════════
// ──  Process output is bytes ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// A process's stdout and stderr are byte streams: esbuild's service protocol
// is binary packets, and so is any program piping an image or an archive.
// The relay to the supervisor carries Uint8Array; a text producer encodes
// at its own edge, and the facet's REPORTED result — the \`stdout\`/\`stderr\`
// strings the wrapper declares — decodes at its edge with one streaming
// decoder per stream, so a multibyte character split across two writes
// still reads as one character.
const __nimbusOutEnc = new TextEncoder();
const __nimbusOutDec = { stdout: new TextDecoder("utf-8", { ignoreBOM: true }), stderr: new TextDecoder("utf-8", { ignoreBOM: true }) };
/** \`process.stdout.write(d, enc)\` payload as bytes. */
function __nimbusOutBytes(d, enc) {
  if (d instanceof Uint8Array) return d;
  if (typeof d === "string") {
    return typeof enc === "string" && enc !== "utf8" && enc !== "utf-8"
      ? __BufferMod.from(d, enc)
      : __nimbusOutEnc.encode(d);
  }
  return __nimbusOutEnc.encode(String(d));
}
/** Decode one stream's bytes into its text accumulator, streaming. */
function __nimbusOutText(streamName, bytes) {
  return __nimbusOutDec[streamName === "stderr" ? "stderr" : "stdout"].decode(bytes, { stream: true });
}

// ═══════════════════════════════════════════════════════════════════════
// ──  fs.constants (linux x64) ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// The ONE table behind fs.constants, fs.promises.constants, and the fs slice
// of node:constants / process.binding('fs'). Values are real Node on Linux
// x64 (node -p 'require("fs").constants'). Packages compose open flags from
// this table at module init — modern-tar (create-astro via @bluwy/giget-core)
// computes O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW|O_EXCL and passes the number
// to fs.open — so a partial table silently degrades every such open to
// O_RDONLY (0) and every extraction fails ENOENT. Frozen, as Node's is.
const __fsConstants = Object.freeze({
  // ── libuv fs flags ────────────────────────────────────────────────
  UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2,
  // ── open(2) flags ─────────────────────────────────────────────────
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3,
  UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7,
  EXTENSIONLESS_FORMAT_JAVASCRIPT: 0, EXTENSIONLESS_FORMAT_WASM: 1,
  // ── stat.mode file-type bits ──────────────────────────────────────
  S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192,
  S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152,
  O_CREAT: 64, O_EXCL: 128, UV_FS_O_FILEMAP: 0, O_NOCTTY: 256, O_TRUNC: 512,
  O_APPEND: 1024, O_DIRECTORY: 65536, O_NOATIME: 262144, O_NOFOLLOW: 131072,
  O_SYNC: 1052672, O_DSYNC: 4096, O_DIRECT: 16384, O_NONBLOCK: 2048,
  // ── stat.mode permission bits ─────────────────────────────────────
  S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64,
  S_IRWXG: 56, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8,
  S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1,
  // ── fs.access modes ───────────────────────────────────────────────
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  // ── fs.copyFile modes (libuv shape + Node alias) ──────────────────
  UV_FS_COPYFILE_EXCL: 1, COPYFILE_EXCL: 1,
  UV_FS_COPYFILE_FICLONE: 2, COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4, COPYFILE_FICLONE_FORCE: 4,
});

// ═══════════════════════════════════════════════════════════════════════
// ──  fs shim (VFS-backed) ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// libuv's words for each code (core vfs-error.ts ERRNO_DESCRIPTION).
const __nimbusErrnoDescription = ${JSON.stringify(ERRNO_DESCRIPTION)};
const { utf8Length: __nimbusUtf8Length } = ${UTF8_LENGTH_SOURCE};
// fd 0 reading its \`< file\` (__nimbusTakeStdin): the program's read of stdin, not of a file.
let __nimbusTakingStdinFile = false;
const __fsMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  // ── byte-shape helpers ──
  // A file's content is \`Uint8Array | string\`: strings for text the
  // program wrote as text, bytes for everything read from the filesystem.
  function _isBytes(v) { return v instanceof Uint8Array; }
  // Coerce to bytes for binary-write paths. Strings are UTF-8-encoded
  // (lossless for valid Unicode); bytes pass through.
  function _asBytes(v) {
    if (_isBytes(v)) return v;
    if (typeof v === "string") return _enc.encode(v);
    return new Uint8Array(0);
  }
  // Coerce to string for text-read paths. Bytes are UTF-8-decoded
  // (lossy for invalid sequences — same caveat as Node's
  // \`Buffer.toString('utf8')\`); strings pass through.
  function _asString(v) {
    if (typeof v === "string") return v;
    if (_isBytes(v)) return _dec.decode(v);
    return "";
  }
  // A file's content as the string an \`encoding\` option asks for: UTF-8
  // text, or its bytes in base64, hex, latin1, … (Buffer#toString).
  function _decodeAs(v, encoding) {
    const name = __pathToLowerCase(String(encoding));
    if (name === "utf8" || name === "utf-8") return _asString(v);
    return __BufferMod.from(_isBytes(v) ? v : _asString(v)).toString(encoding);
  }

  // ── helpers ──
  function _strip(p) { return __vfsKey(String(p)); }
  function _resolve(p) {
    // X.5-O: WHATWG-URL → POSIX path coercion. Pre-fix String(p) on
    // a URL instance or 'file://' string produced 'file:///package.json';
    // that failed the startsWith('/') guard below and got misrouted via
    // path.resolve(cwd, 'file:///…') → corrupt path → ENOENT (verify-90993b3
    // §3 bucket O: vite). Strip 'file://' and unwrap URL instances first.
    let s;
    if (p && typeof p === "object" && p.protocol === "file:" && typeof p.pathname === "string") {
      // URL instance — pathname is already a POSIX path with leading /
      try { s = __pathDecodeURIComponent(p.pathname); } catch { s = p.pathname; }
    } else {
      s = String(p);
      if (__pathStartsWith(s, "file://")) {
        // 'file:///abs' → '/abs', 'file://host/abs' → '/abs'
        const tail = __pathSlice(s, 7);
        const slashIdx = __pathIndexOf(tail, "/");
        const pathPart = __pathStartsWith(tail, "/") ? tail : (slashIdx >= 0 ? __pathSlice(tail, slashIdx) : "/" + tail);
        try { s = __pathDecodeURIComponent(pathPart); } catch { s = pathPart; }
      }
    }
    if (__pathStartsWith(s, "/")) return __vfsNormalizePath(s);
    return __vfsNormalizePath(__pathMod.resolve(cwd || "/home/user", s));
  }


  function _createMode(opts) {
    return _coerceMode(opts !== null && typeof opts === "object" ? opts.mode : undefined, 0o666);
  }

  // The errors this fs made itself, as Node words them: a call's refusal passes them on as they are (_rfError).
  const _madeHere = new __NimbusSafeWeakSet();
  function _fsErr(code, syscall, p, dest) {
    const described = Object.prototype.hasOwnProperty.call(__nimbusErrnoDescription, code) ? __nimbusErrnoDescription[code] + ", " : "";
    const second = dest === undefined ? "" : " -> '" + dest + "'";
    const err = new Error(code + ": " + described + syscall + " '" + p + "'" + second);
    // Node's uvException order: errno, code, syscall, path, dest.
    const errno = Number(__constantsMod[code]);
    err.errno = Number.isInteger(errno) ? -errno : -1;
    err.code = code;
    err.syscall = syscall;
    err.path = String(p);
    if (dest !== undefined) err.dest = String(dest);
    _madeHere.add(err);
    return err;
  }

  /**
   * Turn a failed supervisor call into a filesystem error the caller can
   * branch on. Every exit from here carries a code, a syscall, a path and an
   * errno, because that is the shape everything written against node:fs
   * expects — \`err.code === 'ENOENT'\` is how programs make decisions.
   *
   * The code arrives as the error's own property. Both ends of the RPC run
   * with workerd's \`enhanced_error_serialization\`, which carries an error's
   * own properties across (the host refuses to compose without it), so the
   * code the authority set (_fsErr here, fsError in the runtime-fs bridge,
   * vfsError and VfsError in the VFS) is the code seen here.
   *
   * What this does fix: a failure with no errno spelling at all — the object
   * was reset, the RPC disconnected, a quota was hit — used to be returned
   * UNCHANGED, carrying no code. A program branching on err.code then matched
   * no arm at all, so an I/O failure presented as a hang rather than an
   * error. EIO is the honest answer: the operation failed, and no more
   * specific reason is known. The authority's own words stay in the message
   * so classifying the failure does not cost the reason for it.
   */
  function _mapSupervisorError(error, syscall, p, dest) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    const declared = error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
    const known = declared !== undefined && Number.isInteger(Number(__constantsMod[declared]));
    const mapped = _fsErr(known ? declared : "EIO", syscall, p, dest);
    // An I/O failure says what failed (the client's write the session did not answer, a lost call).
    if ((!known || declared === "EIO") && message) mapped.message += " — " + message;
    return mapped;
  }

  function _coerceMode(value, def) {
    return parseFileMode(value, "mode", def) & 0o7777;
  }

  function _coerceTimeMs(value, syscall, p) {
    if (value instanceof Date) {
      const ms = value.getTime();
      if (Number.isFinite(ms)) return Math.trunc(ms);
      throw _fsErr("EINVAL", syscall, p);
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw _fsErr("EINVAL", syscall, p);
    return Math.trunc(n * 1000);
  }

  const _S_IFMT = 0o170000;
  function StatsBase(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks) {
    this.dev = dev;
    this.mode = mode;
    this.nlink = nlink;
    this.uid = uid;
    this.gid = gid;
    this.rdev = rdev;
    this.blksize = blksize;
    this.ino = ino;
    this.size = size;
    this.blocks = blocks;
  }
  for (const [name, format] of [["isDirectory", 0o040000], ["isFile", 0o100000], ["isBlockDevice", 0o060000], ["isCharacterDevice", 0o020000], ["isSymbolicLink", 0o120000], ["isFIFO", 0o010000], ["isSocket", 0o140000]]) {
    StatsBase.prototype[name] = { [name]() { return this._checkModeProperty(format); } }[name];
  }
  const _lazyDateFields = Object.fromEntries(["atime", "mtime", "ctime", "birthtime"].map((name) => [name, {
    enumerable: true,
    configurable: true,
    get() { return (this[name] = new Date(Math.round(Number(this[name + "Ms"])))); },
    set(value) { Object.defineProperty(this, name, { value, writable: true }); },
  }]));
  function BigIntStats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeNs, mtimeNs, ctimeNs, birthtimeNs) {
    Reflect.apply(StatsBase, this, [dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks]);
    this.atimeMs = atimeNs / 1000000n;
    this.mtimeMs = mtimeNs / 1000000n;
    this.ctimeMs = ctimeNs / 1000000n;
    this.birthtimeMs = birthtimeNs / 1000000n;
    this.atimeNs = atimeNs;
    this.mtimeNs = mtimeNs;
    this.ctimeNs = ctimeNs;
    this.birthtimeNs = birthtimeNs;
  }
  Object.setPrototypeOf(BigIntStats.prototype, StatsBase.prototype);
  Object.setPrototypeOf(BigIntStats, StatsBase);
  Object.defineProperties(BigIntStats.prototype, _lazyDateFields);
  BigIntStats.prototype._checkModeProperty = function (property) {
    return (this.mode & BigInt(_S_IFMT)) === BigInt(property);
  };
  function Stats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs) {
    Reflect.apply(StatsBase, this, [dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks]);
    this.atimeMs = atimeMs;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = ctimeMs;
    this.birthtimeMs = birthtimeMs;
  }
  Object.setPrototypeOf(Stats.prototype, StatsBase.prototype);
  Object.setPrototypeOf(Stats, StatsBase);
  Object.defineProperties(Stats.prototype, _lazyDateFields);
  Stats.prototype._checkModeProperty = function (property) {
    return (this.mode & _S_IFMT) === property;
  };
  // The device of a stat with none (a heap-only embedder's); 512-byte blocks, 4096 at a time.
  const _STAT_DEVICE = 2049;
  const _STAT_BLKSIZE = 4096;
  // A path's Stats; without a link count, a directory has two, a file one.
  function _newStats(mode, uid, gid, ino, size, atimeMs, mtimeMs, ctimeMs, nlink, dev) {
    const blocks = Math.ceil(size / _STAT_BLKSIZE) * (_STAT_BLKSIZE / 512);
    const links = nlink ?? ((mode & _S_IFMT) === 0o040000 ? 2 : 1);
    return new Stats(dev ?? _STAT_DEVICE, mode, links, Number(uid), Number(gid), 0, _STAT_BLKSIZE, ino ?? 0, size, blocks, atimeMs, mtimeMs, ctimeMs, ctimeMs);
  }
  // A stat call's answer, BigIntStats in nanoseconds where \`bigint\` (its
  // options' bigint, read before its I/O, as Node reads it).
  function _statsAs(stats, bigint) {
    if (stats === undefined || !bigint) return stats;
    const big = (value) => BigInt(Math.trunc(Number(value)));
    const ns = __nimbusMsToNs;
    return new BigIntStats(big(stats.dev), big(stats.mode), big(stats.nlink), big(stats.uid), big(stats.gid), big(stats.rdev), big(stats.blksize),
      big(stats.ino), big(stats.size), big(stats.blocks), ns(stats.atimeMs), ns(stats.mtimeMs), ns(stats.ctimeMs), ns(stats.birthtimeMs));
  }
  // A path's mode: its stored bits, its type's where they name none, and this process's own chmod over them.
  function _statMode(isDir, isSymlink, mode) {
    const typeMode = isDir ? 0o040000 : isSymlink ? 0o120000 : 0o100000;
    const storedMode = Number(mode);
    return Number.isInteger(storedMode)
      ? ((storedMode & _S_IFMT) === 0 ? typeMode | storedMode : storedMode)
      : typeMode | (isDir ? 0o755 : 0o644);
  }

  function _statObject(meta) {
    const type = meta?.type || (meta?.isDir || meta?.isDirectory ? "directory" : "file");
    const isDir = type === "directory";
    const isSymlink = type === "symlink";
    const now = __nimbusOwnNow();
    const mtimeMs = Number(meta?.mtime ?? now);
    const atimeMs = Number(meta?.atime ?? meta?.mtime ?? now);
    const ctimeMs = Number(meta?.ctime ?? meta?.mtime ?? now);
    const mode = _statMode(isDir, isSymlink, Number(meta?.mode ?? (isDir ? 0o755 : 0o644)));
    return _newStats(mode, meta?.uid, meta?.gid, _statIdentity(meta?.ino), Number(meta?.size || 0), atimeMs, mtimeMs, ctimeMs, _statIdentity(meta?.nlink), _statIdentity(meta?.dev));
  }

  function _statIdentity(value) {
    return value === undefined || value === null ? undefined : Number(value);
  }

  // Each exact dirent type's S_IFMT bits and Node predicate (core's vfs/dirent-type.ts).
  const _direntTypes = ${JSON.stringify(DIRENT_TYPES)};
  /** The dirent type a mode's format bits name, or \`fallback\` where they name none. */
  function _direntTypeOfMode(mode, fallback) {
    const format = Number(mode) & 0o170000;
    for (const type in _direntTypes) if (_direntTypes[type].format === format) return type;
    return fallback;
  }
  /** The dirent type an lstat says, for an entry the listing could not type ('unknown'). */
  function _direntTypeOfStats(st) {
    return _direntTypeOfMode(st.mode, st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "file");
  }

  // The one Dirent shape: readdir({ withFileTypes }) sync and async, and
  // every Dir.read(), for an entry whose type is known (an 'unknown' one is
  // lstat'ed first). \`parentPath\` is Node's field; \`path\` its deprecated
  // alias that older callers still read.
  class __Dirent {
    constructor(name, type, parentPath) {
      this.name = name;
      this.parentPath = parentPath === undefined ? "" : String(parentPath);
      this.path = this.parentPath;
      this._holds = _direntTypes[type === "dir" ? "directory" : type]?.node;
    }
    isFile() { return this._holds === "isFile"; }
    isDirectory() { return this._holds === "isDirectory"; }
    isSymbolicLink() { return this._holds === "isSymbolicLink"; }
    isBlockDevice() { return this._holds === "isBlockDevice"; }
    isCharacterDevice() { return this._holds === "isCharacterDevice"; }
    isFIFO() { return this._holds === "isFIFO"; }
    isSocket() { return this._holds === "isSocket"; }
  }
  function _direntObject(name, type, parentPath) { return new __Dirent(name, type, parentPath); }

  const READ_STREAM_CHUNK_BYTES = 65536;
  const READ_BATCH_REQUEST_BYTES = ${FS_READ_BATCH_REQUEST_BYTES};

  // ── The process's filesystem (core runtime/wasi/resident-filesystem.ts) ──
  // Every call below answers through it: a synchronous call through its
  // synchronous face, which answers from what this process holds and has
  // decided or refuses (EAGAIN: what it needs is the session's, not
  // resident), an asynchronous one through the filesystem itself, which
  // waits for the session where it must. What this process changes is
  // decided there (its holder and provisional decisions) and sent in its
  // client's waves; what the session holds is its store's view.
  function _rf() { return __nimbusResidentFs(); }

  /**
   * A refusal or failure of the process's filesystem, as Node reports
   * \`syscall\` of \`p\` (and \`dest\`). A synchronous call it could not answer
   * now names its async remedy (\`asyncForm\`): the program's way to the bytes.
   */
  /**
   * A synchronous access to a file's content where its miss would be raised
   * (_rfError): a run again of a run that stopped at that miss has reached
   * where it stopped (stop-replay.ts read). Not a speculation's, nor fd 0's
   * read of a \`< file\` (__nimbusTakeStdin).
   */
  function _contentRead(absPath) {
    if (__nimbusReplay && !globalThis.__nimbusVfsSpeculation && !__nimbusTakingStdinFile) __nimbusReplay.read(_strip(absPath));
  }
  function _rfError(error, syscall, p, dest, asyncForm) {
    // What this fs judged itself (an fs error it made, a Node error such as ERR_FS_EISDIR) is already Node's.
    if (_madeHere.has(error) || (error !== null && typeof error === "object" && typeof error.code === "string" && __pathStartsWith(error.code, "ERR_"))) return error;
    const mapped = _mapSupervisorError(error, syscall, p, dest);
    if (mapped.code !== "EAGAIN") return mapped;
    const named = typeof p === "string" || p instanceof URL;
    // On a mount, in a directory its launch did not list: the namespace cannot say what is there.
    const mount = typeof __resident !== "undefined" && named ? __resident.namespace.unknown(_strip(_resolve(p)), true, true) : null;
    // A content read this process does not hold: a one-shot that can be run again stops here, to run again
    // as a resident, which holds the file (stop-replay.ts miss). Not a speculation's (its fetch repairs it),
    // nor fd 0's read of a \`< file\`, which stops for stdin (__nimbusTakeStdin).
    if (mount === null && named && (syscall === "open" || syscall === "read") && __nimbusReplay && !globalThis.__nimbusVfsSpeculation && !__nimbusTakingStdinFile) {
      __nimbusReplay.miss(_strip(_resolve(p)));
    }
    mapped.message = mount !== null
      ? "EAGAIN: " + syscall + " '" + String(p) + "'" + (dest === undefined ? "" : " -> '" + dest + "'") + ": " + mount
        + " is an asynchronous mount; this caller cannot wait for it" + (asyncForm ? "; " + asyncForm + " reads it" : "")
      : _fsErr("EAGAIN", syscall, p, dest).message + " — '" + String(p) + "' exists but its content is not " +
        "resident in this facet, and synchronous I/O cannot block to fetch it" + (asyncForm ? "; " + asyncForm + " reads it from the live filesystem" : "");
    return mapped;
  }
  /** \`run\` over the synchronous face, its refusal Node's \`syscall\` of \`p\`. */
  function _sync(syscall, p, asyncForm, run, dest) {
    let fs;
    try { fs = _rf().synchronous; }
    catch (error) { throw _rfError(error, syscall, p, dest, asyncForm); }
    try { return run(fs); }
    catch (error) { throw _rfError(error, syscall, p, dest, asyncForm); }
  }
  /**
   * \`run\` over the filesystem, awaited, its refusal Node's \`syscall\` of
   * \`p\`: an operation in flight from its start to its answer, as Node's
   * libuv request is, so the program is not taken for finished between the
   * session calls it makes. A change is answered once the session has
   * everything the process logged (another process reads it as this one
   * was told it is), its refusal the call's: as this fs has always answered
   * an awaited change.
   */
  function _async(syscall, p, run, dest) {
    return __nimbusTrackOp((async () => {
      try {
        const fs = _rf();
        const answer = await run(fs);
        if (__nimbusProcessSupervised) await fs.flush();
        return answer;
      } catch (error) { throw _rfError(error, syscall, p, dest); }
    })());
  }
  /** An awaited call that changes nothing (a read's): answered as the filesystem answers it. */
  function _asyncQuiet(syscall, p, run) {
    return __nimbusTrackOp((async () => {
      try { return await run(_rf()); }
      catch (error) { throw _rfError(error, syscall, p); }
    })());
  }
  /**
   * An awaited call that reads what a name is or holds (an open among them):
   * over the session as it is now, as Node's call finds what another process
   * just did. The filesystem owes its barrier, which the call's walk takes
   * before it answers from what this process holds (inbound).
   */
  function _asyncRead(syscall, p, run) {
    return _asyncQuiet(syscall, p, (fs) => {
      if (__nimbusProcessSupervised) fs.inbound();
      return run(fs);
    });
  }
  /** A name's answer where nothing is there at all (readlink's ENOENT, beside its EINVAL). */
  const _absent = {};
  /** A path's string as the filesystem takes it, from Node's argument forms. */
  function _at(p) { return _resolve(p); }
  /** A stat answer as Node's Stats (BigIntStats where \`bigint\`), undefined for none. */
  function _stats(stat, bigint) {
    return stat === null || stat === undefined ? undefined : _statsAs(_statObject(stat), bigint);
  }
  /** What a write keeps of the caller's data: its bytes (copied: a program may reuse its buffer), a string encoded as \`encoding\` says. */
  function _writeBytes(data, encoding) {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    const text = typeof data === "string" ? data : String(data);
    const name = typeof encoding === "string" ? __pathToLowerCase(encoding) : "utf8";
    return name === "utf8" || name === "utf-8" ? _enc.encode(text) : _asBytes(__BufferMod.from(text, encoding));
  }
  function _encodingOf(opts) { return typeof opts === "string" ? opts : opts?.encoding; }
  /** A write's open flags (Node's \`flag\` option, \`w\` unless given), with its create mode. */
  function _writeFlags(opts, flag) {
    const fl = _parseOpenFlags(opts !== null && typeof opts === "object" && opts.flag !== undefined ? opts.flag : flag);
    return { ...fl, mode: _createMode(opts) };
  }
  /** A whole-file write by descriptor: an open with \`fl\`, every byte written, closed. */
  function _writeThrough(fs, absPath, bytes, fl) {
    const opened = fs.open(absPath, fl);
    let done = false;
    try {
      let at = 0;
      while (at < bytes.byteLength) at += fs.write(opened.id, null, bytes.subarray(at));
      done = true;
    } finally {
      try { fs.close(opened.id); } catch (error) { if (done) throw error; }
    }
  }
  async function _writeThroughAsync(fs, absPath, bytes, fl) {
    const opened = await fs.open(absPath, fl);
    let done = false;
    try {
      let at = 0;
      while (at < bytes.byteLength) at += await fs.write(opened.id, null, bytes.subarray(at));
      done = true;
    } finally {
      try { await fs.close(opened.id); } catch (error) { if (done) throw error; }
    }
  }
  /** Whether \`fl\` is a whole-file write the filesystem's writeFile makes: create, truncate, write, default mode, nothing else. */
  function _plainWrite(fl) {
    return fl.write && fl.create && fl.truncate && !fl.append && !fl.exclusive && !fl.read && !fl.directory && fl.followSymlinks && !fl.sync && fl.mode === 0o666;
  }
  function _accessMode(p, mode) {
    const requested = mode === undefined ? 0 : Number(mode);
    if (!Number.isInteger(requested) || requested < 0 || (requested & ~7) !== 0) throw _fsErr("EINVAL", "access", p);
    return requested;
  }
  function _times(atime, mtime, syscall, p) {
    return [_coerceTimeMs(atime, syscall, p), _coerceTimeMs(mtime, syscall, p)];
  }
  /** The directory entries the filesystem lists, as readdir answers them: names in code-unit order, or Dirents. */
  function _listed(entries, absPath, opts, lstat) {
    // On the launch's captures: a program may have replaced Array.prototype.sort or map, which Node's readdir never asks.
    const sorted = new __PathList();
    for (let i = 0; i < entries.length; i++) sorted[i] = entries[i];
    __nimbusSort(sorted, (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const encoding = _encodingOf(opts);
    const out = new __PathList();
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      if (!opts?.withFileTypes) out[i] = encoding === "buffer" ? __BufferMod.from(entry.name) : entry.name;
      else out[i] = _direntObject(entry.name, entry.type === "unknown" ? _direntTypeOfStats(lstat(absPath + "/" + entry.name)) : entry.type, absPath);
    }
    return __nimbusArrayCopy(out);
  }
  /** The first directory a recursive mkdir of \`absPath\` makes, or undefined: what Node's answers. */
  function _firstMissing(absPath, stat) {
    const parts = absPath.split("/").filter(Boolean);
    let at = "";
    for (const part of parts) {
      at += "/" + part;
      if (stat(at) === null) return at;
    }
    return undefined;
  }

  // ── Synchronous calls ──
  function readFileSync(p, opts) {
    // fd 0 and the paths that name it read the launch's stdin from the
    // position synchronous reads share (__nimbusSyncStdinState): all of it
    // once its writer has finished. A pipe still open has more to come, which
    // Node blocks for: the run stops until its writer ends it, and runs again
    // (__nimbusStopForStdin). A \`< file\` larger than the read ahead is
    // served from its start only.
    if (p === 0 || __NIMBUS_STDIN_PATHS.has(p)) {
      if (!__nimbusStdinEnded()) {
        throw __nimbusSyncStdinError("readFileSync", __nimbusStdinFileSource() !== null ? "" : __nimbusStopForStdin("end", "read"));
      }
      const state = __nimbusSyncStdinState();
      const all = state.source.bytes;
      __nimbusReplay?.readAll(all.byteLength - state.pos);
      const bytes = __BufferMod.from(all.subarray(state.pos));
      state.pos = all.byteLength;
      __nimbusStdinFollower?.consumed();
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      return encoding ? bytes.toString(encoding) : bytes;
    }
    const absPath = _at(p);
    _contentRead(absPath);
    const content = _readingDirectory(p, () => _sync("open", p, "fs.promises.readFile", (fs) => fs.readFile(absPath)));
    if (content === null) throw _fsErr("ENOENT", "open", p);
    return _readAnswer(absPath, content, opts);
  }
  /** A directory opens for reading and refuses the read: Node's EISDIR of a whole-file read is its read's. */
  function _readingDirectory(p, read) {
    const isDirectory = (error) => error !== null && typeof error === "object" && error.code === "EISDIR";
    let answer;
    try { answer = read(); } catch (error) { throw isDirectory(error) ? _fsErr("EISDIR", "read", p) : error; }
    return answer instanceof Promise ? answer.catch((error) => { throw isDirectory(error) ? _fsErr("EISDIR", "read", p) : error; }) : answer;
  }
  /** A whole-file read's answer: a string where an encoding is asked, else a Buffer, tagged where the launch compiled the image. */
  function _readAnswer(absPath, content, opts) {
    const encoding = _encodingOf(opts);
    if (encoding) return _decodeAs(content, encoding);
    const bytes = __BufferMod.from(content);
    // A wasm image the launch compiled through the module map is tagged on
    // the way out, so the WebAssembly seam below can answer the package's own
    // new WebAssembly.Module(readFileSync(...)) with the compiled module —
    // request-time compilation from bytes is refused by the runtime.
    const precompiled = __nimbusMapGet(__nimbusPrecompiledWasm, _strip(absPath));
    if (precompiled !== undefined) bytes[__nimbusWasmModuleTag] = precompiled;
    return bytes;
  }

  function writeFileSync(p, data, opts) {
    const absPath = _at(p);
    const fl = _writeFlags(opts, "w");
    const bytes = _writeBytes(data, _encodingOf(opts));
    _sync("open", p, "fs.promises.writeFile", (fs) => (_plainWrite(fl) ? fs.writeFile(absPath, bytes) : _writeThrough(fs, absPath, bytes, fl)));
  }
  function appendFileSync(p, data, opts) {
    const absPath = _at(p);
    const bytes = _writeBytes(data, _encodingOf(opts));
    _sync("open", p, "fs.promises.appendFile", (fs) => _writeThrough(fs, absPath, bytes, _writeFlags(opts, "a")));
  }

  /** Whether the path names anything, as Node answers it: never a throw. */
  function existsSync(p) {
    if (p === undefined || p === null || p === "") return false;
    try { return _rf().synchronous.stat(_at(p)) !== null; }
    catch { return false; }
  }
  function statSync(p, opts) {
    const absPath = _at(p);
    const stat = _sync("stat", p, "fs.promises.stat", (fs) => fs.stat(absPath));
    if (stat === null) {
      // Node's statSync honors { throwIfNoEntry: false } by returning undefined
      // for a missing path instead of throwing.
      if (opts && opts.throwIfNoEntry === false) return undefined;
      throw _fsErr("ENOENT", "stat", p);
    }
    return _stats(stat, Boolean(opts?.bigint));
  }
  function lstatSync(p, opts) {
    const absPath = _at(p);
    const stat = _sync("lstat", p, "fs.promises.lstat", (fs) => fs.stat(absPath, { followSymlinks: false }));
    if (stat === null) {
      if (opts && opts.throwIfNoEntry === false) return undefined;
      throw _fsErr("ENOENT", "lstat", p);
    }
    return _stats(stat, Boolean(opts?.bigint));
  }
  function readdirSync(p, opts) {
    const absPath = _at(p);
    const entries = _sync("scandir", p, "fs.promises.readdir", (fs) => fs.readdir(absPath));
    return _listed(entries, absPath, opts, (at) => lstatSync(at));
  }
  function accessSync(p, mode) {
    const absPath = _at(p);
    const requested = _accessMode(p, mode);
    _sync("access", p, "fs.promises.access", (fs) => fs.access(absPath, requested));
  }
  function realpathSync(p, opts) {
    const absPath = _at(String(p));
    const real = _sync("realpath", p, "fs.promises.realpath", (fs) => fs.realpath(absPath));
    return _encodingOf(opts) === "buffer" ? __BufferMod.from(real) : real;
  }
  realpathSync.native = realpathSync;
  function readlinkSync(p, opts) {
    const absPath = _at(p);
    // No link there: nothing at all (ENOENT), or a name that is not a link (EINVAL).
    const target = _sync("readlink", p, "fs.promises.readlink", (fs) => fs.readlink(absPath) ?? (fs.stat(absPath, { followSymlinks: false }) === null ? _absent : null));
    if (target === _absent) throw _fsErr("ENOENT", "readlink", p);
    if (target === null) throw _fsErr("EINVAL", "readlink", p);
    return _encodingOf(opts) === "buffer" ? __BufferMod.from(target) : target;
  }

  function mkdirSync(p, opts) {
    const absPath = _at(p);
    const options = typeof opts === "object" && opts !== null ? opts : { mode: opts };
    const recursive = !!options.recursive;
    const mode = options.mode === undefined ? 0o777 : _coerceMode(options.mode);
    return _sync("mkdir", p, "fs.promises.mkdir", (fs) => {
      const first = recursive ? _firstMissing(absPath, (at) => fs.stat(at)) : undefined;
      fs.mkdir(absPath, { recursive, mode, umask: __processUmask });
      return first;
    });
  }
  function unlinkSync(p) {
    const absPath = _at(p);
    _sync("unlink", p, "fs.promises.unlink", (fs) => fs.unlink(absPath));
  }
  function rmdirSync(p) {
    const absPath = _at(p);
    _sync("rmdir", p, "fs.promises.rmdir", (fs) => fs.rmdir(absPath));
  }
  function renameSync(oldP, newP) {
    const from = _at(oldP);
    const to = _at(newP);
    _sync("rename", oldP, "fs.promises.rename", (fs) => fs.rename(from, to), newP);
  }
  function symlinkSync(target, path) {
    const absPath = _at(path);
    const text = String(target);
    _sync("symlink", text, "fs.promises.symlink", (fs) => fs.symlink(text, absPath), path);
  }
  function linkSync(existingPath, newPath) { throw _fsErr("ENOSYS", "link", existingPath, newPath); }
  function copyFileSync(src, dest, mode) {
    const from = _at(src);
    const to = _at(dest);
    _sync("copyfile", src, "fs.promises.copyFile", (fs) => {
      if ((Number(mode) & __fsConstants.COPYFILE_EXCL) !== 0 && fs.stat(to) !== null) throw _fsErr("EEXIST", "copyfile", src, dest);
      fs.copyFile(from, to, { keepMode: true });
    }, dest);
  }
  /** rm's refusals before it removes: a directory without \`recursive\` (ERR_FS_EISDIR), nothing there without \`force\`. */
  function _rmJudged(stat, p, o) {
    if (stat === null) {
      if (o.force) return false;
      throw _fsErr("ENOENT", "rm", p);
    }
    if (stat.type === "directory" && !o.recursive) {
      throw new nodeErrorCodes.ERR_FS_EISDIR({ code: "EISDIR", message: "is a directory", path: String(p), syscall: "rm", errno: Number(__constantsMod.EISDIR) });
    }
    return true;
  }
  /**
   * rm -r's removal of what \`type\` names at \`absPath\`, for a caller that
   * cannot wait: a directory's names first, each unlinked or removed in turn
   * (Node's rimraf), so each is a removal the filesystem decides now. A name
   * gone meanwhile is not there to remove.
   */
  function _removeTreeSync(fs, absPath, type) {
    if (type !== "directory") { fs.unlink(absPath); return; }
    const entries = fs.readdir(absPath);
    for (let i = 0; i < entries.length; i++) {
      const child = absPath + "/" + entries[i].name;
      const childType = entries[i].type === "unknown" ? fs.stat(child, { followSymlinks: false })?.type : entries[i].type;
      if (childType !== undefined) _removeTreeSync(fs, child, childType === "dir" ? "directory" : childType);
    }
    fs.rmdir(absPath);
  }
  function truncateSync(p, len) {
    const absPath = _at(p);
    const size = Math.max(0, Math.trunc(Number(len) || 0));
    // Node's own: an open of it 'r+', its ftruncate, its close.
    _sync("open", p, "fs.promises.truncate", (fs) => {
      const opened = fs.open(absPath, _openFlags("r+"));
      let done = false;
      try { fs.ftruncate(opened.id, size); done = true; }
      finally { try { fs.close(opened.id); } catch (error) { if (done) throw error; } }
    });
  }
  function rmSync(p, opts) {
    const absPath = _at(p);
    const o = opts || {};
    _sync("rm", p, "fs.promises.rm", (fs) => {
      const stat = fs.stat(absPath, { followSymlinks: false });
      if (_rmJudged(stat, p, o)) _removeTreeSync(fs, absPath, stat.type);
    });
  }
  function chmodSync(p, mode) {
    const absPath = _at(p);
    const bits = _coerceMode(mode);
    _sync("chmod", p, "fs.promises.chmod", (fs) => fs.chmod(absPath, bits));
  }
  function chownSync(p, uid, gid) {
    nodeOwnerId(uid, "uid");
    nodeOwnerId(gid, "gid");
    const absPath = _at(p);
    _sync("chown", p, "fs.promises.chown", (fs) => fs.chown(absPath, Number(uid), Number(gid), { followSymlinks: true }));
  }
  function lchownSync(p, uid, gid) {
    nodeOwnerId(uid, "uid");
    nodeOwnerId(gid, "gid");
    const absPath = _at(p);
    _sync("lchown", p, "fs.promises.lchown", (fs) => fs.chown(absPath, Number(uid), Number(gid), { followSymlinks: false }));
  }
  function utimesSync(p, atime, mtime) {
    const absPath = _at(p);
    const [a, m] = _times(atime, mtime, "utime", p);
    _sync("utime", p, "fs.promises.utimes", (fs) => fs.utimes(absPath, a, m, { followSymlinks: true }));
  }
  function lutimesSync(p, atime, mtime) {
    const absPath = _at(p);
    const [a, m] = _times(atime, mtime, "lutime", p);
    _sync("lutime", p, "fs.promises.lutimes", (fs) => fs.utimes(absPath, a, m, { followSymlinks: false }));
  }

  // ── Asynchronous calls ──
  async function _readFileAsync(p, opts) {
    if (p === 0 || __NIMBUS_STDIN_PATHS.has(p)) return readFileSync(p, opts);
    if (p instanceof __FileHandle) return p.readFile(opts);
    const absPath = _at(p);
    const content = await _readingDirectory(p, () => _asyncRead("open", p, (fs) => fs.readFile(absPath)));
    if (content === null) throw _fsErr("ENOENT", "open", p);
    return _readAnswer(absPath, content, opts);
  }
  async function _writeFileAsync(p, data, opts) {
    if (p instanceof __FileHandle) return p.writeFile(data, opts);
    const absPath = _at(p);
    const fl = _writeFlags(opts, "w");
    const bytes = _writeBytes(await _writeData(data), _encodingOf(opts));
    await _async("open", p, (fs) => (_plainWrite(fl) ? fs.writeFile(absPath, bytes) : _writeThroughAsync(fs, absPath, bytes, fl)));
  }
  /** fs.promises.writeFile's data: an iterable or a stream of chunks, gathered, or the data itself. */
  async function _writeData(data) {
    if (typeof data === "string" || data instanceof Uint8Array || ArrayBuffer.isView(data) || data === null || typeof data !== "object") return data;
    if (typeof data[Symbol.asyncIterator] !== "function" && typeof data[Symbol.iterator] !== "function") return data;
    const parts = [];
    let total = 0;
    for await (const chunk of data) {
      const bytes = _writeBytes(chunk);
      parts.push(bytes);
      total += bytes.byteLength;
    }
    return _concatBytes(parts, total);
  }
  function _concatBytes(parts, total) {
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.byteLength; }
    return out;
  }
  async function _appendFileAsync(p, data, opts) {
    if (p instanceof __FileHandle) return p.appendFile(data, opts);
    const absPath = _at(p);
    const bytes = _writeBytes(data, _encodingOf(opts));
    // A directory refuses the append's write, as Node's says it.
    await _async("open", p, (fs) => _writeThroughAsync(fs, absPath, bytes, _writeFlags(opts, "a"))).catch((error) => {
      throw error && error.code === "EISDIR" ? _fsErr("EISDIR", "write", p) : error;
    });
  }
  async function _statAsync(p) {
    const absPath = _at(p);
    const stat = await _asyncRead("stat", p, (fs) => fs.stat(absPath));
    if (stat === null) throw _fsErr("ENOENT", "stat", p);
    return _stats(stat, false);
  }
  async function _lstatAsync(p) {
    const absPath = _at(p);
    const stat = await _asyncRead("lstat", p, (fs) => fs.stat(absPath, { followSymlinks: false }));
    if (stat === null) throw _fsErr("ENOENT", "lstat", p);
    return _stats(stat, false);
  }
  async function _readdirAsync(p, opts) {
    const absPath = _at(p);
    const entries = await _asyncRead("scandir", p, (fs) => fs.readdir(absPath));
    if (!opts?.withFileTypes || !entries.some((entry) => entry.type === "unknown")) return _listed(entries, absPath, opts);
    // An entry the listing could not type is lstat'ed, as Node's readdir does.
    const typed = [];
    for (const entry of entries) {
      typed.push(entry.type !== "unknown" ? entry : { name: entry.name, type: _direntTypeOfStats(await _lstatAsync(absPath + "/" + entry.name)) });
    }
    return _listed(typed, absPath, opts);
  }
  async function _existsAsync(p) {
    if (p === undefined || p === null || p === "") return false;
    try { return (await _rf().stat(_at(p))) !== null; }
    catch { return false; }
  }
  async function _accessAsync(p, mode) {
    const absPath = _at(p);
    const requested = _accessMode(p, mode);
    await _asyncRead("access", p, (fs) => fs.access(absPath, requested));
  }
  async function _realpathAsync(p, opts) {
    const absPath = _at(String(p));
    const real = await _asyncRead("realpath", p, (fs) => fs.realpath(absPath));
    return _encodingOf(opts) === "buffer" ? __BufferMod.from(real) : real;
  }
  async function _readlinkAsync(p, opts) {
    const absPath = _at(p);
    const target = await _asyncRead("readlink", p, async (fs) => (await fs.readlink(absPath)) ?? ((await fs.stat(absPath, { followSymlinks: false })) === null ? _absent : null));
    if (target === _absent) throw _fsErr("ENOENT", "readlink", p);
    if (target === null) throw _fsErr("EINVAL", "readlink", p);
    return _encodingOf(opts) === "buffer" ? __BufferMod.from(target) : target;
  }
  async function _mkdirAsync(p, opts) {
    const absPath = _at(p);
    const options = typeof opts === "object" && opts !== null ? opts : { mode: opts };
    const recursive = !!options.recursive;
    const mode = options.mode === undefined ? 0o777 : _coerceMode(options.mode);
    return _async("mkdir", p, async (fs) => {
      const first = recursive ? await _firstMissingAsync(absPath, fs) : undefined;
      await fs.mkdir(absPath, { recursive, mode, umask: __processUmask });
      return first;
    });
  }
  async function _firstMissingAsync(absPath, fs) {
    const parts = absPath.split("/").filter(Boolean);
    let at = "";
    for (const part of parts) {
      at += "/" + part;
      if ((await fs.stat(at)) === null) return at;
    }
    return undefined;
  }
  async function _unlinkAsync(p) {
    const absPath = _at(p);
    await _async("unlink", p, (fs) => fs.unlink(absPath));
  }
  async function _rmdirAsync(p) {
    const absPath = _at(p);
    await _async("rmdir", p, (fs) => fs.rmdir(absPath));
  }
  async function _renameAsync(oldP, newP) {
    const from = _at(oldP);
    const to = _at(newP);
    await _async("rename", oldP, (fs) => fs.rename(from, to), newP);
  }
  async function _symlinkAsync(target, path) {
    const absPath = _at(path);
    const text = String(target);
    await _async("symlink", text, (fs) => fs.symlink(text, absPath), path);
  }
  async function _truncateAsync(p, len) {
    if (p instanceof __FileHandle) return p.truncate(len);
    const absPath = _at(p);
    const size = Math.max(0, Math.trunc(Number(len) || 0));
    await _async("truncate", p, (fs) => fs.truncate(absPath, size));
  }
  async function _copyFileAsync(src, dest, mode) {
    const from = _at(src);
    const to = _at(dest);
    await _async("copyfile", src, async (fs) => {
      if ((Number(mode) & __fsConstants.COPYFILE_EXCL) !== 0 && (await fs.stat(to)) !== null) throw _fsErr("EEXIST", "copyfile", src, dest);
      await fs.copyFile(from, to, { keepMode: true });
    }, dest);
  }
  async function _rmAsync(p, opts) {
    const absPath = _at(p);
    const o = opts || {};
    await _async("rm", p, async (fs) => {
      if (_rmJudged(await fs.stat(absPath, { followSymlinks: false }), p, o)) await fs.remove(absPath, { recursive: !!o.recursive, force: !!o.force });
    });
  }
  async function _chmodAsync(p, mode) {
    const absPath = _at(p);
    const bits = _coerceMode(mode);
    await _async("chmod", p, (fs) => fs.chmod(absPath, bits));
  }
  async function _chownAsync(p, uid, gid, opts, syscallOverride) {
    const follow = !(opts && opts.followSymlinks === false);
    const absPath = _at(p);
    await _async(syscallOverride || (follow ? "chown" : "lchown"), p, (fs) => fs.chown(absPath, Number(uid), Number(gid), { followSymlinks: follow }));
  }
  async function _utimesAsync(p, atime, mtime, opts, syscallOverride) {
    const follow = !(opts && opts.followSymlinks === false);
    const syscall = syscallOverride || (follow ? "utime" : "lutime");
    const absPath = _at(p);
    const [a, m] = _times(atime, mtime, syscall, p);
    await _async(syscall, p, (fs) => fs.utimes(absPath, a, m, { followSymlinks: follow }));
  }

  /**
   * fs.watch and fs.watchFile's poll of one path: what the filesystem says
   * of it (its identity, size, times, mode and owner), compared each
   * interval. A call it cannot answer now (a relist) says nothing.
   */
  function _watchPath(filename, onChange) {
    const absPath = _at(filename);
    function snapshot() {
      let stat;
      try { stat = _rf().synchronous.stat(absPath); }
      catch { return null; }
      if (stat === null) return { stamp: "absent", absent: true };
      return { stamp: [stat.dev, stat.ino, stat.type, stat.size, stat.mtime, stat.ctime, stat.mode, stat.uid, stat.gid].join(":"), absent: false };
    }
    let stopped = false;
    let previous = snapshot();
    const interval = setInterval(() => {
      if (stopped) return;
      const current = snapshot();
      if (current === null) return;
      if (previous === null) { previous = current; return; }
      if (current.stamp !== previous.stamp) {
        const eventType = current.absent || previous.absent ? "rename" : "change";
        previous = current;
        onChange(eventType, __pathMod.basename(filename));
      }
    }, 500);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  // ── Descriptors ──
  // Node's one fd table: numbers from 3, each a descriptor of the process's
  // filesystem (its handle id), whose position and access are the
  // filesystem's. O_SYNC is Node's side: each write is followed by an fsync.
  let __nextFileHandleFd = 3;
  const __fileHandles = new Map();
  class __FileHandle {
    constructor(path, opened, fl) {
      this._path = path;
      this._id = opened.id;
      this._flags = fl;
      this._closed = false;
      this.fd = __nextFileHandleFd++;
      __fileHandles.set(this.fd, this);
    }
    _assertOpen(syscall) {
      if (this._closed) throw _fsErr("EBADF", syscall, this._path);
    }
    _readArgs(buffer, offset, length, position) {
      if (buffer && !(buffer instanceof Uint8Array)) {
        // options-object form: read({ buffer, offset, length, position })
        const o = buffer;
        buffer = o.buffer; offset = o.offset; length = o.length; position = o.position;
      }
      if (!buffer) buffer = __BufferMod.alloc(16384);
      const off = offset || 0;
      const want = (length === undefined || length === null) ? buffer.length - off : Math.max(0, Number(length));
      const pos = _isCurrentPos(position) ? null : Math.max(0, Number(position));
      return { buffer, off, want, pos };
    }
    async read(buffer, offset, length, position) {
      this._assertOpen("read");
      const args = this._readArgs(buffer, offset, length, position);
      const slice = await _asyncRead("read", this._path, (fs) => fs.read(this._id, args.pos, args.want));
      args.buffer.set(slice, args.off);
      return { bytesRead: slice.byteLength, buffer: args.buffer };
    }
    _readSync(buffer, offset, length, position) {
      this._assertOpen("read");
      const args = this._readArgs(buffer, offset, length, position);
      _contentRead(_resolve(this._path));
      const slice = _sync("read", this._path, "fs.promises.FileHandle.read", (fs) => fs.read(this._id, args.pos, args.want));
      args.buffer.set(slice, args.off);
      return slice.byteLength;
    }
    async write(buffer, offset, length, position) {
      this._assertOpen("write");
      // As writeSync and callback write read them: (string[, position[,
      // encoding]]), (buffer[, offset[, length[, position]]]) or (buffer, {
      // offset, length, position }).
      const norm = _normWriteArgs(buffer, offset, length, position);
      const pos = _isCurrentPos(norm.pos) ? null : Math.max(0, Number(norm.pos));
      const written = await _async("write", this._path, async (fs) => {
        const n = await fs.write(this._id, pos, norm.bytes);
        if (this._flags.sync) await fs.fsync(this._id);
        return n;
      });
      return { bytesWritten: written, buffer };
    }
    _writeSync(data, a, b, c) {
      this._assertOpen("write");
      const norm = _normWriteArgs(data, a, b, c);
      const pos = _isCurrentPos(norm.pos) ? null : Math.max(0, Number(norm.pos));
      return _sync("write", this._path, "fs.promises.FileHandle.write", (fs) => {
        const n = fs.write(this._id, pos, norm.bytes);
        if (this._flags.sync) fs.fsync(this._id);
        return n;
      });
    }
    async readFile(opts) {
      this._assertOpen("read");
      // From the descriptor's position to its end, as Node's FileHandle.readFile reads.
      const parts = [];
      let total = 0;
      for (;;) {
        const chunk = await _asyncRead("read", this._path, (fs) => fs.read(this._id, null, READ_STREAM_CHUNK_BYTES));
        if (chunk.byteLength === 0) break;
        parts.push(chunk);
        total += chunk.byteLength;
      }
      return _readAnswer(this._path, _concatBytes(parts, total), opts);
    }
    async writeFile(data, opts) {
      this._assertOpen("write");
      const bytes = _writeBytes(await _writeData(data), _encodingOf(opts));
      let at = 0;
      while (at < bytes.byteLength) at += (await this.write(bytes.subarray(at), 0, bytes.byteLength - at, null)).bytesWritten;
    }
    async appendFile(data, opts) { return this.writeFile(data, opts); }
    async stat(opts) {
      this._assertOpen("fstat");
      return _stats(await _asyncRead("fstat", this._path, (fs) => fs.fstat(this._id)), Boolean(opts?.bigint));
    }
    _statSync(opts) {
      this._assertOpen("fstat");
      return _stats(_sync("fstat", this._path, "fs.promises.FileHandle.stat", (fs) => fs.fstat(this._id)), Boolean(opts?.bigint));
    }
    async truncate(len) {
      this._assertOpen("ftruncate");
      const size = Math.max(0, Math.trunc(Number(len) || 0));
      await _async("ftruncate", this._path, (fs) => fs.ftruncate(this._id, size));
    }
    _truncateSync(len) {
      this._assertOpen("ftruncate");
      const size = Math.max(0, Math.trunc(Number(len) || 0));
      _sync("ftruncate", this._path, "fs.promises.FileHandle.truncate", (fs) => fs.ftruncate(this._id, size));
    }
    async chmod(mode) {
      this._assertOpen("fchmod");
      const bits = _coerceMode(mode);
      await _async("fchmod", this._path, (fs) => fs.fchmod(this._id, bits));
    }
    async chown(uid, gid) {
      this._assertOpen("fchown");
      await _async("fchown", this._path, (fs) => fs.fchown(this._id, Number(uid), Number(gid)));
    }
    async utimes(atime, mtime) {
      this._assertOpen("futime");
      const [a, m] = _times(atime, mtime, "futime", this._path);
      await _async("futime", this._path, (fs) => fs.futimes(this._id, a, m));
    }
    async sync() { this._assertOpen("fsync"); await _async("fsync", this._path, (fs) => fs.fsync(this._id)); }
    async datasync() { this._assertOpen("fdatasync"); await _async("fdatasync", this._path, (fs) => fs.fsync(this._id)); }
    // Scatter/gather: one sequential pass per buffer, stopping at the first
    // short read, positions advanced by hand when an explicit one was given
    // so the file position stays untouched.
    async readv(buffers, position) {
      this._assertOpen("read");
      let bytesRead = 0;
      let pos = _isCurrentPos(position) ? null : Number(position);
      for (const buffer of buffers) {
        const r = await this.read(buffer, 0, buffer.byteLength, pos);
        bytesRead += r.bytesRead;
        if (pos !== null) pos += r.bytesRead;
        if (r.bytesRead < buffer.byteLength) break;
      }
      return { bytesRead, buffers };
    }
    async writev(buffers, position) {
      this._assertOpen("write");
      let bytesWritten = 0;
      let pos = _isCurrentPos(position) ? null : Number(position);
      for (const buffer of buffers) {
        const r = await this.write(buffer, 0, buffer.byteLength, pos);
        bytesWritten += r.bytesWritten;
        if (pos !== null) pos += r.bytesWritten;
      }
      return { bytesWritten, buffers };
    }
    async close() {
      this._assertOpen("close");
      this._closed = true;
      __fileHandles.delete(this.fd);
      await _async("close", this._path, (fs) => fs.close(this._id));
    }
    _closeSync() {
      this._assertOpen("close");
      this._closed = true;
      __fileHandles.delete(this.fd);
      _sync("close", this._path, "fs.promises.FileHandle.close", (fs) => fs.close(this._id));
    }
    [Symbol.asyncDispose]() { return this.close(); }
  }
  /** Node's open flags and create mode as the filesystem takes them (RuntimeOpenFlags). */
  function _openFlags(flags, mode) {
    const fl = _parseOpenFlags(flags);
    return { ...fl, mode: _coerceMode(mode, 0o666), umask: __processUmask };
  }
  async function _openAsync(path, flags, mode) {
    const absPath = _at(path);
    const fl = _openFlags(flags, mode);
    // What the name is now; an open that makes or empties a file is a change, answered once the session has it.
    const changes = fl.write || fl.create || fl.truncate || fl.append;
    const opened = await (changes ? _async : _asyncRead)("open", path, (fs) => {
      if (__nimbusProcessSupervised) fs.inbound();
      return fs.open(absPath, fl);
    });
    return new __FileHandle(path, opened, fl);
  }
  function openSync(path, flags, mode) {
    const absPath = _at(path);
    const fl = _openFlags(flags, mode);
    const opened = _sync("open", path, "fs.promises.open", (fs) => {
      // A directory has no descriptor a synchronous caller reads here: EISDIR, as this fs has always answered it.
      let found = null;
      try { found = fs.stat(absPath); } catch {}
      if (!fl.directory && found?.type === "directory") throw _fsErr("EISDIR", "open", path);
      return fs.open(absPath, fl);
    });
    return new __FileHandle(path, opened, fl).fd;
  }

  /** A ranged read of \`absPath\` (a read stream's window): clamped at its end, null when nothing is there. */
  function _readRangeAt(absPath, displayPath, pos, want) {
    return _asyncRead("read", displayPath, (fs) => fs.readRange(absPath, pos, want));
  }

  /**
   * ACQUIRE: the barrier a resumption takes before the program's callback
   * runs (the filesystem's catchUp), so a synchronous read in it reads the
   * session's state as of the input that woke it. \`delivered\`: the answer
   * a delivery carried, which stands in for asking where it can; \`viaIo\`:
   * I/O just arrived, which a trusted read lease answers without asking.
   */
  async function _resumptionAcquire(delivered, viaIo) {
    if (__nimbusProcessFilesystem === null || !__nimbusProcessSupervised) return;
    await __nimbusProcessFilesystem.catchUp({ viaIo: !!viaIo, delivered: delivered ?? null });
  }

  /**
   * RELEASE: what this process wrote reaches the session before an effect
   * of it can be observed from outside (an outbound request, a frame sent
   * on a relayed socket): what is held is sent first.
   */
  async function _resumptionRelease() {
    if (__nimbusProcessFilesystem === null) return;
    await __nimbusProcessFilesystem.flush();
  }

  // Every untrusted resumption — a facet-local timer, an outbound fetch
  // response, a relayed socket frame — runs user code with no supervisor
  // message behind it, so it cannot have carried an invalidation. The shim
  // owns these entry points, so it takes the missing barrier: the user
  // callback is preceded by a completed ACQUIRE. After it, a synchronous
  // read in the callback is as fresh as an async read at the same instant.
  function _installResumptionBarriers() {
    // This run's, each run: a loader that reuses the isolate runs another process on another filesystem.
    globalThis.__nimbusVfsAcquireBarrier = _resumptionAcquire;
    globalThis.__nimbusVfsAcquireArgs = () => (__nimbusProcessFilesystem === null ? null : __nimbusProcessFilesystem.acquireArgs());
    globalThis.__nimbusVfsReleaseBarrier = _resumptionRelease;
    if (globalThis.__nimbusResumptionBarriersInstalled) return;
    globalThis.__nimbusResumptionBarriersInstalled = true;
    const _setTimeout = globalThis.setTimeout;
    const _setInterval = globalThis.setInterval;
    // The barrier moves the user callback BEHIND an awaited round trip, and
    // the timer bookkeeping counts a timer as done the moment its closure
    // starts. Counting the ACQUIRE as an in-flight operation holds the facet
    // open across it; never the callback that follows it, which is free to be
    // long-lived (an SSE writer). What the callback throws is an uncaught
    // exception, as a timer's is in Node, not the rejection of the chain it
    // runs on.
    const _barriered = (cb, args) => {
      __nimbusTrackOp(globalThis.__nimbusVfsAcquireBarrier()).then(() => {
        try {
          // By the captured Reflect.apply: a program may have replaced the array iterator a spread asks.
          __nimbusApply(cb, undefined, args);
        } catch (error) {
          __nimbusUncaughtException(error);
        }
      });
    };
    if (typeof _setTimeout === "function") {
      globalThis.setTimeout = function setTimeout(cb, ms, ...args) {
        if (typeof cb !== "function") return _setTimeout(cb, ms);
        return _setTimeout(() => { _barriered(cb, args); }, ms);
      };
    }
    if (typeof _setInterval === "function") {
      globalThis.setInterval = function setInterval(cb, ms, ...args) {
        if (typeof cb !== "function") return _setInterval(cb, ms);
        return _setInterval(() => { _barriered(cb, args); }, ms);
      };
    }
  }

  // ── cpSync, fs.promises.cp, fs.cp ──
  // Node's own (lib/internal/fs/cp, vendored), over this fs: its options
  // checked as lib/fs.js checks them.
  function _cpArgs(src, dest, opts) {
    const { getValidatedPath, validateCpOptions } = __nimbusNodeLib().require("internal/fs/utils");
    const options = validateCpOptions(opts);
    return [getValidatedPath(src, "src"), getValidatedPath(dest, "dest"), options];
  }
  function cpSync(src, dest, opts) {
    const args = _cpArgs(src, dest, opts);
    __nimbusNodeLib().require("internal/fs/cp/cp-sync").cpSyncFn(...args);
  }
  async function _cpAsync(src, dest, opts) {
    const args = _cpArgs(src, dest, opts);
    return __nimbusNodeLib().require("internal/fs/cp/cp").cpFn(...args);
  }

  // ── mkdtemp ──
  // Node appends six characters from [a-zA-Z0-9]; a collision with a name
  // the sync view already knows is retried rather than reused.
  const _MKDTEMP_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  function _mkdtempName(prefix) {
    for (let attempt = 0; attempt < 64; attempt++) {
      let suffix = "";
      for (let i = 0; i < 6; i++) suffix += _MKDTEMP_ALPHABET[Math.floor(Math.random() * _MKDTEMP_ALPHABET.length)];
      const name = String(prefix) + suffix;
      if (!existsSync(name)) return name;
    }
    throw _fsErr("EEXIST", "mkdtemp", String(prefix) + "XXXXXX");
  }
  function mkdtempSync(prefix) {
    const name = _mkdtempName(prefix);
    mkdirSync(name, { mode: 0o700 });
    return name;
  }
  async function _mkdtempAsync(prefix) {
    const name = _mkdtempName(prefix);
    await _mkdirAsync(name, { mode: 0o700 });
    return name;
  }

  function readFile(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _readFileAsync(p, opts).then((r) => { if (cb) cb(null, r); }).catch((e) => { if (cb) cb(e); });
  }
  function writeFile(p, d, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _writeFileAsync(p, d, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function appendFile(p, d, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _appendFileAsync(p, d, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  // fs.stat and fs.lstat: (path[, options], callback).
  function stat(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    const bigint = Boolean(opts?.bigint);
    _statAsync(p).then((s) => cb(null, _statsAs(s, bigint)), (e) => cb(e));
  }
  function lstat(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    const bigint = Boolean(opts?.bigint);
    _lstatAsync(p).then((s) => cb(null, _statsAs(s, bigint)), (e) => cb(e));
  }
  function readdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _readdirAsync(p, opts).then((d) => cb(null, d)).catch((e) => cb(e));
  }
  function exists(p, cb) { _existsAsync(p).then((ok) => cb(ok)).catch(() => cb(false)); }
  function mkdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _mkdirAsync(p, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function unlink(p, cb) { _unlinkAsync(p).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  // The callback form proper-lockfile (via graceful-fs) releases its lock directory with.
  function rmdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _rmdirAsync(p).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function rename(oldP, newP, cb) { _renameAsync(oldP, newP).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function utimes(p, atime, mtime, cb) { _utimesAsync(p, atime, mtime).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function lutimes(p, atime, mtime, cb) { _utimesAsync(p, atime, mtime, { followSymlinks: false }).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function chmod(p, mode, cb) { _chmodAsync(p, mode).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  // The callback forms check their ids at once, as Node's do: a bad one throws, never calls back.
  function chown(p, uid, gid, cb) { nodeOwnerId(uid, "uid"); nodeOwnerId(gid, "gid"); _chownAsync(p, uid, gid).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function lchown(p, uid, gid, cb) { nodeOwnerId(uid, "uid"); nodeOwnerId(gid, "gid"); _chownAsync(p, uid, gid, { followSymlinks: false }).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function access(p, mode, cb) {
    if (typeof mode === "function") { cb = mode; mode = undefined; }
    _accessAsync(p, mode).then(() => cb(null)).catch((e) => cb(e));
  }

  // ── open flags, as Node reads them (stringToFlags, node-arguments.ts) ──
  function _parseOpenFlags(flags) {
    const bits = stringToFlags(flags);
    const access = bits & O_ACCMODE;
    return {
      read: access !== O_WRONLY,
      write: access !== O_RDONLY,
      append: (bits & O_APPEND) !== 0,
      create: (bits & O_CREAT) !== 0,
      truncate: (bits & O_TRUNC) !== 0,
      exclusive: (bits & O_EXCL) !== 0,
      directory: (bits & O_DIRECTORY) !== 0,
      // O_NOFOLLOW: a final symbolic link is not opened (ELOOP).
      followSymlinks: (bits & O_NOFOLLOW) === 0,
      // O_SYNC (O_DSYNC's bit among its own): each write is followed by what fsync does for it.
      sync: (bits & O_SYNC) !== 0,
    };
  }

  function _fdHandle(fd, syscall) {
    const handle = __fileHandles.get(Number(fd));
    if (!handle || handle._closed) throw _fsErr("EBADF", syscall, fd);
    return handle;
  }
  // Resolve an fd for a callback-style syscall, delivering EBADF via cb.
  function _fdFor(fd, syscall, cb) {
    try { return _fdHandle(fd, syscall); }
    catch (e) { queueMicrotask(() => cb(e)); return null; }
  }
  function _isStdioFd(fd) { const n = Number(fd); return n === 0 || n === 1 || n === 2; }
  // stdio descriptors are character devices, not VFS files.
  // A terminal's: a character device, crw--w----. Its times are read as
  // the program reads the clock: only the program asks for them, as many
  // times in a run again as in its run, so a run again is handed the same.
  function _stdioStat() {
    const now = Date.now();
    return _newStats(0o020620, cred.uid, cred.gid, undefined, 0, now, now, now, 1);
  }
  // Node treats a null position — and a negative one, which libuv maps to
  // the same thing — as "use and advance the file position".
  function _isCurrentPos(p) {
    return p === undefined || p === null || Number(p) < 0;
  }
  // Normalizes every documented fs.write/writeSync argument shape:
  //   (fd, buffer[, offset[, length[, position]]])
  //   (fd, buffer[, options])   where options = { offset, length, position }
  //   (fd, string[, position[, encoding]])
  function _normWriteArgs(data, a, b, c) {
    if (typeof data === "string") {
      return {
        bytes: _asBytes(__BufferMod.from(data, typeof b === "string" ? b : "utf8")),
        pos: a,
      };
    }
    let off = a, len = b, pos = c;
    if (a !== null && typeof a === "object" && !(a instanceof Uint8Array)) {
      off = a.offset; len = a.length; pos = a.position;
    }
    off = off === undefined || off === null ? 0 : Number(off);
    len = len === undefined || len === null ? data.length - off : Number(len);
    return { bytes: _asBytes(data).subarray(off, off + len), pos };
  }

  function closeSync(fd) {
    if (_isStdioFd(fd)) return;
    _fdHandle(fd, "close")._closeSync();
  }

  function readSync(fd, buffer, offsetOrOptions, length, position) {
    let offset = offsetOrOptions;
    if (offsetOrOptions !== null && typeof offsetOrOptions === "object") {
      offset = offsetOrOptions.offset;
      length = offsetOrOptions.length;
      position = offsetOrOptions.position;
    }
    // fd 0 reads the launch's stdin (__nimbusReadStdinInto). stdout and
    // stderr read nothing.
    if (Number(fd) === 0) return __nimbusReadStdinInto(buffer, offset, length, "read");
    if (_isStdioFd(fd)) return 0;
    return _fdHandle(fd, "read")._readSync(buffer, offset, length, position);
  }

  function writeSync(fd, data, a, b, c) {
    const n = Number(fd);
    if (n === 1 || n === 2) {
      const bytes = _normWriteArgs(data, a, b, c).bytes;
      (n === 2 ? __processMod.stderr : __processMod.stdout).write(bytes);
      return bytes.byteLength;
    }
    if (n === 0) throw _fsErr("EBADF", "write", fd);
    return _fdHandle(fd, "write")._writeSync(data, a, b, c);
  }

  function fstatSync(fd, opts) {
    if (_isStdioFd(fd)) return _statsAs(_stdioStat(), Boolean(opts?.bigint));
    return _fdHandle(fd, "fstat")._statSync(opts);
  }

  function ftruncateSync(fd, len) {
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "ftruncate", fd);
    _fdHandle(fd, "ftruncate")._truncateSync(len);
  }

  // A sync form cannot wait for the session: it reports what was refused already, and holds nothing back.
  function _fsyncSync(fd, syscall) {
    if (_isStdioFd(fd)) return;
    const handle = _fdHandle(fd, syscall);
    _sync(syscall, handle._path, "fs.promises.FileHandle.sync", (fs) => fs.fsync(handle._id));
  }
  function fsyncSync(fd) { _fsyncSync(fd, "fsync"); }
  function fdatasyncSync(fd) { _fsyncSync(fd, "fdatasync"); }

  // Descriptor metadata, sync: the descriptor's file, whatever its name since.
  function futimesSync(fd, atime, mtime) {
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "futime", fd);
    const handle = _fdHandle(fd, "futime");
    const [a, m] = _times(atime, mtime, "futime", handle._path);
    _sync("futime", handle._path, "fs.promises.FileHandle.utimes", (fs) => fs.futimes(handle._id, a, m));
  }
  function fchmodSync(fd, mode) {
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "fchmod", fd);
    const handle = _fdHandle(fd, "fchmod");
    const bits = _coerceMode(mode);
    _sync("fchmod", handle._path, "fs.promises.FileHandle.chmod", (fs) => fs.fchmod(handle._id, bits));
  }
  function fchownSync(fd, uid, gid) {
    nodeOwnerId(uid, "uid");
    nodeOwnerId(gid, "gid");
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "fchown", fd);
    const handle = _fdHandle(fd, "fchown");
    _sync("fchown", handle._path, "fs.promises.FileHandle.chown", (fs) => fs.fchown(handle._id, Number(uid), Number(gid)));
  }

  // Scatter/gather, sync: readSync/writeSync per buffer; stdio fds keep the
  // stream behaviour those two already give them.
  function readvSync(fd, buffers, position) {
    let bytesRead = 0;
    let pos = _isCurrentPos(position) ? null : Number(position);
    for (const buffer of buffers) {
      const n = readSync(fd, buffer, 0, buffer.byteLength, pos);
      bytesRead += n;
      if (pos !== null) pos += n;
      if (n < buffer.byteLength) break;
    }
    return bytesRead;
  }
  function writevSync(fd, buffers, position) {
    let bytesWritten = 0;
    let pos = _isCurrentPos(position) ? null : Number(position);
    for (const buffer of buffers) {
      const n = writeSync(fd, buffer, 0, buffer.byteLength, pos);
      bytesWritten += n;
      if (pos !== null) pos += n;
    }
    return bytesWritten;
  }

  // ── callback forms (live I/O — these CAN reach the supervisor) ──
  function open(path, flags, mode, cb) {
    if (typeof flags === "function") { cb = flags; flags = undefined; mode = undefined; }
    else if (typeof mode === "function") { cb = mode; mode = undefined; }
    _openAsync(path, flags, mode).then((h) => cb(null, h.fd)).catch((e) => cb(e));
  }
  function close(fd, cb) {
    let err = null;
    try { closeSync(fd); } catch (e) { err = e; }
    // Without a callback there is nowhere to deliver the failure, so raise
    // it here rather than let an EBADF vanish.
    if (typeof cb !== "function") { if (err) throw err; return; }
    queueMicrotask(() => cb(err));
  }
  function read(fd, buffer, offset, length, position, cb) {
    if (typeof buffer === "function") {
      // read(fd, callback)
      cb = buffer; buffer = undefined; offset = undefined; length = undefined; position = undefined;
    } else if (typeof offset === "function") {
      // read(fd, options, callback) — the buffer rides inside options
      cb = offset;
      const o = buffer !== null && typeof buffer === "object" && !(buffer instanceof Uint8Array) ? buffer : {};
      buffer = o.buffer instanceof Uint8Array ? o.buffer : undefined;
      offset = o.offset; length = o.length; position = o.position;
    } else if (typeof length === "function") {
      // read(fd, buffer, options, callback)
      cb = length;
      const o = offset !== null && typeof offset === "object" ? offset : {};
      offset = o.offset; length = o.length; position = o.position;
    } else if (typeof position === "function") {
      // read(fd, buffer, offset, length, callback)
      cb = position; position = undefined;
    }
    if (!(buffer instanceof Uint8Array)) buffer = __BufferMod.alloc(16384);
    if (Number(fd) === 0) {
      let n;
      try { n = __nimbusReadStdinInto(buffer, offset, length, "read"); }
      catch (e) { queueMicrotask(() => cb(e)); return; }
      queueMicrotask(() => cb(null, n, buffer));
      return;
    }
    if (_isStdioFd(fd)) { queueMicrotask(() => cb(null, 0, buffer)); return; }
    const handle = _fdFor(fd, "read", cb);
    if (!handle) return;
    handle.read(buffer, offset, length, position)
      .then((r) => cb(null, r.bytesRead, r.buffer))
      .catch((e) => cb(e));
  }
  function write(fd, data, a, b, c, d) {
    // write(fd, buffer[, offset[, length[, position]]], cb)
    // write(fd, string[, position[, encoding]], cb)
    let cb = d;
    if (typeof a === "function") { cb = a; a = undefined; b = undefined; c = undefined; }
    else if (typeof b === "function") { cb = b; b = undefined; c = undefined; }
    else if (typeof c === "function") { cb = c; c = undefined; }
    let norm;
    try { norm = _normWriteArgs(data, a, b, c); }
    catch (e) { queueMicrotask(() => cb(e)); return; }
    const n = Number(fd);
    if (n === 1 || n === 2) {
      try {
        (n === 2 ? __processMod.stderr : __processMod.stdout).write(norm.bytes, error => cb(error || null, error ? 0 : norm.bytes.byteLength, data));
      } catch (error) { queueMicrotask(() => cb(error, 0, data)); }
      return;
    }
    const handle = _fdFor(fd, "write", cb);
    if (!handle) return;
    // Hand over already-decoded bytes so the async path applies the same
    // encoding rules as writeSync instead of FileHandle.write's UTF-8-only
    // string branch.
    handle.write(norm.bytes, 0, norm.bytes.byteLength, _isCurrentPos(norm.pos) ? null : Number(norm.pos))
      .then((r) => cb(null, r.bytesWritten, data))
      .catch((e) => cb(e));
  }
  function fstat(fd, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    const bigint = Boolean(opts?.bigint);
    let stats = null;
    let err = null;
    try { stats = fstatSync(fd, { bigint }); } catch (e) { err = e; }
    queueMicrotask(() => cb(err, stats));
  }
  function ftruncate(fd, len, cb) {
    if (typeof len === "function") { cb = len; len = 0; }
    if (_isStdioFd(fd)) { queueMicrotask(() => cb(_fsErr("EINVAL", "ftruncate", fd))); return; }
    const handle = _fdFor(fd, "ftruncate", cb);
    if (!handle) return;
    handle.truncate(len).then(() => cb(null)).catch((e) => cb(e));
  }
  // The async forms wait for what fsync waits for: the descriptor's file's held writes sent, and what they met.
  function _fsyncCb(fd, syscall, cb) {
    let handle = null;
    let err = null;
    try { if (!_isStdioFd(fd)) handle = _fdHandle(fd, syscall); } catch (e) { err = e; }
    // Without a callback there is nowhere to deliver the failure, so raise
    // it here rather than let an EBADF vanish.
    if (typeof cb !== "function") { if (err) throw err; return; }
    if (err || !handle) { queueMicrotask(() => cb(err)); return; }
    (syscall === "fsync" ? handle.sync() : handle.datasync()).then(() => cb(null)).catch((e) => cb(e));
  }
  function fsync(fd, cb) { _fsyncCb(fd, "fsync", cb); }
  function fdatasync(fd, cb) { _fsyncCb(fd, "fdatasync", cb); }
  function futimes(fd, atime, mtime, cb) {
    if (_isStdioFd(fd)) { queueMicrotask(() => cb(_fsErr("EINVAL", "futimes", fd))); return; }
    const handle = _fdFor(fd, "futimes", cb);
    if (!handle) return;
    handle.utimes(atime, mtime).then(() => cb(null)).catch((e) => cb(e));
  }
  function readv(fd, buffers, position, cb) {
    if (typeof position === "function") { cb = position; position = null; }
    const run = async () => {
      let bytesRead = 0;
      let pos = _isCurrentPos(position) ? null : Number(position);
      for (const buffer of buffers) {
        const n = await new Promise((res, rej) =>
          read(fd, buffer, 0, buffer.byteLength, pos, (e, count) => (e ? rej(e) : res(count))));
        bytesRead += n;
        if (pos !== null) pos += n;
        if (n < buffer.byteLength) break;
      }
      return bytesRead;
    };
    run().then((n) => cb(null, n, buffers)).catch((e) => cb(e));
  }
  function writev(fd, buffers, position, cb) {
    if (typeof position === "function") { cb = position; position = null; }
    const run = async () => {
      let bytesWritten = 0;
      let pos = _isCurrentPos(position) ? null : Number(position);
      for (const buffer of buffers) {
        const n = await new Promise((res, rej) =>
          write(fd, buffer, 0, buffer.byteLength, pos, (e, count) => (e ? rej(e) : res(count))));
        bytesWritten += n;
        if (pos !== null) pos += n;
      }
      return bytesWritten;
    };
    run().then((n) => cb(null, n, buffers)).catch((e) => cb(e));
  }
  function fchmod(fd, mode, cb) {
    const handle = _fdFor(fd, "fchmod", cb);
    if (!handle) return;
    handle.chmod(mode).then(() => cb(null)).catch((e) => cb(e));
  }
  function fchown(fd, uid, gid, cb) {
    nodeOwnerId(uid, "uid");
    nodeOwnerId(gid, "gid");
    const handle = _fdFor(fd, "fchown", cb);
    if (!handle) return;
    handle.chown(uid, gid).then(() => cb(null)).catch((error) => cb(error));
  }

  // ── Dir — fs.opendir / opendirSync / fs.promises.opendir ──
  // The listing is taken whole at open (both readdir forms already return
  // one) and handed out one Dirent per read(); closing a closed Dir is
  // ERR_DIR_CLOSED as in Node.
  class __Dir {
    constructor(path, entries) {
      this.path = path;
      this._entries = entries;
      this._at = 0;
      this._closed = false;
    }
    _assertOpen() {
      if (this._closed) {
        throw nodeError(Error, "ERR_DIR_CLOSED", "Directory handle was closed");
      }
    }
    readSync() {
      this._assertOpen();
      return this._at < this._entries.length ? this._entries[this._at++] : null;
    }
    read(cb) {
      const result = new Promise((res, rej) => { try { res(this.readSync()); } catch (e) { rej(e); } });
      if (typeof cb !== "function") return result;
      result.then((entry) => cb(null, entry), (e) => cb(e));
    }
    closeSync() { this._assertOpen(); this._closed = true; }
    close(cb) {
      const result = new Promise((res, rej) => { try { this.closeSync(); res(); } catch (e) { rej(e); } });
      if (typeof cb !== "function") return result;
      result.then(() => cb(null), (e) => cb(e));
    }
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const entry = this.readSync();
          if (entry === null) break;
          yield entry;
        }
      } finally {
        if (!this._closed) this._closed = true;
      }
    }
    [Symbol.asyncDispose]() { return this._closed ? Promise.resolve() : this.close(); }
    [Symbol.dispose]() { if (!this._closed) this.closeSync(); }
  }
  function opendirSync(p, opts) {
    return new __Dir(String(p), readdirSync(p, { withFileTypes: true }));
  }
  async function _opendirAsync(p, opts) {
    return new __Dir(String(p), await _readdirAsync(p, { withFileTypes: true }));
  }
  function opendir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _opendirAsync(p, opts).then((dir) => cb(null, dir)).catch((e) => cb(e));
  }

  // ── statfs ──
  // Honest constants for the VFS: the block size is the SQLite chunk unit's
  // page size, and blocks is the session's storage limit (VFS_CAPACITY, the
  // one the storage ledger enforces) in those blocks.
  // The supervisor surface exposes no usage counter, so bfree/bavail report
  // the whole capacity; the VFS has no inode table, so files/ffree are 0
  // (unknown, not "none"). \`type\` is 0: this is no kernel filesystem and
  // no magic number would be true of it.
  const _STATFS_BSIZE = 4096;
  const _STATFS_BLOCKS = Math.floor(${VFS_CAPACITY} / 4096);
  function _statfsObject(opts) {
    const wrap = opts && opts.bigint ? BigInt : Number;
    return {
      type: wrap(0),
      bsize: wrap(_STATFS_BSIZE),
      blocks: wrap(_STATFS_BLOCKS),
      bfree: wrap(_STATFS_BLOCKS),
      bavail: wrap(_STATFS_BLOCKS),
      files: wrap(0),
      ffree: wrap(0),
    };
  }
  function statfsSync(p, opts) {
    if (statSync(p, { throwIfNoEntry: false }) === undefined) throw _fsErr("ENOENT", "statfs", p);
    return _statfsObject(opts);
  }
  async function _statfsAsync(p, opts) {
    await _statAsync(p);
    return _statfsObject(opts);
  }
  function statfs(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _statfsAsync(p, opts).then((s) => cb(null, s)).catch((e) => cb(e));
  }

  // ── remaining callback forms of the path operations ──
  function rm(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _rmAsync(p, opts).then(() => cb(null)).catch((e) => cb(e));
  }
  function cp(src, dest, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    __nimbusNodeLib().require("internal/validators").validateFunction(cb, "cb");
    const args = _cpArgs(src, dest, opts);
    __nimbusNodeLib().require("util").callbackify(__nimbusNodeLib().require("internal/fs/cp/cp").cpFn)(...args, cb);
  }
  function truncate(p, len, cb) {
    if (typeof len === "function") { cb = len; len = 0; }
    _truncateAsync(p, len || 0).then(() => cb(null)).catch((e) => cb(e));
  }
  function copyFile(src, dest, mode, cb) {
    if (typeof mode === "function") { cb = mode; mode = 0; }
    promises.copyFile(src, dest, mode).then(() => cb(null)).catch((e) => cb(e));
  }
  function mkdtemp(prefix, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _mkdtempAsync(prefix).then((name) => cb(null, name)).catch((e) => cb(e));
  }
  function link(existingPath, newPath, cb) { queueMicrotask(() => cb(_fsErr("ENOSYS", "link", existingPath, newPath))); }
  function symlink(target, path, type, cb) {
    if (typeof type === "function") { cb = type; type = undefined; }
    _symlinkAsync(target, path).then(() => cb(null)).catch((e) => cb(e));
  }
  function readlink(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _readlinkAsync(p).then((target) => cb(null, target)).catch((e) => cb(e));
  }
  function realpath(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _realpathAsync(p).then((r) => cb(null, r), (e) => cb(e));
  }
  realpath.native = realpath;

  // ── fs.glob ── Node 22's fs.glob, fs.globSync and fs.promises.glob: its
  // Glob, ported from lib/internal/fs/glob.js (v22.23.4; the Linux paths),
  // matching with the minimatch Node vendors (node-minimatch-source.ts),
  // which is evaluated the first time a program globs.
  const _Glob = (() => {
    let minimatch = null;
    const mm = () => minimatch ??= __nimbusMinimatch();
    const { join, resolve, basename, isAbsolute, dirname } = __pathMod;
    const validateStringArray = (value, name) => {
      if (!Array.isArray(value)) throw invalidArgType(name, "Array", value);
      for (let i = 0; i < value.length; i++) if (typeof value[i] !== "string") throw invalidArgType(name + "[" + i + "]", "string", value[i]);
    };
    const createMatcher = (pattern) => new (mm().Minimatch)(pattern, {
      __proto__: null, nocase: false, windowsPathsNoEscape: true, nonegate: true, nocomment: true,
      optimizationLevel: 2, platform: "linux", nocaseMagicOnly: true,
    });
    const direntOf = (path, st) => new __Dirent(basename(path), _direntTypeOfStats(st), dirname(path));
    const getDirentSync = (path) => {
      let st;
      try { st = lstatSync(path); } catch { return null; }
      return direntOf(path, st);
    };
    const getDirent = async (path) => {
      let st;
      try { st = await promises.lstat(path); } catch { return null; }
      return direntOf(path, st);
    };

    class Cache {
      #cache = new Map();
      #statsCache = new Map();
      #readdirCache = new Map();
      stat(path) {
        const cached = this.#statsCache.get(path);
        if (cached) return cached;
        const promise = getDirent(path);
        this.#statsCache.set(path, promise);
        return promise;
      }
      statSync(path) {
        const cached = this.#statsCache.get(path);
        if (cached && !(cached instanceof Promise)) return cached;
        const val = getDirentSync(path);
        this.#statsCache.set(path, val);
        return val;
      }
      addToStatCache(path, val) { this.#statsCache.set(path, val); }
      readdir(path) {
        const cached = this.#readdirCache.get(path);
        if (cached) return cached;
        const promise = promises.readdir(path, { withFileTypes: true }).then(null, () => []);
        this.#readdirCache.set(path, promise);
        return promise;
      }
      readdirSync(path) {
        const cached = this.#readdirCache.get(path);
        if (cached) return cached;
        let val;
        try { val = readdirSync(path, { withFileTypes: true }); } catch { val = []; }
        this.#readdirCache.set(path, val);
        return val;
      }
      add(path, pattern) {
        let cache = this.#cache.get(path);
        if (!cache) {
          cache = new Set();
          this.#cache.set(path, cache);
        }
        const originalSize = cache.size;
        pattern.indexes.forEach((index) => cache.add(pattern.cacheKey(index)));
        return cache.size !== originalSize + pattern.indexes.size;
      }
      seen(path, pattern, index) { return this.#cache.get(path)?.has(pattern.cacheKey(index)); }
    }

    class Pattern {
      #pattern;
      #globStrings;
      constructor(pattern, globStrings, indexes, symlinks) {
        this.#pattern = pattern;
        this.#globStrings = globStrings;
        this.indexes = indexes;
        this.symlinks = symlinks;
        this.last = pattern.length - 1;
      }
      isLast(isDirectory) {
        return this.indexes.has(this.last) ||
          (this.at(-1) === "" && isDirectory && this.indexes.has(this.last - 1) && this.at(-2) === mm().GLOBSTAR);
      }
      isFirst() { return this.indexes.has(0); }
      get hasSeenSymlinks() { return Array.from(this.indexes).some((i) => !this.symlinks.has(i)); }
      at(index) { return this.#pattern.at(index); }
      child(indexes, symlinks = new Set()) { return new Pattern(this.#pattern, this.#globStrings, indexes, symlinks); }
      test(index, path) {
        if (index > this.#pattern.length) return false;
        const pattern = this.#pattern[index];
        if (pattern === mm().GLOBSTAR) return true;
        if (typeof pattern === "string") return pattern === path;
        if (typeof pattern?.test === "function") return pattern.test(path);
        return false;
      }
      cacheKey(index) {
        let key = "";
        for (let i = index; i < this.#globStrings.length; i++) {
          key += this.#globStrings[i];
          if (i !== this.#globStrings.length - 1) key += "/";
        }
        return key;
      }
    }

    class ResultSet extends Set {
      #root = ".";
      #isExcluded = () => false;
      setup(root, isExcludedFn) {
        this.#root = root;
        this.#isExcluded = isExcludedFn;
      }
      add(value) {
        if (this.#isExcluded(resolve(this.#root, value))) return false;
        super.add(value);
        return true;
      }
    }

    class Glob {
      #root;
      #exclude;
      #cache = new Cache();
      #results = new ResultSet();
      #queue = [];
      #subpatterns = new Map();
      #patterns;
      #withFileTypes;
      #isExcluded = () => false;
      constructor(pattern, options) {
        if (options === undefined) options = {};
        if (options === null || typeof options !== "object" || Array.isArray(options)) throw invalidArgType("options", "object", options);
        const { exclude, cwd, withFileTypes } = options;
        this.#root = (cwd && typeof cwd === "object" && typeof cwd.href === "string" && typeof cwd.protocol === "string")
          ? builtins.url.fileURLToPath(cwd) : (cwd ?? ".");
        this.#withFileTypes = !!withFileTypes;
        if (exclude != null) {
          if (Array.isArray(exclude)) {
            for (let i = 0; i < exclude.length; i++) if (typeof exclude[i] !== "string") throw invalidArgType("options.exclude[" + i + "]", "string", exclude[i]);
            const matchers = exclude.map((p) => resolve(this.#root, p)).map((p) => createMatcher(p));
            this.#isExcluded = (value) => matchers.some((matcher) => matcher.match(value));
            this.#results.setup(this.#root, this.#isExcluded);
          } else if (typeof exclude !== "function") {
            throw invalidArgType("options.exclude", ["function", "string[]"], exclude);
          } else {
            this.#exclude = exclude;
          }
        }
        let patterns;
        if (typeof pattern === "object") {
          validateStringArray(pattern, "patterns");
          patterns = pattern;
        } else {
          if (typeof pattern !== "string") throw invalidArgType("patterns", "string", pattern);
          patterns = [pattern];
        }
        this.matchers = patterns.map((p) => createMatcher(p));
        this.#patterns = this.matchers.flatMap((matcher) => matcher.set.map((p, i) =>
          new Pattern(p, matcher.globParts[i], new Set().add(0), new Set())));
      }

      globSync() {
        this.#queue.push({ __proto__: null, path: ".", patterns: this.#patterns });
        while (this.#queue.length > 0) {
          const item = this.#queue.pop();
          for (let i = 0; i < item.patterns.length; i++) this.#addSubpatterns(item.path, item.patterns[i]);
          this.#subpatterns.forEach((patterns, path) => this.#queue.push({ __proto__: null, path, patterns }));
          this.#subpatterns.clear();
        }
        return Array.from(this.#results,
          this.#withFileTypes ? (path) => this.#cache.statSync(isAbsolute(path) ? path : join(this.#root, path)) : undefined);
      }
      #addSubpattern(path, pattern) {
        if (this.#isExcluded(path)) return;
        const fullpath = resolve(this.#root, path);
        // If path is a directory, add trailing slash and test patterns again.
        if (this.#isExcluded(fullpath + "/") && this.#cache.statSync(fullpath).isDirectory()) return;
        if (this.#exclude) {
          if (this.#withFileTypes) {
            const stat = this.#cache.statSync(path);
            if (stat !== null && this.#exclude(stat)) return;
          } else if (this.#exclude(path)) {
            return;
          }
        }
        if (!this.#subpatterns.has(path)) this.#subpatterns.set(path, [pattern]);
        else this.#subpatterns.get(path).push(pattern);
      }
      #addSubpatterns(path, pattern) {
        const seen = this.#cache.add(path, pattern);
        if (seen) return;
        const fullpath = resolve(this.#root, path);
        const stat = this.#cache.statSync(fullpath);
        const last = pattern.last;
        const isDirectory = stat?.isDirectory() || (stat?.isSymbolicLink() && pattern.hasSeenSymlinks);
        const isLast = pattern.isLast(isDirectory);
        const isFirst = pattern.isFirst();

        if (this.#isExcluded(fullpath)) return;
        if (isFirst && pattern.at(0) === "") {
          // Absolute path, go to root
          this.#addSubpattern("/", pattern.child(new Set().add(1)));
          return;
        }
        if (isFirst && pattern.at(0) === "..") {
          // Start with .., go to parent
          this.#addSubpattern("../", pattern.child(new Set().add(1)));
          return;
        }
        if (isFirst && pattern.at(0) === ".") {
          // Start with ., proceed
          this.#addSubpattern(".", pattern.child(new Set().add(1)));
          return;
        }

        if (isLast && typeof pattern.at(-1) === "string") {
          // Add result if it exists
          const p = pattern.at(-1);
          const stat = this.#cache.statSync(join(fullpath, p));
          if (stat && (p || isDirectory)) this.#results.add(join(path, p));
          if (pattern.indexes.size === 1 && pattern.indexes.has(last)) return;
        } else if (isLast && pattern.at(-1) === mm().GLOBSTAR &&
          (path !== "." || pattern.at(0) === "." || (last === 0 && stat))) {
          // If pattern ends with **, add to results
          // if path is ".", add it only if pattern starts with "." or pattern is exactly "**"
          this.#results.add(path);
        }

        if (!isDirectory) return;

        let children;
        const firstPattern = pattern.indexes.size === 1 && pattern.at(pattern.indexes.values().next().value);
        if (typeof firstPattern === "string") {
          const stat = this.#cache.statSync(join(fullpath, firstPattern));
          if (stat) {
            stat.name = firstPattern;
            children = [stat];
          } else {
            return;
          }
        } else {
          children = this.#cache.readdirSync(fullpath);
        }

        for (let i = 0; i < children.length; i++) {
          const entry = children[i];
          const entryPath = join(path, entry.name);
          this.#cache.addToStatCache(join(fullpath, entry.name), entry);

          const subPatterns = new Set();
          const nSymlinks = new Set();
          for (const index of pattern.indexes) {
            // For each child, check potential patterns
            if (this.#cache.seen(entryPath, pattern, index) || this.#cache.seen(entryPath, pattern, index + 1)) return;
            const current = pattern.at(index);
            const nextIndex = index + 1;
            const next = pattern.at(nextIndex);
            const fromSymlink = pattern.symlinks.has(index);

            if (current === mm().GLOBSTAR) {
              const isDot = entry.name[0] === ".";
              const nextMatches = pattern.test(nextIndex, entry.name);
              let nextNonGlobIndex = nextIndex;
              while (pattern.at(nextNonGlobIndex) === mm().GLOBSTAR) nextNonGlobIndex++;
              const matchesDot = isDot && pattern.test(nextNonGlobIndex, entry.name);
              if ((isDot && !matchesDot) || (this.#exclude && this.#exclude(this.#withFileTypes ? entry : entry.name))) continue;
              if (!fromSymlink && entry.isDirectory()) {
                // If directory, add ** to its potential patterns
                subPatterns.add(index);
              } else if (!fromSymlink && index === last) {
                // If ** is last, add to results
                this.#results.add(entryPath);
              }

              // Any pattern after ** is also a potential pattern
              // so we can already test it here
              if (nextMatches && nextIndex === last && !isLast) {
                // If next pattern is the last one, add to results
                this.#results.add(entryPath);
              } else if (nextMatches && entry.isDirectory()) {
                // Pattern matched, meaning two patterns forward
                // are also potential patterns
                // e.g **/b/c when entry is a/b - add c to potential patterns
                subPatterns.add(index + 2);
              }
              if ((nextMatches || pattern.at(0) === ".") &&
                (entry.isDirectory() || entry.isSymbolicLink()) && !fromSymlink) {
                // If pattern after ** matches, or pattern starts with "."
                // and entry is a directory or symlink, add to potential patterns
                subPatterns.add(nextIndex);
              }

              if (entry.isSymbolicLink()) nSymlinks.add(index);

              if (next === ".." && entry.isDirectory()) {
                // In case pattern is "**/..",
                // both parent and current directory should be added to the queue
                // if this is the last pattern, add to results instead
                const parent = join(path, "..");
                if (nextIndex < last) {
                  if (!this.#subpatterns.has(path) && !this.#cache.seen(path, pattern, nextIndex + 1)) {
                    this.#subpatterns.set(path, [pattern.child(new Set().add(nextIndex + 1))]);
                  }
                  if (!this.#subpatterns.has(parent) && !this.#cache.seen(parent, pattern, nextIndex + 1)) {
                    this.#subpatterns.set(parent, [pattern.child(new Set().add(nextIndex + 1))]);
                  }
                } else {
                  if (!this.#cache.seen(path, pattern, nextIndex)) {
                    this.#cache.add(path, pattern.child(new Set().add(nextIndex)));
                    this.#results.add(path);
                  }
                  if (!this.#cache.seen(path, pattern, nextIndex) || !this.#cache.seen(parent, pattern, nextIndex)) {
                    this.#cache.add(parent, pattern.child(new Set().add(nextIndex)));
                    this.#results.add(parent);
                  }
                }
              }
            }
            if (typeof current === "string") {
              if (pattern.test(index, entry.name) && index !== last) {
                // If current pattern matches entry name
                // the next pattern is a potential pattern
                subPatterns.add(nextIndex);
              } else if (current === "." && pattern.test(nextIndex, entry.name)) {
                // If current pattern is ".", proceed to test next pattern
                if (nextIndex === last) this.#results.add(entryPath);
                else subPatterns.add(nextIndex + 1);
              }
            }
            if (typeof current === "object" && pattern.test(index, entry.name)) {
              // If current pattern is a regex that matches entry name (e.g *.js)
              // add next pattern to potential patterns, or to results if it's the last pattern
              if (index === last) this.#results.add(entryPath);
              else if (entry.isDirectory()) subPatterns.add(nextIndex);
            }
          }
          if (subPatterns.size > 0) {
            // If there are potential patterns, add to queue
            this.#addSubpattern(entryPath, pattern.child(subPatterns, nSymlinks));
          }
        }
      }

      async* glob() {
        this.#queue.push({ __proto__: null, path: ".", patterns: this.#patterns });
        while (this.#queue.length > 0) {
          const item = this.#queue.pop();
          for (let i = 0; i < item.patterns.length; i++) yield* this.#iterateSubpatterns(item.path, item.patterns[i]);
          this.#subpatterns.forEach((patterns, path) => this.#queue.push({ __proto__: null, path, patterns }));
          this.#subpatterns.clear();
        }
      }
      async* #iterateSubpatterns(path, pattern) {
        const seen = this.#cache.add(path, pattern);
        if (seen) return;
        const fullpath = resolve(this.#root, path);
        const stat = await this.#cache.stat(fullpath);
        const last = pattern.last;
        const isDirectory = stat?.isDirectory() || (stat?.isSymbolicLink() && pattern.hasSeenSymlinks);
        const isLast = pattern.isLast(isDirectory);
        const isFirst = pattern.isFirst();

        if (this.#isExcluded(fullpath)) return;
        if (isFirst && pattern.at(0) === "") {
          // Absolute path, go to root
          this.#addSubpattern("/", pattern.child(new Set().add(1)));
          return;
        }
        if (isFirst && pattern.at(0) === "..") {
          // Start with .., go to parent
          this.#addSubpattern("../", pattern.child(new Set().add(1)));
          return;
        }
        if (isFirst && pattern.at(0) === ".") {
          // Start with ., proceed
          this.#addSubpattern(".", pattern.child(new Set().add(1)));
          return;
        }

        if (isLast && typeof pattern.at(-1) === "string") {
          // Add result if it exists
          const p = pattern.at(-1);
          const stat = await this.#cache.stat(join(fullpath, p));
          if (stat && (p || isDirectory)) {
            const result = join(path, p);
            if (!this.#results.has(result) && this.#results.add(result)) yield this.#withFileTypes ? stat : result;
          }
          if (pattern.indexes.size === 1 && pattern.indexes.has(last)) return;
        } else if (isLast && pattern.at(-1) === mm().GLOBSTAR &&
          (path !== "." || pattern.at(0) === "." || (last === 0 && stat))) {
          // If pattern ends with **, add to results
          // if path is ".", add it only if pattern starts with "." or pattern is exactly "**"
          if (!this.#results.has(path) && this.#results.add(path)) yield this.#withFileTypes ? stat : path;
        }

        if (!isDirectory) return;

        let children;
        const firstPattern = pattern.indexes.size === 1 && pattern.at(pattern.indexes.values().next().value);
        if (typeof firstPattern === "string") {
          const stat = await this.#cache.stat(join(fullpath, firstPattern));
          if (stat) {
            stat.name = firstPattern;
            children = [stat];
          } else {
            return;
          }
        } else {
          children = await this.#cache.readdir(fullpath);
        }

        for (let i = 0; i < children.length; i++) {
          const entry = children[i];
          const entryPath = join(path, entry.name);
          this.#cache.addToStatCache(join(fullpath, entry.name), entry);

          const subPatterns = new Set();
          const nSymlinks = new Set();
          for (const index of pattern.indexes) {
            // For each child, check potential patterns
            if (this.#cache.seen(entryPath, pattern, index) || this.#cache.seen(entryPath, pattern, index + 1)) return;
            const current = pattern.at(index);
            const nextIndex = index + 1;
            const next = pattern.at(nextIndex);
            const fromSymlink = pattern.symlinks.has(index);

            if (current === mm().GLOBSTAR) {
              const isDot = entry.name[0] === ".";
              const nextMatches = pattern.test(nextIndex, entry.name);
              let nextNonGlobIndex = nextIndex;
              while (pattern.at(nextNonGlobIndex) === mm().GLOBSTAR) nextNonGlobIndex++;
              const matchesDot = isDot && pattern.test(nextNonGlobIndex, entry.name);
              if ((isDot && !matchesDot) || (this.#exclude && this.#exclude(this.#withFileTypes ? entry : entry.name))) continue;
              if (!fromSymlink && entry.isDirectory()) {
                // If directory, add ** to its potential patterns
                subPatterns.add(index);
              } else if (!fromSymlink && index === last) {
                // If ** is last, add to results
                if (!this.#results.has(entryPath) && this.#results.add(entryPath)) yield this.#withFileTypes ? entry : entryPath;
              }

              // Any pattern after ** is also a potential pattern
              // so we can already test it here
              if (nextMatches && nextIndex === last && !isLast) {
                // If next pattern is the last one, add to results
                if (!this.#results.has(entryPath) && this.#results.add(entryPath)) yield this.#withFileTypes ? entry : entryPath;
              } else if (nextMatches && entry.isDirectory()) {
                // Pattern matched, meaning two patterns forward
                // are also potential patterns
                // e.g **/b/c when entry is a/b - add c to potential patterns
                subPatterns.add(index + 2);
              }
              if ((nextMatches || pattern.at(0) === ".") &&
                (entry.isDirectory() || entry.isSymbolicLink()) && !fromSymlink) {
                // If pattern after ** matches, or pattern starts with "."
                // and entry is a directory or symlink, add to potential patterns
                subPatterns.add(nextIndex);
              }

              if (entry.isSymbolicLink()) nSymlinks.add(index);

              if (next === ".." && entry.isDirectory()) {
                // In case pattern is "**/..",
                // both parent and current directory should be added to the queue
                // if this is the last pattern, add to results instead
                const parent = join(path, "..");
                if (nextIndex < last) {
                  if (!this.#subpatterns.has(path) && !this.#cache.seen(path, pattern, nextIndex + 1)) {
                    this.#subpatterns.set(path, [pattern.child(new Set().add(nextIndex + 1))]);
                  }
                  if (!this.#subpatterns.has(parent) && !this.#cache.seen(parent, pattern, nextIndex + 1)) {
                    this.#subpatterns.set(parent, [pattern.child(new Set().add(nextIndex + 1))]);
                  }
                } else {
                  if (!this.#cache.seen(path, pattern, nextIndex)) {
                    this.#cache.add(path, pattern.child(new Set().add(nextIndex)));
                    if (!this.#results.has(path) && this.#results.add(path)) {
                      yield this.#withFileTypes ? this.#cache.statSync(fullpath) : path;
                    }
                  }
                  if (!this.#cache.seen(path, pattern, nextIndex) || !this.#cache.seen(parent, pattern, nextIndex)) {
                    this.#cache.add(parent, pattern.child(new Set().add(nextIndex)));
                    if (!this.#results.has(parent) && this.#results.add(parent)) {
                      yield this.#withFileTypes ? this.#cache.statSync(join(this.#root, parent)) : parent;
                    }
                  }
                }
              }
            }
            if (typeof current === "string") {
              if (pattern.test(index, entry.name) && index !== last) {
                // If current pattern matches entry name
                // the next pattern is a potential pattern
                subPatterns.add(nextIndex);
              } else if (current === "." && pattern.test(nextIndex, entry.name)) {
                // If current pattern is ".", proceed to test next pattern
                if (nextIndex === last) {
                  if (!this.#results.has(entryPath) && this.#results.add(entryPath)) yield this.#withFileTypes ? entry : entryPath;
                } else {
                  subPatterns.add(nextIndex + 1);
                }
              }
            }
            if (typeof current === "object" && pattern.test(index, entry.name)) {
              // If current pattern is a regex that matches entry name (e.g *.js)
              // add next pattern to potential patterns, or to results if it's the last pattern
              if (index === last) {
                if (!this.#results.has(entryPath) && this.#results.add(entryPath)) yield this.#withFileTypes ? entry : entryPath;
              } else if (entry.isDirectory()) {
                subPatterns.add(nextIndex);
              }
            }
          }
          if (subPatterns.size > 0) {
            // If there are potential patterns, add to queue
            this.#addSubpattern(entryPath, pattern.child(subPatterns, nSymlinks));
          }
        }
      }
    }
    return Glob;
  })();
  function glob(pattern, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== "function") throw invalidArgType("cb", "function", callback);
    (async () => {
      try {
        const res = [];
        for await (const entry of new _Glob(pattern, options).glob()) res.push(entry);
        callback(null, res);
      } catch (err) {
        callback(err);
      }
    })();
  }
  function globSync(pattern, options) {
    return new _Glob(pattern, options).globSync();
  }

  // ── promises namespace (W3: full surface, VFS-backed) ──
  // We can't forward to workerd's node:fs/promises because that operates
  // on a real-host filesystem, not our VFS. So every method is shim'd
  // against the same underlying readFileSync/writeFileSync/etc.
  const promises = {
    // pre-W3 surface:
    readFile: (p, o) => new Promise((res, rej) => readFile(p, o, (e, d) => e ? rej(e) : res(d))),
    writeFile: (p, d, o) => new Promise((res, rej) => writeFile(p, d, o, (e) => e ? rej(e) : res())),
    stat: (p, opts) => new Promise((res, rej) => stat(p, opts, (e, s) => e ? rej(e) : res(s))),
    readdir: (p, o) => new Promise((res, rej) => readdir(p, o, (e, d) => e ? rej(e) : res(d))),
    mkdir: (p, o) => new Promise((res, rej) => mkdir(p, o, (e) => e ? rej(e) : res())),
    unlink: (p) => new Promise((res, rej) => unlink(p, (e) => e ? rej(e) : res())),
    access: (p, m) => new Promise((res, rej) => access(p, m, (e) => e ? rej(e) : res())),

    // W3 additions:
    appendFile: async (p, d, o) => { await _appendFileAsync(p, d, o); },
    lstat: (p, opts) => new Promise((res, rej) => lstat(p, opts, (e, s) => e ? rej(e) : res(s))),
    // The same local retraction and queued authority removal rmSync does.
    rm: async (p, opts) => { await _rmAsync(p, opts); },
    cp: (src, dest, opts) => _cpAsync(src, dest, opts),
    copyFile: (src, dest, mode) => _copyFileAsync(src, dest, mode),
    rename: async (oldP, newP) => { await _renameAsync(oldP, newP); },
    rmdir: async (p) => { await _rmdirAsync(p); },
    realpath: (p) => _realpathAsync(p),
    truncate: async (p, len) => { await _truncateAsync(p, len || 0); },
    chmod: async (p, mode) => { await _chmodAsync(p, mode); },
    chown: async (p, uid, gid) => { await _chownAsync(p, uid, gid); },
    // A symlink's own mode is macOS's (O_SYMLINK); Linux has none to set.
    lchmod: async () => { throw new nodeErrorCodes.ERR_METHOD_NOT_IMPLEMENTED("lchmod()"); },
    lchown: async (p, uid, gid) => { await _chownAsync(p, uid, gid, { followSymlinks: false }); },
    utimes: async (p, atime, mtime) => { await _utimesAsync(p, atime, mtime); },
    lutimes: async (p, atime, mtime) => { await _utimesAsync(p, atime, mtime, { followSymlinks: false }); },
    symlink: async (target, path) => { await _symlinkAsync(target, path); },
    link: async (existingPath, newPath) => { throw _fsErr("ENOSYS", "link", existingPath, newPath); },
    readlink: async (p) => _readlinkAsync(p),
    mkdtemp: async (prefix) => _mkdtempAsync(prefix),
    open: async (path, flags, mode) => _openAsync(path, flags, mode),
    opendir: async (p, opts) => _opendirAsync(p, opts),
    statfs: async (p, opts) => _statfsAsync(p, opts),
    // The watch engine as an async iterator: each change queued until asked
    // for, ended by return() (a waiting next() with it) or by its signal, an
    // AbortError delivered once. Like Node's generator, nothing starts, and
    // its options are not checked, until the first next().
    watch: (filename, opts) => {
      const signal = opts?.signal;
      const queue = [];
      const waiting = [];
      let stop = null;
      let listening = false;
      let state = "new"; // "new" | "watching" | "aborted" | "done"
      const aborted = () => new (__nimbusNodeLib().require("internal/errors").AbortError)(undefined, { cause: signal.reason });
      const finish = () => {
        state = "done";
        queue.length = 0;
        if (stop !== null) { stop(); stop = null; }
        if (listening) { listening = false; signal.removeEventListener("abort", onAbort); }
      };
      const onAbort = () => {
        const pending = waiting.splice(0);
        finish();
        if (pending.length === 0) { state = "aborted"; return; }
        const error = aborted();
        for (const one of pending) one.reject(error);
      };
      const start = () => {
        if (signal !== undefined) __nimbusNodeLib().require("internal/validators").validateAbortSignal(signal, "options.signal");
        if (signal?.aborted) { finish(); throw aborted(); }
        state = "watching";
        stop = _watchPath(filename, (eventType, name) => {
          const event = { eventType, filename: name };
          const pending = waiting.shift();
          if (pending) pending.resolve({ value: event, done: false }); else queue.push(event);
        });
        if (signal !== undefined) { signal.addEventListener("abort", onAbort, { once: true }); listening = true; }
      };
      const iterator = {
        next() {
          if (state === "new") {
            try { start(); } catch (error) { finish(); return Promise.reject(error); }
          }
          if (state === "aborted") { state = "done"; return Promise.reject(aborted()); }
          if (state === "done") return Promise.resolve({ value: undefined, done: true });
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
          return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); });
        },
        return() {
          const pending = waiting.splice(0);
          finish();
          for (const one of pending) one.resolve({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(error) {
          iterator.return();
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() { return iterator; },
      };
      return iterator;
    },
    glob: async function* (pattern, options) {
      yield* new _Glob(pattern, options).glob();
    },
  };

  // ── constants ── the shared linux x64 table (see __fsConstants).
  const constants = __fsConstants;
  promises.constants = constants;

  // fs.ReadStream / fs.WriteStream classes. Real Node exposes these as
  // constructors; graceful-fs (bundled by degit → create-cloudflare)
  // re-parents its own patched stream off fs.ReadStream.prototype, so
  // the classes must exist with readable prototypes and stream the file.
  // __streamMod is defined later in the generated bundle than __fsMod,
  // so the classes are built lazily on first access (post-init) and
  // cached, exposed via getters to avoid a temporal-dead-zone reference.
  let __ReadStreamClass = null;
  let __WriteStreamClass = null;
  /**
   * An fs stream's close options, as Node reads them: autoClose (default
   * true) is whether it is destroyed once done, emitClose (default true)
   * whether destroying it emits 'close'.
   */
  function __fsStreamLifecycle(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    return {
      autoDestroy: options.autoClose === undefined ? true : !!options.autoClose,
      emitClose: options.emitClose !== false,
    };
  }
  function __getReadStream() {
    if (__ReadStreamClass) return __ReadStreamClass;
    /**
     * ONE read-stream implementation, behind both \`fs.createReadStream\`
     * and the exported \`fs.ReadStream\` class.
     *
     * Each \`_read()\` pulls exactly one bounded chunk, so a multi-MB asset
     * streams to the consumer without the facet — or the supervisor — ever
     * materialising the whole file, and \`.pipe()\` backpressure actually
     * throttles the source. A file the prefetch bundle does not carry is
     * read live from the VFS via the same stateless ranged RPC that
     * FileHandle.read uses: the bundle is a cache, the VFS is the truth.
     */
    __ReadStreamClass = class ReadStream extends __streamMod.Readable {
      constructor(path, opts) {
        const options = typeof opts === "string" ? { encoding: opts } : (opts || {});
        super({
          encoding: options.encoding || null,
          highWaterMark: options.highWaterMark || READ_STREAM_CHUNK_BYTES,
          ...__fsStreamLifecycle(options),
        });
        this.path = path;
        this.bytesRead = 0;
        this._abs = _resolve(path);
        this._pos = Number.isFinite(options.start) ? Math.max(0, Math.trunc(options.start)) : 0;
        // Node's \`end\` option is INCLUSIVE.
        this._last = Number.isFinite(options.end) ? Math.trunc(options.end) : Infinity;
      }
      _read() {
        // The base class guarantees one outstanding _read at a time, so the
        // position cursor advances sequentially without extra locking.
        this._pull().catch((e) => this.destroy(e));
      }
      async _pull() {
        if (this._pos > this._last) { this.push(null); return; }
        // A resolved ranged RPC can feed the next read in the same task
        // indefinitely. Yield between windows so other session traffic and
        // other processes can run; this is a scheduling boundary, not a
        // backoff or a timeout that pretends I/O completed.
        if (this.bytesRead > 0) await new Promise((nextTurn) => globalThis.setTimeout(nextTurn, 0));
        if (this._readableState.destroyed) return;
        const want = Math.min(this._readableState.highWaterMark, READ_BATCH_REQUEST_BYTES, this._last - this._pos + 1);
        const chunk = await _readRangeAt(this._abs, this.path, this._pos, want);
        // Nothing there to open: Node's stream fails its open (ENOENT); one gone after it opened ends.
        if (chunk === null && this.bytesRead === 0) throw _fsErr("ENOENT", "open", this.path);
        if (chunk === null) { this.push(null); return; }
        this._pos += chunk.byteLength;
        this.bytesRead += chunk.byteLength;
        // A Buffer, as Node's read streams yield (a view, not a copy):
        // \`s += chunk\` reads text, where a bare Uint8Array reads "97,98".
        this.push(__BufferMod.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (chunk.byteLength < want) this.push(null);
      }
      open() {}
      // lib/internal/fs/streams.js: \`cb\` once it has closed (finished's answer).
      close(cb) {
        if (typeof cb === "function") __streamMod.finished(this, cb);
        this.destroy();
      }
    };
    return __ReadStreamClass;
  }
  function __getWriteStream() {
    if (__WriteStreamClass) return __WriteStreamClass;
    __WriteStreamClass = class WriteStream extends __streamMod.Writable {
      constructor(path, opts) { super(__fsStreamLifecycle(opts)); this.path = path; this._opts = opts; this._chunks = []; this._anyBytes = false; }
      _write(chunk, enc, cb) {
        // Acknowledged, the caller may reuse its buffer: the stream keeps its own bytes.
        if (chunk instanceof Uint8Array) { this._anyBytes = true; this._chunks.push(new Uint8Array(chunk)); }
        else this._chunks.push(typeof chunk === "string" ? chunk : String(chunk));
        cb();
      }
      _final(cb) {
        let out;
        if (this._anyBytes) {
          let total = 0;
          for (const c of this._chunks) total += (c instanceof Uint8Array) ? c.byteLength : __nimbusUtf8Length(c);
          out = new Uint8Array(total); let off = 0;
          for (const c of this._chunks) { const b = (c instanceof Uint8Array) ? c : _enc.encode(c); out.set(b, off); off += b.byteLength; }
        } else {
          out = this._chunks.join("");
        }
        _writeFileAsync(this.path, out, this._createOptions()).then(() => cb(), cb);
      }
      open() {}
      // The file it makes: its \`mode\` option's.
      _createOptions() {
        return this._opts !== null && typeof this._opts === "object" && this._opts.mode !== undefined ? { mode: this._opts.mode } : undefined;
      }
      // lib/internal/fs/streams.js: ends the stream, \`cb\` once it has closed.
      close(cb) {
        if (cb) {
          if (this.closed) { queueMicrotask(cb); return; }
          this.on("close", cb);
        }
        if (!this._writableState.autoDestroy) this.on("finish", this.destroy);
        this.end();
      }
    };
    return __WriteStreamClass;
  }

  const __fsExports = {
    readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
    readdirSync, mkdirSync, unlinkSync, rmdirSync, renameSync, copyFileSync,
    realpathSync, utimesSync, lutimesSync, chmodSync, chownSync, lchownSync, accessSync,
    rmSync, cpSync, mkdtempSync, truncateSync, linkSync, opendirSync, statfsSync, symlinkSync, readlinkSync,
    openSync, closeSync, readSync, writeSync, fstatSync, ftruncateSync, fsyncSync, fdatasyncSync,
    futimesSync, fchmodSync, fchownSync, readvSync, writevSync,
    open, close, read, write, fstat, ftruncate, fsync, fdatasync, fchmod, futimes, readv, writev,
    readFile, writeFile, appendFile, stat, lstat, readdir, exists, mkdir, unlink, rmdir, rename, utimes, lutimes, chmod, chown, lchown, fchown, access,
    // Linux's (lib/fs.js: only where O_SYMLINK is).
    lchmod: undefined, lchmodSync: undefined,
    rm, cp, truncate, copyFile, mkdtemp, link, symlink, readlink, realpath, opendir, statfs,
    glob, globSync,
    Dirent: __Dirent,
    Dir: __Dir,
    promises, constants,
    // lib/internal/fs/utils.js toUnixTimestamp: seconds since the epoch.
    _toUnixTimestamp(time, name = "time") {
      if (typeof time === "string" && +time == time) return +time;
      if (Number.isFinite(time)) return time < 0 ? Date.now() / 1000 : time;
      if (__realUtil.types.isDate(time)) return time.getTime() / 1000;
      throw invalidArgType(name, ["Date", "Time in seconds"], time);
    },
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    createReadStream: (p, opts) => new (__getReadStream())(p, opts),
    createWriteStream: (p, opts) => new (__getWriteStream())(p, opts),
    // fs.watch(): an EventEmitter over the watch engine (_watchPath).
    watch: (filename, opts, listener) => {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      const watcher = new __eventsMod();
      if (listener) watcher.on("change", listener);
      let stop = _watchPath(filename, (eventType, name) => watcher.emit("change", eventType, name));
      watcher.close = () => {
        if (stop !== null) { stop(); stop = null; }
        watcher.removeAllListeners();
      };
      return watcher;
    },
    watchFile: (filename, opts, listener) => {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      // No-op but accept the API
      return { unref: () => {} };
    },
    unwatchFile: () => {},
  };
  // Lazy getters with setters: graceful-fs reads fs.ReadStream.prototype
  // then reassigns fs.ReadStream / fs.FileReadStream to its patched
  // subclass, so each slot must be both readable (lazily) and writable.
  const __defLazyStream = (key, build) => {
    let __set = false;
    let __val;
    Object.defineProperty(__fsExports, key, {
      get() { return __set ? __val : build(); },
      set(v) { __set = true; __val = v; },
      enumerable: true, configurable: true,
    });
  };
  __defLazyStream("ReadStream", __getReadStream);
  __defLazyStream("WriteStream", __getWriteStream);
  __defLazyStream("FileReadStream", __getReadStream);
  __defLazyStream("FileWriteStream", __getWriteStream);
  // fs.Stats: the class every stat answers, its constructor deprecated
  // (DEP0180), as Node's deprecate wraps it, made when first read.
  Object.defineProperty(__fsExports, "Stats", {
    get() {
      const value = __nimbusNodeLib().require("internal/util").deprecate(Stats, "fs.Stats constructor is deprecated.", "DEP0180");
      Object.defineProperty(__fsExports, "Stats", { value, writable: true, enumerable: true, configurable: true });
      return value;
    },
    enumerable: true, configurable: true,
  });
  _installResumptionBarriers();
  return __fsExports;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  WebSocket: relayed through the supervisor ───────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// The last resumption that reached a facet without a supervisor message.
// A directly-connected socket delivers \`onmessage\` as a bare resumption:
// an arbitrary third party wakes the facet at a time of its own choosing,
// and a synchronous read in that handler serves whatever the facet was
// holding when it last heard from the authority. Two facets connected to
// any common external endpoint had a full-duplex channel that never
// touched the supervisor, which breaks causal consistency and not merely
// linearizability.
//
// Proxying the bytes would not have fixed it. The frame has to arrive AS a
// supervisor reply, so the supervisor terminates the socket and this class
// receives frames as replies to a poll it is already blocked on. Then the
// frame handler takes the same ACQUIRE the timer and fetch boundaries take,
// and \`_UNBARRIERED_RESUMPTIONS\` is empty.
//
// This is a listener registry rather than an EventTarget subclass on
// purpose: it dispatches plain event-shaped objects, which is what a
// relayed frame can carry across RPC, and it keeps \`onmessage\` and
// \`addEventListener\` served by one path instead of two.
//
// The second argument is Node's: subprotocols, or a WebSocketInit
// \`{ protocols, headers }\` (undici's), whose headers the supervisor sends
// with the upgrade. What the handshake answered (the upgrade's response
// headers, or a refusal: __nimbusRefusal) is kept on the socket under
// __NIMBUS_WS_HANDSHAKE, for the \`ws\` package's upgrade path
// (runtime/node-ws-upgrade.ts), which asks for a refusal's body with
// __NIMBUS_WS_REFUSAL_BODY in the init.
const __NIMBUS_WS_HANDSHAKE = Symbol.for("nimbus.websocket.handshake");
const __NIMBUS_WS_REFUSAL_BODY = Symbol.for("nimbus.websocket.refusal-body");

// A refused upgrade, as the relay answered it (session/ws-relay.ts): its
// head at once, and its body (when asked for) read from the relay as it
// comes, for the one consumer that reads it, until it ends or is cancelled.
// An open body holds the process, as a response's socket does in Node.
function __nimbusRefusal(supervisor, refused) {
  const pending = [];
  let ended = refused.body === null ? true : null;
  let consumer = null;
  let cancelled = false;
  const hold = refused.body === null ? null : __nimbusHoldSocket();
  const finish = (complete) => {
    if (ended !== null) return;
    ended = complete;
    if (hold) hold(false);
    if (consumer) consumer.end(complete);
  };
  if (refused.body !== null) {
    (async () => {
      while (ended === null && !cancelled) {
        let events;
        try {
          events = await __nimbusUseRpcResultUnref(supervisor.wsPoll(refused.body, 5000), (result) => result);
        } catch { finish(false); return; }
        if (!Array.isArray(events)) continue;
        for (const event of events) {
          if (cancelled) return;
          // Its bytes are an inbound delivery, as a frame is.
          await __nimbusInboundBarrier(undefined, true);
          if (event.kind === "message" && event.bytes) {
            if (consumer) consumer.chunk(event.bytes);
            else pending.push(event.bytes);
          } else if (event.kind === "close") {
            finish(event.code === 1000);
            return;
          }
        }
      }
    })();
  }
  return {
    status: refused.status,
    statusText: refused.statusText,
    headers: refused.headers,
    /** Its body to \`onChunk\`, then \`onEnd(complete)\`: whether it arrived whole. */
    read(onChunk, onEnd) {
      consumer = { chunk: onChunk, end: onEnd };
      for (const chunk of pending.splice(0)) onChunk(chunk);
      if (ended !== null) onEnd(ended);
    },
    /** The body is not wanted: the relay stops reading it. */
    cancel() {
      if (cancelled || ended !== null) return;
      cancelled = true;
      if (hold) hold(false);
      __nimbusUseRpcResultUnref(supervisor.wsClose(refused.body), () => undefined).catch(() => {});
    },
  };
}
const __NimbusRelayedWebSocket = (() => {
  const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
  /** A header list as the relay takes it: [name, value] pairs. */
  const headerPairs = (headers) => {
    if (headers === undefined || headers === null) return [];
    if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
      const pairs = [];
      headers.forEach((value, name) => { pairs.push([String(name), String(value)]); });
      return pairs;
    }
    if (Array.isArray(headers)) return headers.map(([name, value]) => [String(name), String(value)]);
    return Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((one) => [name, String(one)]));
  };
  class NimbusWebSocket {
    constructor(url, protocolsOrInit) {
      const supervisor = _nimbusSupervisor();
      if (!supervisor || typeof supervisor.wsOpen !== "function") {
        // Not a fallback to the platform socket, deliberately. An
        // unmediated socket is exactly the incoherence this class exists
        // to remove, and opening one quietly would put the guarantee back
        // to being conditional on which facet you happened to be in.
        throw new Error(
          "WebSocket: no supervisor is bound to this process, so a socket " +
          "cannot be relayed; a directly-connected socket would deliver " +
          "frames outside the filesystem coherence barrier",
        );
      }
      this.url = String(url);
      this.readyState = CONNECTING;
      this.protocol = "";
      this.extensions = "";
      this.binaryType = "arraybuffer";
      this.bufferedAmount = 0;
      this.onopen = null; this.onmessage = null;
      this.onerror = null; this.onclose = null;
      this._listeners = new Map();
      this._id = null;
      this._done = false;
      this._sends = Promise.resolve();
      const init = protocolsOrInit !== null && typeof protocolsOrInit === "object" && !Array.isArray(protocolsOrInit)
        ? protocolsOrInit : { protocols: protocolsOrInit };
      const protocols = init.protocols;
      const requested = protocols === undefined ? []
        : (Array.isArray(protocols) ? protocols.map(String) : [String(protocols)]);
      const headers = headerPairs(init.headers);
      const refusalBody = init[__NIMBUS_WS_REFUSAL_BODY] === true;
      this[__NIMBUS_WS_HANDSHAKE] = null;
      // Open, or opening, until its close: a handle, as Node's WebSocket is.
      // Taken only once the socket exists, past every throw in this
      // constructor: a caught constructor failure holds nothing.
      this._hold = __nimbusHoldSocket();
      this._ready = this._connect(supervisor, requested, headers, refusalBody);
    }

    async _connect(supervisor, protocols, headers, refusalBody) {
      try {
        // Its handshake is as outward a frame as any (its URL, its headers).
        const release = globalThis.__nimbusVfsReleaseBarrier;
        if (typeof release === "function") await release();
        const opened = await __nimbusUseRpcResultUnref(
          supervisor.wsOpen(this.url, protocols, headers, refusalBody),
          (result) => result,
        );
        if (opened.refused) {
          if (this.readyState !== CONNECTING) {
            // Closed while it handshook (an aborted request): its body is not
            // wanted, and nothing of it may hold the process; close() reports the close.
            if (opened.refused.body !== null) {
              __nimbusUseRpcResultUnref(supervisor.wsClose(opened.refused.body), () => undefined).catch(() => {});
            }
            return;
          }
          this[__NIMBUS_WS_HANDSHAKE] = __nimbusRefusal(supervisor, opened.refused);
          throw new Error("websocket relay: " + this.url + " did not upgrade (HTTP " + opened.refused.status + ")");
        }
        this[__NIMBUS_WS_HANDSHAKE] = { status: 101, statusText: "Switching Protocols", headers: opened.headers || [] };
        this._id = opened.id;
        this.protocol = opened.protocol || "";
        this._pump(supervisor);
      } catch (error) {
        this._fail(error);
      }
    }

    async _pump(supervisor) {
      while (!this._done) {
        let events;
        try {
          events = await __nimbusUseRpcResultUnref(
            supervisor.wsPoll(this._id, 5000),
            (result) => result,
          );
        } catch (error) { this._fail(error); return; }
        if (!Array.isArray(events)) continue;
        for (const event of events) {
          if (this._done) return;
          // The barrier the whole relay exists for. Every frame is now a
          // supervisor reply, so it can carry the invalidation delta, and
          // user code runs only after the resident set has caught up.
          await __nimbusInboundBarrier(undefined, true);
          this._deliver(event);
        }
      }
    }

    _deliver(event) {
      if (event.kind === "open") {
        this.readyState = OPEN;
        this._emit({ type: "open", target: this });
        return;
      }
      if (event.kind === "message") {
        const data = event.text !== null && event.text !== undefined
          ? event.text
          : (this.binaryType === "arraybuffer"
            ? _nimbusToArrayBuffer(event.bytes)
            : event.bytes);
        this._emit({ type: "message", data, target: this });
        return;
      }
      if (event.kind === "error") {
        this._emit({ type: "error", message: event.message, target: this });
        return;
      }
      if (event.kind === "close") {
        this._done = true;
        this._hold(false);
        this.readyState = CLOSED;
        this._emit({
          type: "close", code: event.code, reason: event.reason,
          wasClean: event.code === 1000, target: this,
        });
      }
    }

    _fail(error) {
      if (this._done) return;
      this._done = true;
      this._hold(false);
      this.readyState = CLOSED;
      const message = (error && error.message) || String(error);
      this._emit({ type: "error", message, target: this });
      this._emit({ type: "close", code: 1006, reason: message, wasClean: false, target: this });
    }

    _emit(event) {
      const handler = this["on" + event.type];
      if (typeof handler === "function") {
        try { handler.call(this, event); } catch (error) { _nimbusReportListenerError(error); }
      }
      const listeners = this._listeners.get(event.type);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          if (typeof listener === "function") listener.call(this, event);
          else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(event);
        } catch (error) { _nimbusReportListenerError(error); }
      }
    }

    addEventListener(type, listener) {
      const key = String(type);
      if (!this._listeners.has(key)) this._listeners.set(key, new Set());
      this._listeners.get(key).add(listener);
    }

    removeEventListener(type, listener) {
      const listeners = this._listeners.get(String(type));
      if (listeners) listeners.delete(listener);
    }

    dispatchEvent(event) { this._emit(event); return true; }

    send(data) {
      if (this.readyState === CLOSED || this.readyState === CLOSING) {
        throw new Error("WebSocket: send on a socket that is already closing");
      }
      const text = typeof data === "string" ? data : null;
      const bytes = text === null ? _nimbusToBytes(data) : null;
      const size = text !== null ? text.length : (bytes ? bytes.byteLength : 0);
      this.bufferedAmount += size;
      // A frame leaving this facet is an outward-visible effect of whatever
      // it just wrote, so the parked writes go first. Otherwise the peer
      // that reads this frame can act on a write the authority does not
      // have yet, which is the causal edge the protocol closes.
      this._sends = this._sends.then(async () => {
        const supervisor = _nimbusSupervisor();
        if (!supervisor || this._done) return;
        const release = globalThis.__nimbusVfsReleaseBarrier;
        if (typeof release === "function") await release();
        await this._ready;
        if (this._id === null || this._done) return;
        await __nimbusUseRpcResultUnref(
          supervisor.wsSend(this._id, text, bytes),
          () => undefined,
        );
      }).then(
        () => { this.bufferedAmount -= size; },
        (error) => { this.bufferedAmount -= size; this._fail(error); },
      );
      __nimbusTrackOp(this._sends);
    }

    close(code, reason) {
      if (this._done || this.readyState === CLOSING) return;
      this.readyState = CLOSING;
      const supervisor = _nimbusSupervisor();
      const closing = (async () => {
        await this._ready.catch(() => {});
        if (this._id === null || !supervisor) return;
        // So is its close (its code, its reason).
        const release = globalThis.__nimbusVfsReleaseBarrier;
        if (typeof release === "function") await release();
        await __nimbusUseRpcResultUnref(
          supervisor.wsClose(this._id, code, reason),
          () => undefined,
        );
      })().catch(() => {}).then(() => {
        this._done = true;
        this._hold(false);
        this.readyState = CLOSED;
        this._emit({
          type: "close", code: code === undefined ? 1000 : code,
          reason: reason === undefined ? "" : String(reason),
          wasClean: true, target: this,
        });
      });
      __nimbusTrackOp(closing);
    }
  }
  for (const [name, value] of [["CONNECTING", CONNECTING], ["OPEN", OPEN], ["CLOSING", CLOSING], ["CLOSED", CLOSED]]) {
    NimbusWebSocket[name] = value;
    NimbusWebSocket.prototype[name] = value;
  }
  return NimbusWebSocket;
})();

function _nimbusSupervisor() {
  try { return typeof __supervisor !== "undefined" ? __supervisor : null; }
  catch { return null; }
}

function _nimbusToBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

function _nimbusToArrayBuffer(bytes) {
  if (!bytes) return new ArrayBuffer(0);
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.byteLength === view.byteLength
    ? view.buffer
    : view.slice().buffer;
}

// A listener that throws is the program's bug, but swallowing it silently
// would make a relayed socket behave differently from a direct one. Route it
// to the same place an uncaught async failure goes.
function _nimbusReportListenerError(error) {
  queueMicrotask(() => { throw error; });
}

globalThis.WebSocket = __NimbusRelayedWebSocket;

// ═══════════════════════════════════════════════════════════════════════
// ──  constants module (framework-fixes-F1) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// require('node:constants') (and the legacy bare require('constants'))
// expose a FLAT object of POSIX/Linux/OpenSSL constants. Real Node ships
// ~234 constants; the full fs slice comes from __fsConstants, and the rest
// is what actually gets touched by:
//   - create-next-app (touches UV_FS_O_FILEMAP — verified via grep on
//     unpkg.com/create-next-app@latest/dist/index.js)
//   - signal/errno tables (shared shape with __osMod.constants.signals
//     etc. — flat here, nested there; both shapes are real-Node-accurate
//     and we expose both via the right module).
//   - dlopen flags (RTLD_*) for libraries that probe defined-ness.
//   - SSL_OP_* / TLS_*_VERSION for libs that probe TLS options
//     (vanilla openssl numeric values — semantic match real Node's).
//
// Values match real Node v20 on Linux exactly. Verified via
// node -e 'console.log(require("node:constants"))'.
//
// History: F1 root cause in framework-fixes wave. Pre-fix create-next-app
// errored with "Cannot find module 'node:constants'" at module init.
// The errno, signal, priority and dlopen tables, written once: node:constants
// spreads them flat, os.constants nests them by name.
const __dlopenConstants = { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 };
// Errno (Linux ABI). fs/network libraries (graceful-fs, retry layers in
// node-fetch wrappers) probe these to decide retry strategy.
const __errnoConstants = {
  E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97,
  EAGAIN: 11, EALREADY: 114, EBADF: 9, EBADMSG: 74, EBUSY: 16,
  ECANCELED: 125, ECHILD: 10, ECONNABORTED: 103, ECONNREFUSED: 111,
  ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89, EDOM: 33, EDQUOT: 122,
  EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113, EIDRM: 43,
  EILSEQ: 84, EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5,
  EISCONN: 106, EISDIR: 21, ELOOP: 40, EMFILE: 24, EMLINK: 31,
  EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36, ENETDOWN: 100,
  ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23, ENOBUFS: 105,
  ENODATA: 61, ENODEV: 19, ENOENT: 2, ENOEXEC: 8, ENOLCK: 37,
  ENOLINK: 67, ENOMEM: 12, ENOMSG: 42, ENOPROTOOPT: 92, ENOSPC: 28,
  ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107, ENOTDIR: 20,
  ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25, ENXIO: 6,
  EOPNOTSUPP: 95, EOVERFLOW: 75, EPERM: 1, EPIPE: 32, EPROTO: 71,
  EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ERANGE: 34, EROFS: 30,
  ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62, ETIMEDOUT: 110,
  ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18,
};
// Process priority, for os.setPriority / os.getPriority.
const __priorityConstants = {
  PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
  PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20,
};
// Signals (POSIX + Linux), numbered as the Linux ABI numbers them.
const __signalConstants = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
  SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
  SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19,
  SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
  SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
  SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
};
const __constantsMod = {
  ...__dlopenConstants,
  ...__errnoConstants,
  ...__priorityConstants,
  ...__signalConstants,
  // ── fs constants (O_*, S_IF*, S_I*, F_OK.., COPYFILE_*, UV_*) ────
  // Node's constants module is the union of os, fs and crypto constants;
  // the fs slice is __fsConstants, the same object fs.constants exposes.
  ...__fsConstants,
  // ── OpenSSL / TLS option flags ────────────────────────────────────
  // Numeric values from real Node v20. Libraries probe defined-ness;
  // we ship the surface so constants.SSL_OP_* doesn't undefined-throw.
  OPENSSL_VERSION_NUMBER: 810549328,
  SSL_OP_ALL: 2147485776, SSL_OP_ALLOW_NO_DHE_KEX: 1024,
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144,
  SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304,
  SSL_OP_CISCO_ANYCONNECT: 32768, SSL_OP_COOKIE_EXCHANGE: 8192,
  SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648,
  SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048,
  SSL_OP_LEGACY_SERVER_CONNECT: 4, SSL_OP_NO_COMPRESSION: 131072,
  SSL_OP_NO_ENCRYPT_THEN_MAC: 524288, SSL_OP_NO_QUERY_MTU: 4096,
  SSL_OP_NO_RENEGOTIATION: 1073741824,
  SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536,
  SSL_OP_NO_SSLv2: 0, SSL_OP_NO_SSLv3: 33554432,
  SSL_OP_NO_TICKET: 16384, SSL_OP_NO_TLSv1: 67108864,
  SSL_OP_NO_TLSv1_1: 268435456, SSL_OP_NO_TLSv1_2: 134217728,
  SSL_OP_NO_TLSv1_3: 536870912, SSL_OP_PRIORITIZE_CHACHA: 2097152,
  SSL_OP_TLS_ROLLBACK_BUG: 8388608,
  // ── TLS version numbers ───────────────────────────────────────────
  TLS1_VERSION: 769, TLS1_1_VERSION: 770,
  TLS1_2_VERSION: 771, TLS1_3_VERSION: 772,
  // ── crypto engine method flags ────────────────────────────────────
  ENGINE_METHOD_RSA: 1, ENGINE_METHOD_DSA: 2, ENGINE_METHOD_DH: 4,
  ENGINE_METHOD_RAND: 8, ENGINE_METHOD_EC: 2048,
  ENGINE_METHOD_CIPHERS: 64, ENGINE_METHOD_DIGESTS: 128,
  ENGINE_METHOD_PKEY_METHS: 512, ENGINE_METHOD_PKEY_ASN1_METHS: 1024,
  ENGINE_METHOD_ALL: 65535, ENGINE_METHOD_NONE: 0,
  // ── DH / RSA padding ──────────────────────────────────────────────
  DH_CHECK_P_NOT_SAFE_PRIME: 2, DH_CHECK_P_NOT_PRIME: 1,
  DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8,
  RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4, RSA_X931_PADDING: 5,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
};

// ═══════════════════════════════════════════════════════════════════════
// ──  os module ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// This process's nice value (os.getPriority/setPriority), as Linux keeps it.
let __nimbusNice = 0;
// lib/os.js's ERR_SYSTEM_ERROR for a priority call libuv refused.
function __nimbusPriorityError(syscall, code) {
  return new nodeErrorCodes.ERR_SYSTEM_ERROR({
    errno: -__errnoConstants[code], code, message: __nimbusErrnoDescription[code], syscall,
  });
}
// The system as uname(2) reports it (core constants.ts SYSTEM_IDENTITY): \`uname\` prints the same.
const __nimbusSystem = ${JSON.stringify(SYSTEM_IDENTITY)};
const __osMod = {
  platform: () => ${JSON.stringify(NODE_SYSTEM.platform)}, arch: () => ${JSON.stringify(NODE_SYSTEM.arch)}, type: () => __nimbusSystem.sysname,
  release: () => __nimbusSystem.release, version: () => __nimbusSystem.version, machine: () => __nimbusSystem.machine,
  tmpdir: () => "/tmp", homedir: () => "/home/user",
  hostname: () => __nimbusSystem.nodename, devNull: "/dev/null",
  // lib/os.js: this process's priority. Linux lets anyone raise its nice
  // value and only root lower it (RLIMIT_NICE 0). Named limit: another
  // process's is not readable from here, as process.kill's signal is not,
  // and the call raises ENOSYS.
  getPriority(pid) {
    if (pid === undefined) pid = 0;
    else __nimbusNodeLib().require("internal/validators").validateInt32(pid, "pid");
    if (pid !== 0 && pid !== __processMod.pid) throw __nimbusPriorityError("uv_os_getpriority", "ENOSYS");
    return __nimbusNice;
  },
  setPriority(pid, priority) {
    if (priority === undefined) {
      priority = pid;
      pid = 0;
    }
    const { validateInt32 } = __nimbusNodeLib().require("internal/validators");
    validateInt32(pid, "pid");
    validateInt32(priority, "priority", -20, 19);
    if (pid !== 0 && pid !== __processMod.pid) throw __nimbusPriorityError("uv_os_setpriority", "ENOSYS");
    if (priority < __nimbusNice && Number(cred.uid) !== 0) throw __nimbusPriorityError("uv_os_setpriority", "EACCES");
    __nimbusNice = priority;
  },
  userInfo: () => {
    const uid = Number(cred.uid);
    const gid = Number(cred.gid);
    const root = uid === 0;
    return { uid, gid, username: root ? "root" : "user", homedir: root ? "/root" : "/home/user", shell: "/bin/sh" };
  },
  cpus: () => [{ model: "DO vCPU", speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
  // One JavaScript thread per Worker isolate, irrespective of the host CPU.
  availableParallelism: () => 1,
  totalmem: () => 128 * 1024 * 1024, freemem: () => 64 * 1024 * 1024,
  loadavg: () => [0, 0, 0], uptime: () => 3600,
  networkInterfaces: () => ({ lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }] }),
  EOL: "\\n", endianness: () => "LE",
  // os.constants — signals + errno + priority. Used by human-signals,
  // signal-exit, cross-spawn, exit-hook, and a long tail of "graceful
  // shutdown" / "child-process plumbing" libraries that real Node ships.
  //
  // human-signals's main.js (v2+) does:
  //   import { constants } from 'node:os'
  //   ...
  //   const findSignalByNumber = (number, signals) =>
  //     signals.find(({ name }) => constants.signals[name] === number)
  //
  // Pre-fix, __osMod had no \`constants\` field → \`constants.signals\`
  // was undefined → \`signals[name]\` throws TypeError → caller's
  // \`getSignalsByName\` blows up at module init time. Surfaced by
  // create-react-router (transitively depends on human-signals via
  // execa / cross-spawn).
  //
  // Values mirror real Node v20+ on Linux (verified against \`node -e
  // "console.log(require('os').constants)"\`). The shape is stable;
  // pinning POSIX signal numbers per the LSB / glibc table.
  constants: {
    signals: __signalConstants,
    errno: __errnoConstants,
    priority: __priorityConstants,
    dlopen: __dlopenConstants,
  },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  events module ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// workerd's own node:events (nodejs_compat). Its EventEmitter is Node's
// function constructor, so \`EventEmitter.call(this)\` + util.inherits,
// mixin-copies of EventEmitter.prototype (express's createApplication) and
// the static once/on/captureRejections helpers behave as in Node, and native
// node:http servers are instances of the same class userland requires.
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/events/ and
// workerd v1.20260926.1 src/node/internal/events.ts (\`export function
// EventEmitter\`; http servers extend it in internal_http_server.ts).
const __eventsMod = __nativeBuiltin("events");

// ═══════════════════════════════════════════════════════════════════════
// ──  stream module: the platform's node:stream ──────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Every stream here is one of its classes: the files', the children's, the
// terminal's, HTTP's and zlib's alike.
const __streamMod = __nativeBuiltin("stream");

// ═══════════════════════════════════════════════════════════════════════
// ──  node:sqlite module (sql.js-backed) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
${SQLITE_SHIM_CODE}

// ═══════════════════════════════════════════════════════════════════════
// ──  undici (npm) — mapped onto the platform HTTP stack ─────────────
// ═══════════════════════════════════════════════════════════════════════
${UNDICI_SHIM_CODE}

// ═══════════════════════════════════════════════════════════════════════
// ──  util module ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// util.inspect, format and formatWithOptions are Node v22.23.4's own
// lib/internal/util/inspect.js (node-lib-source.ts), evaluated the first
// time a program formats a value, over what node-lib-host.ts gives it in
// place of Node's internals: what a program prints of a value, through util
// or console, is what Node prints (node-inspect-matches-node,
// console-format-matches-node-workerd). workerd's own node:util gives
// util.types, and reads what only V8's internals hold (a promise's state,
// a proxy's target) as values, through its inspect. consola's FancyReporter
// calls formatWithOptions directly (nuxi init).
const __realUtil = __nativeBuiltin("util");
// ── Node's library ──
// Node's own modules (node-lib-source.ts), run over node-lib-host.ts the
// first time a program needs one: util.inspect, util, assert, querystring,
// punycode and what they require. Their module of the launch's map
// (node-lib-module.ts) is compiled then, not before. Named limit: Node's
// primordials are taken then too, where Node takes them at bootstrap, so a
// builtin the program replaced before that first use is the one they hold.
// The process_methods binding Node's per_thread.js wraps: the isolate's
// monotonic clock (performance.now), _rawDebug to stderr, and .env loading.
// Named limit: a Worker exposes no CPU time or memory readings, so
// cpuUsage, threadCpuUsage, resourceUsage and memoryUsage read 0.
const __nimbusHrtimeBuffer = new Uint32Array(4);
// When the process started, on performance.now's clock (an epoch-based one in workerd).
const __nimbusStartedAt = performance.now();
// Milliseconds as BigInt nanoseconds, the whole milliseconds converted exactly
// (an epoch's milliseconds times 1e6 are past a double's integers).
function __nimbusMsToNs(ms) {
  const value = Number(ms);
  const whole = Math.trunc(value);
  return BigInt(whole) * 1000000n + BigInt(Math.round((value - whole) * 1e6));
}
const __nimbusProcessMethods = {
  hrtimeBuffer: __nimbusHrtimeBuffer,
  hrtime() {
    const ns = __nimbusMsToNs(performance.now());
    const sec = ns / 1000000000n;
    __nimbusHrtimeBuffer[0] = Number(sec >> 32n);
    __nimbusHrtimeBuffer[1] = Number(sec & 0xffffffffn);
    __nimbusHrtimeBuffer[2] = Number(ns % 1000000000n);
  },
  hrtimeBigInt() {
    new BigUint64Array(__nimbusHrtimeBuffer.buffer, 0, 1)[0] = __nimbusMsToNs(performance.now());
  },
  _rawDebug(text) { __nimbusWriteFatal(text + "\\n"); },
  cpuUsage(values) { values.fill(0); },
  threadCpuUsage(values) { values.fill(0); },
  memoryUsage(values) { values.fill(0); },
  rss: () => 0,
  resourceUsage(values) { values.fill(0); },
  // src/node_dotenv.cc: a .env file's variables, none the environment already has.
  loadEnvFile(path = ".env") {
    const parsed = __nimbusNodeLib().require("util").parseEnv(builtins.fs.readFileSync(path, "utf8"));
    for (const key of Object.keys(parsed)) if (!Object.hasOwn(__processMod.env, key)) __processMod.env[key] = parsed[key];
  },
};
let __nimbusNodeLibrary = null;
function __nimbusNodeLib() {
  if (__nimbusNodeLibrary !== null) return __nimbusNodeLibrary;
  const lib = __nimbusRegistryRequire("./${RUNTIME_NODE_LIB_MODULE}");
  const primordials = {};
  lib.primordialsOf(primordials, globalThis);
  // The East Asian Wide and Fullwidth ranges, ascending: [first, last] pairs.
  const wide = lib.eastAsianWideRanges.split(",").flatMap((range) => {
    const [first, last = first] = range.split("-");
    return [parseInt(first, 16), parseInt(last, 16)];
  });
  __nimbusNodeLibrary = lib.createNodeLib({
    util: __realUtil,
    errors: { codes: nodeErrorCodes, hideStackFrames, isErrorStackTraceLimitWritable },
    // V8's slots, as workerd's inspect reaches them (node-lib-host.ts THE BINDING).
    slots: lib.createWorkerdSlots(__realUtil),
    Buffer: __BufferMod,
    url: { pathToFileURL: __urlMod.pathToFileURL, fileURLToPath: __urlMod.fileURLToPath, URL: __urlMod.URL },
    processMethods: __nimbusProcessMethods,
    diagnosticsChannel: builtins.diagnostics_channel,
    cliOptions: lib.cliOptions,
    cliAliases: lib.cliAliases,
    process: __processMod,
    builtinModules: __NodeModule.builtinModules,
    builtinObjects: lib.builtinObjects,
    eastAsianWide(code) {
      let low = 0;
      let high = wide.length / 2 - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (code < wide[2 * mid]) high = mid - 1;
        else if (code > wide[2 * mid + 1]) low = mid + 1;
        else return true;
      }
      return false;
    },
    signals: __osMod.constants.signals,
    insideNodeModules: __nimbusInsideNodeModules,
    errorSourcePositions: __nimbusErrorSourcePositions,
    tokenizer: (code, options) => __nimbusRegistryRequire("./${RUNTIME_PARSER_MODULE}").tokenizer(code, options),
    sourceMaps: { getSourceMapsSupport: () => __nimbusSourceMapsSupport, findSourceMap: __nimbusFindSourceMap, getSourceLine: __nimbusOriginalSourceLine },
    colorDepth: () => __nimbusColorDepth(),
    customPromisifyArgs: __nimbusCustomPromisifyArgs,
    uvErrors: lib.uvErrors,
    optionValue: __nimbusOptionValue,
    console: __consoleMod,
    workerThreads: builtins.worker_threads,
    get nodeDebug() { return __nimbusNodeDebugAtLaunch; },
    callSites: (count, above) => __nimbusStackSites({}, count, above),
    timers: builtins.timers,
    fetch: globalThis.fetch.bind(globalThis),
    createCaresBinding: lib.createCaresBinding,
    // Node's modules that copy (lib/internal/fs/cp) do it through this fs.
    fs: () => builtins.fs,
    path: __pathMod,
    errno: __osMod.constants.errno,
    primordials,
    sources: lib.sources,
  });
  return __nimbusNodeLibrary;
}
function __nimbusNodeInspect() {
  return __nimbusNodeLib().require("internal/util/inspect");
}
// What util.promisify makes an object of when a callback is given several
// values (lib/internal/util.js customPromisifyArgs): fs.read's bytesRead and
// buffer, dns.lookup's address and family.
const __nimbusCustomPromisifyArgs = Symbol("customPromisifyArgs");
// internal/options getOptionValue, for the options Node's library reads.
function __nimbusOptionValue(name) {
  switch (name) {
    case "--eval": return typeof __nimbusNodeCommandLine?.eval === "string" ? __nimbusNodeCommandLine.eval : "";
    case "--enable-source-maps": return __nimbusNodeCommandLine?.enableSourceMaps === true;
    default: return undefined;
  }
}
// isInsideNodeModules (the util binding): whether the program's innermost
// frame on the stack is a package's.
function __nimbusInsideNodeModules() {
  for (const site of __nimbusStackSites({}, Infinity, __nimbusInsideNodeModules)) {
    const file = site.getFileName();
    if (typeof file === "string" && __nimbusModuleOfFile(file) !== null) return /[\\\\/]node_modules[\\\\/]/.test(file);
  }
  return false;
}
// getErrorSourcePositions (the errors binding): where V8 placed the first
// frame of a stack \`error\` captured and nothing read yet, in its file's text
// as the program wrote it; an empty line where the runtime has no text for it.
function __nimbusErrorSourcePositions(error) {
  const site = typeof __nimbusStackSites === "function" ? __nimbusStackSites(error)[0] : undefined;
  const scriptResourceName = site?.getFileName() ?? "";
  const lineNumber = site?.getLineNumber() ?? 0;
  const startColumn = Math.max(0, (site?.getColumnNumber() ?? 1) - 1);
  const text = scriptResourceName === "" ? null : __nimbusModuleSourceText(__nimbusModuleOfFile(scriptResourceName));
  const sourceLine = text?.split(/\\r\\n|[\\n\\r\\u2028\\u2029]/, lineNumber)[lineNumber - 1] ?? "";
  return { sourceLine, scriptResourceName, lineNumber, startColumn };
}
// Node's errors describe a value only inspect can (a null-prototype
// object) with it, as Node's do.
useNodeErrorInspect((value, options) => __nimbusNodeInspect().inspect(value, options));
// util.inspect, which loads Node's the first time it formats: its custom
// symbol is Node's registered one, its options and styles Node's own.
function __nimbusInspect(value, options) {
  return Reflect.apply(__nimbusNodeInspect().inspect, this, arguments);
}
Object.defineProperties(__nimbusInspect, {
  name: { value: "inspect" },
  custom: { value: Symbol.for("nodejs.util.inspect.custom"), writable: true, enumerable: true, configurable: true },
  defaultOptions: {
    get() { return __nimbusNodeInspect().inspect.defaultOptions; },
    set(options) { __nimbusNodeInspect().inspect.defaultOptions = options; },
    enumerable: true, configurable: true,
  },
  colors: { get() { return __nimbusNodeInspect().inspect.colors; }, set(value) { __nimbusNodeInspect().inspect.colors = value; }, enumerable: true, configurable: true },
  styles: { get() { return __nimbusNodeInspect().inspect.styles; }, set(value) { __nimbusNodeInspect().inspect.styles = value; }, enumerable: true, configurable: true },
});

// ═══════════════════════════════════════════════════════════════════════
// ──  url module ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// X.5-M (M-3): lenient URL constructor for rolldown-bundled CJS packages.
//
// Rolldown/rollup-bundled CJS packages (vite v7, esbuild plugins, …)
// emit at module top-level:
//
//     const X = new URL("../../../src/node/constants.ts", import.meta.url);
//
// where the rolldown-CJS polyfill for import.meta.url evaluates to literal
// null (the bare word) in our facet (no document, no location, polyfill doesn't reach
//
// workerd's URL constructor strict-rejects null/undefined base, throwing
// "Invalid URL string." at module top-level eval — breaks require('vite').
//
// Fix: wrap globalThis.URL so null/undefined base for a string input
// defaults to "file:///" (after first trying the input as an absolute
// URL). All other URL behaviour is passthrough; instanceof checks and
// static methods (canParse, parse, createObjectURL, ...) preserved.
//
// Stage A (this commit): vite no longer throws at the URL constructor;
// it now progresses to a deeper fs-URL composition gap (vite passes URL
// instances / file:// strings to fs.readFileSync, which our fs shim
// doesn't strip) — that's out-of-charter, see X5M-retro §3.
//
// X.5-M3 (this section): when esbuild ESM-to-CJS pre-compile substitutes
// import.meta.url with undefined (its documented empty-import-meta
// warning behavior), new URL(rel, undefined) falls into the null-base
// branch below. Pre-M3 the fallback was a literal "file:///", which
// resolved every new URL("../foo", import.meta.url) to root-relative
// file:///foo — wrong for vite/dist/node/chunks/logger.js:75 et al.
//
// M3 plumbs the currently-loading module's path via globalThis.__currentModulePath
// (set+restored by __loadModule per call). When set, the fallback becomes
// "file:///" + __currentModulePath so relative URLs resolve against
// the real on-VFS module location — restoring proper import.meta.url
//
// The leniency is scoped to calls that PASSED a base. \`new URL(x)\` with one
// argument is Node's strict absolute-URL parse: it throws
// TypeError [ERR_INVALID_URL] for anything that is not already a URL, and
// that throw is load-bearing rather than incidental. Node's own ESM
// resolver — and every vendored copy of it, including exsolve, which is what
// \`nuxt dev\` resolves \`@nuxt/kit\` and \`nuxt\` with — spells the
// bare-specifier test as
//     try { resolved = new URL(specifier); } catch { packageResolve(…); }
// Swallowing the throw made \`new URL("@nuxt/kit")\` answer
// file:///@nuxt/kit, so moduleResolve never reached packageResolve and
// finalizeResolution stat'd /@nuxt/kit — the FILESYSTEM ROOT — instead of
// walking <from>/node_modules. Two syscalls and every bare import in the
// project was unresolvable. The bundler breakage this wrapper exists for
// (\`new URL(rel, import.meta.url)\` where the rolldown/esbuild polyfill
// reduced import.meta.url to null/undefined) is always a two-argument call,
// so requiring the base argument keeps that fix and restores Node's
// contract for the one-argument form. URL.canParse, which is bound
// straight off the native constructor below, already answered false for
// these strings; the constructor now agrees with it.
(() => {
  const _Orig = __nimbusFrontBase(globalThis.URL);
  const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
  // Named URL, as Node's class is: its name is what inspect and errors print.
  class URL extends _Orig {
    constructor(input, base) {
      if (arguments.length === 0) throw new nodeErrorCodes.ERR_MISSING_ARGS("url");
      const inputText = "".concat(input);
      if (arguments.length >= 2 && base == null && typeof input === "string") {
        try { super(input); return; }
        catch {
          // X.5-M3: prefer current module path when known, so
          //   new URL(rel, undefined) === new URL(rel, "file:///" + __filename)
          // matches real ESM import-meta-url resolution.
          const cur = globalThis.__currentModulePath;
          const fallback = (typeof cur === "string" && cur.length > 0)
            ? "file:///" + cur.replace(/^\\/+/, "")
            : "file:///";
          super(input, fallback);
          return;
        }
      }
      const baseText = base === undefined ? undefined : "".concat(base);
      try { super(inputText, baseText); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input: inputText, ...(baseText !== undefined ? { base: baseText } : {}) });
      }
    }
    // Node's (lib/internal/url.js, v22.23.4), but for showHidden's internal
    // context, which workerd's URL has none of.
    [inspectCustom](depth, opts) {
      if (typeof depth === "number" && depth < 0) return this;
      let constructor = URL;
      for (let proto = this; proto; proto = Object.getPrototypeOf(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, "constructor");
        if (descriptor !== undefined && typeof descriptor.value === "function" && descriptor.value.name !== "") {
          constructor = descriptor.value;
          break;
        }
      }
      const obj = { __proto__: { constructor } };
      obj.href = this.href;
      obj.origin = this.origin;
      obj.protocol = this.protocol;
      obj.username = this.username;
      obj.password = this.password;
      obj.host = this.host;
      obj.hostname = this.hostname;
      obj.port = this.port;
      obj.pathname = this.pathname;
      obj.search = this.search;
      obj.searchParams = this.searchParams;
      obj.hash = this.hash;
      return constructor.name + " " + __nimbusInspect(obj, opts);
    }
  }
  for (const k of Object.getOwnPropertyNames(_Orig)) {
    if (typeof _Orig[k] === "function" && !(k in URL)) {
      try { URL[k] = _Orig[k].bind(_Orig); } catch (_e) {}
    }
  }
  // NOTE: cannot reassign URL.prototype = _Orig.prototype — workerd treats
  // class.prototype as read-only. Inheritance via "extends _Orig" is enough:
  // URL instances are instanceof _Orig, and URL.prototype's __proto__ is
  // _Orig.prototype (so all native URL methods are reachable via the chain).
  globalThis.URL = __nimbusFronted(URL, _Orig);
  // URLSearchParams prints as Node's does (lib/internal/url.js, v22.23.4).
  Object.defineProperty(globalThis.URLSearchParams.prototype, inspectCustom, {
    value: function (recurseTimes, ctx) {
      if (typeof recurseTimes === "number" && recurseTimes < 0) return ctx.stylize("[Object]", "special");
      const separator = ", ";
      const innerOpts = { ...ctx };
      if (recurseTimes !== null) innerOpts.depth = recurseTimes - 1;
      const innerInspect = (v) => __nimbusInspect(v, innerOpts);
      const output = [];
      for (const [name, value] of this) output.push(innerInspect(name) + " => " + innerInspect(value));
      let length = -separator.length;
      for (let i = 0; i < output.length; i++) length += output[i].replace(/\\u001b\\[\\d\\d?m/g, "").length + separator.length;
      if (length > ctx.breakLength) return this.constructor.name + " {\\n  " + output.join(",\\n  ") + " }";
      if (output.length) return this.constructor.name + " { " + output.join(separator) + " }";
      return this.constructor.name + " {}";
    },
    writable: true, configurable: true,
  });
})();
// The legacy API (parse/format/resolve/resolveObject/Url) and the rest of the
// module are workerd's own node:url (runtime/node-shims-imports.ts).
// It was imitated here over WHATWG \`new URL()\`, which throws for the path-only
// URL every HTTP server receives as \`req.url\`: \`url.parse("/hello.txt")\` came
// back as \`{ href }\` with no pathname, so node-static stat'ed
// "<root>/undefined" and answered 404 for every file.
const __realUrl = __nativeBuiltin("url");
const __urlMod = {
  ...__realUrl,
  URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
  // Node's semantics: a relative path resolves against the process's cwd, a
  // trailing slash survives, and the characters the URL parser would read as
  // syntax or leave raw are percent-encoded ('%' first; the pathname setter
  // encodes '?', '#', spaces and controls such as rolldown's "\\0" virtual-id
  // prefix). Prefixing "file://" instead made a relative path's first segment
  // the URL's host, which throws for "\\0rolldown/runtime.js" and misnames
  // every other one.
  pathToFileURL: (p) => {
    const input = String(p);
    let resolved = __pathMod.resolve(input);
    if (input.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
    const url = new URL("file:///");
    url.pathname = resolved.replace(/%/g, "%25").replace(/\\\\/g, "%5C").replace(/\\n/g, "%0A").replace(/\\r/g, "%0D").replace(/\\t/g, "%09");
    return url;
  },
};
__urlMod.URL = globalThis.URL;

// ═══════════════════════════════════════════════════════════════════════
// ──  crypto module: the platform's node:crypto ─────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __cryptoMod = __nativeBuiltin("crypto");

// ═══════════════════════════════════════════════════════════════════════
// ──  vm module (W3: hybrid — forward surface, honest-error on eval) ──
// ═══════════════════════════════════════════════════════════════════════
//
// Workerd's node:vm provides the API surface (constants, classes,
// runInContext as a function) BUT every code-running method throws
// ERR_METHOD_NOT_IMPLEMENTED at request-handler time. New Function
// is also blocked at request time. So we forward the surface (so
// jsdom's static-load checks pass) and wrap the eval methods with
// a honest Nimbus error so callers know it's the workerd block.
//
// Acceptance limitation: jsdom static-load works; jsdom HTML-script
// execution does not.  Documented in W3 retro for W3.5 follow-up
// (a parser-based vm fallback, or pre-bundle vm-using scripts at
// install time).
// ── Runtime code: the Function constructors ──
//
// A Worker generates code from strings only while its modules evaluate: at
// request time — where every program runs — \`new Function(...)\` and its async
// and generator siblings throw EvalError "Code generation from strings
// disallowed for this context". Each constructor here asks the native one
// first and, refused that way, hands the arguments to the launch's
// runtime-code service (core/_shared/commonjs-cell.ts, RUNTIME CODE), which
// answers from this launch's module map when an earlier launch staged the
// text, and otherwise records it for the next launch and runs it in the
// interpreter. That is the constructor a module runner evaluates with
// (Vite's SSR runner: \`new AsyncFunction(...)\`), reached as each kind's
// \`prototype.constructor\`, which is how \`(async function () {}).constructor\`
// finds it. A facet without the service (opencode's) keeps the native refusal.
function __nimbusIsCodegenRefusal(e) {
  return e instanceof EvalError && /Code generation from strings disallowed/.test(String(e.message));
}
// es-module-lexer decodes quoted import/export names with indirect eval and
// swallows failures. A single quoted string is data, not executable code:
// decode it without compiling, preserving native eval (including its Workers
// refusal) for everything else. No general-evaluation capability is exposed,
// and Function("null") / eval("1 + 1") feature probes remain refused.
const __nimbusDecodeStringLiteral = ${DECODE_JAVASCRIPT_STRING_LITERAL_SOURCE};
(() => {
  const nativeEval = globalThis.eval;
  if (nativeEval.__nimbusNative) return;
  const routed = { eval(source) {
    if (typeof source === "string") {
      const value = __nimbusDecodeStringLiteral(source);
      if (value !== undefined) return value;
    }
    return Reflect.apply(nativeEval, undefined, [source]);
  } }.eval;
  Object.defineProperty(routed, "__nimbusNative", { value: nativeEval });
  globalThis.eval = routed;
})();
(() => {
  const kinds = [
    ["function", Function],
    ["async", Object.getPrototypeOf(async function () {}).constructor],
    ["generator", Object.getPrototypeOf(function* () {}).constructor],
    ["asyncGenerator", Object.getPrototypeOf(async function* () {}).constructor],
  ];
  const nativeToString = Function.prototype.toString;
  // Vite's module runner compiles each SSR module with new AsyncFunction and
  // imports its dependencies only when that module runs, so a refused module
  // hid everything it imports and every launch learned one more module.
  // Vite's SSR transform hoists a module's static imports into a generated
  // prologue, one statement per line, after "use strict" and the export
  // getters:
  //   const __vite_ssr_import_N__ = await __vite_ssr_import__("<source>"[, <metadata JSON>]);
  // Those imports are what the module would have run first, in this order.
  // This reads that prologue and stops at the first other line.
  const viteHoistedImports = (body) => {
    const found = [];
    for (const raw of body.split("\\n")) {
      const line = raw.trim();
      if (line === "" || line === '"use strict";' || line.startsWith("__vite_ssr_exportName__(")) continue;
      let rest = line;
      if (rest.startsWith("const __vite_ssr_import_")) {
        const bound = rest.indexOf("__ = ");
        if (bound < 0) break;
        rest = rest.slice(bound + 5);
      }
      const head = "await __vite_ssr_import__(";
      if (!rest.startsWith(head) || !rest.endsWith(");")) break;
      rest = rest.slice(head.length, -2);
      const quote = rest[0];
      if (quote !== '"' && quote !== "'") break;
      let end = 1;
      while (end < rest.length && rest[end] !== quote) end += rest[end] === "\\\\" ? 2 : 1;
      if (end >= rest.length) break;
      const source = __nimbusDecodeStringLiteral(rest.slice(0, end + 1));
      if (typeof source !== "string") break;
      const tail = rest.slice(end + 1).trim();
      let metadata;
      if (tail !== "") {
        if (!tail.startsWith(",")) break;
        try { metadata = JSON.parse(tail.slice(1)); } catch { break; }
      }
      found.push([source, metadata]);
    }
    return found;
  };
  // A constructor routed to the runtime-code service, for code of \`kind\`
  // from \`origin()\` (commonjs-cell.ts, RUNTIME CODE): native first, so a
  // context that may compile does.
  const routedConstructor = (kind, Native, origin) => {
    const routed = function (...args) {
      try {
        return new.target === undefined ? Reflect.apply(Native, undefined, args) : Reflect.construct(Native, args, new.target);
      } catch (e) {
        const service = globalThis.__nimbusRuntimeCode;
        if (!__nimbusIsCodegenRefusal(e) || !service) throw e;
        const params = args.slice(0, -1).map(String);
        const body = args.length > 0 ? String(args[args.length - 1]) : "";
        try {
          const fn = service.compileFunction(kind, params, body, origin(routed));
          // A subclass's \`new\` (\`class F extends Function\`) makes an instance of the subclass.
          if (new.target !== undefined && new.target !== routed) {
            const proto = new.target.prototype;
            if (proto !== null && (typeof proto === "object" || typeof proto === "function")) Object.setPrototypeOf(fn, proto);
          }
          return fn;
        } catch (refusal) {
          const importAt = params.indexOf("__vite_ssr_import__");
          if (kind !== "async" || importAt < 0 || !refusal || refusal.code !== "ERR_NIMBUS_CODE_NEXT_LAUNCH") throw refusal;
          // The refusal is already recorded for the next launch. Before
          // failing, run the module's hoisted imports through the runner's
          // own import function, so their code is recorded in this launch.
          const imports = viteHoistedImports(body);
          return async function (...values) {
            const load = values[importAt];
            if (typeof load === "function") {
              for (const [source, metadata] of imports) {
                try { await load(source, metadata); } catch {}
              }
            }
            throw refusal;
          };
        }
      }
    };
    // Made as each module's code origin is, after the program ran: through the launch's captures.
    // A function's own name and length stay configurable, as the definitions they replace leave them.
    __nimbusDefine(routed, "name", __nimbusData(Native.name, false, false, true));
    __nimbusDefine(routed, "length", __nimbusData(Native.length, false, false, true));
    __nimbusDefine(routed, "prototype", __nimbusData(Native.prototype, false, false, false));
    __nimbusDefine(routed, "__nimbusNative", __nimbusData(Native, false, false, false));
    __nimbusDefine(routed, "toString", __nimbusData(() => __nimbusApply(nativeToString, Native, []), true, false, true));
    __nimbusPrimordials.reflectSetPrototypeOf(routed, __nimbusPrimordials.reflectGetPrototypeOf(Native));
    return routed;
  };
  const nativeFunction = Function.__nimbusNative ?? Function;
  for (const [kind, Native] of kinds) {
    if (Native.__nimbusNative) continue;
    const routed = routedConstructor(kind, Native, (constructor) => callerOrigin(constructor));
    Object.defineProperty(Native.prototype, "constructor", { value: routed, writable: true, configurable: true, enumerable: false });
    if (kind === "function") globalThis.Function = routed;
  }
  // A refusing origin: code whose import() Node refuses (vm's), or whose
  // caller is no module of the program. Its Function is undefined, its own
  // property, so its code reads and assigns the global's.
  const refusingOrigin = (code, message) => Object.freeze({
    import: () => Promise.reject(Object.assign(new TypeError(message), { code })),
    Function: undefined,
  });
  const unbound = refusingOrigin("ERR_NIMBUS_IMPORT_NO_IMPORTER",
    "import() in code built by a function constructor that no module of the program called (the stack names none) "
    + "has no importer here: Node resolves it against the module that called the constructor. Build the code from "
    + "a module, or import outside it.");
  // Each module's origin (THE WRAPPER): import() against its URL, and a
  // Function of its own whose code keeps the origin. One per URL, so a
  // module's Function is one object for as long as the process runs.
  const origins = new __NimbusSafeMap();
  globalThis.__nimbusCodeOrigin = (importer) => {
    let origin = origins.get(importer);
    if (origin === undefined) {
      const Bound = routedConstructor("function", nativeFunction, () => origin);
      origin = __nimbusFreeze({ import: (specifier, options) => globalThis.__nimbusDynamicImport(importer, specifier, options), Function: Bound });
      origins.set(importer, origin);
    }
    return origin;
  };
  // The module whose code called a constructor that is not its own (the
  // global Function, or one reached through a prototype): Node resolves the
  // built code's import() against it, as V8 hands its host the caller's
  // script. The innermost frame in a module of the program, above the
  // constructor; none (runtime code's, or no module's) is unbound.
  const callerOrigin = (constructor) => {
    try {
      // The interpreter's frames too: a module it evaluates may be the caller.
      const holder = {};
      if (__nimbusInterpreter !== null) {
        // All its frames: the constructor is native, never one of them.
        __nimbusInterpreter.captureStack(holder);
        const stamp = __nimbusInterpretedStacks.get(holder);
        if (stamp !== undefined) stamp.sites = __nimbusStackSites({}, Infinity, constructor);
      }
      for (const site of __nimbusStackSites(holder, Infinity, constructor)) {
        const file = site.getFileName();
        const module = typeof file === "string" ? __nimbusModuleOfFile(file) : null;
        // A map module's path, or the program's entry's file (the stack entry has no map path).
        const path = module === null ? null : module.path ?? (typeof module.file === "string" && module.file.startsWith("/") ? module.file : null);
        if (path !== null) return globalThis.__nimbusCodeOrigin(__nimbusFileUrl(path));
      }
    } catch {}
    return unbound;
  };
  globalThis.__nimbusUnboundOrigin = unbound;
  globalThis.__nimbusVmOrigin = refusingOrigin("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", "A dynamic import callback was not specified.");
})();

const __vmMod = (() => {
  const real = __nativeBuiltin("vm");
  // What a script's function is called with, as the launch starts: the
  // program may later replace Reflect.apply or the globalThis property, and
  // native vm consults neither.
  const apply = Reflect.apply;
  const scriptThis = globalThis;
  function honestError(method, originalErr) {
    const e = nodeError(Error, 'ERR_VM_DYNAMIC_EVAL_DISALLOWED', 'vm.' + method + ': workerd does not implement runtime eval. ' +
      'Pre-bundle vm-using scripts at install time, or wait for W3.5 ' +
      'parser-based fallback. (Original: ' +
      ((originalErr && originalErr.message) || 'no underlying error') + ')');
    return e;
  }
  function wrapRuntimeEval(method) {
    return (...args) => {
      if (typeof real[method] !== 'function') throw honestError(method, null);
      try { return real[method](...args); } catch (e) {
        // Workerd surfaces ERR_METHOD_NOT_IMPLEMENTED;
        // \`new Function\` surfaces "Code generation from strings disallowed".
        if (e && (e.code === 'ERR_METHOD_NOT_IMPLEMENTED'
                  || /not implemented|disallowed|Code generation/i.test(e.message || ''))) {
          throw honestError(method, e);
        }
        throw e;
      }
    };
  }
  return {
    constants: real.constants,
    createContext: (sandbox, opts) => {
      try { return real.createContext(sandbox, opts); }
      catch { return sandbox || {}; }
    },
    isContext: real.isContext,
    runInContext: wrapRuntimeEval('runInContext'),
    runInNewContext: wrapRuntimeEval('runInNewContext'),
    // jiti evaluates a parenthesized (async) CommonJS wrapper expression
    // statement, \`(function (exports, require, ...) { ... });\`. The service
    // stages a script that is one expression as a zero-argument function
    // returning its value (the script's completion value); the wrapper
    // itself executes only when the caller invokes it. The function is
    // called with the global object as \`this\`, which is a script's
    // \`this\` at its top level, strict or not. This is not a vm
    // context or a global-script evaluator: declarations/completion values
    // spanning statements, execution deadlines and context mutation have no
    // equivalent here and remain unsupported.
    runInThisContext: (code, options = {}) => {
      try { return wrapRuntimeEval('runInThisContext')(code, options); }
      catch (e) {
        const service = globalThis.__nimbusRuntimeCode;
        if (e?.code !== 'ERR_VM_DYNAMIC_EVAL_DISALLOWED' || !service
          || options?.timeout !== undefined || options?.breakOnSigint
          || options?.importModuleDynamically || options?.cachedData) throw e;
        // vm's code has no importer: Node refuses its import() (globalThis.__nimbusVmOrigin).
        return apply(service.compileExpression(String(code), globalThis.__nimbusVmOrigin), scriptThis, []);
      }
    },
    // A function of \`params\` and \`code\` is what the Function constructor
    // builds, so a refusal goes to the same runtime-code service. Context
    // extensions and a parsing context have no such form.
    compileFunction: (code, params = [], options = {}) => {
      try {
        return wrapRuntimeEval('compileFunction')(code, params, options);
      } catch (e) {
        const service = globalThis.__nimbusRuntimeCode;
        const refused = e && e.code === 'ERR_VM_DYNAMIC_EVAL_DISALLOWED';
        const plain = !options || (!options.contextExtensions?.length && !options.parsingContext);
        if (!refused || !service || !plain) throw e;
        return service.compileFunction("function", Array.from(params, String), String(code), globalThis.__nimbusVmOrigin);
      }
    },
    Script: real.Script,
    Module: real.Module,
    SourceTextModule: real.SourceTextModule,
    SyntheticModule: real.SyntheticModule,
    measureMemory: real.measureMemory ?? (async () => ({ total: { jsMemoryEstimate: 0 } })),
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  http2 module: Node's exports, no HTTP/2 transport ──────────────
// ═══════════════════════════════════════════════════════════════════════
//
// axios's dist/node code does \`var http2 = require('http2')\` at top
// level, unconditionally, and Astro's dev server asks
// \`res instanceof Http2ServerResponse\` of every response: the module
// loads with every name Node's has, and only opening HTTP/2 refuses.
// core/_shared/http2-module.ts, compiled once by
// scripts/bundle-facet-workers.mjs, declares createHttp2Module; the
// substrate's node-compat imports the same function.
${HTTP2_MODULE_PREAMBLE}
const __http2Mod = createHttp2Module({
  EventEmitter: __eventsMod,
  Readable: __streamMod.Readable,
  Stream: __streamMod,
  Buffer: __BufferMod,
  emitWarning: (message) => {
    const proc = globalThis.process;
    if (proc && typeof proc.emitWarning === "function") proc.emitWarning(message);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// ──  repl module (W3: forward to workerd) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ts-node imports repl. Workerd has it (stub since 2026-03-17).
const __replMod = __nativeBuiltin("repl");

// ═══════════════════════════════════════════════════════════════════════
// ──  diagnostics_channel (W3: forward to workerd) ───────────────────
// ═══════════════════════════════════════════════════════════════════════
// fastify uses Channel.runStores at request-handler time — workerd's
// real impl includes this. Forward whole module.
const __diagChannelMod = __nativeBuiltin("diagnostics_channel");

// ═══════════════════════════════════════════════════════════════════════
// ──  tls module (W3: forward to workerd, override createServer) ─────
// ═══════════════════════════════════════════════════════════════════════
${EGRESS_TLS_CLIENT_SOURCE}
const __tlsMod = (() => {
  const real = __nativeBuiltin("tls");
  // A socket tls.connect opens holds the program until it closes or is
  // unref'd, as in Node. Held once the socket exists: arguments tls.connect
  // refuses (a bad port) throw first, and a caught throw holds nothing.
  // Opening a socket is something a second run would do again
  // (runtime/stop-replay.ts): counted before any I/O.
  const describe = (args) => {
    const first = args[0], second = args[1];
    if (first !== null && typeof first === "object") return String(first.host || first.servername || "") + ":" + String(first.port ?? "");
    return (typeof second === "string" ? second : "") + ":" + String(first ?? "");
  };
  // A run whose network goes through the session (one that can stop at a
  // read of stdin) cannot make TLS itself: workerd's outbound connect does
  // not carry TLS ("Incoming CONNECT with TLS not supported"). Its TLS
  // connections are made by the session (SupervisorRPC.connect): the
  // program's socket is plaintext to the session, named by a token the
  // session maps to the server, and the TLS session with the server is made
  // there when node:tls asks for it (its native socket's startTls). workerd's
  // own TLSSocket still runs on top, so what node:tls offers is what it
  // offers natively, and an option neither path can honour fails by name.
  const realNet = __nativeBuiltin("net");
  const tokens = new WeakMap();
  // The plaintext net.Socket each proxied native socket belongs to.
  const carriers = new WeakMap();
  // What a failed TLS session's error adds, by native socket (options.ca).
  const notes = new WeakMap();
  let startTlsPatched = false;
  const notImplemented = (option, why) => {
    return nodeError(Error, 'ERR_OPTION_NOT_IMPLEMENTED', 'The ' + option + ' option is not implemented: ' + why);
  };
  const patchStartTls = (native) => {
    if (startTlsPatched || !native) return;
    startTlsPatched = true;
    const proto = Object.getPrototypeOf(native);
    const original = proto.startTls;
    Object.defineProperty(proto, 'startTls', { configurable: true, writable: true, value: function startTls(options) {
      const token = tokens.get(this);
      if (token === undefined) return Reflect.apply(original, this, arguments);
      const self = this;
      // workerd's TLSSocket has released the carrier's writer and reader and
      // takes the connection over; the carrier keeps the old handle, and
      // ending or destroying it would use the released writer (a TypeError
      // thrown outside the program's reach) or close the connection under
      // the TLS session. It lets go of it here.
      const carrier = carriers.get(this);
      if (carrier && carrier._handle && carrier._handle.socket === this) carrier._handle = null;
      const servername = options && typeof options.expectedServerHostname === 'string' ? options.expectedServerHostname : undefined;
      // Unref'd: the TLS socket holds the program while it is open (connect
      // below), and one the program destroyed holds nothing.
      const opened = Promise.resolve(self.opened).then(async (info) => {
        const answer = await __nimbusUseRpcResultUnref(
          __supervisor.netTls('upgrade', token, servername === undefined ? {} : { servername }), (result) => result);
        if (!answer || !answer.ok) throw new Error(String((answer && answer.error) || 'the TLS session could not be made') + (notes.get(self) || ''));
        return info;
      });
      opened.catch(() => {});
      return {
        opened, closed: self.closed, readable: self.readable, writable: self.writable,
        secureTransport: 'on', upgraded: false,
        close: (...a) => self.close(...a),
        startTls() { throw new TypeError('Cannot startTls on a TLS socket.'); },
      };
    } });
  };
  const proxiedConnect = (...args) => {
    // tls.connect's forms: (options[, cb]) and (port[, host][, options][, cb]).
    let options = {}, cb;
    if (args[0] !== null && typeof args[0] === 'object') { options = { ...args[0] }; cb = args[1]; }
    else {
      options.port = args[0];
      let i = 1;
      if (typeof args[i] === 'string') options.host = args[i++];
      if (args[i] !== null && typeof args[i] === 'object') Object.assign(options, args[i++]);
      cb = args[i];
    }
    const host = options.host || 'localhost';
    const port = Number(options.port);
    if (options.socket) {
      throw notImplemented('options.socket', 'a TLS session over a socket the program opened is not made in a program whose network goes through Nimbus (one started with its stdin open)');
    }
    for (const name of ['cert', 'key', 'pfx', 'passphrase']) {
      if (options[name] !== undefined) {
        throw notImplemented('options.' + name, 'Nimbus presents no client certificate');
      }
    }
    // A CA the program names is not used, as workerd's own node:tls does not
    // use it: the platform's trust store decides. A server it does not trust
    // fails the TLS session, and the error says the CA went unused.
    const note = options.ca !== undefined || options.secureContext !== undefined
      ? ' (the options.' + (options.ca !== undefined ? 'ca' : 'secureContext') + ' given is not used: Nimbus checks a server against the platform trust store only)'
      : '';
    let token = '';
    for (const b of crypto.getRandomValues(new Uint8Array(16))) token += (b < 16 ? '0' : '') + b.toString(16);
    __nimbusReplay?.effect('tls.connect ' + host + ':' + port);
    const notice = __nimbusReplay && __nimbusReplay.afterBoundary();
    let cancelled = false;
    const registration = notice
      ? Promise.resolve(notice).then(() => cancelled ? undefined : __supervisor.netTls('open', token, { host, port }))
      : Promise.resolve(__supervisor.netTls('open', token, { host, port }));
    let raw, socket;
    const fail = (error) => {
      // Emit the precise refusal on the returned TLS socket, once. Its raw
      // carrier has not opened yet and is only cleaned up, without inventing
      // a second error or waiting for an unregistered token at the outbound.
      socket?.destroy(error);
      raw?.destroy();
    };
    registration.catch(fail);
    __nimbusCarrierOpening = true;
    __nimbusCarrierGate = notice ? registration : null;
    __nimbusCarrierFailure = fail;
    try {
      raw = realNet.connect({ host: token + '.nimbus-net.invalid', port: 1, allowHalfOpen: options.allowHalfOpen === true });
    } finally {
      __nimbusCarrierOpening = false;
      __nimbusCarrierGate = null;
      __nimbusCarrierFailure = null;
    }
    // The carrier's connect waits at a gate (the replay boundary's notice, a raw socket's): it has no handle yet.
    const deferred = raw.connecting && !raw._handle;
    const name = () => {
      // workerd's empty-parent _start listener adopts raw._handle on this
      // same event. Its TLS socket must leave the placeholder connecting
      // state first; native TLS then emits its own connect after upgrading,
      // which releases the native Socket's existing write/end buffers.
      if (deferred && socket && !socket.destroyed) socket.connecting = false;
      const native = raw._handle && raw._handle.socket;
      if (native) { tokens.set(native, token); carriers.set(native, raw); if (note) notes.set(native, note); patchStartTls(native); }
    };
    name();
    raw.once('connect', name);
    socket = real.connect({ ...options, host, port, socket: raw, servername: options.servername ?? host }, cb);
    if (deferred && raw.connecting && !socket.destroyed) socket.connecting = true;
    // The returned TLS socket owns the carrier, including while its native
    // handle has not been created. Cancelling it cancels that pending work.
    const destroy = socket.destroy;
    socket.destroy = function(...args) {
      cancelled = true;
      raw.destroy();
      return Reflect.apply(destroy, this, args);
    };
    return socket;
  };
  const connect = (...args) => {
    const proxied = !!(__nimbusReplay && __nimbusReplay.outbound);
    const egressed = globalThis.__nimbusEgress === true;
    if (egressed || !proxied) __nimbusReplay?.effect("tls.connect " + describe(args));
    const socket = egressed ? __nimbusEgressTlsConnect(real, realNet, args)
      : proxied ? proxiedConnect(...args) : real.connect(...args);
    let closed = false;
    let hold = null;
    socket.once('close', () => { closed = true; hold?.(false); });
    hold = __nimbusHoldSocket();
    const ref = socket.ref, unref = socket.unref;
    socket.ref = function () {
      if (!closed) hold(true);
      if (typeof ref === 'function') Reflect.apply(ref, this, arguments);
      return this;
    };
    socket.unref = function () {
      hold(false);
      if (typeof unref === 'function') Reflect.apply(unref, this, arguments);
      return this;
    };
    return socket;
  };
  // tls.checkServerIdentity is Node's (core _shared/tls-identity.ts):
  // workerd's is an older Node's, which matched '127.1' against a
  // certificate for 127.0.0.1. isIP is Node's own (the vendored
  // lib/internal/net.js), and domainToASCII is workerd's, which runs the
  // algorithm Node's binding runs.
  const checkServerIdentity = createCheckServerIdentity({
    isIP: (input) => __nimbusNodeLib().require("internal/net").isIP(input),
    domainToASCII: (domain) => __urlMod.domainToASCII(domain),
  });
  // Anything else node:tls exports that is called or constructed (a
  // TLSSocket, a server) may open a connection: counted too, all but the
  // helpers that only compute.
  const pure = { createSecureContext: true, getCiphers: true, convertALPNProtocols: true };
  const counted = new Map();
  // tls.createServer in workerd would bind a real port; in a facet we want
  // routing through __portRegistry, so override that one method.
  return new Proxy(real, {
    get(t, p) {
      if (p === 'connect') return connect;
      if (p === 'checkServerIdentity') return checkServerIdentity;
      if (p === 'createServer') {
        return () => {
          throw nodeError(Error, 'ERR_NET_SERVER_NOT_AVAILABLE', 'tls.createServer: not supported in Nimbus facet. Use http.createServer for routing.');
        };
      }
      const value = t[p];
      if (typeof value !== 'function' || typeof p !== 'string' || Object.hasOwn(pure, p)) return value;
      if (!counted.has(p)) {
        counted.set(p, new Proxy(value, {
          apply(target, self, args) { __nimbusReplay?.effect('tls.' + p); return Reflect.apply(target, self, args); },
          construct(target, args, newTarget) {
            if (globalThis.__nimbusEgress === true) {
              throw nodeError(Error, 'ERR_NIMBUS_EGRESS_TLS', ${JSON.stringify(EGRESS_TLS_REFUSAL)});
            }
            if (__nimbusReplay && __nimbusReplay.outbound) {
              throw notImplemented('tls.' + p, 'a TLS socket the program builds itself is not made in a program whose network goes through Nimbus (one started with its stdin open); use tls.connect');
            }
            __nimbusReplay?.effect('new tls.' + p);
            return Reflect.construct(target, args, newTarget === counted.get(p) ? target : newTarget);
          },
        }));
      }
      return counted.get(p);
    }
  });
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  async_hooks module (W3: forward to workerd) ────────────────────
// ═══════════════════════════════════════════════════════════════════════
// AsyncLocalStorage is the 90% case; workerd has it via nodejs_als
// (auto-on at compat date 2026-04-01). createHook is also present
// in workerd as a non-functional stub.
const __asyncHooksMod = __nativeBuiltin("async_hooks");

// ═══════════════════════════════════════════════════════════════════════
// ──  inspector module (forward to workerd) ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// workerd's nodejs_compat exposes node:inspector (Session/console/url).
// The V8 inspector protocol isn't attachable inside a Worker, so a
// constructed Session is inert: connect()/post() resolve/no-op rather
// than driving a real debugger. Tools that import it for optional
// profiling (e.g. nuxi's lockfile timing Session) degrade cleanly.
const __inspectorMod = __nativeBuiltin("inspector");

// ═══════════════════════════════════════════════════════════════════════
// ──  assert module ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
// ──  string_decoder, child_process ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// workerd's node:string_decoder, Node's StringDecoder: hex, base64, latin1
// and UTF-16 as well as UTF-8, a character split across writes held over.
const __stringDecoderMod = __nativeBuiltin("string_decoder");

// ═══════════════════════════════════════════════════════════════════════
// ──  child_process — W8 facet-mapped impl ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// Routes through __supervisor.cp{Spawn,StdinWrite,StdinEnd,ReadOutput,
// DrainOutput,Kill,Wait}. When __supervisor is unavailable (rare — the
// facet is normally instantiated with one), every API surfaces a clean
// ERR_CHILD_PROCESS_UNAVAILABLE error rather than silently returning
// success.
//
// Key differences from the pre-W8 stub:
//   1. spawn() actually spawns. Returns a ChildProcess emitter whose
//      stdio streams are real workerd Readable/Writable instances.
//   2. exec/execFile route through spawn (Node-doc semantics). The
//      callback fires (err, stdout, stderr) once the child exits.
//   3. fork() establishes a JSON-newline IPC channel via the stdin
//      queue. ChildProcess.send(msg)→cpStdinWrite of JSON.stringify(msg)+'\\n'.
//      Phase 1 limit: messages are JSON, NOT v8.serialize. Buffer/Date
//      project to their JSON shapes ({type:'Buffer',data:[...]} and
//      ISO strings respectively). Documented in cp-fork-ipc.mjs probe.
//   4. spawnSync returns a result object that FILLS IN LATER: the spawn is
//      async and the fields land as the child's events fire, so a caller
//      reads status=null until it settles. \`__deferred\` resolves with the
//      completed result and is the contract Nimbus consumers await.
//      execSync/execFileSync cannot offer that — their Node contract is to
//      RETURN the child's stdout — so they refuse instead of lying; see
//      _refuseSyncExec below.
//   5. Live children are tracked in __cpChildren so the facet's exit-
//      time drain (see __cpDrainAllChildren below) can issue a
//      cpDrainOutput RPC for each before reportExit fires. This is
//      the BLOCKER-1 fix from W8-plan §8.5: without it, output from
//      unawaited children dies between the last 'data' poll and the
//      facet's reportExit.
const __cpChildren = new Map();   // pid → ChildProcess (for exit-time drain)
// Pids of this process's children that have exited, so process.kill can
// answer ESRCH for them as Node does (session pids are never reused). Bounded:
// the oldest are forgotten first, and a forgotten pid is an unknown one.
const __cpExitedPids = new Set();
const __CP_EXITED_PIDS_MAX = 1024;

const __childProcessMod = (() => {
  const HAS_SUPERVISOR = !!(__supervisor && typeof __supervisor.cpSpawn === "function");

  /**
   * Child stdout/stderr. Bytes, as Node's: a 'data' listener sees a Buffer
   * until the consumer calls .setEncoding(), which is how a binary protocol
   * (esbuild's service) reads its packets and how a text consumer opts into
   * text. It used to default to utf8 for the cross-spawn / husky pattern;
   * that pattern reads \`String(chunk)\` and works on a Buffer, and the
   * default turned every byte above 0x7f into U+FFFD for everyone else.
   * Flowing-mode resumption and encoding are the Readable base class's job.
   */
  function _makeReadable() {
    return new __streamMod.PassThrough();
  }

  /**
   * Create a workerd-Writable backed by cpStdinWrite RPC.
   *
   * A child's stdin is BYTES. esbuild's service protocol is binary packets,
   * and so is anything piping an image or an archive to a child. The relay
   * used to decode each chunk to a UTF-8 string here, which turned every
   * byte sequence that is not valid UTF-8 into U+FFFD — unrecoverable, and
   * measured at twice the length for a buffer covering all 256 values. The
   * queue and the RPC carry Uint8Array now; text callers encode at this
   * edge, which is the only place that knows it had text.
   */
  function _toBytes(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === "string") return new TextEncoder().encode(chunk);
    return new TextEncoder().encode(String(chunk));
  }
  /**
   * RELEASE ahead of what the child observes this process by: its launch
   * (it reads the files this process wrote, its own script among them) and
   * what this process writes to its stdin. A synchronous
   * write is only parked; without the barrier a child spawned right after
   * \`writeFileSync\` could read the file before the write-back reached the
   * authority, and a child told "ready" on stdin could read the pre-write
   * bytes. Measured: a parent that wrote its child's module and spawned it
   * at once had the child fail \`cannot find module\` (1 run in 5).
   */
  async function _releaseToChild() {
    const release = globalThis.__nimbusVfsReleaseBarrier;
    // A write-back that fails is retained and reported at exit (the write
    // ledger's contract); the child is not the operation to blame for it.
    if (typeof release === "function") { try { await release(); } catch {} }
  }

  function _queueStdinWrite(child, data) {
    if (!child._brokerPid) {
      child._pendingStdin = child._pendingStdin || [];
      child._pendingStdin.push(data);
      return Promise.resolve();
    }
    if (!HAS_SUPERVISOR) return Promise.reject(nodeError(Error, "ERR_CHILD_PROCESS_UNAVAILABLE", "child_process: no supervisor runs this process's children"));
    const prior = child._stdinChain || Promise.resolve();
    const next = prior.then(_releaseToChild).then(() => _writeStdinWhenRoom(child, data));
    child._stdinChain = next.catch(() => {});
    __pendingIO.push(next.catch(() => {}));
    return next;
  }
  // A write goes to the child's queue in pieces no larger than a read takes,
  // and a piece the queue has no room for waits and goes again, as a full
  // pipe holds its writer: one write larger than the queue (256 KiB) is never
  // refused whole, and a parent writing faster than its child reads loses
  // nothing. One the child no longer reads is dropped, as before, and so is
  // one still waiting when this program has ended.
  const __NIMBUS_STDIN_PIECE_BYTES = 64 * 1024;
  async function _writeStdinWhenRoom(child, data) {
    for (let at = 0; at < data.byteLength; at += __NIMBUS_STDIN_PIECE_BYTES) {
      const piece = data.subarray(at, Math.min(data.byteLength, at + __NIMBUS_STDIN_PIECE_BYTES));
      for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
        const answer = await __nimbusUseRpcResult(__supervisor.cpStdinWrite(child._brokerPid, piece), (result) => result);
        if (__nimbusProgramStopped) return;
        if (!answer || (!answer.ok && !answer.full)) throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
        if (answer.ok) break;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  function _queueStdinEnd(child) {
    child._pendingStdinEnd = true;
    if (!child._brokerPid) return Promise.resolve();
    if (!HAS_SUPERVISOR) return Promise.resolve();
    const prior = child._stdinChain || Promise.resolve();
    const next = prior.then(_releaseToChild).then(() =>
      __nimbusUseRpcResult(__supervisor.cpStdinEnd(child._brokerPid), () => undefined)
    );
    child._stdinChain = next.catch(() => {});
    __pendingIO.push(next.catch(() => {}));
    return next;
  }
  function _makeWritable(child) {
    const w = new __streamMod.Writable({
      write(chunk, enc, cb) {
        _queueStdinWrite(child, _toBytes(chunk))
          .then(() => cb())
          .catch((e) => cb(e));
      },
      final(cb) {
        _queueStdinEnd(child)
          .then(() => cb())
          .catch(() => cb()); // best-effort end
      },
    });
    return w;
  }

  /** Normalize stdio config to a 3-tuple of 'pipe'|'ignore'|'inherit'. */
  function _normalizeStdio(stdio) {
    if (!stdio) return ["pipe", "pipe", "pipe"];
    if (Array.isArray(stdio)) {
      const a = stdio.slice(0, 3);
      while (a.length < 3) a.push("pipe");
      return a.map((v) => (v === "ignore" || v === "inherit" || v === "pipe") ? v : "pipe");
    }
    if (stdio === "ignore" || stdio === "inherit" || stdio === "pipe") return [stdio, stdio, stdio];
    return ["pipe", "pipe", "pipe"];
  }

  // An inherited descriptor has no public ChildProcess stream, but its
  // relay writes through the parent's stream just like the parent's own
  // writes. Ending the child closes only this relay, never the parent.
  function _inheritOutput(child, fd) {
    let ended = false;
    return {
      write(bytes) {
        if (ended) return;
        const parent = fd === 1 ? __processMod.stdout : __processMod.stderr;
        if (!parent.write(bytes)) return new Promise((resolve) => parent.once('drain', resolve));
      },
      end() {
        if (ended) return;
        ended = true;
        if (fd === 1) child._stdoutEnded = true;
        else child._stderrEnded = true;
        _maybeFireClose(child);
      },
    };
  }

  // The parent's actual fd 0 (seeded input or the live terminal pump), not
  // an empty spawn payload: a consumer of its own, as the child's inherited
  // descriptor is, its bytes as they came. The private relay remains absent
  // from child.stdin, and relinquishes the input when the child exits.
  function _inheritStdin(child) {
    const relay = new __streamMod.Readable({ read() { __nimbusStdinSource.want(relay); } });
    __nimbusStdinSource.attach(relay);
    let stopped = false;
    relay.on('end', () => { if (!stopped) void _queueStdinEnd(child); });
    relay.on('data', (chunk) => {
      if (stopped) return;
      relay.pause();
      const task = _queueStdinWrite(child, _toBytes(chunk)).then(() => {
        if (!stopped) relay.resume();
      }, (error) => {
        if (!stopped) child.emit('error', error);
      });
      __pendingIO.push(task);
    });
    child.once('exit', () => { stopped = true; relay.destroy(); });
  }

  /** Build a fresh ChildProcess emitter with real streams. */
  function _makeChild(opts) {
    const stdio = _normalizeStdio((opts || {}).stdio);
    const child = new __eventsMod();
    // Published once the child has started (_markSpawned), as Node's is only
    // for a spawn that succeeded; the broker's pid for it is _brokerPid,
    // known as soon as the broker has it (pending admission, or refused).
    child.pid = undefined;
    child._brokerPid = 0;
    child._started = false;
    child.connected = false;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    // Node exposes null for inherited/ignored descriptors. The inherited
    // descriptors nevertheless have private relays to the parent.
    child.stdin  = stdio[0] === 'pipe' ? _makeWritable(child) : null;
    child.stdout = stdio[1] === 'pipe' ? _makeReadable() : null;
    child.stderr = stdio[2] === 'pipe' ? _makeReadable() : null;
    child.stdio = [child.stdin, child.stdout, child.stderr];
    child._stdioModes = stdio;
    child._stdoutSink = child.stdout || (stdio[1] === 'inherit' ? _inheritOutput(child, 1) : null);
    child._stderrSink = child.stderr || (stdio[2] === 'inherit' ? _inheritOutput(child, 2) : null);
    child._pendingKill = null;       // {signal} if kill called before pid
    child._exitFired = false;
    child._closeFired = false;
    child._stdinChain = Promise.resolve();
    child._pendingStdin = [];
    child._pendingStdinEnd = false;
    let _resolveClosePromise;
    child._closePromise = new Promise((resolve) => { _resolveClosePromise = resolve; });
    child._resolveClosePromise = _resolveClosePromise;
    child._closeTracked = false;
    const _trackCloseInterest = (event) => {
      if ((event === "close" || event === "exit") && !child._closeTracked) {
        child._closeTracked = true;
        // Holds this process, as the child's handle does in Node, until the
        // child closes or this process exits (process.exit() does not wait
        // for children). A handle, not output to flush: a resident's boot,
        // which flushes what it wrote, does not wait for its children.
        void _childPoll(Promise.race([child._closePromise, __nimbusProcessExitPromise]), () => undefined).catch(() => {});
      }
    };
    const _childOn = child.on.bind(child);
    const _childOnce = child.once.bind(child);
    child.on = function(event, listener) {
      _trackCloseInterest(event);
      return _childOn(event, listener);
    };
    child.addListener = child.on;
    child.once = function(event, listener) {
      _trackCloseInterest(event);
      return _childOnce(event, listener);
    };
    // Inherited streams must be drained before close too. Only ignored
    // output has no relay to wait for.
    child._stdoutEnded = stdio[1] === 'ignore';
    child._stderrEnded = stdio[2] === 'ignore';
    if (stdio[1] === 'inherit' || stdio[2] === 'inherit') _trackCloseInterest('close');
    // Listen to the underlying streams' 'end' events so 'close' fires
    // only after actual data has flushed; or 'close', for a stream destroyed
    // before its end (a pipeline's failing sink), as Node counts its pipes'.
    if (child.stdout) {
      const done = () => { child._stdoutEnded = true; _maybeFireClose(child); };
      child.stdout.on("end", done);
      child.stdout.on("close", () => { if (!child.stdout.readableEnded) _closeChildOutput(child, 1); done(); });
    }
    if (child.stderr) {
      const done = () => { child._stderrEnded = true; _maybeFireClose(child); };
      child.stderr.on("end", done);
      child.stderr.on("close", () => { if (!child.stderr.readableEnded) _closeChildOutput(child, 2); done(); });
    }

    child.kill = function(signal) {
      // Node semantics: a child that has exited has no handle to signal,
      // so kill() returns false and \`killed\` stays as it was. Before the
      // pid is known the kill is queued, and counts as sent.
      const sig = signal || "SIGTERM";
      if (child._exitFired) return false;
      child.killed = true;
      if (!child._brokerPid) { child._pendingKill = { signal: sig }; return true; }
      if (!HAS_SUPERVISOR) return true;
      __pendingIO.push(
        __nimbusUseRpcResult(__supervisor.cpKill(child._brokerPid, sig), () => undefined).catch(() => {}),
      );
      return true;
    };
    child.ref = function() { return child; };
    child.unref = function() { return child; };
    child.disconnect = function() {
      child.connected = false;
      try { child.emit("disconnect"); } catch {}
    };

    return child;
  }

  /**
   * Coalesce the close event: emit only after exit AND both streams
   * have ended. Once close fires, evict the child from __cpChildren so
   * a long-running parent that spawns thousands of children doesn't
   * leak ChildProcess emitters + PassThrough buffers into memory.
   */
  function _maybeFireClose(child) {
    if (child._exitFired && child._stdoutEnded && child._stderrEnded && !child._closeFired) {
      child._closeFired = true;
      try { child.emit("close", child.exitCode, child.signalCode); } catch {}
      try { child._resolveClosePromise({ code: child.exitCode, signal: child.signalCode }); } catch {}
      // Evict from the live-children map after a microtask so any
      // close listeners that re-read child state see consistent values.
      queueMicrotask(() => {
        try {
          if (child._brokerPid) {
            __cpChildren.delete(child._brokerPid);
            __cpExitedPids.add(child._brokerPid);
            if (__cpExitedPids.size > __CP_EXITED_PIDS_MAX) __cpExitedPids.delete(__cpExitedPids.values().next().value);
          }
        } catch {}
      });
    }
  }

  /**
   * Read-loop for a single fd. Long-polls cpReadOutput, pushes chunks
   * into the Readable via .push, handles closure.
   *
   * What the child printed, and that it closed the stream, is news from
   * another process, which may have written files before it printed. So a
   * reply that delivers anything takes the barrier first, and a 'data'
   * handler that reads what the child wrote reads it current. The poll sends
   * this process's ACQUIRE arguments and the reply carries the answer, so the
   * barrier costs no round trip of its own.
   */
  /**
   * One of a child's long polls (its output, its exit): ref'd work, as a
   * Node child's pipes and handle are, and counted as waiting on a child
   * (__nimbusChildOps), which is how the program's event loop tells that
   * waiting on children is all it is doing (__nimbusReportBlockedState).
   */
  async function _childPoll(promise, use) {
    globalThis.__nimbusChildOps = (globalThis.__nimbusChildOps || 0) + 1;
    try { return await __nimbusUseRpcResult(promise, use); }
    finally { globalThis.__nimbusChildOps--; }
  }

  /** A reply's news numbers, applied once its effect has been (__nimbusApplyNews). */
  function _applyNews(r) {
    if (r && Array.isArray(r.news)) globalThis.__nimbusApplyNews(r.news);
  }

  /**
   * Its consumer destroyed the child's stdout or stderr before its end (a
   * pipeline's failing sink): the parent's read end closes, so the child's
   * writes there fail, EPIPE, as they do to a Node pipe with no reader. Sent
   * once the broker knows the child; its read loop sends it otherwise.
   */
  function _closeChildOutput(child, fd) {
    if (!HAS_SUPERVISOR || !child._brokerPid || child._exitFired) return;
    const closed = child._closedOutputs ??= new Set();
    if (closed.has(fd)) return;
    closed.add(fd);
    __nimbusUseRpcResult(__supervisor.cpCloseOutput(child._brokerPid, fd), () => undefined).catch(() => {});
  }

  async function _runReadLoop(child, fd, stream, sinceSeqRef) {
    // Exponential backoff for idle children: start at 100ms, double up
    // to 1500ms cap. Reset to 100ms whenever a chunk arrives. Caps
    // workerd subrequest budget consumption for many concurrent
    // children — a 30-way 'concurrently' would otherwise sustain 60
    // in-flight RPCs at 250ms intervals.
    let backoff = 100;
    const BACKOFF_MAX = 1500;
    while (HAS_SUPERVISOR && child._brokerPid && !child._streamsClosed) {
      if (stream.destroyed) { _closeChildOutput(child, fd); return; }
      try {
        const r = await _childPoll(
          __supervisor.cpReadOutput(child._brokerPid, fd, sinceSeqRef.value, backoff, __nimbusVfsAcquireArgs()),
          (result) => result,
        );
        const chunks = r && Array.isArray(r.chunks) ? r.chunks : [];
        if (chunks.length > 0 || (r && r.closed)) await __nimbusInboundBarrier(r.acquired, true);
        if (chunks.length > 0) {
          backoff = 100;  // reset — child is producing
          // A child that has output has started: 'spawn' and its pid come
          // before its first byte, as in Node.
          _markSpawned(child);
          for (const c of chunks) {
            // Ended by the exit-time drain meanwhile: what is left was its.
            if (stream.writableEnded) return;
            if (stream.destroyed) { _closeChildOutput(child, fd); return; }
            // The queue hands back bytes; a Readable given a string would
            // encode it again.
            const written = stream.write(__BufferMod.from(c.data));
            if (written && typeof written.then === 'function') await written;
            else if (written === false && stream.writableNeedDrain) {
              await new Promise((resolve) => {
                const done = () => { stream.removeListener('drain', done); stream.removeListener('close', done); resolve(); };
                stream.once('drain', done); stream.once('close', done);
              });
            }
            if (typeof c.seq === "number" && c.seq > sinceSeqRef.value) {
              sinceSeqRef.value = c.seq;
            }
          }
        } else {
          backoff = Math.min(backoff * 2, BACKOFF_MAX);
        }
        if (r && r.closed) stream.end();
        _applyNews(r);
        if (r && r.closed) {
          // _stdoutEnded / _stderrEnded flag is set in the stream's
          // 'end' listener (see _makeChild) so 'close' fires AFTER
          // actual data flushes.
          break;
        }
      } catch (e) {
        // RPC failure → close the stream and bail.
        stream.end();
        break;
      }
    }
  }

  /**
   * The child started (the broker admitted it): its pid is published and
   * 'spawn' emitted, once, as Node does for a spawn that succeeded.
   */
  function _markSpawned(child) {
    if (child._started) return;
    child._started = true;
    child.pid = child._brokerPid;
    child.connected = true;
    try { child.emit("spawn"); } catch {}
  }

  /**
   * What a wait answered, applied: the child started; or it ended, by a
   * status or a signal (a child that ended is one that started, so 'spawn'
   * comes first); or its spawn failed, and it never ran. True once the
   * child is settled. Shared by the wait loop and the exit-time drain, so a
   * refusal is reported one way, whichever sees it.
   */
  /**
   * After 'exit', as Node's ChildProcess does (flushStdio): any stdio stream
   * the program has not read is resumed, so its buffered output drains, it
   * ends, and 'close' can follow. On the next turn, so an 'exit' listener
   * still has its chance to start reading. Without it a child that wrote to
   * a stream its parent never read (an error on stderr) exited and never
   * closed, and its parent, waiting for 'close', waited for good.
   */
  function _flushStdio(child) {
    queueMicrotask(() => {
      for (const stream of [child.stdout, child.stderr]) {
        // A stream done with, or one a consumer owns in readable mode (a
        // 'readable' listener, an async iterator), is left as it is, as
        // Node's flushStdio leaves one that is no longer readable or whose
        // readableListening is set: resuming it would hand its next chunks
        // to no one.
        if (!stream || !stream.readable || stream._readableState.readableListening) continue;
        try { stream.resume(); } catch {}
      }
    });
  }

  // Node destroys the parent's pipe to fd0 before announcing the child's
  // exit. A later stdin.end(data) is a write to a destroyed stream, not a
  // fresh RPC to an input reader the session has already removed.
  function _closeChildInput(child) {
    try { child.stdin && child.stdin.destroy(); } catch {}
  }

  function _applyWait(child, r) {
    // Settled already (both the wait loop and the exit-time drain can hear
    // of the same exit or refusal): nothing more to emit.
    if (child._exitFired) return true;
    if (!r) return false;
    if (r.done && r.spawnError) {
      _failSpawn(child, r.spawnError, r.exitCode);
      return true;
    }
    if (r.started || r.done) _markSpawned(child);
    if (!r.done) return false;
    // Node's pair: a status and no signal, or the signal and no status.
    child.exitCode = r.exitCode;
    child.signalCode = r.signal || null;
    child._exitFired = true;
    _closeChildInput(child);
    try { child.emit("exit", r.exitCode, r.signal || null); } catch {}
    _flushStdio(child);
    _maybeFireClose(child);
    return true;
  }

  /**
   * Wait-loop: long-poll cpWait until the child reports its start, then its
   * exit. Applied behind the barrier: a child's exit is how a parent learns
   * the files it wrote are there. Answered on the reply, as for the child's
   * output.
   */
  async function _runWaitLoop(child) {
    while (HAS_SUPERVISOR && child._brokerPid && !child._exitFired) {
      try {
        const r = await _childPoll(
          __supervisor.cpWait(child._brokerPid, 1000, __nimbusVfsAcquireArgs(), child._started),
          (result) => result,
        );
        if (r && (r.done || r.started)) await __nimbusInboundBarrier(r.acquired, true);
        const settled = _applyWait(child, r);
        _applyNews(r);
        if (settled) break;
      } catch (e) {
        // Couldn't wait — synthesize an error exit.
        child.exitCode = 1;
        child._exitFired = true;
        _closeChildInput(child);
        try { child.emit("exit", 1, null); } catch {}
        _flushStdio(child);
        _maybeFireClose(child);
        break;
      }
    }
  }

  /**
   * The child never ran: its spawn failed with errno \`code\` (EAGAIN: the
   * session had no room to start it, and never would). As Node reports a
   * failed spawn: an 'error' event named for the file and the code, no
   * 'exit', no pid, and 'close' with the negative errno as its status once
   * the streams have ended.
   */
  function _failSpawn(child, code, errno) {
    const err = new Error("spawn " + child.spawnfile + " " + code);
    err.errno = errno;
    err.code = code;
    err.syscall = "spawn " + child.spawnfile;
    err.path = child.spawnfile;
    err.spawnargs = child.spawnargs.slice(1);
    __cpChildren.delete(child._brokerPid);
    child.exitCode = errno;
    child._exitFired = true;
    _closeChildInput(child);
    try { child.emit("error", err); } catch {}
    try { child._stdoutSink && child._stdoutSink.end(); } catch {}
    try { child._stderrSink && child._stderrSink.end(); } catch {}
    // As Node's onexit for a spawn that failed: the streams drain, so they end.
    _flushStdio(child);
    _maybeFireClose(child);
  }

  /**
   * Internal spawn primitive. Always returns a ChildProcess emitter;
   * any failure (no supervisor, bad cmd) surfaces via 'error' + 'exit'
   * events, never a synchronous throw.
   */
  function _spawn(cmd, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || [];
    opts = opts || {};
    const child = _makeChild(opts);
    child.spawnfile = String(cmd);
    child.spawnargs = [String(cmd), ...args.map(String)];
    // \`timeout\`: ended with \`killSignal\` once it has run that long, as Node's spawn does.
    if (opts.timeout > 0) {
      let timer = setTimeout(() => {
        timer = null;
        child._timedOut = true;
        child.kill(opts.killSignal);
      }, opts.timeout);
      const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
      child.once("exit", clear);
      child.once("error", clear);
    }

    if (!HAS_SUPERVISOR) {
      queueMicrotask(() => {
        const err = nodeError(Error, "ERR_CHILD_PROCESS_UNAVAILABLE", "child_process: no supervisor runs this process's children", { cmd });
        try { child.emit("error", err); } catch {}
        child._exitFired = true;
        child.exitCode = 1;
        _closeChildInput(child);
        try { child.emit("exit", 1, null); } catch {}
        // End the streams synchronously; their 'end' listeners flip the
        // _stdoutEnded/_stderrEnded flags and trigger _maybeFireClose.
        try { child._stdoutSink && child._stdoutSink.end(); } catch {}
        try { child._stderrSink && child._stderrSink.end(); } catch {}
        _flushStdio(child);
        _maybeFireClose(child);
      });
      return child;
    }

    // A child is started as spawn() returns, whenever its cpSpawn is sent: a
    // run started again would start it again.
    __nimbusReplay?.effect("cpSpawn " + cmd);
    // Issue cpSpawn asynchronously. Return the emitter immediately so
    // callers can attach 'data' listeners before any chunk arrives.
    __pendingIO.push((async () => {
      try {
        await _releaseToChild();
        const r = await __nimbusUseRpcResult(
          __supervisor.cpSpawn({
            command: cmd,
            args,
            env: { ...(__processMod.env || {}), ...(opts.env || {}) },
            cwd: opts.cwd || cwd || "/home/user",
            // Node has already buffered stdin in the guest. Its inherited
            // descriptor is a byte source into the SAME broker pipe, whereas
            // a WASI fd is inherited directly from the supervisor channel.
            stdio: child._stdioModes[0] === 'inherit' ? ['pipe', ...child._stdioModes.slice(1)] : child._stdioModes,
            detached: !!opts.detached,
            shell: opts.shell || false,
          }),
          (result) => result,
        );
        // The broker has the child; it starts once it is admitted, and its
        // wait loop says so (_markSpawned), or that it was refused.
        child._brokerPid = r.childPid;
        __cpChildren.set(child._brokerPid, child);

        // Flush any stdin written before pid was known, preserving
        // write-before-end ordering for common child.stdin.write();
        // child.stdin.end() patterns. It heads the stdin chain, so what is
        // written once the pid is known goes after it, and each write waits
        // for room in the child's queue rather than being dropped. Not
        // awaited here: the child's output is not held behind a slow reader.
        const pendingStdin = child._pendingStdin ? child._pendingStdin.splice(0) : [];
        const endBeforePid = child._pendingStdinEnd === true;
        if (pendingStdin.length > 0 || endBeforePid) {
          const flushed = (async () => {
            await _releaseToChild();
            for (const d of pendingStdin) await _writeStdinWhenRoom(child, d).catch(() => {});
            if (endBeforePid) {
              await __nimbusUseRpcResult(__supervisor.cpStdinEnd(child._brokerPid), () => undefined).catch(() => {});
            }
          })();
          child._stdinChain = flushed;
          __pendingIO.push(flushed);
        }

        // Flush a queued kill if .kill() was called before pid landed.
        if (child._pendingKill) {
          const sig = child._pendingKill.signal;
          child._pendingKill = null;
          __pendingIO.push(__nimbusUseRpcResult(
            __supervisor.cpKill(child._brokerPid, sig),
            () => undefined,
          ).catch(() => {}));
        }

        // Both piped and inherited output have read loops; the latter use
        // private sinks and finish without ending the parent's streams.
        if (child._stdioModes[0] === 'inherit') _inheritStdin(child);
        else if (child._stdioModes[0] === 'ignore') await _queueStdinEnd(child);
        const stdoutSeq = { value: 0 };
        const stderrSeq = { value: 0 };
        if (child._stdoutSink) void _runReadLoop(child, 1, child._stdoutSink, stdoutSeq);
        if (child._stderrSink) void _runReadLoop(child, 2, child._stderrSink, stderrSeq);
        void _runWaitLoop(child);
      } catch (e) {
        // The broker refused the spawn with an errno (EAGAIN at the depth
        // cap): a failed spawn, reported as the session's refusal is.
        if (e && typeof e.code === "string" && typeof e.errno === "number") {
          _failSpawn(child, e.code, e.errno);
          return;
        }
        try { child.emit("error", e); } catch {}
        child._exitFired = true;
        _closeChildInput(child);
        try { child.emit("exit", 1, null); } catch {}
        try { child._stdoutSink && child._stdoutSink.end(); } catch {}
        try { child._stderrSink && child._stderrSink.end(); } catch {}
        _maybeFireClose(child);
      }
    })());

    return child;
  }

  /**
   * The callback of exec and execFile, as Node's: once, with no error when
   * the child exited 0, else an error saying how it ended (\`code\`, or
   * \`signal\` and no code; \`killed\` when it was killed), and the spawn's
   * own error when it never ran. \`cmd\` is the command line, as Node joins it.
   */
  function _execCallback(child, cmd, cb) {
    let stdout = "", stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => { stdout += String(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += String(d); });
    let spawnError = null;
    let done = false;
    // Use 'close' (fires after exit AND both stdio streams ended) so all
    // chunks have landed before cb resolves.
    child.on("error", (e) => { spawnError = e; });
    child.on("close", (code, signal) => {
      if (done || !cb) return;
      done = true;
      if (spawnError) {
        spawnError.cmd = cmd;
        cb(spawnError, stdout, stderr);
      } else if (code === 0 && signal === null) {
        cb(null, stdout, stderr);
      } else {
        // stdout and stderr ride on it too, as util.promisify(exec)'s rejection carries them.
        const err = Object.assign(new Error("Command failed: " + cmd + "\\n" + stderr), {
          code, killed: child.killed, signal, cmd, stdout, stderr,
        });
        cb(err, stdout, stderr);
      }
    });
  }

  /**
   * exec(cmd, opts, cb) — Node semantics: passes cmd to a shell
   * (we use 'sh -c'). Buffers stdout/stderr; cb fires once on close.
   */
  function exec(cmd, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    // Use sh -c so shell metacharacters work for husky/concurrently/etc.
    const child = _spawn("sh", ["-c", cmd], { ...opts, shell: true });
    _execCallback(child, String(cmd), cb);
    return child;
  }

  /**
   * execFile(file, args, opts, cb) — like exec but no shell.
   */
  function execFile(file, args, opts, cb) {
    if (typeof args === "function") { cb = args; args = []; opts = {}; }
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    args = args || [];
    const child = _spawn(file, args, { ...opts, shell: false });
    _execCallback(child, [String(file), ...args.map(String)].join(" "), cb);
    return child;
  }
  // util.promisify's (lib/child_process.js customPromiseExecFunction): its
  // stdout and stderr, or the error with both; the child is the promise's.
  for (const fn of [exec, execFile]) {
    Object.defineProperty(fn, Symbol.for("nodejs.util.promisify.custom"), {
      enumerable: false,
      value: { [fn.name](...args) {
        let resolve;
        let reject;
        const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
        promise.child = fn(...args, (err, stdout, stderr) => {
          if (err !== null) {
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
          } else {
            resolve({ stdout, stderr });
          }
        });
        return promise;
      } }[fn.name],
    });
  }

  /**
   * Fake-sync spawn. Phase-1 limit: V8/Workers can't truly block JS
   * execution. We approximate "synchronous" semantics by:
   *   1. Issuing the underlying _spawn (which queues async work onto
   *      __pendingIO).
   *   2. Returning a result object that LAZILY accumulates fields as
   *      stdout/stderr/exit events fire. Callers like cross-spawn.sync
   *      that read result.status get null until the spawn settles.
   *   3. When the parent facet's main drain settles __pendingIO before
   *      reportExit (facets/manager.ts), the result object's fields are
   *      filled in by the time the supervisor sees the parent exit.
   *
   * Cross-spawn.sync's typical pattern is "const r = spawnSync(...);
   * if (r.status !== 0) throw". To make THIS work synchronously, we
   * also expose a .__deferred promise; idiomatic Nimbus consumers
   * await r.__deferred to get a fully-populated result. Probes test
   * both shapes.
   *
   * Real Node spawnSync truly blocks the event loop via libuv; matching
   * that semantic in workerd would require Atomics.wait on shared state
   * which workerd doesn't expose to userland. Phase 1 documents this.
   */
  function spawnSync(cmd, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || []; opts = opts || {};
    const child = _spawn(cmd, args, opts);
    let stdout = "", stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => { stdout += String(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += String(d); });

    const result = { pid: 0, stdout: "", stderr: "", status: null, signal: null, output: [null, "", ""] };
    let _done = false;
    // A spawn that failed is the result's \`error\`, named for spawnSync, as Node's.
    let spawnError = null;
    child.on("error", (e) => {
      spawnError = e;
      e.syscall = "spawnSync " + child.spawnfile;
      e.message = "spawnSync " + child.spawnfile + " " + e.code;
    });
    result.__deferred = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        if (spawnError) {
          result.error = spawnError;
          result.output = null;
          result.stdout = null;
          result.stderr = null;
          result.status = null;
          _done = true;
          resolve(result);
          return;
        }
        result.pid = child.pid;
        result.stdout = stdout;
        result.stderr = stderr;
        result.status = code;
        result.signal = signal;
        result.output = [null, stdout, stderr];
        // \`timeout\` ended it: Node's spawnSync says so in \`error\` as well.
        if (child._timedOut) {
          result.error = Object.assign(new Error("spawnSync " + child.spawnfile + " ETIMEDOUT"), {
            errno: -110, code: "ETIMEDOUT", syscall: "spawnSync " + child.spawnfile,
            path: child.spawnfile, spawnargs: child.spawnargs.slice(1),
          });
        }
        _done = true;
        resolve(result);
      });
    });
    // Best-effort eager population: as 'data' events flow we already
    // mutate stdout/stderr above; once 'exit' fires we also populate
    // .status synchronously (before 'close' which fires after streams
    // drain). This narrows the window where a sync caller sees
    // status=null.
    child.on("exit", (code, signal) => {
      if (result.status === null) result.status = code;
      if (result.signal === null) result.signal = signal;
    });
    return result;
  }

  /**
   * execSync/execFileSync return the child's stdout and throw when it exits
   * non-zero — a contract that is only meaningful once the child has run to
   * completion. A facet has no synchronous I/O primitive: every path to a
   * child process is an async supervisor RPC, and JS in workerd cannot block
   * on one. readFileSync answers the same constraint by serving content that
   * was already staged into the facet, but a command's output cannot exist
   * before the command runs, so there is nothing to pre-stage.
   *
   * The pre-fix shim kicked off an async spawn and returned an empty,
   * not-yet-populated result object. Callers — which shell out precisely
   * because they need the result NOW — read a blank stdout, or run their next
   * step before the child has started, and report success. Refusing is the
   * only honest answer left.
   */
  function _refuseSyncExec(api, command) {
    const err = nodeError(Error, "ERR_NIMBUS_SYNC_CHILD_PROCESS", "child_process." + api + " is not supported in a Nimbus node facet: a facet " +
      "has no synchronous I/O primitive, so a child process cannot be run to completion " +
      "without yielding to the event loop. Returning early would report success for a " +
      "command that has not run. Use the asynchronous form instead — exec/execFile/spawn, " +
      "or await util.promisify(child_process.exec)(...). Command: " + command,);
    err.command = command;
    throw err;
  }

  function execSync(cmd, opts) {
    _refuseSyncExec("execSync", String(cmd));
  }

  function execFileSync(file, args, opts) {
    _refuseSyncExec(
      "execFileSync",
      [String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(" "),
    );
  }

  /**
   * fork(modulePath, args, opts) — spawn a child node facet with an IPC
   * channel. IPC is JSON-newline over the stdin queue. Phase-1 limits:
   *   - Buffer → {type:'Buffer', data:[...]} (JSON.stringify projection)
   *   - Date   → ISO string
   *   - Map/Set lose all entries (become {})
   * Documented + asserted in cp-fork-ipc.mjs.
   */
  function fork(modulePath, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || []; opts = opts || {};
    // The child runs the requested module with __NIMBUS_FORK_IPC=1 in env
    // so a corresponding fork-aware runtime in the child knows to listen
    // on stdin for IPC frames.
    const childEnv = { ...(__processMod.env || {}), ...(opts.env || {}), NIMBUS_FORK_IPC: "1" };
    // Node's fork (lib/child_process.js): the child takes options.execArgv,
    // else the parent's process.execArgv, but its -e and the code after it
    // (an eval's own, which would fork the eval again).
    let execArgv = opts.execArgv || __processMod.execArgv;
    if (execArgv === __processMod.execArgv && __processMod._eval != null) {
      const index = execArgv.lastIndexOf(__processMod._eval);
      if (index > 0) {
        execArgv = execArgv.slice();
        execArgv.splice(index - 1, 2);
      }
    }
    const child = _spawn("node", [...execArgv, modulePath, ...args], { ...opts, env: childEnv });
    child.connected = true;
    child.send = function(msg) {
      if (!child.connected) return false;
      if (!child.stdin) return false;
      try {
        const line = JSON.stringify(msg) + "\\n";
        child.stdin.write(line);
        return true;
      } catch (e) {
        return false;
      }
    };
    // 'message' events: parent listens to child.stdout newline-
    // delimited and parses each as JSON. Real Node IPC uses a side-
    // channel fd; Phase 1 multiplexes through stdout. Any well-formed
    // JSON line counts as a message — non-JSON lines are dropped
    // silently (real fork would route them to stderr-style handling).
    // No __nimbusIpc envelope: round-trip is symmetric with the
    // parent's child.send which writes raw JSON.stringify(msg)+'\\n'.
    child.stdout.on("data", (d) => {
      const lines = String(d).split("\\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try { msg = JSON.parse(trimmed); }
        catch { continue; }
        try { child.emit("message", msg); } catch {}
      }
    });
    child.on("exit", () => {
      child.connected = false;
      try { child.emit("disconnect"); } catch {}
    });
    return child;
  }

  /**
   * Exit-time drain: walk __cpChildren and issue cpDrainOutput RPCs so
   * any unawaited children's stdout lands before the facet's reportExit.
   * Called automatically by the facet's exit path AND exposed for tests.
   */
  async function __cpDrainAllChildren() {
    if (!HAS_SUPERVISOR) return;
    const drains = [];
    for (const [pid, child] of __cpChildren) {
      drains.push((async () => {
        try {
          const r = await __nimbusUseRpcResult(
            __supervisor.cpDrainOutput(pid),
            (result) => result,
          );
          // Output means it started: 'spawn' before its first byte.
          if (r && ((r.stdout && r.stdout.byteLength > 0) || (r.stderr && r.stderr.byteLength > 0))) _markSpawned(child);
          // What the pump has not delivered, to a stream still open to it.
          if (r && r.stdout && r.stdout.byteLength > 0 && child.stdout?.writable) {
            child.stdout.write(__BufferMod.from(r.stdout));
          }
          if (r && r.stderr && r.stderr.byteLength > 0 && child.stderr?.writable) {
            child.stderr.write(__BufferMod.from(r.stderr));
          }
          // Force-close streams so listeners receive 'end'. The 'end'
          // event listeners in _makeChild flip _stdoutEnded/_stderrEnded.
          try { child.stdout && child.stdout.end(); } catch {}
          try { child.stderr && child.stderr.end(); } catch {}
          if (!child._exitFired) {
            // No exit reported yet — wait briefly, then synthesize. A start,
            // an exit or a refused spawn the wait reports is applied as the
            // wait loop applies it (_applyWait).
            let settled = false;
            try {
              const w = await __nimbusUseRpcResult(
                __supervisor.cpWait(pid, 500, undefined, child._started),
                (result) => result,
              );
              settled = _applyWait(child, w);
              _applyNews(w);
            } catch { /* synthesized below */ }
            if (!settled) {
              child.exitCode = child.exitCode == null ? 0 : child.exitCode;
              child._exitFired = true;
              _closeChildInput(child);
              try { child.emit("exit", child.exitCode, child.signalCode); } catch {}
              _flushStdio(child);
            }
          }
          _maybeFireClose(child);
        } catch { /* best-effort */ }
      })());
    }
    await Promise.allSettled(drains);
  }

  return {
    spawn: _spawn,
    spawnSync,
    exec,
    execSync,
    execFile,
    execFileSync,
    fork,
    ChildProcess: __eventsMod,
    __cpDrainAllChildren,    // exposed for the facet exit hook + tests
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  console ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Node's Console (lib/internal/console/constructor.js), the one console:
// each method formats its arguments with util.formatWithOptions, in colour
// for a stream that is a terminal with colours (Node's shouldColorize),
// indents the line by its group and writes it through the stream's own
// write. The process's console is one over process.stdout and
// process.stderr, so what it prints is theirs: captured, streamed live,
// nothing once the program stopped. workerd's node:console has no Console
// constructor ("The Console method is not implemented"), which OpenTUI's
// console capture calls over streams of its own.
// Node's colour policy (lib/internal/tty.js getColorDepth and hasColors,
// lib/internal/util/colors.js shouldColorize, v22.23.4), for its platform
// (Nimbus is linux): FORCE_COLOR first, then NODE_DISABLE_COLORS, NO_COLOR and
// TERM=dumb, then the CI and terminal variables. Each stream decides for
// itself: a terminal's getColorDepth reads the env it is given.
const __NIMBUS_TERM_ENVS = {
  eterm: 4, cons25: 4, console: 4, cygwin: 4, dtterm: 4, gnome: 4, hurd: 4, jfbterm: 4, konsole: 4, kterm: 4,
  mlterm: 4, mosh: 24, putty: 4, st: 4, "rxvt-unicode-24bit": 24, terminator: 24, "xterm-kitty": 24,
};
const __NIMBUS_CI_ENVS = [["APPVEYOR", 8], ["BUILDKITE", 8], ["CIRCLECI", 24], ["DRONE", 8], ["GITEA_ACTIONS", 24], ["GITHUB_ACTIONS", 24], ["GITLAB_CI", 8], ["TRAVIS", 8]];
const __NIMBUS_TERM_ENVS_REG_EXP = [/ansi/, /color/, /linux/, /direct/, /^con[0-9]*x[0-9]/, /^rxvt/, /^screen/, /^xterm/, /^vt100/, /^vt220/];
let __nimbusColorWarned = false;
// The warnings Node's console and colour policy emit: process.emitWarning.
function __nimbusEmitWarning(...args) {
  return Reflect.apply(__processMod.emitWarning, __processMod, args);
}
function __nimbusWarnOnDeactivatedColors(env) {
  if (__nimbusColorWarned) return;
  let name = "";
  if (env.NODE_DISABLE_COLORS !== undefined) name = "NODE_DISABLE_COLORS";
  if (env.NO_COLOR !== undefined) {
    if (name !== "") name += "' and '";
    name += "NO_COLOR";
  }
  if (name !== "") {
    __nimbusEmitWarning("The '" + name + "' env is ignored due to the 'FORCE_COLOR' env being set.", "Warning");
    __nimbusColorWarned = true;
  }
}
function __nimbusColorDepth(env = __processMod.env) {
  const hasOwn = (name) => Object.prototype.hasOwnProperty.call(env, name);
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR) {
      case "":
      case "1":
      case "true":
        __nimbusWarnOnDeactivatedColors(env);
        return 4;
      case "2":
        __nimbusWarnOnDeactivatedColors(env);
        return 8;
      case "3":
        __nimbusWarnOnDeactivatedColors(env);
        return 24;
      default:
        return 1;
    }
  }
  if (env.NODE_DISABLE_COLORS !== undefined || env.NO_COLOR !== undefined || env.TERM === "dumb") return 1;
  if (env.TMUX) return 24;
  if (hasOwn("TF_BUILD") && hasOwn("AGENT_NAME")) return 4;
  if (hasOwn("CI")) {
    for (const [name, colors] of __NIMBUS_CI_ENVS) if (hasOwn(name)) return colors;
    if (env.CI_NAME === "codeship") return 8;
    return 1;
  }
  if ("TEAMCITY_VERSION" in env) return /^(9\\.(0*[1-9]\\d*)\\.|\\d{2,}\\.)/.exec(env.TEAMCITY_VERSION) !== null ? 4 : 1;
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      if (!env.TERM_PROGRAM_VERSION || /^[0-2]\\./.exec(env.TERM_PROGRAM_VERSION) !== null) return 8;
      return 24;
    case "HyperTerm":
    case "MacTerm":
      return 24;
    case "Apple_Terminal":
      return 8;
  }
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 24;
  if (env.TERM) {
    if (/truecolor/.exec(env.TERM) !== null) return 24;
    if (/^xterm-256/.exec(env.TERM) !== null) return 8;
    const termEnv = env.TERM.toLowerCase();
    if (__NIMBUS_TERM_ENVS[termEnv]) return __NIMBUS_TERM_ENVS[termEnv];
    if (__NIMBUS_TERM_ENVS_REG_EXP.some((term) => term.exec(termEnv) !== null)) return 4;
  }
  if (env.COLORTERM) return 4;
  return 1;
}
function __nimbusHasColors(count, env) {
  if (env === undefined && (count === undefined || (typeof count === "object" && count !== null))) {
    env = count;
    count = 16;
  } else if (typeof count !== "number") {
    throw invalidArgType("count", "number", count);
  } else if (!Number.isInteger(count) || count < 2 || count > Number.MAX_SAFE_INTEGER) {
    const range = Number.isInteger(count) ? ">= 2 && <= 9007199254740991" : "an integer";
    throw new nodeErrorCodes.ERR_OUT_OF_RANGE("count", range, count);
  }
  return count <= 2 ** __nimbusColorDepth(env);
}
function __nimbusShouldColorize(stream) {
  if (__processMod.env.FORCE_COLOR !== undefined) return __nimbusColorDepth() > 2;
  return Boolean(stream?.isTTY) && (typeof stream.getColorDepth === "function" ? stream.getColorDepth() > 2 : true);
}
// Node's formatTime (lib/internal/util/debuglog.js), for console.time.
function __nimbusFormatTime(ms) {
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (ms >= 1000) {
    if (ms >= 60000) {
      if (ms >= 3600000) {
        hours = Math.floor(ms / 3600000);
        ms = ms % 3600000;
      }
      minutes = Math.floor(ms / 60000);
      ms = ms % 60000;
    }
    seconds = ms / 1000;
  }
  if (hours !== 0 || minutes !== 0) {
    const [whole, fraction] = seconds.toFixed(3).split(".");
    const pad = (n) => String(n).padStart(2, "0");
    const res = hours !== 0 ? hours + ":" + pad(minutes) : minutes;
    return res + ":" + pad(whole) + "." + fraction + " (" + (hours !== 0 ? "h:m" : "") + "m:ss.mmm)";
  }
  if (seconds !== 0) return seconds.toFixed(3) + "s";
  return Number(ms.toFixed(3)) + "ms";
}
// Node's lib/internal/cli_table.js: the head and the columns of cell text, drawn.
function __nimbusTable(head, columns) {
  const renderRow = (row, widths) => {
    let out = "│ ";
    for (let i = 0; i < row.length; i++) {
      out += row[i] + " ".repeat(Math.ceil(widths[i] - __nimbusNodeInspect().getStringWidth(row[i])));
      if (i !== row.length - 1) out += " │ ";
    }
    return out + " │";
  };
  const rows = [];
  const widths = head.map((h) => __nimbusNodeInspect().getStringWidth(h));
  const longest = Math.max(...columns.map((column) => column.length));
  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longest; j++) {
      rows[j] ??= [];
      const value = rows[j][i] = Object.prototype.hasOwnProperty.call(column, j) ? column[j] : "";
      widths[i] = Math.max(widths[i] || 0, __nimbusNodeInspect().getStringWidth(value));
    }
  }
  const divider = widths.map((w) => "─".repeat(w + 2));
  let result = "┌" + divider.join("┬") + "┐\\n" + renderRow(head, widths) + "\\n" + "├" + divider.join("┼") + "┤\\n";
  for (const row of rows) result += renderRow(row, widths) + "\\n";
  return result + "└" + divider.join("┴") + "┘";
}
class __NimbusConsole {
  #stdout;
  #stderr;
  #ignoreErrors;
  #colorMode;
  #inspectOptions;
  #groupIndentation;
  #groupIndent = "";
  #counts = new Map();
  #timers = new Map();
  constructor(options, stderr, ignoreErrors) {
    if (!options || typeof options.write === "function") options = { stdout: options, stderr, ignoreErrors };
    const { stdout: out, stderr: err = out, ignoreErrors: ignore = true, colorMode = "auto", inspectOptions, groupIndentation = 2 } = options;
    for (const [name, stream] of [["stdout", out], ["stderr", err]]) {
      if (!stream || typeof stream.write !== "function") {
        throw nodeError(TypeError, "ERR_CONSOLE_WRITABLE_STREAM", "Console expects a writable stream instance for " + name);
      }
    }
    this.#stdout = () => out;
    this.#stderr = () => err;
    this.#ignoreErrors = ignore;
    this.#colorMode = colorMode;
    this.#inspectOptions = inspectOptions;
    this.#groupIndentation = groupIndentation;
    // Node binds every method to its console, so a method taken off it works.
    for (const key of Object.getOwnPropertyNames(__NimbusConsole.prototype)) {
      if (key !== "constructor" && typeof this[key] === "function") this[key] = this[key].bind(this);
    }
  }
  // The process's console: over whatever process.stdout and process.stderr are when it writes.
  static forProcess(stdout, stderr) {
    const console = new __NimbusConsole({ write() {} });
    console.#stdout = stdout;
    console.#stderr = stderr;
    return console;
  }
  #optionsFor(stream) {
    const color = this.#colorMode === "auto" ? __nimbusShouldColorize(stream) : this.#colorMode;
    const options = this.#inspectOptions;
    if (options) return options.colors === undefined ? { ...options, colors: color } : options;
    return color ? { colors: true } : {};
  }
  #format(stream, args) {
    // Strings with no format directive are joined as formatWithOptions
    // joins them, without loading Node's inspect for a line it never needs.
    if (args.every((arg) => typeof arg === "string") && (args.length < 2 || !args[0].includes("%"))) return args.join(" ");
    return __nimbusNodeInspect().formatWithOptions(this.#optionsFor(stream), ...args);
  }
  #write(stream, string) {
    const indent = this.#groupIndent;
    if (indent.length !== 0) {
      if (string.includes("\\n")) string = string.replace(/\\n/g, "\\n" + indent);
      string = indent + string;
    }
    try {
      stream.write(string + "\\n");
    } catch (e) {
      if (!this.#ignoreErrors) throw e;
    }
  }
  log(...args) { const out = this.#stdout(); this.#write(out, this.#format(out, args)); }
  info(...args) { const out = this.#stdout(); this.#write(out, this.#format(out, args)); }
  debug(...args) { const out = this.#stdout(); this.#write(out, this.#format(out, args)); }
  dirxml(...args) { const out = this.#stdout(); this.#write(out, this.#format(out, args)); }
  warn(...args) { const err = this.#stderr(); this.#write(err, this.#format(err, args)); }
  error(...args) { const err = this.#stderr(); this.#write(err, this.#format(err, args)); }
  dir(object, options) {
    const out = this.#stdout();
    this.#write(out, __nimbusInspect(object, { customInspect: false, ...this.#optionsFor(out), ...options }));
  }
  trace(...args) {
    const err = { name: "Trace", message: this.#format(this.#stderr(), args) };
    Error.captureStackTrace(err, __NimbusConsole.prototype.trace);
    this.error(err.stack);
  }
  assert(expression, ...args) {
    if (expression) return;
    args[0] = "Assertion failed" + (args.length === 0 ? "" : ": " + args[0]);
    Reflect.apply(this.warn, this, args);
  }
  clear() {
    const out = this.#stdout();
    if (!out.isTTY || __processMod.env.TERM === "dumb") return;
    if (typeof out.cursorTo === "function") out.cursorTo(0, 0);
    if (typeof out.clearScreenDown === "function") out.clearScreenDown();
  }
  count(label = "default") {
    label = String(label);
    const count = (this.#counts.get(label) ?? 0) + 1;
    this.#counts.set(label, count);
    this.log(label + ": " + count);
  }
  countReset(label = "default") {
    label = String(label);
    if (!this.#counts.has(label)) {
      __nimbusEmitWarning("Count for '" + label + "' does not exist");
      return;
    }
    this.#counts.delete(label);
  }
  group(...data) {
    if (data.length > 0) Reflect.apply(this.log, this, data);
    this.#groupIndent += " ".repeat(this.#groupIndentation);
  }
  groupCollapsed(...data) { Reflect.apply(this.group, this, data); }
  groupEnd() {
    this.#groupIndent = this.#groupIndent.slice(0, this.#groupIndent.length - this.#groupIndentation);
  }
  time(label = "default") {
    label = String(label);
    if (this.#timers.has(label)) {
      __nimbusEmitWarning("Label '" + label + "' already exists for console.time()");
      return;
    }
    this.#timers.set(label, performance.now());
  }
  timeEnd(label = "default") {
    label = String(label);
    if (this.#timeLog("timeEnd", label, [])) this.#timers.delete(label);
  }
  timeLog(label = "default", ...data) {
    this.#timeLog("timeLog", String(label), data);
  }
  #timeLog(name, label, data) {
    const start = this.#timers.get(label);
    if (start === undefined) {
      __nimbusEmitWarning("No such label '" + label + "' for console." + name + "()");
      return false;
    }
    Reflect.apply(this.log, this, ["%s: %s", label, __nimbusFormatTime(performance.now() - start), ...data]);
    return true;
  }
  // Node's console.table and lib/internal/cli_table.js. A Map or Set
  // iterator is tabled as the object it is: Node previews one without
  // consuming it, which only its internals can.
  table(data, properties) {
    if (properties !== undefined && !Array.isArray(properties)) {
      throw invalidArgType("properties", "Array", properties);
    }
    if (data === null || typeof data !== "object") return this.log(data);
    const options = this.#optionsFor(this.#stdout());
    const show = (v) => __nimbusInspect(v, {
      depth: v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 2 ? -1 : 0,
      maxArrayLength: 3,
      breakLength: Infinity,
      ...options,
    });
    const indexes = (length) => Array.from({ length }, (_, i) => show(i));
    const render = (head, columns) => this.log(__nimbusTable(head, columns));
    if (__realUtil.types.isMap(data)) {
      const keys = [];
      const values = [];
      for (const [k, v] of data) { keys.push(show(k)); values.push(show(v)); }
      return render(["(iteration index)", "Key", "Values"], [indexes(keys.length), keys, values]);
    }
    if (__realUtil.types.isSet(data)) {
      const values = [];
      for (const v of data) values.push(show(v));
      return render(["(iteration index)", "Values"], [indexes(values.length), values]);
    }
    const map = Object.create(null);
    let hasPrimitives = false;
    const primitives = [];
    const indexKeys = Object.keys(data);
    for (let i = 0; i < indexKeys.length; i++) {
      const item = data[indexKeys[i]];
      const primitive = item === null || (typeof item !== "function" && typeof item !== "object");
      if (properties === undefined && primitive) {
        hasPrimitives = true;
        primitives[i] = show(item);
      } else {
        for (const key of properties || Object.keys(item)) {
          map[key] ??= [];
          map[key][i] = (primitive && properties) || !Object.prototype.hasOwnProperty.call(item, key) ? "" : show(item[key]);
        }
      }
    }
    const keys = Object.keys(map);
    const values = Object.values(map);
    if (hasPrimitives) {
      keys.push("Values");
      values.push(primitives);
    }
    keys.unshift("(index)");
    values.unshift(indexKeys);
    return render(keys, values);
  }
  timeStamp() {}
  profile() {}
  profileEnd() {}
}
const __consoleMod = __NimbusConsole.forProcess(() => __processMod.stdout, () => __processMod.stderr);
__consoleMod.Console = __NimbusConsole;

// ═══════════════════════════════════════════════════════════════════════
// ──  process shim ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __nimbusAttachedTty = env?.NIMBUS_ATTACHED_TTY === "1";
let __nimbusTtyColumns = Number(env && env.COLUMNS) || 80;
let __nimbusTtyRows = Number(env && env.LINES) || 24;
const __nimbusTerminalOutputStreams = [];
function __nimbusClampTerminalCoordinate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}
function __nimbusWriteControl(stream, data, cb) {
  if (stream && typeof stream.write === "function") stream.write(data);
  if (typeof cb === "function") queueMicrotask(cb);
  return true;
}
function __nimbusClearLine(stream, dir, cb) {
  const n = Number(dir);
  const mode = n < 0 ? 1 : n > 0 ? 0 : 2;
  return __nimbusWriteControl(stream, "\\x1b[" + mode + "K", cb);
}
function __nimbusClearScreenDown(stream, cb) {
  return __nimbusWriteControl(stream, "\\x1b[0J", cb);
}
function __nimbusCursorTo(stream, x, y, cb) {
  if (typeof y === "function") {
    cb = y;
    y = undefined;
  }
  const col = __nimbusClampTerminalCoordinate(x) + 1;
  if (y === undefined) return __nimbusWriteControl(stream, "\\x1b[" + col + "G", cb);
  const row = __nimbusClampTerminalCoordinate(y) + 1;
  return __nimbusWriteControl(stream, "\\x1b[" + row + ";" + col + "H", cb);
}
function __nimbusMoveCursor(stream, dx, dy, cb) {
  let out = "";
  const x = Math.trunc(Number(dx) || 0);
  const y = Math.trunc(Number(dy) || 0);
  if (x < 0) out += "\\x1b[" + (-x) + "D";
  else if (x > 0) out += "\\x1b[" + x + "C";
  if (y < 0) out += "\\x1b[" + (-y) + "A";
  else if (y > 0) out += "\\x1b[" + y + "B";
  return __nimbusWriteControl(stream, out, cb);
}
function __nimbusEmitTerminalResize() {
  for (const stream of __nimbusTerminalOutputStreams) {
    try { stream.emit("resize"); } catch {}
  }
}
// The process's live input channel, or 0 when its stdin is the launch's own
// text: the channel the launch was given (a pipe its fd 0 streams through, or
// a resident's start payload: __nimbusLiveInputPid in facets/manager.ts), else
// the child_process child its env names. The launch's own wins: a node that a
// child's script runs reads the script's stdin as the shell handed it, not the
// child's queue it inherited the name of.
function __nimbusLiveInputChannel() {
  const own = typeof __nimbusLiveInputPid === "number" ? __nimbusLiveInputPid : 0;
  return own || (env && env.NIMBUS_CP_CHILD_PID ? Number(env.NIMBUS_CP_CHILD_PID) : 0);
}
// fd 0 of a \`< file\` redirect is the file itself, from the redirect's
// offset (facets/manager.ts, __nimbusStdinFile): read at a position for a
// synchronous read, streamed by process.stdin.
function __nimbusStdinFileSource() {
  return typeof __nimbusStdinFile !== "undefined" && __nimbusStdinFile !== null ? __nimbusStdinFile : null;
}
// What fd 0 holds before the program reads it, taken once by process.stdin's
// first consumer or a synchronous read of fd 0, whichever comes first (the
// two share one fd in Node): the launch's own stdin text; for a live channel
// (a pipe streaming through it, facets/manager.ts _pumpStdinPipe, or a
// child_process child's), what __nimbusPrepareStdin took before the entry ran
// and what __nimbusFollowStdin has taken since; for a \`< file\`, the file from
// its offset. \`ended\` says nothing more will follow.
let __nimbusStdinTaken = false;
let __nimbusQueuedStdin = null;
// A growing fd 0: pieces as they arrive, joined when a read looks.
function __nimbusStdinBuffer() {
  return {
    parts: [], length: 0, flat: null, ended: false,
    get bytes() {
      if (this.flat === null) { this.flat = __BufferMod.concat(this.parts, this.length); this.parts = [this.flat]; }
      return this.flat;
    },
    append(piece) { this.parts.push(piece); this.length += piece.byteLength; this.flat = null; },
  };
}
function __nimbusStdinEnded() {
  // A \`< file\` preloaded up to the read ahead ends there only when the file
  // does; one not preloaded is read whole by path when a synchronous read
  // needs it (__nimbusTakeStdin).
  if (__nimbusStdinFileSource() !== null) return __nimbusQueuedStdin === null || __nimbusQueuedStdin.ended;
  if (!__nimbusLiveInputChannel()) return true;
  return __nimbusQueuedStdin !== null && __nimbusQueuedStdin.ended;
}
// What fd 0 held, once: \`source\` is what reads go on reading (the live
// buffer, still growing, for a live channel).
function __nimbusTakeStdin() {
  const ended = __nimbusStdinEnded();
  if (__nimbusStdinTaken) return { source: { bytes: __BufferMod.alloc(0) }, ended };
  __nimbusStdinTaken = true;
  if (__nimbusQueuedStdin !== null) return { source: __nimbusQueuedStdin, ended };
  const file = __nimbusStdinFileSource();
  if (file !== null) {
    // Not read before the entry ran: the file as the process's own
    // synchronous read of it. One the launch did not stage stops the run, and
    // the next run reads it ahead (FacetManager.exec); a run that cannot stop
    // answers as any unstaged read does.
    __nimbusTakingStdinFile = true;
    try {
      return { source: { bytes: __fsMod.readFileSync(file.path).subarray(file.offset) }, ended };
    } catch (err) {
      if (err && err.code === "EAGAIN") __nimbusStopForStdin("end", "read");
      throw err;
    } finally {
      __nimbusTakingStdinFile = false;
    }
  }
  if (__nimbusLiveInputChannel()) {
    __nimbusQueuedStdin = __nimbusStdinBuffer();
    return { source: __nimbusQueuedStdin, ended };
  }
  return { source: { bytes: __BufferMod.from(typeof stdin === "string" ? stdin : "") }, ended };
}
// The paths that name fd 0.
// A SafeSet: every file read asks it, after the program may have replaced Set.prototype.has.
const __NIMBUS_STDIN_PATHS = new __NimbusSafeSet(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
// Synchronous reads of fd 0 (readSync, readFileSync, fs.read) share one
// position in what fd 0 held, as they do in Node, and process.stdin goes on
// from it (__nimbusStdinRemainder).
let __nimbusSyncStdin = null;
function __nimbusSyncStdinState() {
  if (__nimbusSyncStdin === null) __nimbusSyncStdin = { source: __nimbusTakeStdin().source, pos: 0 };
  return __nimbusSyncStdin;
}
// What process.stdin delivers first: what synchronous reads left of fd 0, or
// all it held when none read it. From here process.stdin reads the channel,
// and the follower hands it whatever it takes after.
function __nimbusStdinRemainder() {
  __nimbusStdinFollower?.handOver();
  if (__nimbusSyncStdin === null) return __nimbusTakeStdin().source.bytes;
  const bytes = __nimbusSyncStdin.source.bytes;
  const rest = bytes.subarray(__nimbusSyncStdin.pos);
  __nimbusSyncStdin.pos = bytes.byteLength;
  return rest;
}
// Whether a read of fd 0 could find it short of what it needs, which makes
// the run one that can stop (runtime/stop-replay.ts): a pipe or a child's
// channel not ended when the program starts, or a \`< file\` not read ahead.
function __nimbusStdinCanStop() {
  if (__nimbusStdinFileSource() !== null) return __nimbusQueuedStdin === null;
  return __nimbusLiveInputChannel() !== 0 && !__nimbusStdinEnded();
}
// A read of fd 0 needs input that has not arrived: \`until\` "end" (all of
// stdin) or "data" (any of it). Node blocks the program until its writer
// gives it. Here the run stops, and the supervisor runs the program again from
// its start once the input is there, replaying what this run drew
// (FacetManager.exec, runtime/stop-replay.ts). When it stops this never
// returns: ctx.abort ends the isolate's JavaScript, so no catch or finally of
// the program runs. It returns why the run cannot stop.
function __nimbusStopForStdin(until, syscall) {
  if (!__nimbusReplay || !__nimbusReplay.armed) return "had not started";
  // process.stdin's pump takes input off the channel as it arrives, which a
  // second run could not be handed back.
  if (__nimbusLiveStdinPump !== null) return "read process.stdin as it arrived first, which a second run could not be handed back";
  return __nimbusReplay.block(until, syscall);
}
function __nimbusSyncStdinError(api, why) {
  // The whole message before the Error is built: its stack, which is what an
  // uncaught error prints, captures the message at construction.
  const file = __nimbusStdinFileSource();
  const err = nodeError(Error, "ERR_NIMBUS_SYNC_STDIN", file !== null && __nimbusQueuedStdin !== null && !__nimbusQueuedStdin.ended
    ? "stdin is a file larger than ${Math.round(STDIN_SYNC_READ_BYTES / 1048576)} MiB, and synchronous reads of it are served from its first ${Math.round(STDIN_SYNC_READ_BYTES / 1048576)} MiB only, so a large redirect is never held whole. Read process.stdin, which streams the file"
    : "fs." + api + "(0) has to wait for stdin, which is still open. Nimbus waits by running the program again from its start once the input is there, but this program " + why + ". Read process.stdin instead: it takes the input as it arrives");
  err.syscall = "read";
  return err;
}
// A read of fd 0 into \`target\`: bytes copied, 0 at its end. With nothing
// there and its writer still open, the run stops until there is
// (__nimbusStopForStdin). A run after a stop returns what each of the stopped
// run's reads returned, in order, then what is there.
function __nimbusReadStdinInto(target, offset, length, syscall) {
  const state = __nimbusSyncStdinState();
  const view = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  const at = Number.isInteger(offset) ? offset : 0;
  const room = Math.max(0, view.byteLength - at);
  const want = Math.min(Number.isInteger(length) ? length : room, room);
  if (want === 0) return 0;
  const bytes = state.source.bytes;
  const available = Math.min(want, bytes.byteLength - state.pos);
  const ended = __nimbusStdinEnded();
  const n = __nimbusReplay ? __nimbusReplay.readSome(available, ended) : (available > 0 || ended ? available : -1);
  if (n < 0) throw __nimbusSyncStdinError("readSync", __nimbusStopForStdin("data", syscall));
  if (n > 0) {
    view.set(bytes.subarray(state.pos, state.pos + n), at);
    state.pos += n;
    __nimbusStdinFollower?.consumed();
  }
  return n;
}
// A live channel's packet as fd 0 takes it: its bytes into \`buffer\`, its
// end, and a terminating signal ends the program as Node's default action
// does (a handler the program installed takes it instead).
function __nimbusStdinPacket(packet, buffer, beforeEntry) {
  if (packet.data && packet.data.byteLength > 0) buffer.append(__BufferMod.from(packet.data));
  if (packet.signal) {
    const sig = String(packet.signal);
    let handled = false;
    if (!beforeEntry) { try { handled = __processMod.emit(sig); } catch {} }
    if (!handled && (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL")) {
      const code = sig === "SIGINT" ? 130 : sig === "SIGKILL" ? 137 : 143;
      __nimbusReportProcessExit(code, sig);
      throw new __ProcessExit(code);
    }
  }
  if (packet.ended) buffer.ended = true;
}
// Read from the live channel before the entry runs: all of it when it has
// ended (\`whole\`, __nimbusStdinWhole: a run after a stop that waited for the
// end of stdin); else at least \`atLeast\` bytes (__nimbusStdinAtLeast: the
// stdin a run after a stop is handed back, however much that is), then what
// the channel holds now, without waiting, up to a bound (an endless writer
// refills the channel as fast as it is read).
const __NIMBUS_QUEUED_STDIN_MAX_BYTES = 1024 * 1024;
async function __nimbusTakeQueuedStdin(whole, atLeast) {
  const pid = __nimbusLiveInputChannel();
  if (!pid || !__supervisor || typeof __supervisor.cpReadStdin !== "function") return;
  const buffer = __nimbusStdinBuffer();
  let failures = 0;
  while (whole || buffer.length < atLeast + __NIMBUS_QUEUED_STDIN_MAX_BYTES) {
    const waits = whole || buffer.length < atLeast;
    let packet;
    try {
      packet = await __nimbusUseRpcResult(
        __supervisor.cpReadStdin(pid, waits ? 1000 : 0),
        (result) => result,
      );
      failures = 0;
    } catch (err) {
      // A dropped supervisor call (the session object reset, a network blip)
      // is retried as the live pump retries it, not taken as the end.
      if (++failures > 10) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!packet) break;
    const hasData = !!(packet.data && packet.data.byteLength > 0);
    __nimbusStdinPacket(packet, buffer, true);
    if (buffer.ended) break;
    if (!waits && !hasData && !packet.signal) break;
  }
  __nimbusQueuedStdin = buffer;
}
// While the program runs, its live channel's input and end keep arriving in
// fd 0 (a long poll, never holding the program open), so a synchronous read
// finds what its writer has written by then, and its end: Node's would.
// Bounded: past __NIMBUS_QUEUED_STDIN_MAX_BYTES more it stops taking, and the
// writer waits for the reader, as a full pipe makes it. Once process.stdin
// reads the channel itself (handOver), what the follower took last is
// process.stdin's.
let __nimbusStdinFollower = null;
function __nimbusFollowStdin(pid) {
  const buffer = __nimbusQueuedStdin;
  let handedOver = false;
  let wake = null;
  const late = [];
  // What fd 0 holds that no read has taken: the follower pauses at the bound
  // and goes on as reads take it (consumed), as a pipe's writer does.
  const unread = () => buffer.length - (__nimbusSyncStdin !== null ? __nimbusSyncStdin.pos : 0);
  const follow = async () => {
    let failures = 0;
    while (!handedOver && !buffer.ended && !__nimbusProgramStopped) {
      if (unread() >= __NIMBUS_QUEUED_STDIN_MAX_BYTES) {
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
        continue;
      }
      let packet;
      try {
        // Unref'd, as process.stdin's pump is: the program is not held open
        // for a stdin it may never read.
        packet = await __nimbusUseRpcResultUnref(__supervisor.cpReadStdin(pid, 1000), (result) => result);
        failures = 0;
      } catch {
        if (++failures > 10) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!packet) return;
      const delivers = !!(packet.data && packet.data.byteLength > 0) || packet.ended || packet.signal;
      if (handedOver) { if (delivers) late.push(packet); return; }
      try { __nimbusStdinPacket(packet, buffer, false); }
      catch (err) { if (err instanceof __ProcessExit) return; throw err; }
    }
  };
  const done = follow().catch(() => {});
  return {
    handOver() { handedOver = true; if (wake) wake(); },
    // A read took bytes: what it took is dropped once it is most of fd 0, and
    // a paused follower goes on below the bound.
    consumed() {
      const state = __nimbusSyncStdin;
      if (state !== null && state.source === buffer && state.pos > __NIMBUS_QUEUED_STDIN_MAX_BYTES && state.pos * 2 > buffer.length) {
        const rest = buffer.bytes.slice(state.pos);
        buffer.parts = [rest];
        buffer.length = rest.byteLength;
        buffer.flat = null;
        state.pos = 0;
      }
      if (wake && unread() < __NIMBUS_QUEUED_STDIN_MAX_BYTES) wake();
    },
    // What it took after the hand-over, once its last poll is in.
    async late() { await done; return late; },
  };
}
// Before the entry runs: what its synchronous reads of fd 0 have in hand.
// A live channel: what it holds (all of it when it has ended, and at least
// what a run after a stop is handed back), then the follower. A \`< file\` a
// run that stopped read synchronously (\`syncRead\`): the file from its
// offset up to the read ahead, read in ranges into one buffer; a larger file
// is never held whole, and process.stdin streams on from there. Any other
// file is read as the program reads it.
async function __nimbusPrepareStdin() {
  const file = __nimbusStdinFileSource();
  if (file !== null) {
    if (!file.syncRead) { await __nimbusUseRpcResult(__supervisor.stdinPrepared(), () => undefined); return; }
    const prepared = await __nimbusUseRpcResult(__supervisor.stdinFileRead(file.path, file.offset, ${STDIN_FILE_READ_PIECE_BYTES}), (r) => r);
    const want = Math.max(0, Math.min(prepared.size - file.offset, ${STDIN_SYNC_READ_BYTES}));
    const bytes = __BufferMod.allocUnsafe(want);
    let got = 0, packet = prepared;
    while (got < want) {
      const n = Math.min(packet.data.byteLength, want - got);
      if (!n) break;
      bytes.set(packet.data.subarray(0, n), got);
      got += n;
      if (got < want) packet = await __nimbusUseRpcResult(__supervisor.stdinFileRead(file.path, file.offset + got, Math.min(${STDIN_FILE_READ_PIECE_BYTES}, want - got)), (r) => r);
    }
    __nimbusQueuedStdin = { bytes: bytes.subarray(0, got), ended: file.offset + got >= prepared.size, from: file.offset + got };
    await __nimbusUseRpcResult(__supervisor.stdinPrepared(), () => undefined);
    return;
  }
  const pid = __nimbusLiveInputChannel();
  if (pid) {
    await __nimbusTakeQueuedStdin(
      typeof __nimbusStdinWhole !== "undefined" && __nimbusStdinWhole === true,
      typeof __nimbusStdinAtLeast === "number" ? __nimbusStdinAtLeast : 0,
    );
    if (__nimbusQueuedStdin !== null && !__nimbusQueuedStdin.ended) __nimbusStdinFollower = __nimbusFollowStdin(pid);
  }
}
// fd 0's one source, and its consumers. The source is what the first
// consumer starts (seed): a \`< file\`'s stream, the live channel's pump, or
// what fd 0 held. Its consumers (process.stdin, each tty.ReadStream, a
// child's inherited fd 0) are Readables of their own, as Node's are separate
// handles on fd 0: each chunk goes to one consumer with a read outstanding
// (flowing, in readable mode, or a paused one's own read()), as a read of one
// fd takes it, and waits here while none has; each sees the end when it reads
// after it. The live channel's
// packets also carry its signals and resizes, so its pump reads on while no
// one reads data. A consumer flowing and referenced holds the input open
// (__nimbusInputHandles), as a reading Node stdin does: pausing, unref'ing,
// ending or destroying one lets go of its own hold, and of nothing else.
function __makeStdinSource() {
  const liveChildPid = __nimbusLiveInputChannel();
  const queue = [];
  const consumers = new Set();
  const pending = new Set();
  const unreferenced = new WeakSet();
  let seeded = false, ended = false, failure = null, fileReader = null, inputHeld = false;
  function update() {
    let held = false;
    if (liveChildPid) {
      for (const c of consumers) {
        if (c.readableFlowing === true && !unreferenced.has(c) && !c.readableEnded && !c.destroyed) { held = true; break; }
      }
    }
    if (held === inputHeld) return;
    inputHeld = held;
    globalThis.__nimbusInputHandles = (globalThis.__nimbusInputHandles || 0) + (held ? 1 : -1);
    if (!held) globalThis.__nimbusHandleReleased?.();
  }
  function deliver() {
    for (const c of pending) {
      if (c.destroyed) pending.delete(c);
      else if (queue.length > 0) { pending.delete(c); c.push(queue.shift()); }
      else if (failure !== null) { pending.delete(c); c.destroy(failure); }
      else if (ended) { pending.delete(c); c.push(null); }
    }
    // A \`< file\` is read as its consumers read it.
    if (fileReader !== null) {
      if (queue.length > 0) fileReader.pause();
      else if (pending.size > 0) fileReader.resume();
    }
    update();
  }
  function write(chunk) { queue.push(chunk); deliver(); }
  function end() { ended = true; deliver(); }
  function fail(error) { failure = error; deliver(); }
  async function pumpLiveStdin() {
    __nimbusStdinPumping = true;
    try {
      await pumpLiveStdinPackets();
    } finally {
      __nimbusStdinPumping = false;
      // Its signals are the signal taker's again once its input has ended.
      if (!__nimbusProgramStopped) __nimbusTakeSignals();
    }
  }
  async function pumpLiveStdinPackets() {
    let readFailures = 0;
    // What fd 0's follower took after process.stdin took the channel over
    // comes first (__nimbusFollowStdin).
    const handedOver = __nimbusStdinFollower !== null ? await __nimbusStdinFollower.late() : [];
    while (liveChildPid && !__nimbusProgramStopped && __supervisor && typeof __supervisor.cpReadStdin === "function") {
      let packet;
      try {
        // Unref'd: this long-poll runs for the whole life of an attached
        // facet, so counting it as in-flight work would mean the entry drain
        // never sees the program finish.
        packet = handedOver.length > 0 ? handedOver.shift() : await __nimbusUseRpcResultUnref(
          __supervisor.cpReadStdin(liveChildPid, 1000, __nimbusVfsAcquireArgs()),
          (result) => result,
        );
        readFailures = 0;
      } catch (pumpErr) {
        // Transient supervisor failure — e.g. the session Durable Object
        // instance was reset mid-flight ("Internal error in Durable Object
        // storage caused object to be reset"). The binding routes by DO id,
        // so the next call lands on the fresh instance; killing the pump
        // (and falsely reporting exit 1) on the first rejection turned a
        // recoverable blip into a dead TUI. Retry with a short pause and
        // give up only on persistent failure.
        readFailures++;
        if (readFailures > 10) throw pumpErr;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      // A packet that delivers anything — input, its end, a signal, a resize
      // — hands the program news from outside it, and whatever sent the news
      // may have written files first (a shell's \`echo v2 > f\` before the
      // keystroke, the editor's save before the signal). So it takes the
      // barrier before any handler sees it. The poll sent this process's
      // ACQUIRE arguments and the packet carries the answer, so a keystroke
      // costs no round trip of its own. An empty poll delivers nothing and
      // costs nothing.
      if (packet && (packet.resize || packet.signal || packet.ended
          || (packet.data && packet.data.byteLength > 0))) {
        await __nimbusInboundBarrier(packet.acquired, true);
      }
      if (packet && packet.resize) {
        __nimbusTtyColumns = Number(packet.resize.columns) || __nimbusTtyColumns;
        __nimbusTtyRows = Number(packet.resize.rows) || __nimbusTtyRows;
        __nimbusEmitTerminalResize();
        try { __processMod.emit("SIGWINCH"); } catch {}
      }
      if (packet && packet.signal) {
        const sig = String(packet.signal);
        let handled = false;
        try { handled = __processMod.emit(sig); } catch {}
        if (!handled && (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL")) {
          const code = sig === "SIGINT" ? 130 : sig === "SIGKILL" ? 137 : 143;
          __nimbusReportProcessExit(code, sig);
          throw new __ProcessExit(code);
        }
      }
      // The queue hands back bytes; a Readable given a string would encode
      // it again.
      if (packet && packet.data && packet.data.byteLength > 0) {
        write(__BufferMod.from(packet.data));
      }
      if (packet && packet.ended) {
        end();
        break;
      }
      // Diagnostic hook (runner-installed, NIMBUS_DIAG_EXEC-gated): the pump's
      // cpReadStdin round-trip is the one I/O yield a resident facet is
      // guaranteed to keep making, so it paces the [oc-mem] sampler even when
      // facet timers starve.
      try { globalThis.__nimbusOcPumpDiag && globalThis.__nimbusOcPumpDiag(); } catch {}
    }
  }
  const seed = () => {
    if (seeded) return;
    seeded = true;
    // A \`< file\` streams from the file itself as the program reads: after
    // what a preload or synchronous reads left, from where that stopped.
    const file = __nimbusStdinFileSource();
    if (file !== null) {
      let from = file.offset;
      if (__nimbusSyncStdin !== null || __nimbusQueuedStdin !== null || __nimbusStdinTaken) {
        const first = __nimbusStdinRemainder();
        if (first.length > 0) write(first);
        if (__nimbusQueuedStdin === null || __nimbusQueuedStdin.ended) {
          queueMicrotask(end);
          return;
        }
        from = __nimbusQueuedStdin.from;
      } else {
        __nimbusStdinTaken = true;
      }
      fileReader = __fsMod.createReadStream(file.path, { start: from, highWaterMark: ${STDIN_FILE_READ_PIECE_BYTES} });
      fileReader.on("data", write);
      fileReader.on("end", end);
      fileReader.on("error", fail);
      deliver();
      return;
    }
    if (liveChildPid && __supervisor && typeof __supervisor.cpReadStdin === "function") {
      // What fd 0 held at the start and synchronous reads left comes first;
      // the pump reads on from there unless that was all of it.
      const first = __nimbusStdinRemainder();
      if (first.length > 0) write(first);
      if (__nimbusStdinEnded()) {
        queueMicrotask(end);
        return;
      }
      const pump = pumpLiveStdin().catch((e) => {
        if (e instanceof __ProcessExit) {
          if (!__nimbusProcessExitReported) {
            try { __nimbusReportProcessExit(e.code, ""); } catch {}
          }
          return;
        }
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        __nimbusReleaseStderr(trace + "\\n");
        const exitGate = __nimbusOutputGate();
        try { Promise.resolve(exitGate).then(() => __nimbusUseRpcResult(__supervisor.reportExit(1, trace + "\\n"), () => undefined)).catch(() => {}); } catch {}
        end();
      });
      __nimbusLiveStdinPump = pump;
      return;
    }
    queueMicrotask(() => {
      // A Buffer, as Node's stdin chunks are: \`s += chunk\` and
      // chunk.toString() read text, where a bare Uint8Array reads "104,105".
      const data = __nimbusStdinRemainder();
      if (data.length > 0) write(data);
      end();
    });
  };
  return {
    seed,
    // A consumer of fd 0: \`stream\`, a Readable whose _read is want's.
    attach(stream) {
      consumers.add(stream);
      const { pause, resume } = stream;
      stream.pause = function() { const out = Reflect.apply(pause, this, arguments); update(); return out; };
      stream.resume = function() { seed(); const out = Reflect.apply(resume, this, arguments); deliver(); return out; };
      stream.ref = function() { unreferenced.delete(stream); update(); return stream; };
      stream.unref = function() { unreferenced.add(stream); update(); return stream; };
      stream.on("end", update);
      stream.on("close", () => { consumers.delete(stream); pending.delete(stream); update(); });
    },
    want(stream) { seed(); pending.add(stream); deliver(); },
  };
}
const __nimbusStdinSource = __makeStdinSource();
function __makeProcessStdin() {
  const r = new __streamMod.Readable({ read() { __nimbusStdinSource.want(r); } });
  __nimbusStdinSource.attach(r);
  // As in Node: readFileSync(process.stdin.fd) reads fd 0.
  r.fd = 0;
  r.isTTY = __nimbusAttachedTty;
  r.isRaw = false;
  r.setRawMode = function(mode) {
    r.isRaw = mode !== false;
    return r;
  };
  r.__nimbusStartLivePump = __nimbusStdinSource.seed;
  const origOn = r.on.bind(r);
  // setEncoding is the Readable's own, as Node's: the chunks pushed are
  // decoded by one StringDecoder (a character split across two is one, a
  // leading U+FEFF is kept), its remainder delivered before 'end'.
  // Only a consumer starts stdin, as in Node: a 'data' or 'readable'
  // listener, resume() or read(). An 'end', 'close' or 'error' listener on
  // paused stdin receives nothing. Vite's dev server registers
  // process.stdin.on("end", closeServerAndExit); seeding on that listener
  // ended stdin at once, and every Vite dev server (Astro's included) shut
  // itself down seconds after it started.
  r.on = function(event, listener) {
    if (event === "data" || event === "readable") __nimbusStdinSource.seed();
    const ret = origOn(event, listener);
    if (event === "data" && typeof listener === "function") {
      try { r.resume(); } catch {}
    }
    return ret;
  };
  r.addListener = r.on;
  return r;
}

function __makeProcessOutputStream(streamName) {
  const stream = new __eventsMod();
  Object.assign(stream, {
    fd: streamName === "stderr" ? 2 : 1,
    isTTY: __nimbusAttachedTty,
    writable: true,
    writableEnded: false,
    writableFinished: false,
    writableLength: 0,
    writableNeedDrain: false,
    writableHighWaterMark: 16 * 1024,
    writableObjectMode: false,
    writableCorked: 0,
    readable: false,
    destroyed: false,
    closed: false,
    errored: null,
    write(d, enc, cb) {
      if (typeof enc === "function") cb = enc;
      if (__nimbusProgramStopped) return true;
      // The reported result is text; decode the bytes at this edge only.
      const s = __nimbusOutText(streamName, __nimbusOutBytes(d, enc));
      if (streamName === "stderr") stderr += s;
      else stdout += s;
      if (typeof cb === "function") queueMicrotask(cb);
      return true;
    },
    // A terminal's colours are Node's policy; a pipe's, none.
    getColorDepth: (env) => __nimbusAttachedTty ? __nimbusColorDepth(env) : 1,
    hasColors: (count, env) => __nimbusAttachedTty ? __nimbusHasColors(count, env) : false,
    clearLine(dir, cb) { return __nimbusClearLine(stream, dir, cb); },
    clearScreenDown(cb) { return __nimbusClearScreenDown(stream, cb); },
    cursorTo(x, y, cb) { return __nimbusCursorTo(stream, x, y, cb); },
    moveCursor(dx, dy, cb) { return __nimbusMoveCursor(stream, dx, dy, cb); },
    end(d, enc, cb) {
      if (d !== undefined && typeof d !== "function") stream.write(d, enc);
      if (typeof d === "function") cb = d;
      if (typeof enc === "function") cb = enc;
      stream.writableEnded = true;
      stream.writableFinished = true;
      if (typeof cb === "function") queueMicrotask(cb);
      stream.emit("finish");
      return stream;
    },
    destroy(err) {
      stream.destroyed = true;
      stream.closed = true;
      stream.errored = err || null;
      if (err) stream.emit("error", err);
      stream.emit("close");
      return stream;
    },
    cork() { stream.writableCorked++; },
    uncork() { if (stream.writableCorked > 0) stream.writableCorked--; },
    ref() { return stream; },
    unref() { return stream; },
  });
  Object.defineProperty(stream, "columns", { enumerable: true, get() { return __nimbusTtyColumns; } });
  Object.defineProperty(stream, "rows", { enumerable: true, get() { return __nimbusTtyRows; } });
  __nimbusTerminalOutputStreams.push(stream);
  return stream;
}

// Every live output stream uses the same Writable accounting. The producer
// gets false at its existing high-water mark and drain only once the
// supervisor/foreground pipe has acknowledged the bytes, not at enqueue.
function __nimbusWriteLiveOutput(streamName, data, encoding, callback, send) {
  if (typeof encoding === 'function') callback = encoding;
  if (__nimbusProgramStopped) return true;
  const bytes = __nimbusOutBytes(data, encoding);
  const stream = __processMod[streamName];
  // Live output belongs to the byte delivery/replay ledger, not also to an
  // unbounded returned-result string. Explicit capture uses its own writer.
  stream.writableLength += bytes.byteLength;
  const ready = stream.writableLength < stream.writableHighWaterMark;
  if (!ready) stream.writableNeedDrain = true;
  const sent = Promise.resolve(send(streamName, bytes));
  stream.__nimbusOutputPending = sent;
  sent.then(() => {
    stream.writableLength -= bytes.byteLength;
    if (typeof callback === 'function') callback();
    if (stream.writableLength === 0 && stream.writableNeedDrain) {
      stream.writableNeedDrain = false;
      stream.emit('drain');
    }
  }, (error) => {
    stream.writableLength -= bytes.byteLength;
    if (typeof callback === 'function') callback(error);
    else stream.emit('error', error);
  });
  return ready;
}

// What output must wait for besides the filesystem's gate: what this process
// says it catches (__nimbusSayCaught), so a "ready" it prints after
// process.on() leaves only once a signal sent then finds it caught. Null when
// nothing is held.
let __nimbusOutputHold = null;
function __nimbusHoldOutput(promise) {
  const held = Promise.all([__nimbusOutputHold, promise]).then(() => {}, () => {});
  __nimbusOutputHold = held;
  held.then(() => { if (__nimbusOutputHold === held) __nimbusOutputHold = null; });
}

// The gate an output or exit leaving the process is released at, taken when
// it is made (ProcessFsClient.effect): null when nothing it logged waits.
// What is held (__nimbusOutputHold) is waited for too; the output is written
// meanwhile, so a run that stops carries it (runtime/stop-replay.ts).
function __nimbusOutputGate() {
  const client = __nimbusProcessFilesystem === null ? null : __nimbusProcessFilesystem.client;
  const gate = client ? client.effect() : null;
  const hold = __nimbusOutputHold;
  if (hold === null) return gate;
  return gate === null ? hold : Promise.all([gate, hold]);
}

// Send a line to the session's stderr for this process, at its gate: every
// diagnostic Nimbus prints for a process, as its own output is. Answers once
// sent (never rejects); the run's pending writes wait for it too.
let __nimbusUnreportedStderr = "";
function __nimbusReleaseStderr(line) {
  if (!__supervisor || typeof __supervisor.stderr !== "function") return Promise.resolve();
  const send = () => __nimbusUseRpcResult(__supervisor.stderr(__nimbusOutEnc.encode(line)), () => undefined);
  const gate = __nimbusOutputGate();
  let task;
  try { task = gate === null ? send() : gate.then(send); } catch { __nimbusUnreportedStderr += line; return Promise.resolve(); }
  task = Promise.resolve(task).catch(() => { __nimbusUnreportedStderr += line; });
  if (typeof __pendingIO !== "undefined" && Array.isArray(__pendingIO)) __pendingIO.push(task);
  return task;
}

function __nimbusReportProcessExit(code, reason) {
  if (__nimbusProcessExitReported) return;
  __nimbusProcessExitCode = Number(code ?? 0) & 255;
  __nimbusProgramStopped = true;
  try { if (typeof globalThis.__nimbusStopProgramTimers === "function") globalThis.__nimbusStopProgramTimers(); } catch {}
  try { if (__nimbusProcessExitResolve) __nimbusProcessExitResolve(__nimbusProcessExitCode); } catch {}
  // Generated lifecycle owners defer the terminal supervisor report until
  // their durability boundary has drained. Reporting here would retire the
  // writer capability before pending sync/append mutations can commit.
  if (
    typeof __nimbusDeferProcessExitReport !== "undefined"
    && __nimbusDeferProcessExitReport
  ) return;
  __nimbusProcessExitReported = true;
  if (__supervisor && typeof __supervisor.reportExit === "function") {
    try {
      const task = __nimbusUseRpcResult(__supervisor.reportExit(code, reason || ""), () => undefined);
      if (Array.isArray(__pendingIO) && task && typeof task.catch === "function") {
        __pendingIO.push(task.catch(() => {}));
      }
    } catch {}
  }
}

// process.setUncaughtExceptionCaptureCallback's function, or null.
let __nimbusExceptionCapture = null;
function __nimbusSignalSelf(signal) {
  const sig = String(signal || "SIGTERM");
  const handled = __processMod.emit(sig);
  if (!handled && (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL")) {
    const code = sig === "SIGINT" ? 130 : sig === "SIGKILL" ? 137 : 143;
    __nimbusReportProcessExit(code, sig);
    throw new __ProcessExit(code);
  }
  return true;
}

// Node's process.emitWarning and the 'warning' listener it installs unless
// told not to (core _shared/node-warning.ts, lifo's node's too): the warning
// is an Error named for its type, emitted on the next tick; the listener
// prints it to stderr, the first time with how to trace it.
const __nimbusWarnings = createProcessWarnings(() => __processMod, (text) => __consoleMod.error(text));
let __processUmask = Number(cred.umask) & 0o777;
// Node's command line, as core runtime/node-cli.ts read it: the options
// before the program are process.execArgv (argv is the program's own), the
// program's own conditions are its resolvers', and -e's code is
// process._eval. A host that passes none runs without them.
const __nimbusNodeCommandLine = typeof nodeCommandLine === "undefined" ? undefined : nodeCommandLine;
const __nimbusExecArgv = Array.isArray(__nimbusNodeCommandLine?.execArgv) ? __nimbusNodeCommandLine.execArgv.map(String) : [];
// --no-experimental-strip-types: TypeScript is JavaScript to the CommonJS
// loader, and has no format to the ES loader.
const __nimbusTypeScriptAsJavaScript = __nimbusNodeCommandLine?.stripTypes === false;
// Node defines EventSource only with --experimental-eventsource; workerd's
// lives on the global scope's prototype.
if (__nimbusNodeCommandLine !== undefined && __nimbusNodeCommandLine !== null && __nimbusNodeCommandLine.experimentalEventSource !== true) {
  for (let scope = globalThis; scope !== null && scope !== Object.prototype; scope = Object.getPrototypeOf(scope)) {
    if (Object.hasOwn(scope, "EventSource")) delete scope.EventSource;
  }
}
const __nimbusConditions = Array.isArray(__nimbusNodeCommandLine?.conditions) ? __nimbusNodeCommandLine.conditions.map(String) : [];
const __nimbusEval = typeof __nimbusNodeCommandLine?.eval === "string" ? __nimbusNodeCommandLine.eval : undefined;
// Node's process: an EventEmitter, its prototype a \`process\` object over
// EventEmitter.prototype (lib/internal/bootstrap/node.js).
const __processMod = Object.setPrototypeOf({
  argv: ["/usr/local/bin/node", ...(argv || [])],
  argv0: "node",
  release: {
    name: "node",
    lts: "Jod",
    sourceUrl: "https://nodejs.org/download/release/" + ${NODE_VERSION_LITERAL} + "/node-" + ${NODE_VERSION_LITERAL} + ".tar.gz",
    headersUrl: "https://nodejs.org/download/release/" + ${NODE_VERSION_LITERAL} + "/node-" + ${NODE_VERSION_LITERAL} + "-headers.tar.gz",
  },
  debugPort: 9229,
  domain: null,
  // The isolate's memory, as os reports it.
  constrainedMemory: () => __osMod.totalmem(),
  availableMemory: () => __osMod.freemem(),
  env: env || {},
  cwd: () => cwd || "/home/user",
  chdir: (d) => { cwd = __pathMod.resolve(cwd || "/home/user", d); },
  // Node's: the code given (or process.exitCode), 'exit' once, with it,
  // and whatever code its listeners leave.
  exit: function exit(code) {
    if (arguments.length !== 0) __processMod.exitCode = code;
    if (!__processMod._exiting) {
      __processMod._exiting = true;
      __nimbusEmitExit(__processMod.exitCode || 0);
    }
    exitCode = __processMod.exitCode || 0;
    __nimbusReportProcessExit(exitCode, "");
    throw new __ProcessExit(exitCode);
  },
  _exiting: false,
  platform: ${JSON.stringify(NODE_SYSTEM.platform)}, arch: ${JSON.stringify(NODE_SYSTEM.arch)},
  version: ${NODE_VERSION_LITERAL}, versions: ${NODE_VERSIONS_LITERAL},
  features: Object.freeze({
    inspector: false,
    debug: false,
    uv: false,
    ipv6: true,
    tls_alpn: true,
    tls_sni: true,
    tls_ocsp: false,
    tls: true,
    openssl_is_boringssl: true,
    ...(__nimbusNodeCommandLine ? { typescript: __nimbusNodeCommandLine.transformTypes ? "transform" : __nimbusNodeCommandLine.stripTypes !== false && "strip" } : {}),
  }),
  getBuiltinModule: (id) => {
    if (typeof id !== "string") throw invalidArgType("id", "string", id);
    const builtin = __nimbusBuiltinId(id);
    return builtin === null ? undefined : builtins[builtin];
  },
  execPath: "/usr/local/bin/node",
  execArgv: __nimbusExecArgv,
  // -e's code, as Node keeps it (fork leaves the -e out of a child's execArgv by it).
  ...(__nimbusEval !== undefined ? { _eval: __nimbusEval } : {}),
  // The pid belongs to the supervisor, not to the host isolate. A constant 1
  // made every new Vinext process claim its predecessor's stale lock.
  get pid() { return typeof __nimbusProcessId === "number" ? __nimbusProcessId : Number(env?.NIMBUS_CP_CHILD_PID || 1); },
  ppid: 0, title: "node",
  stdout: __makeProcessOutputStream("stdout"),
  stderr: __makeProcessOutputStream("stderr"),
  stdin: __makeProcessStdin(),
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  emitWarning: __nimbusWarnings.emitWarning,
  // Seconds since the process started.
  uptime: () => (performance.now() - __nimbusStartedAt) / 1000,
  // The signal syscall process.kill makes (Node's binding): 0, or the errno.
  // This process and its own children are signalled (tree-kill and similar
  // helpers kill a child by its pid); a pid that has exited is ESRCH. Named
  // limit: no other process can be signalled synchronously from here (there
  // is no cross-isolate process table), and that is ENOSYS, not an ESRCH
  // that would tell a lockfile probe a live pid is gone.
  _kill(pid, signum) {
    // Node's binding reads both as int32s.
    pid |= 0;
    signum |= 0;
    const signal = signum === 0 ? 0 : Object.keys(__signalConstants).find((name) => __signalConstants[name] === signum);
    if (signal === undefined) return -__errnoConstants.EINVAL;
    if (pid === __processMod.pid || pid === 0) {
      if (signal !== 0) __nimbusSignalSelf(signal);
      return 0;
    }
    const child = __cpChildren.get(pid);
    if (child !== undefined && !child._exitFired) {
      if (signal !== 0) child.kill(signal);
      return 0;
    }
    if (child !== undefined || __cpExitedPids.has(pid)) return -__errnoConstants.ESRCH;
    return -__errnoConstants.ENOSYS;
  },
  // lib/internal/process/execution.js: the one function an uncaught
  // exception goes to instead of 'uncaughtException', while it is set.
  setUncaughtExceptionCaptureCallback(fn) {
    if (fn === null) {
      __nimbusExceptionCapture = null;
      return;
    }
    if (typeof fn !== "function") throw invalidArgType("fn", ["Function", "null"], fn);
    if (__nimbusExceptionCapture !== null) throw new nodeErrorCodes.ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET();
    __nimbusExceptionCapture = fn;
  },
  hasUncaughtExceptionCaptureCallback: () => __nimbusExceptionCapture !== null,
  getuid: () => Number(cred.uid),
  geteuid: () => Number(cred.uid),
  getgid: () => Number(cred.gid),
  getegid: () => Number(cred.gid),
  getgroups: () => Array.from(cred.groups, Number),
  umask: (mask) => {
    const previous = __processUmask;
    if (mask === undefined) return previous;
    // umask(2) keeps the permission bits of what parseFileMode (node-arguments.ts) takes.
    const next = parseFileMode(mask, "mask") & 0o777;
    __processUmask = next;
    if (__supervisor && typeof __supervisor.setUmask === "function") {
      const task = __nimbusUseRpcResult(__supervisor.setUmask(next), () => undefined);
      if (Array.isArray(__pendingIO)) __pendingIO.push(task);
    }
    return previous;
  },
  // process.binding is a deprecated internal API some bundled legacy
  // packages still read at module init (e.g. minipass, bundled by degit
  // → create-cloudflare, does process.binding('fs') for FS constants).
  // Surface the constants those callers need; reject unknown bindings
  // with the same shape Node uses so anything else fails loudly.
  binding: (name) => {
    if (name === "fs") return { constants: __constantsMod };
    if (name === "constants") {
      return { fs: __constantsMod, os: { errno: __constantsMod, signals: __constantsMod }, crypto: {} };
    }
    // Node's process.binding names no code.
    const err = new Error("No such module: " + name);
    throw err;
  },
}, Object.create(__eventsMod.prototype, {
  constructor: { value: { process() {} }.process, writable: true, enumerable: false, configurable: true },
}));
Reflect.apply(__eventsMod, __processMod, []);
__nimbusFronted(__processMod, __nimbusHostProcess);
// Node's per_thread.js methods (lib/internal/process/per_thread.js
// wrapProcessMethods, and its hrtime, assert, ref and unref) over
// __nimbusProcessMethods, from Node's library when first read; then each a
// plain property, as Node's are.
let __nimbusPerThread;
function __nimbusPerThreadMethods() {
  if (__nimbusPerThread === undefined) {
    const perThread = __nimbusNodeLib().require("internal/process/per_thread");
    __nimbusPerThread = { ...perThread.wrapProcessMethods(__nimbusProcessMethods), perThread };
  }
  return __nimbusPerThread;
}
for (const [name, read] of [
  ["cpuUsage", (m) => m.cpuUsage],
  ["threadCpuUsage", (m) => m.threadCpuUsage],
  ["resourceUsage", (m) => m.resourceUsage],
  ["memoryUsage", (m) => m.memoryUsage],
  ["kill", (m) => m.kill],
  ["_rawDebug", (m) => m._rawDebug],
  ["loadEnvFile", (m) => m.loadEnvFile],
  ["hrtime", (m) => Object.assign(m.perThread.hrtime, { bigint: m.perThread.hrtimeBigInt })],
  ["assert", (m) => __nimbusNodeLib().require("internal/util").deprecate(m.perThread.assert, "process.assert() is deprecated. Please use the \`assert\` module instead.", "DEP0100")],
  ["ref", (m) => m.perThread.ref],
  ["unref", (m) => m.perThread.unref],
]) {
  Object.defineProperty(__processMod, name, {
    get() {
      const value = read(__nimbusPerThreadMethods());
      Object.defineProperty(__processMod, name, { value, writable: true, enumerable: true, configurable: true });
      return value;
    },
    set(value) { Object.defineProperty(__processMod, name, { value, writable: true, enumerable: true, configurable: true }); },
    enumerable: true, configurable: true,
  });
}
// As lib/internal/bootstrap/node.js defines it: built when first read, replaced when set.
Object.defineProperty(__processMod, "allowedNodeEnvironmentFlags", {
  get() {
    const flags = __nimbusPerThreadMethods().perThread.buildAllowedFlags();
    __processMod.allowedNodeEnvironmentFlags = flags;
    return __processMod.allowedNodeEnvironmentFlags;
  },
  set(value) { Object.defineProperty(this, "allowedNodeEnvironmentFlags", { value, configurable: true, enumerable: true, writable: true }); },
  enumerable: true, configurable: true,
});
// The 'warning' listener Node installs (setupWarningHandler), unless warnings are off.
if (__nimbusWarnings.installs) __processMod.on("warning", __nimbusWarnings.onWarning);
// The signals this process catches, as its listeners come and go: the
// session queues each one sent to it (a parent's kill, the shell's, a
// client's) for it to take, where it would otherwise take the signal's
// default action (cpCatchSignals), and this process takes them
// (cpTakeSignal), its handlers deciding what it does, as Node's do. While its
// stdin pump runs, the pump takes them with its input (one waits at a time).
// What it catches is said again until the session has it, and its output
// waits for that: a "ready" it prints after process.on() is seen only once a
// signal sent then finds it caught.
const __nimbusCatchable = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGUSR1", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM"];
let __nimbusCaughtWanted = "";
let __nimbusCaughtSaid = "";
let __nimbusCaughtSaying = null;
let __nimbusSignalTaker = null;
let __nimbusStdinPumping = false;
// A pause no program waits on: the facet's own timer, not the program's.
function __nimbusPause(ms) {
  const schedule = globalThis.__nimbusRawSetTimeout || setTimeout;
  return new Promise((resolve) => { schedule(resolve, ms); });
}
function __nimbusCatchSignals(adding) {
  if (!__supervisor || typeof __supervisor.cpCatchSignals !== "function") return;
  __nimbusCaughtWanted = __nimbusCatchable.filter((sig) => sig === adding || __processMod.listenerCount(sig) > 0).join(",");
  // A run that stops carries them, as its word may not have reached the session.
  if (__nimbusReplay && typeof __nimbusReplay.catches === "function") __nimbusReplay.catches(__nimbusCaughtWanted);
  __nimbusSayCaught();
  __nimbusTakeSignals();
}
function __nimbusSayCaught() {
  if (__nimbusCaughtSaying !== null || __nimbusCaughtWanted === __nimbusCaughtSaid) return;
  const saying = (async () => {
    let failures = 0;
    try {
      while (__nimbusCaughtWanted !== __nimbusCaughtSaid && !__nimbusProgramStopped) {
        const wanted = __nimbusCaughtWanted;
        try {
          await __nimbusUseRpcResultUnref(__supervisor.cpCatchSignals(wanted === "" ? [] : wanted.split(",")), () => undefined);
          __nimbusCaughtSaid = wanted;
          failures = 0;
        } catch (error) {
          if (++failures >= 5) {
            __nimbusReleaseStderr("[nimbus] the session did not take this process's signal handlers (" + ((error && error.message) || String(error))
              + "): a signal sent to it takes its default action\\n");
            return;
          }
          await __nimbusPause(200 * failures);
        }
      }
    } finally {
      // Let go in the same turn as the last look at what is wanted: a listener added after says it afresh.
      __nimbusCaughtSaying = null;
    }
  })();
  __nimbusCaughtSaying = saying;
  __nimbusHoldOutput(saying);
}
// Whether this run has taken back what a stop parked (cpTakeSignal): once, past a replay's boundary, whether its
// signals then come by its own waits or with its stdin.
let __nimbusSignalsTakenBack = false;
function __nimbusTakeSignals() {
  if (__nimbusSignalTaker !== null || __nimbusCaughtWanted === "" || typeof __supervisor.cpTakeSignal !== "function") return;
  if (__nimbusStdinPumping && __nimbusSignalsTakenBack) return;
  __nimbusSignalTaker = (async () => {
    let failures = 0;
    while (__nimbusCaughtWanted !== "" && !__nimbusProgramStopped && !(__nimbusStdinPumping && __nimbusSignalsTakenBack)) {
      // A run after a stop takes no signal before the read the run before it stopped at: that run had none there.
      const crossing = __nimbusReplay && typeof __nimbusReplay.untilBoundary === "function" ? __nimbusReplay.untilBoundary() : null;
      if (crossing) await crossing;
      let sig = null;
      const asked = Date.now();
      try {
        // Unref'd, as the stdin pump's poll: waiting for a signal is no reason to keep the program alive. While the
        // pump reads, it takes them with its input: this asks once, to take back what a stop parked, and is done.
        sig = await __nimbusUseRpcResultUnref(__supervisor.cpTakeSignal(__nimbusStdinPumping ? 0 : 5000), (result) => result);
        __nimbusSignalsTakenBack = true;
        failures = 0;
      } catch {
        if (++failures > 10) return;
        sig = null;
      }
      if (__nimbusProgramStopped) return;
      if (sig === null) {
        if (__nimbusStdinPumping) continue;
        // An answer of none that came at once (the session holds no catches for it, or failed) is asked again a second later, not at once.
        if (Date.now() - asked < 1000) await __nimbusPause(1000);
        continue;
      }
      // Whatever sent it may have written files first, as for a signal the stdin pump delivers.
      await __nimbusInboundBarrier(undefined, true);
      if (__nimbusReplay) __nimbusReplay.unreplayable("took " + sig + ", sent from outside it, which a second run would not be sent again");
      __nimbusSignalSelf(String(sig));
    }
  })().catch((e) => {
    if (e instanceof __ProcessExit) return;
    try { queueMicrotask(() => { throw e; }); } catch {}
  }).finally(() => {
    __nimbusSignalTaker = null;
    // Listeners added while it ended are taken by the next.
    if (!__nimbusProgramStopped) __nimbusTakeSignals();
  });
}
__processMod.on("newListener", (event) => { if (__nimbusCatchable.includes(event)) __nimbusCatchSignals(event); });
__processMod.on("removeListener", (event) => { if (__nimbusCatchable.includes(event)) __nimbusCatchSignals(null); });
// Node's process reads as one: Object.prototype.toString gives "[object
// process]", which axios (utils.kindOf) and others test to pick their Node
// paths (axios: its http adapter rather than its fetch one). As Node defines
// it: an own property, writable, not enumerable, not configurable.
Object.defineProperty(__processMod, Symbol.toStringTag, { value: "process", writable: true, enumerable: false, configurable: false });
// process.exitCode as Node keeps it (lib/internal/bootstrap/node.js): a
// safe integer, or a string whose number is one, held as the int32 the
// process exits with; null and undefined unset it.
let __nimbusExitCodeField;
Object.defineProperty(__processMod, "exitCode", {
  get() { return __nimbusExitCodeField; },
  set(code) {
    if (code === null || code === undefined) {
      __nimbusExitCodeField = undefined;
      return;
    }
    // A non-empty string is its number, unless that is NaN; then
    // validateInteger(value, "code") on what there is.
    let value = code;
    if (typeof code === "string" && code !== "" && Number.isNaN((value = Number(code)))) value = code;
    if (typeof value !== "number") throw invalidArgType("code", "number", value);
    if (!Number.isInteger(value)) throw new nodeErrorCodes.ERR_OUT_OF_RANGE("code", "an integer", value);
    if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) {
      throw new nodeErrorCodes.ERR_OUT_OF_RANGE("code", ">= " + Number.MIN_SAFE_INTEGER + " && <= " + Number.MAX_SAFE_INTEGER, value);
    }
    __nimbusExitCodeField = value | 0;
  },
  enumerable: true,
  configurable: false,
});
// The natural end: 'exit' with process.exitCode, once, and the code its
// listeners leave (Node's EmitProcessExit).
function __nimbusExitAtEnd() {
  if (!__processMod._exiting) {
    __processMod._exiting = true;
    __nimbusEmitExit(__processMod.exitCode || 0);
  }
  return (__processMod.exitCode || 0) & 255;
}

// ── What nothing caught ──
// Node 22.23.4's fatal exception (lib/internal/process/execution.js
// createOnGlobalUncaughtException; lib/internal/process/promises.js
// throwUnhandledRejectionsMode; src/node_errors.cc TriggerUncaughtException,
// ReportFatalException, GetErrorSource): 'uncaughtExceptionMonitor' sees it,
// an 'uncaughtException' listener may take it and the program goes on;
// otherwise 'exit' is emitted with process.exitCode 1, the report goes to
// fd 2 — where it was thrown, the error as util.inspect shows it, Node's
// version — and the process exits with process.exitCode. What an
// 'uncaughtException' listener throws is reported as it is, its stack, and
// the process exits 7. A rejection nothing handles is one, with its reason,
// or Node's UnhandledPromiseRejection for a reason that is not an error.
//
// Where it was thrown is V8's message, which Node reads and a Worker's
// JavaScript cannot: here it is read off the error's stack, as V8 places
// it — for a rejection, its first frame; for an exception, the innermost
// \`throw\` statement around one of its frames, else its first frame — in a
// module of the program (__nimbusModuleOfFile), from the text the module was
// compiled from. Named limits (fine-print capabilities): an error thrown
// inside a builtin, which Node reports at its own library's source line,
// and a value that is not an error or an error thrown away from where it
// was made (\`throw e\`), have no such line or the line it was made at.
let __nimbusFatalStderr = null;
// Node writes its report to fd 2 itself, past whatever a program put in
// process.stderr.write's place: the write the runner installed.
function __nimbusWriteFatal(text) {
  try { (__nimbusFatalStderr ?? ((t) => __processMod.stderr.write(t)))(text); } catch {}
}
// V8's NoSideEffectsToString (objects.cc), for the reason Node names.
function __nimbusNoSideEffectsToString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    try { return Function.prototype.toString.call(value); } catch { return "function () { [native code] }"; }
  }
  if (value === null || typeof value !== "object") return String(value);
  if (__realUtil.types.isProxy(value)) return "#<Object>";
  // A data property, own or inherited, never a getter.
  const dataProperty = (key) => {
    for (let o = value; o !== null; o = Object.getPrototypeOf(o)) {
      if (__realUtil.types.isProxy(o)) return undefined;
      const d = Object.getOwnPropertyDescriptor(o, key);
      if (d) return "value" in d ? d.value : undefined;
    }
    return undefined;
  };
  const toString = dataProperty("toString");
  if (__realUtil.types.isNativeError(value) || toString === Error.prototype.toString) {
    const name = dataProperty("name");
    const message = dataProperty("message");
    const n = typeof name === "string" ? name : "Error";
    const m = typeof message === "string" ? message : "";
    return n === "" ? m : m === "" ? n : n + ": " + m;
  }
  if (toString === Object.prototype.toString) {
    const ctor = dataProperty("constructor");
    if (typeof ctor === "function" && typeof ctor.name === "string" && ctor.name !== "") return "#<" + ctor.name + ">";
  }
  const types = __realUtil.types;
  const builtin = Array.isArray(value) ? "Array" : types.isArgumentsObject(value) ? "Arguments"
    : types.isNativeError(value) ? "Error" : types.isDate(value) ? "Date" : types.isRegExp(value) ? "RegExp"
    : types.isBooleanObject(value) ? "Boolean" : types.isNumberObject(value) ? "Number"
    : types.isStringObject(value) ? "String" : "Object";
  const tag = dataProperty(Symbol.toStringTag);
  return "[object " + (typeof tag === "string" ? tag : builtin) + "]";
}
const __NimbusUnhandledPromiseRejection = class UnhandledPromiseRejection extends Error {
  code = "ERR_UNHANDLED_REJECTION";
  constructor(reason) {
    super("This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason \\"" + __nimbusNoSideEffectsToString(reason) + "\\".");
    this.name = "UnhandledPromiseRejection";
  }
};
// A frame of a stack's text: [url, line, column], or null for one without a
// place (a builtin's).
${NODE_SOURCE_MAPS_SOURCE}
// Node's "Transform Types" warning, once, when its loader first parses
// TypeScript: the entry's, or a module's as it is required (an ES module's
// imports are required before its body, as Node links them first).
let __nimbusTransformTypesWarned = __nimbusNodeCommandLine?.transformTypes !== true;
function __nimbusLoadsTypeScript(path) {
  if (__nimbusTransformTypesWarned || !stripsTypeScript(path) || __nimbusUnderNodeModules(path)) return;
  __nimbusTransformTypesWarned = true;
  __processMod.emitWarning("Transform Types is an experimental feature and might change at any time", "ExperimentalWarning");
}
function __nimbusFrameAt(line) {
  if (!line.startsWith("    at ")) return null;
  let at = line.slice(7);
  if (at.endsWith(")")) {
    const open = at.indexOf(" (");
    if (open !== -1) at = at.slice(open + 2, -1);
  }
  // eval code: \`eval at f (url:1:2), <anonymous>:1:1\`.
  const comma = at.lastIndexOf(", ");
  if (comma !== -1) at = at.slice(comma + 2);
  const place = /^(.*):(\\d+):(\\d+)$/.exec(at);
  return place === null ? null : [place[1], Number(place[2]), Number(place[3])];
}
// Where a frame's column (the source's, past the wrapper's head) is in the module's text.
function __nimbusEmittedColumn(module, line, column) {
  const emitted = __nimbusGeneratedColumn(module, line, column);
  return line === 1 ? emitted + module.head : emitted;
}
// GetErrorSource: \`file:line\`, the line, and under it the place, \`^\` from
// start to end. As Node does, the columns, which are V8's (UTF-16), count
// the line's UTF-8 bytes.
function __nimbusArrowOf(module, text, start, end, empty = false) {
  let lineStart = 0;
  let line = 1;
  for (;;) {
    const next = text.slice(lineStart).search(/\\r\\n|[\\n\\r\\u2028\\u2029]/);
    if (next === -1 || lineStart + next >= start) break;
    lineStart += next + (text.startsWith("\\r\\n", lineStart + next) ? 2 : 1);
    line++;
  }
  const rest = text.slice(lineStart);
  const lineEnd = rest.search(/[\\n\\r\\u2028\\u2029]/);
  let source = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
  let from = start - lineStart;
  let to = end - lineStart;
  if (line === 1) {
    source = source.slice(module.head);
    if (module.hashbang && source.startsWith("//")) source = "#!" + source.slice(2);
    from -= module.head;
    to -= module.head;
  }
  // A staged ES module's line and places as its source has them.
  if (to > from) to = __nimbusSourceColumn(module, line, to);
  from = __nimbusSourceColumn(module, line, from + 1) - 1;
  // At the end of the input V8 underlines nothing (\`empty\`); anywhere else, a character at least.
  if (to <= from) to = empty ? from : from + 1;
  source = __nimbusSourceLine(module, line, source);
  let arrow = __nimbusFrameFile(module) + ":" + line + "\\n" + source + "\\n";
  const bytes = new TextEncoder().encode(source);
  if (from > to || from < 0 || to > bytes.length) return arrow;
  let underline = "";
  for (let i = 0; i < from; i++) underline += bytes[i] === 9 ? "\\t" : " ";
  for (let i = from; i < to; i++) underline += "^";
  return arrow + underline + "\\n";
}
// The offset of 1-based (line, column) in a module's text.
function __nimbusTextOffset(text, line, column) {
  let offset = 0;
  for (let n = 1; n < line; n++) {
    const next = text.slice(offset).search(/\\r\\n|[\\n\\r\\u2028\\u2029]/);
    if (next === -1) return -1;
    offset += next + (text.startsWith("\\r\\n", offset + next) ? 2 : 1);
  }
  return offset + column - 1;
}
// Where V8 places what was thrown, as Node prints it above the error, or null.
function __nimbusFatalArrow(error, fromPromise) {
  // Node's own error for a reason that is not one: its library's line.
  if (error instanceof __NimbusUnhandledPromiseRejection) {
    return "node:internal/process/promises:392\\n      new UnhandledPromiseRejection(reason);\\n      ^\\n";
  }
  if (typeof __nimbusModuleOfFile !== "function") return null;
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  let stack;
  try { stack = error.stack; } catch { return null; }
  if (typeof stack !== "string") return null;
  // A source-mapped stack reads original places; its frames are kept apart.
  const frames = __nimbusGeneratedFrames.get(error)?.filter((frame) => frame[1] !== null) ?? [];
  if (!__nimbusGeneratedFrames.has(error)) {
    for (const line of stack.split("\\n")) {
      const frame = __nimbusFrameAt(line);
      if (frame !== null) frames.push(frame);
    }
  }
  // Thrown by the program, or by a builtin it called: its first frame with a place.
  const top = frames.length === 0 ? null : __nimbusModuleOfFile(frames[0][0]);
  if (top === null) return null;
  const texts = new Map();
  const textOf = (module) => {
    if (!texts.has(module.name)) texts.set(module.name, __nimbusFrameModuleText(module));
    return texts.get(module.name);
  };
  if (!fromPromise && !(top.esModule && typeof top.source === "string")) {
    for (const [file, line, column] of frames) {
      const module = __nimbusModuleOfFile(file);
      const text = module === null ? null : textOf(module);
      if (text === null) continue;
      const offset = __nimbusTextOffset(text, line, __nimbusEmittedColumn(module, line, column));
      const thrown = offset < 0 ? null : __nimbusFatalLocation(text, module.goal, offset);
      if (thrown !== null) return __nimbusSourceMappedArrow(module, text, thrown[0]) ?? __nimbusArrowOf(module, text, thrown[0], thrown[1]);
    }
  }
  const text = textOf(top);
  if (text === null) return null;
  const [, line, column] = frames[0];
  const offset = __nimbusTextOffset(text, line, __nimbusEmittedColumn(top, line, column));
  return offset < 0 ? null : __nimbusSourceMappedArrow(top, text, offset) ?? __nimbusArrowOf(top, text, offset, offset + 1);
}
// Where a module that does not compile stops, for its stack (commonjs-cell.ts
// __nimbusDecorateSyntaxError), or null: -e code or stdin as Node reports it
// (__nimbusEvalArrow).
globalThis.__nimbusSyntaxErrorArrow = function __nimbusSyntaxErrorArrow(module, error) {
  const arrow = __nimbusCompileArrow(module, error);
  return arrow === null ? null : __nimbusEvalArrow(module, arrow);
};
function __nimbusCompileArrow(module, error) {
  const text = module === null ? null : __nimbusFrameModuleText(module);
  const place = text === null ? null : __nimbusFatalLocation(text, module.goal, -1);
  if (place === null) return null;
  if (module.esModule) return __nimbusArrowOf(module, text, place[0], place[1]);
  // A CommonJS cell's source is followed by its wrapper's tail, which V8
  // reads where Node's compile (wrapSafe, the source alone) meets the end of
  // the input: an error found there is the end of input's, as Node reports it.
  const end = text.length - module.tail;
  // V8's end of input is the source's end, nothing underlined.
  if (error?.message === "Unexpected end of input") return __nimbusArrowOf(module, text, end, end, true);
  if (place[0] >= end) {
    const parser = __nimbusRegistryRequire("./${RUNTIME_PARSER_MODULE}");
    const named = error instanceof __nimbusRealmSyntaxError ? /^Unexpected token '(.+)'$/.exec(error.message) : null;
    // An argument list left open is placed at its last token, as V8 places it whatever follows.
    if (error?.message === "missing ) after argument list") {
      const last = parser.lastTokenBefore(text, end);
      if (last !== null) return __nimbusArrowOf(module, text, last[0], last[1]);
    } else if (named?.[1] === "...") {
      // A parenthesized rest no arrow follows: V8 names its ellipsis.
      const rest = parser.openParenRest(text, end);
      if (rest !== null) return __nimbusArrowOf(module, text, rest[0], rest[1]);
    } else if (named !== null && text.slice(end).includes(named[1])) {
      // The tail's token, where the source alone ends: the header of a
      // stack formatted before is renamed, a formatter's own text kept.
      const header = "SyntaxError: " + error.message;
      error.message = "Unexpected end of input";
      if (typeof error.stack === "string" && error.stack.startsWith(header)) error.stack = "SyntaxError: " + error.message + error.stack.slice(header.length);
    }
    return __nimbusArrowOf(module, text, end, end, true);
  }
  // A comment left open runs to the end of the input: V8 underlines it from
  // its start to the end of its line.
  if (text.startsWith("/*", place[0]) && text.indexOf("*/", place[0] + 2) === -1) {
    const line = text.slice(place[0], end).search(/[\\n\\r\\u2028\\u2029]/);
    return __nimbusArrowOf(module, text, place[0], line === -1 ? end : place[0] + line);
  }
  return __nimbusArrowOf(module, text, place[0], place[1]);
}
// -e code or stdin that Node's eval compiled as it was given or stripped
// (NodeLaunch.evalTypeScript): a compile error names the script, not the
// stripper's sourceURL its frames have (__nimbusEvalStripped); code that
// compiles neither as JavaScript nor as TypeScript has amaro's message after
// a script's arrow, a module's a line apart (execution.js evalTypeScript,
// evalTypeScriptModuleEntryPoint).
function __nimbusEvalArrow(module, arrow) {
  const entry = module.path === null || (module.esModule && module.path === "/" + __nimbusEsmEntryKey);
  if (!entry) return arrow;
  const named = module.compileFile === undefined ? arrow : module.compileFile + arrow.slice(__nimbusFrameFile(module).length);
  const hint = __nimbusNodeCommandLine?.evalTypeScript?.hint;
  if (typeof hint !== "string") return named;
  return module.esModule ? named + "\\n" + hint + "\\n" : named + hint + "\\n";
}
// -e code or stdin that Node compiles as a script, with a \`return\` at its
// top (\`at\`, in \`text\`): V8's SyntaxError, its arrow under the \`return\`
// and the script's name, with amaro's message where Node's eval adds it
// (__nimbusEvalArrow), and no frame of the code that throws it (node-eval.ts
// illegalReturn; the entry runs the code as a function's body, where it
// would compile).
function __nimbusEvalIllegalReturn(text, at) {
  const entry = __nimbusEntryModule();
  const error = new __nimbusRealmSyntaxError("Illegal return statement");
  if (entry === null) return error;
  const source = { name: entry.name, path: null, file: __nimbusFrameFile(entry), head: 0, tail: 0, esModule: false, goal: "script", hashbang: false };
  const arrow = __nimbusEvalArrow(entry, __nimbusArrowOf(source, text, at, at + "return".length));
  // A program's Error.prepareStackTrace may make the stack anything: only a
  // string's frames are trimmed, this function's and the code's that throws.
  if (typeof error.stack === "string") error.stack = arrow + "\\n" + error.stack.replace(/(\\n    at [^\\n]*){1,2}/, "");
  __nimbusDecorated.add(error);
  return error;
}
// -e code or stdin as Node's eval stripped it: a strip's frames are named
// by the stripper's sourceURL, [eval], stdin's too (typescript.js
// processTypeScriptCode), a compile error by the script (__nimbusEvalArrow);
// a transform warned of Transform Types, where Node's warning prints.
function __nimbusEvalStripped(module) {
  const typeScript = __nimbusNodeCommandLine?.evalTypeScript;
  if (typeScript?.transformWarning === true && !__nimbusTransformTypesWarned) {
    __nimbusTransformTypesWarned = true;
    __processMod.emitWarning("Transform Types is an experimental feature and might change at any time", "ExperimentalWarning");
  }
  if (typeScript?.sourceUrl !== true || module === null) return;
  module.compileFile = __nimbusFrameFile(module);
  if (module.path === null) module.file = "[eval]";
  else module.frameFile = "[eval]";
  __nimbusModulesByFile?.set("[eval]", module);
}
// ReportFatalException: the text Node prints for \`error\`. \`enhance\`: the
// error as inspect shows it (an 'uncaughtException' listener's error is its
// stack).
function __nimbusFatalReport(error, fromPromise, enhance) {
  const isObject = error !== null && (typeof error === "object" || typeof error === "function");
  const decorated = isObject && typeof __nimbusDecorated !== "undefined" && __nimbusDecorated.has(error);
  const arrow = decorated ? null : __nimbusFatalArrow(error, fromPromise);
  let report = "";
  let attached = null;
  // AppendExceptionLine: an error keeps its arrow for below; for anything
  // else it is printed at once.
  if (arrow !== null) {
    if (isObject && __realUtil.types.isNativeError(error)) attached = arrow;
    else report += "\\n" + arrow;
  }
  let trace;
  if (isObject) {
    try { trace = error.stack; } catch {}
    if (enhance) {
      try {
        const inspect = __nimbusInspect;
        const colors = __nimbusShouldColorize(__processMod.stderr) || inspect.defaultOptions.colors;
        trace = inspect(error, { colors, customInspect: false, depth: Math.max(inspect.defaultOptions.depth, 5) });
      } catch {}
    }
  }
  let text = "";
  if (trace !== undefined) {
    try { text = String(trace); } catch {}
  }
  if (text.length > 0) {
    report += attached === null ? text + "\\n" : attached + "\\n" + text + "\\n";
  } else {
    let message;
    let name;
    if (isObject) {
      try { message = error.message; } catch {}
      try { name = error.name; } catch {}
    }
    if (message === undefined || name === undefined) {
      let shown = "";
      try { shown = String(error); } catch {}
      report += shown + "\\n";
    } else {
      let shownName = "";
      let shownMessage = "";
      try { shownName = String(name); } catch {}
      try { shownMessage = String(message); } catch {}
      report += (attached === null ? "" : attached + "\\n") + shownName + ": " + shownMessage + "\\n";
    }
    const argv0 = __pathMod.basename(String(__processMod.argv[0] || "node")).replace(/(.)\\.[^.]*$/, "$1");
    report += "(Use \`" + argv0 + " --trace-uncaught ...\` to show where the exception was thrown)\\n";
  }
  return report + "\\nNode.js " + __processMod.version + "\\n";
}
// The entry's typeless warning, where its graph did not link
// (__nimbusEsmImport), issued as the failure is taken: Node issued it while
// loading, and its next tick delivers it after a listener that takes the
// failure, before what that listener warns, and never once the failure has
// ended the process (the program stopped, nothing more it writes is shown).
let __nimbusHeldEntryWarning = null;
// An exception nothing caught (\`fromPromise\`: a rejection, or an ES
// module's evaluation): whether a listener took it.
function __nimbusUncaughtException(error, fromPromise = false) {
  if (error instanceof __ProcessExit) {
    __nimbusReportProcessExit(error.code, "");
    return true;
  }
  const held = __nimbusHeldEntryWarning;
  __nimbusHeldEntryWarning = null;
  if (held !== null) held();
  const type = fromPromise ? "unhandledRejection" : "uncaughtException";
  try {
    __processMod.emit("uncaughtExceptionMonitor", error, type);
    if (__nimbusExceptionCapture !== null) {
      __nimbusExceptionCapture(error);
      return true;
    }
    if (__processMod.emit("uncaughtException", error, type)) return true;
  } catch (thrown) {
    if (thrown instanceof __ProcessExit) {
      __nimbusReportProcessExit(thrown.code, "");
      return true;
    }
    // The process ends: Node runs no more ticks, a warning's included.
    __nimbusWarnings.dropQueued();
    const report = __nimbusFatalReport(thrown, false, false);
    __nimbusWriteFatal(report);
    __nimbusReportProcessExit(7, report);
    return false;
  }
  __nimbusWarnings.dropQueued();
  try {
    if (!__processMod._exiting) {
      __processMod._exiting = true;
      __processMod.exitCode = 1;
      __nimbusEmitExit(1);
    }
  } catch {}
  const report = __nimbusFatalReport(error, fromPromise, true);
  __nimbusWriteFatal(report);
  __nimbusReportProcessExit(__processMod.exitCode ?? 1, report);
  return false;
}
// A rejection nothing handles: 'unhandledRejection', then, unhandled, an
// uncaught exception: the reason if it is an error (it has its own stack),
// else Node's UnhandledPromiseRejection.
function __nimbusUnhandledRejection(reason, promise) {
  let handled;
  try {
    handled = __processMod.emit("unhandledRejection", reason, promise);
  } catch (thrown) {
    __nimbusUncaughtException(thrown, false);
    return;
  }
  if (handled) return;
  const errorLike = typeof reason === "object" && reason !== null && Object.hasOwn(reason, "stack");
  __nimbusUncaughtException(errorLike ? reason : new __NimbusUnhandledPromiseRejection(reason), true);
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = event && typeof event === "object" && "reason" in event ? event.reason : event;
    const promise = event && typeof event === "object" && "promise" in event ? event.promise : undefined;
    __nimbusUnhandledRejection(reason, promise);
    try { event.preventDefault?.(); } catch {}
  });
  globalThis.addEventListener("error", (event) => {
    __nimbusUncaughtException(event && typeof event === "object" && "error" in event ? event.error : event);
    try { event.preventDefault?.(); } catch {}
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ──  Builtins initialization (MUST come before require) ─────────────
// ═══════════════════════════════════════════════════════════════════════
const builtins = {};
builtins.fs = __fsMod;
builtins.path = __pathMod;
builtins.os = __osMod;
// framework-fixes-F1 (2026-05-12): 'node:constants' (legacy 'constants').
// Pre-fix require('node:constants') threw "Cannot find module" because
// the table didn't include it. create-next-app touches
// constants.UV_FS_O_FILEMAP at module init; that crash blocked the entire
// scaffold flow. See __constantsMod definition above for the full shape.
builtins.constants = __constantsMod;
builtins.events = __eventsMod;
builtins.stream = __streamMod;
builtins.buffer = __bufferModule;
builtins.url = __urlMod;
builtins.crypto = __cryptoMod;
// Node's own (Node's library above), each run the first time it is required.
for (const [name, read] of [
  ["assert", () => __nimbusNodeLib().require("assert")],
  ["assert/strict", () => __nimbusNodeLib().require("assert").strict],
  ["querystring", () => __nimbusNodeLib().require("querystring")],
  ["punycode", () => __nimbusNodeLib().require("punycode")],
  ["util", () => __nimbusNodeLib().require("util")],
  ["util/types", () => __nimbusNodeLib().require("util").types],
  ["dns", () => __nimbusNodeLib().require("dns")],
  ["dns/promises", () => __nimbusNodeLib().require("dns/promises")],
  ["timers/promises", () => __nimbusNodeLib().require("timers/promises")],
  ["path/posix", () => builtins.path.posix],
  ["path/win32", () => builtins.path.win32],
  ["_stream_duplex", () => __streamMod.Duplex],
  ["_stream_passthrough", () => __streamMod.PassThrough],
  ["_stream_readable", () => __streamMod.Readable],
  ["_stream_transform", () => __streamMod.Transform],
  ["_stream_writable", () => __streamMod.Writable],
]) {
  Object.defineProperty(builtins, name, { get: read, enumerable: true, configurable: true });
}
// lib/sys.js: util, deprecated (DEP0025) the first time it loads.
let __nimbusSysWarned = false;
Object.defineProperty(builtins, "sys", {
  get() {
    if (!__nimbusSysWarned) {
      __nimbusSysWarned = true;
      __processMod.emitWarning("sys is deprecated. Use util instead.", "DeprecationWarning", "DEP0025");
    }
    return builtins.util;
  },
  enumerable: true, configurable: true,
});
builtins.string_decoder = __stringDecoderMod;
// node:sqlite (sql.js-backed). Dual-registered like node:fs/promises; the
// resolver strips the node: prefix but the explicit key matches the
// constants/util-types convention. The engine boots lazily and
// synchronously on the first DatabaseSync open (sqlite-shim.ts __getSQL) —
// the ~48 MiB boot must not be paid by processes that never open a DB.
builtins.sqlite = __sqliteMod;
builtins.child_process = __childProcessMod;
builtins.process = __processMod;
// NODE_DEBUG as the program started with it: what util.debuglog reads (Node's
// bootstrap). A runner that hands the env over after this module evaluates
// (opencode's) takes it again then (__nimbusTakeLaunchEnv).
let __nimbusNodeDebugAtLaunch = __processMod.env?.NODE_DEBUG;
function __nimbusTakeLaunchEnv() { __nimbusNodeDebugAtLaunch = __processMod.env?.NODE_DEBUG; }
builtins.console = __consoleMod;
${NATIVE_HTTP_SOURCE}
${NODE_WS_UPGRADE_SOURCE}
// W3 — net.Socket honest-error mode.
//
// Pre-W3 behaviour: \`new net.Socket().connect(443, 'example.com')\`
// immediately fired the 'connect' event without any I/O — silent lie.
// Anything attempting raw TCP from a facet (pg, mysql2, redis wire
// protocols) thought it succeeded but produced no I/O.
//
// W3 behaviour: connect() emits 'error' with code
// ERR_NET_SOCKET_NOT_AVAILABLE so callers fail loud.  W8 will route
// raw outbound TCP through supervisor RPC.
builtins.net = (() => {
  if (globalThis.__nimbusEgress === true) {
    const native = __nativeBuiltin("net");
    return { ...native, get Server() { return builtins.http.Server; },
      createServer: (options, handler) => builtins.http.createServer(typeof options === 'function' ? options : handler) };
  }
  class Socket extends __eventsMod {
    constructor() {
      super();
      this.connecting = false;
      this.destroyed = false;
      // Honest: we cannot send/receive bytes from a facet today.
      this.writable = false;
      this.readable = false;
      this.remoteAddress = null;
      this.remotePort = null;
      this.localAddress = "0.0.0.0";
      this.localPort = 0;
    }
    connect(port, host, cb) {
      if (typeof host === "function") { cb = host; host = "127.0.0.1"; }
      // Opening a socket is something a second run would do again
      // (runtime/stop-replay.ts), however it ends.
      __nimbusReplay?.effect("net.connect " + String(host || "127.0.0.1") + ":" + String(port));
      this.remoteAddress = host || "127.0.0.1";
      this.remotePort = port;
      const self = this;
      queueMicrotask(() => {
        const err = nodeError(Error, "ERR_NET_SOCKET_NOT_AVAILABLE", "net.Socket: outbound TCP from Nimbus facet not yet supported. " +
          "Use fetch() for HTTP/HTTPS. (W8 will route via supervisor RPC.)");
        self.destroyed = true;
        self.emit("error", err);
        if (cb) cb(err);
      });
      return this;
    }
    write() { return false; }
    end(data, enc, cb) {
      if (typeof data === "function") { cb = data; data = undefined; }
      const self = this;
      queueMicrotask(() => { self.emit("end"); self.emit("close"); if (cb) cb(); });
      return this;
    }
    destroy(err) { this.destroyed = true; if (err) this.emit("error", err); this.emit("close"); return this; }
    setEncoding() { return this; }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return null; }
  }
  return {
    Socket,
    get Server() { return builtins.http.Server; },
    createServer: (o, h) => { if (typeof o === "function") { h = o; } return builtins.http.createServer(h); },
    createConnection: (p, h, cb) => new Socket().connect(p, h, cb),
    connect: (p, h, cb) => new Socket().connect(p, h, cb),
    isIP: (s) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(s) ? 4 : 0,
    isIPv4: (s) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(s),
    isIPv6: () => false,
  };
})();
// dgram (UDP) — workerd has no UDP sockets. Some packages require it at
// module init (dns2's server/udp.js, bundled by create-cloudflare) but
// never open a UDP server during scaffolding. Expose the API surface so
// module init succeeds; bind/send surface an honest error only if used.
builtins.dgram = (() => {
  class Socket extends __eventsMod {
    constructor(opts) { super(); this.type = (opts && opts.type) || (typeof opts === "string" ? opts : "udp4"); }
    bind(_port, _addr, cb) {
      const err = nodeError(Error, "ERR_SOCKET_BAD_PORT", "UDP sockets are not supported in this runtime");
      queueMicrotask(() => this.emit("error", err));
      if (typeof cb === "function") queueMicrotask(cb);
      return this;
    }
    send(_msg, ...args) {
      const cb = args.find((a) => typeof a === "function");
      const err = new Error("UDP sockets are not supported in this runtime");
      if (cb) queueMicrotask(() => cb(err)); else queueMicrotask(() => this.emit("error", err));
    }
    address() { return { address: "0.0.0.0", port: 0, family: this.type === "udp6" ? "IPv6" : "IPv4" }; }
    close(cb) { queueMicrotask(() => { this.emit("close"); if (typeof cb === "function") cb(); }); return this; }
    setBroadcast() {} setTTL() {} setMulticastTTL() {} addMembership() {} dropMembership() {}
    ref() { return this; } unref() { return this; }
  }
  return { Socket, createSocket: (opts, cb) => { const s = new Socket(opts); if (typeof cb === "function") s.on("message", cb); return s; } };
})();

builtins.tty = {
  isatty: () => __nimbusAttachedTty,
  // The process's terminal: a ReadStream reads fd 0, as process.stdin does, a
  // WriteStream writes its stdout (fd 2: its stderr).
  ReadStream: class extends __streamMod.Readable {
    constructor(fd) {
      super();
      this.fd = fd;
      this.isTTY = __nimbusAttachedTty;
      this.isRaw = false;
      __nimbusStdinSource.attach(this);
    }
    setRawMode(mode) { this.isRaw = mode !== false; return this; }
    // A consumer of fd 0 of its own (__makeStdinSource).
    _read() { __nimbusStdinSource.want(this); }
  },
  WriteStream: class extends __streamMod.Writable {
    constructor(fd) { super(); this.fd = fd; this.isTTY = __nimbusAttachedTty; }
    _write(chunk, encoding, callback) { (this.fd === 2 ? __processMod.stderr : __processMod.stdout).write(chunk, encoding, callback); }
    get columns() { return __nimbusTtyColumns; }
    get rows() { return __nimbusTtyRows; }
    getColorDepth(env) { return __nimbusColorDepth(env); }
    hasColors(count, env) { return __nimbusHasColors(count, env); }
    clearLine(dir, cb) { return __nimbusClearLine(this, dir, cb); }
    clearScreenDown(cb) { return __nimbusClearScreenDown(this, cb); }
    cursorTo(x, y, cb) { return __nimbusCursorTo(this, x, y, cb); }
    moveCursor(dx, dy, cb) { return __nimbusMoveCursor(this, dx, dy, cb); }
    getWindowSize() { return [this.columns, this.rows]; }
  },
};
// builtinModules is the node CORE list. The table also carries the npm
// packages the facet provides itself (FACET_PROVIDED_PACKAGES), which are not
// core and must not be reported as such — a package that sniffs this list
// would otherwise conclude e.g. undici ships with node.
// A SafeSet: every require asks it, after the program may have replaced Set.prototype.has.
const __nimbusFacetProvidedPackages = new __NimbusSafeSet(${FACET_PROVIDED_PACKAGES_LITERAL});
// Node's builtins that exist only with the scheme (lib/internal/bootstrap/realm.js schemelessBlockList).
const __NODE_SCHEME_ONLY_BUILTINS = new __NimbusSafeSet(${JSON.stringify(NODE_SCHEME_ONLY_BUILTINS)});
// The Node builtin \`specifier\` names, by its id, or null: what require,
// import, module.isBuiltin, module.builtinModules and
// process.getBuiltinModule read. The packages the process provides are in
// the table but are not Node's.
function __nimbusBuiltinId(specifier) {
  // Every require and import asks this: on the launch's captures.
  const scheme = __pathStartsWith(specifier, "node:");
  const id = scheme ? __pathSlice(specifier, 5) : specifier;
  if (!__nimbusPrimordials.objectHasOwn(builtins, id) || __nimbusFacetProvidedPackages.has(id)) return null;
  return scheme || !__NODE_SCHEME_ONLY_BUILTINS.has(id) ? id : null;
}
// node:module. In Node \`require('module')\` IS the Module constructor, its
// statics the module API, and \`Module.Module\` the same function: loaders
// such as jiti (Nuxt's nuxt.config, c12) build a module by hand —
// \`new Module(filename)\`, then \`paths\`, \`require\`, and \`_compile\` — so
// the constructor has to exist with Node's shape. \`_compile\` turns source
// text into code: through the runtime-code service when the launch carries
// one (a module written after launch is staged for the next launch there),
// otherwise with Node's own wrapper through the Function constructor, which
// works while modules evaluate and whose refusal at request time names the
// file honestly.
function __NodeModule(id = "", parent) {
  if (!new.target) throw new TypeError("Class constructor Module cannot be invoked without 'new'");
  this.id = id;
  this.path = __pathMod.dirname(id);
  this.exports = {};
  __nimbusModuleParents.set(this, parent);
  __nimbusUpdateChildren(parent, this, false);
  this.filename = null;
  this.loaded = false;
  this.children = [];
}
// The module that first required each (lib/internal/modules/cjs/loader.js moduleParentCache).
const __nimbusModuleParents = new WeakMap();
Object.defineProperty(__NodeModule.prototype, "parent", {
  get() { return __nimbusModuleParents.get(this); },
  set(value) { __nimbusModuleParents.set(this, value); },
  configurable: true,
});
function __nimbusUpdateChildren(parent, child, scan) {
  const children = parent?.children;
  // Node's updateChildren, on its primordials (ArrayPrototypeIncludes, ArrayPrototypePush): ours are the launch's.
  if (children && !(scan && __nimbusPrimordials.arrayIncludes(children, child))) __nimbusPrimordials.arrayPush(children, child);
}
// Where a module's requests resolve from: its file's directory, or for one
// with no file (Node's REPL, a hand-made Module) the working directory.
function __nimbusModuleDir(module) {
  return module?.filename ? __pathMod.dirname(module.filename) : (cwd || "/home/user");
}
__NodeModule.prototype.require = function require(id) {
  return __requireFrom(id, __nimbusModuleDir(this), this);
};
__NodeModule.prototype._compile = function _compile(content, filename) {
  const file = String(filename ?? this.filename ?? this.id);
  const dir = __pathMod.dirname(file);
  const text = String(content).replace(/^#!.*/, "");
  const service = globalThis.__nimbusRuntimeCode;
  let wrapper;
  if (service && typeof service.compileModule === "function") {
    wrapper = service.compileModule(file, text);
  } else {
    try {
      wrapper = Function("exports", "require", "module", "__filename", "__dirname", text);
    } catch (e) {
      if (__nimbusIsCodegenRefusal(e)) {
        const err = nodeError(Error, "ERR_NIMBUS_CODE_NEXT_LAUNCH", "Nimbus: Module._compile(" + file + "): a Worker compiles code only while a launch's modules load, and this text arrived after launch.");
        throw err;
      }
      throw e;
    }
  }
  return wrapper.call(this.exports, this.exports, __nimbusMakeRequire(this), this, file, dir);
};
Object.defineProperty(__NodeModule, "builtinModules", {
  get() { return Object.keys(builtins).filter((id) => __nimbusBuiltinId(id) !== null); },
  enumerable: true, configurable: true,
});
// lib/internal/modules/cjs/loader.js createRequire: the require of a module at
// \`filename\` (a file URL or an absolute path; a directory's, with a trailing slash).
__NodeModule.createRequire = function createRequire(filename) {
  let filepath;
  const url = filename !== null && typeof filename === "object" && filename.href && filename.protocol && filename.auth === undefined && filename.path === undefined;
  if (url || (typeof filename === "string" && !filename.startsWith("/"))) {
    try {
      filepath = builtins.url.fileURLToPath(filename);
    } catch {
      throw new nodeErrorCodes.ERR_INVALID_ARG_VALUE("filename", filename, "must be a file URL object, file URL string, or absolute path string");
    }
  } else if (typeof filename !== "string") {
    throw new nodeErrorCodes.ERR_INVALID_ARG_VALUE("filename", filename, "must be a file URL object, file URL string, or absolute path string");
  } else {
    filepath = filename;
  }
  const proxyPath = filepath.endsWith("/") ? __pathMod.join(filepath, "noop.js") : filepath;
  const module = new __NodeModule(proxyPath);
  module.filename = proxyPath;
  module.paths = __NodeModule._nodeModulePaths(module.path);
  return __nimbusMakeRequire(module);
};
__NodeModule.isBuiltin = (specifier) => typeof specifier === "string" && __nimbusBuiltinId(specifier) !== null;
// Node 22.1's on-disk compile cache. There is no disk to cache into and
// nothing to compile ahead: callers (pi's CLI entry calls it
// unconditionally) get Node's own answer for a cache that is off.
__NodeModule.enableCompileCache = () => ({ status: 3, message: 'compile cache is not available in this runtime' });
__NodeModule.getCompileCacheDir = () => undefined;
__NodeModule.flushCompileCache = () => {};
__NodeModule.constants = { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } };
__NodeModule.wrapper = ["(function (exports, require, module, __filename, __dirname) { ", "\\n});"];
__NodeModule.wrap = (script) => __NodeModule.wrapper[0] + script + __NodeModule.wrapper[1];
__NodeModule._extensions = { ".js": () => {}, ".json": () => {}, ".node": () => {} };
// require.cache: each CommonJS module by its file, as it loads.
__NodeModule._cache = { __proto__: null };
__NodeModule.globalPaths = [];
// Node's lookup path list: every ancestor's node_modules, nearest first,
// never a node_modules/node_modules.
__NodeModule._nodeModulePaths = (from) => {
  return requireNodeModulePaths(__pathMod.resolve(String(from)));
};
// Module._resolveFilename: a builtin's id as asked, a staged binding's name,
// or the file \`request\` names from \`parent\` (or from each of
// \`options.paths\`, in order); MODULE_NOT_FOUND with its require stack.
__NodeModule._resolveFilename = function _resolveFilename(request, parent, isMain, options) {
  if (__nimbusBuiltinId(request) !== null || __stagedBinding(request)) return request;
  let dirs = [__nimbusModuleDir(parent)];
  // options.paths' directories, from the working directory, each validated as
  // path.resolve does: a relative request's as it is searched, a bare one's first.
  const relative = request === "." || request === ".." || request.startsWith("./") || request.startsWith("../");
  const absolute = (dir) => {
    if (typeof dir !== "string") throw invalidArgType("paths[0]", "string", dir);
    return __pathMod.resolve(dir);
  };
  if (options !== null && typeof options === "object") {
    if (Array.isArray(options.paths)) dirs = relative ? options.paths : options.paths.map(absolute);
    else if (options.paths !== undefined) throw new nodeErrorCodes.ERR_INVALID_ARG_VALUE("options.paths", options.paths);
  }
  const lookup = relative ? dirs : [__nimbusModuleDir(parent)];
  for (const dir of lookup) {
    const found = __requireResolver.resolveSync(request, absolute(dir), {
      ...(relative ? {} : { paths: dirs.map(absolute) }),
      ...(typeof parent?.filename === "string" ? { parent: parent.filename } : {}),
    });
    if (found) return found.builtin ? "node:" + found.builtin : found.path;
  }
  throw __nimbusModuleNotFound(request, parent);
};
// Module._resolveLookupPaths: where a bare request is looked for (the
// module's node_modules folders), a relative one's directory, or null for a
// builtin. Named limit: NODE_PATH and Node's global folders ($HOME/.node_modules,
// $HOME/.node_libraries, <prefix>/lib/node) are neither searched nor listed.
__NodeModule._resolveLookupPaths = function _resolveLookupPaths(request, parent) {
  if (__nimbusBuiltinId(request) !== null) return null;
  if (request[0] !== "." || (request.length > 1 && request[1] !== "." && request[1] !== "/")) {
    return parent?.paths?.length ? [...parent.paths] : null;
  }
  return [parent?.id && parent.filename ? __pathMod.dirname(parent.filename) : "."];
};
// Node's MODULE_NOT_FOUND: the request, and the files that required down to it.
function __nimbusModuleNotFound(request, parent) {
  const requireStack = [];
  for (let cursor = parent; cursor; cursor = __nimbusModuleParents.get(cursor)) requireStack.push(cursor.filename || cursor.id);
  let message = "Cannot find module '" + request + "'";
  if (requireStack.length > 0) message += "\\nRequire stack:\\n- " + requireStack.join("\\n- ");
  const error = new Error(message);
  error.code = "MODULE_NOT_FOUND";
  error.requireStack = requireStack;
  return error;
}
// lib/internal/modules/helpers.js makeRequireFunction: \`module\`'s require,
// resolving from \`fromDir\` (its file's directory). \`required\` false is an
// ES module's, which only its static imports call.
function __nimbusMakeRequire(module, fromDir = __nimbusModuleDir(module)) {
  const require = function require(id) {
    return __requireFrom(id, fromDir, module);
  };
  function resolve(request, options) {
    if (typeof request !== "string") throw invalidArgType("request", "string", request);
    return __NodeModule._resolveFilename(request, module, false, options);
  }
  resolve.paths = function paths(request) {
    if (typeof request !== "string") throw invalidArgType("request", "string", request);
    return __NodeModule._resolveLookupPaths(request, module);
  };
  require.resolve = resolve;
  require.main = __processMod.mainModule;
  require.extensions = __NodeModule._extensions;
  require.cache = __NodeModule._cache;
  return require;
}
__NodeModule._load = (request, parent) => __requireFrom(request, __nimbusModuleDir(parent), parent ?? undefined);
__NodeModule.Module = __NodeModule;
// Node's class, from its library the first time it is read: then a value, as Node's.
Object.defineProperty(__NodeModule, "SourceMap", {
  get() {
    const SourceMap = __nimbusSourceMapClass();
    Object.defineProperty(__NodeModule, "SourceMap", { value: SourceMap, writable: true, enumerable: true, configurable: true });
    return SourceMap;
  },
  enumerable: true, configurable: true,
});
__NodeModule.findSourceMap = function findSourceMap(sourceURL) { return __nimbusFindSourceMap(sourceURL); };
// Each builtin's ES namespace reads its builtin's names again (native-esm.ts builtinFacadeModule).
__NodeModule.syncBuiltinESMExports = function syncBuiltinESMExports() {
  for (const resync of __nimbusEsmResyncs) resync();
};
__NodeModule.getSourceMapsSupport = function getSourceMapsSupport() { return __nimbusSourceMapsSupport; };
__NodeModule.setSourceMapsSupport = function setSourceMapsSupport(enabled, options = {}) { __nimbusSetSourceMapsSupport(enabled, options); };
Object.defineProperty(__NodeModule, "name", { value: "Module" });
builtins.module = __NodeModule;
// Bind to globalThis: workerd's timer globals throw "Illegal invocation"
// when called with a receiver other than globalThis (i.e. as
// timers.setInterval(...)), which clack's spinner — used by
// create-cloudflare — triggers.
// lib/timers.js: the global timer functions themselves, as Node's are; its
// deprecated item timers and timers.promises from Node's library, when first read.
builtins.timers = {
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setImmediate: globalThis.setImmediate, clearImmediate: globalThis.clearImmediate,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
};
for (const name of ["_unrefActive", "active", "unenroll", "enroll", "promises"]) {
  Object.defineProperty(builtins.timers, name, {
    get() {
      const value = name === "promises" ? builtins["timers/promises"] : __nimbusNodeLib().require("internal/timers/legacy")[name];
      if (name !== "promises") Object.defineProperty(builtins.timers, name, { value, writable: true, enumerable: true, configurable: true });
      return value;
    },
    enumerable: true, configurable: true,
  });
}
// ──  zlib ───────────────────────────────────────────────────────────
//
// The platform's node:zlib — complete at the production compat date: every
// *Sync variant, brotli/zstd, crc32, constants, and real streaming create*
// factories. Forwarded verbatim: results are the host realm's own Buffer
// instances, and __BufferMod.isBuffer recognizes that brand (see the Buffer
// shim), so Buffer checks stay truthful without copying every result or
// intercepting stream chunks.
builtins.zlib = (() => {
  const __real = __nativeBuiltin("zlib");
  const mod = {};
  // lib/zlib.js: the functions, the classes, \`constants\` and \`codes\` are
  // the module's enumerable exports; each constant but Brotli's is on the
  // module too, read-only and not enumerable (deprecated); there is no
  // \`default\`. workerd exports every constant by name, enumerable, and two
  // zstd modes of its own (ZSTD_ENCODE, ZSTD_DECODE) beside Node's
  // ZSTD_COMPRESS and ZSTD_DECOMPRESS. Named limit: ZLIB_VERNUM and
  // Z_MAX_CHUNK are the engine's values, not Node's, and the Brotli decoder
  // is the engine's: Node 22.23.4's has a fix (CVE-2026-111497) and its error
  // code, BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, which workerd's
  // constants lack.
  const workerdOnly = { ZSTD_ENCODE: true, ZSTD_DECODE: true };
  const constants = Object.create(null);
  for (const [name, value] of Object.entries(__real.constants)) {
    if (!Object.hasOwn(workerdOnly, name)) Object.defineProperty(constants, name, { value, enumerable: true });
  }
  // The lookup tables, crc32, and the stream factories/classes pass
  // through bound to the native module (capitalized names are classes —
  // binding would strip their prototype and break \`new\`).
  for (const k of Object.keys(__real)) {
    if (k === "constants" || k === "codes" || k in constants || Object.hasOwn(workerdOnly, k)) continue;
    const v = __real[k];
    // lib/zlib.js defines each create* factory read-only.
    Object.defineProperty(mod, k, {
      value: (typeof v === "function" && /^[a-z]/.test(k)) ? v.bind(__real) : v,
      writable: !/^create[A-Z]/.test(k), enumerable: true, configurable: true,
    });
  }
  Object.defineProperties(mod, {
    constants: { value: constants, enumerable: true },
    codes: { value: __real.codes, enumerable: true },
  });
  for (const [name, value] of Object.entries(constants)) {
    if (!name.startsWith("BROTLI")) Object.defineProperty(mod, name, { value });
  }
  if (__real.promises) mod.promises = __real.promises;
  return mod;
})();
builtins.readline = (() => {
  function emitKeypressEvents(stream) {
    if (!stream || stream.__nimbusKeypressEvents) return;
    stream.__nimbusKeypressEvents = true;
    // One decoder for the stream, as Node's emitKeypressEvents keeps (string_decoder).
    const decoder = new __stringDecoderMod.StringDecoder("utf8");
    stream.on("data", (chunk) => {
      const text = chunk instanceof Uint8Array
        ? decoder.write(chunk)
        : String(chunk);
      for (let i = 0; i < text.length; i++) {
        let str = text[i];
        let key = { sequence: str, name: str, ctrl: false, meta: false, shift: false };
        if (str === "\\x1b" && text[i + 1] === "[") {
          const code = text[i + 2];
          if (code === "A" || code === "B" || code === "C" || code === "D") {
            i += 2;
            str = "\\x1b[" + code;
            key = {
              sequence: str,
              name: code === "A" ? "up" : code === "B" ? "down" : code === "C" ? "right" : "left",
              ctrl: false,
              meta: false,
              shift: false,
            };
          }
        } else if (str === "\\x03") {
          key = { sequence: str, name: "c", ctrl: true, meta: false, shift: false };
        } else if (str === "\\x7f" || str === "\\b") {
          key = { sequence: str, name: "backspace", ctrl: false, meta: false, shift: false };
        } else if (str === "\\r" || str === "\\n") {
          key = { sequence: str, name: "enter", ctrl: false, meta: false, shift: false };
        }
        stream.emit("keypress", str, key);
      }
    });
  }
  function createInterface(opts) {
    const inp = typeof opts === "object" && opts ? opts : { input: opts };
    const input = inp.input || __processMod.stdin;
    const output = inp.output || __processMod.stdout;
    const rl = new __eventsMod();
    let closed = false;
    let promptText = inp.prompt || "> ";
    let buffer = "";
    const pending = [];
    const queued = [];
    function pushLine(line) {
      if (closed) return;
      rl.emit("line", line);
      const waiter = pending.shift();
      if (waiter) waiter({ value: line, done: false });
      else queued.push(line);
    }
    function handleInputText(text) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\\r" || ch === "\\n") {
          if (ch === "\\r" && text[i + 1] === "\\n") i++;
          const line = buffer;
          buffer = "";
          pushLine(line);
          continue;
        }
        if (ch === "\\x7f" || ch === "\\b") {
          if (buffer.length > 0) buffer = buffer.slice(0, -1);
          continue;
        }
        if (ch === "\\x03") {
          rl.emit("SIGINT");
          continue;
        }
        buffer += ch;
      }
    }
    // One decoder for the input, as Node's readline Interface keeps (string_decoder).
    const inputDecoder = new __stringDecoderMod.StringDecoder("utf8");
    function onData(chunk) {
      const text = chunk instanceof Uint8Array
        ? inputDecoder.write(chunk)
        : String(chunk);
      handleInputText(text);
    }
    function onEnd() {
      if (buffer) {
        const tail = buffer;
        buffer = "";
        pushLine(tail);
      }
      rl.close();
    }
    try {
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      if (typeof input.resume === "function") input.resume();
    } catch {}
    rl.close = () => {
      if (closed) return;
      closed = true;
      try { input.removeListener?.("data", onData); } catch {}
      try { input.removeListener?.("end", onEnd); } catch {}
      try { input.removeListener?.("close", onEnd); } catch {}
      for (const waiter of pending.splice(0)) waiter({ value: undefined, done: true });
      rl.emit("close");
    };
    rl.question = (q, o, cb) => {
      if (typeof o === "function") cb = o;
      if (output && typeof output.write === "function") output.write(q);
      const onLine = (line) => {
        rl.removeListener("line", onLine);
        if (typeof cb === "function") cb(line);
      };
      rl.on("line", onLine);
    };
    rl.prompt = () => { if (output && typeof output.write === "function") output.write(promptText); };
    rl.setPrompt = (p) => { promptText = String(p); return rl; };
    rl.getPrompt = () => promptText;
    rl.pause = () => { try { input.pause?.(); } catch {} return rl; };
    rl.resume = () => { try { input.resume?.(); } catch {} return rl; };
    rl.write = (data) => { onData(data); return rl; };
    rl[Symbol.asyncIterator] = async function*() {
      while (!closed) {
        if (queued.length > 0) {
          yield queued.shift();
          continue;
        }
        const next = await new Promise((resolve) => pending.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    };
    return rl;
  }
  function clearLine(stream, dir, cb) { return __nimbusClearLine(stream, dir, cb); }
  function clearScreenDown(stream, cb) { return __nimbusClearScreenDown(stream, cb); }
  function cursorTo(stream, x, y, cb) { return __nimbusCursorTo(stream, x, y, cb); }
  function moveCursor(stream, dx, dy, cb) { return __nimbusMoveCursor(stream, dx, dy, cb); }
  const promises = {
    createInterface(opts) {
      const iface = createInterface(opts);
      const originalQuestion = iface.question.bind(iface);
      iface.question = (query, options) => new Promise((resolve) => {
        void options;
        originalQuestion(query, (answer) => resolve(answer));
      });
      return iface;
    },
  };
  return {
    createInterface,
    Interface: __eventsMod,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor,
    emitKeypressEvents,
    promises,
  };
})();
// perf_hooks: Node's names, from workerd's node:perf_hooks (Node's surface
// over the platform's performance, its classes the globals). Named limit:
// createHistogram and monitorEventLoopDelay throw ERR_METHOD_NOT_IMPLEMENTED.
builtins.perf_hooks = ((perfHooks) => Object.fromEntries([
  "Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure", "PerformanceObserver", "PerformanceObserverEntryList",
  "PerformanceResourceTiming", "monitorEventLoopDelay", "createHistogram", "performance", "constants",
].map((name) => [name, perfHooks[name]])))(__nativeBuiltin("perf_hooks"));
// X.5-Z5 §3 follow-on: minimal v8 stub for jiti (used transitively by
// @tailwindcss/vite). jiti reads v8.startupSnapshot.isBuildingSnapshot()
// to decide whether to skip JIT compilation; workerd never builds v8
// snapshots, so 'false' is the correct answer. Other v8 introspection
// APIs (cachedDataVersionTag, getHeapStatistics, etc.) return inert
// values that satisfy the shape contract without offering real data.
builtins.v8 = {
  startupSnapshot: {
    isBuildingSnapshot: () => false,
    addSerializeCallback: () => {},
    addDeserializeCallback: () => {},
    setDeserializeMainFunction: () => {},
    setDeserializeData: () => {},
  },
  cachedDataVersionTag: () => 0,
  getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0, malloced_memory: 0 }),
  getHeapSpaceStatistics: () => [],
  setFlagsFromString: () => {},
  serialize: (v) => __BufferMod.from(JSON.stringify(v)),
  deserialize: (b) => JSON.parse(__BufferMod.from(b).toString()),
  writeHeapSnapshot: () => "",
};
// node:worker_threads BroadcastChannel, which workerd lacks. A process has one
// thread, so a message reaches the other open channels of its name in this
// process, as in Node: never the poster, after the poster's microtasks, each
// as a MessageEvent of its own structured clone. An open channel keeps the
// process alive until it is closed or unref'd, as its handle does in Node.
const __BroadcastChannel = (() => {
  const open = new Map();
  const state = new WeakMap();
  const own = (channel) => {
    const s = state.get(channel);
    if (s === undefined) {
      const error = nodeError(TypeError, "ERR_INVALID_THIS", 'Value of "this" must be of type BroadcastChannel');
      throw error;
    }
    return s;
  };
  const deliver = (channel, data) => {
    if (state.get(channel).open) channel.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) }));
  };
  class BroadcastChannel extends EventTarget {
    constructor(name) {
      if (arguments.length === 0) throw new nodeErrorCodes.ERR_MISSING_ARGS("name");
      super();
      const s = { name: String(name), open: true, hold: null, handlers: { message: null, messageerror: null } };
      state.set(this, s);
      for (const type of ["message", "messageerror"]) {
        this.addEventListener(type, (event) => {
          if (typeof s.handlers[type] === "function") s.handlers[type].call(this, event);
        });
      }
      if (!open.has(s.name)) open.set(s.name, new Set());
      open.get(s.name).add(this);
      s.hold = __nimbusHoldSocket();
    }
    get name() { return own(this).name; }
    get onmessage() { return own(this).handlers.message; }
    set onmessage(handler) { own(this).handlers.message = typeof handler === "function" ? handler : null; }
    get onmessageerror() { return own(this).handlers.messageerror; }
    set onmessageerror(handler) { own(this).handlers.messageerror = typeof handler === "function" ? handler : null; }
    postMessage(message) {
      const s = own(this);
      if (arguments.length === 0) throw new nodeErrorCodes.ERR_MISSING_ARGS("message");
      if (!s.open) throw new DOMException("BroadcastChannel is closed.", "InvalidStateError");
      const data = structuredClone(message);
      const schedule = globalThis.__nimbusRawSetTimeout || globalThis.setTimeout;
      for (const peer of open.get(s.name) || []) {
        if (peer !== this) schedule(() => deliver(peer, data), 0);
      }
    }
    close() {
      const s = own(this);
      if (!s.open) return;
      s.open = false;
      s.hold(false);
      const peers = open.get(s.name);
      peers.delete(this);
      if (peers.size === 0) open.delete(s.name);
    }
    ref() {
      const s = own(this);
      if (s.open) s.hold(true);
      return this;
    }
    unref() {
      const s = own(this);
      if (s.open) s.hold(false);
      return this;
    }
  }
  return BroadcastChannel;
})();
// The global is worker_threads' own, as in Node, and this process's: a facet
// that runs process after process keeps its globals, and a constructor left
// by an earlier one would join channels this process can never reach.
Object.defineProperty(globalThis, "BroadcastChannel", { value: __BroadcastChannel, writable: true, configurable: true, enumerable: false });
const __workerThreadsUntransferable = new WeakSet();
const __workerThreadsUncloneable = new WeakSet();
builtins.worker_threads = {
  isMainThread: true,
  parentPort: null,
  workerData: null,
  threadId: 0,
  SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
  Worker: class extends __eventsMod {
    constructor() { super(); }
    terminate() { return Promise.resolve(0); }
    postMessage() {}
  },
  MessageChannel: globalThis.MessageChannel,
  MessagePort: globalThis.MessagePort,
  BroadcastChannel: __BroadcastChannel,
  receiveMessageOnPort: () => undefined,
  markAsUntransferable(value) {
    if (value && (typeof value === "object" || typeof value === "function")) {
      __workerThreadsUntransferable.add(value);
    }
  },
  isMarkedAsUntransferable(value) {
    return !!(value && (typeof value === "object" || typeof value === "function") &&
      __workerThreadsUntransferable.has(value));
  },
  markAsUncloneable(value) {
    if (value && (typeof value === "object" || typeof value === "function")) {
      __workerThreadsUncloneable.add(value);
    }
  },
};

// ── W3 additions: builtins forwarded/shimmed for axios/jsdom/fastify/
//                 puppeteer-core/ts-node + Node 20 surface completeness.
builtins.vm = __vmMod;
builtins.http2 = __http2Mod;
builtins.repl = __replMod;
builtins.diagnostics_channel = __diagChannelMod;
builtins.tls = __tlsMod;
builtins.async_hooks = __asyncHooksMod;
builtins.inspector = __inspectorMod;
// node:inspector/promises — the promisified Session surface.
builtins["inspector/promises"] = __nativeBuiltin("inspector/promises");
// Subpath-style require() — the shim's __requireFrom strips a 'node:'
// prefix to look up bare names, so we expose both bare and prefixed
// keys explicitly for grep-friendliness and to handle any future call
// site that bypasses the strip path.
builtins["fs/promises"] = __fsMod.promises;
builtins["readline/promises"] = builtins.readline.promises;

builtins["stream/promises"] = __streamMod.promises;
// Taken the first time a program requires it, few do.
Object.defineProperty(builtins, "stream/consumers", {
  get() {
    const consumers = __nativeBuiltin("stream/consumers");
    Object.defineProperty(builtins, "stream/consumers", { value: consumers, writable: true, enumerable: true, configurable: true });
    return consumers;
  },
  enumerable: true, configurable: true,
});

// stream/web: Node's names, each the platform's global class, as Node's are.
builtins["stream/web"] = Object.fromEntries([
  "ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest",
  "ReadableByteStreamController", "ReadableStreamDefaultController", "TransformStream", "TransformStreamDefaultController",
  "WritableStream", "WritableStreamDefaultWriter", "WritableStreamDefaultController", "ByteLengthQueuingStrategy",
  "CountQueuingStrategy", "TextEncoderStream", "TextDecoderStream", "CompressionStream", "DecompressionStream",
].map((name) => [name, globalThis[name]]));
// util.promisify's for the timers: timers/promises' (lib/timers.js).
for (const [owner, name] of [[builtins.timers, "setTimeout"], [builtins.timers, "setImmediate"], [globalThis, "setTimeout"], [globalThis, "setImmediate"]]) {
  const fn = owner[name];
  if (typeof fn === "function" && Object.isExtensible(fn) && !Object.hasOwn(fn, Symbol.for("nodejs.util.promisify.custom"))) {
    Object.defineProperty(fn, Symbol.for("nodejs.util.promisify.custom"), { enumerable: true, get: () => builtins["timers/promises"][name] });
  }
}

// undici (npm, not node core) — Nimbus provides it instead of node_modules.
// __requireFrom checks this table BEFORE resolving, so this wins over any
// installed copy, and esbuild lowers every ESM import of "undici" into the
// same require. Rationale for shadowing it at all: runtime/undici-shim.ts.
// No "node:undici" alias — it is not a node builtin, and the prefetch walker
// skips it via the same FACET_PROVIDED_PACKAGES list.
builtins.undici = __undiciMod;

// ── The builtins workerd provides: their errors, Node's ──
// workerd's own builtins (src/node/internal/internal_errors.ts) fail with
// its NodeError: an error with its code and its name as own properties, a
// toString of its own (TypeError, RangeError) or its class's, and a stack
// headed \`TypeError: …\`, not Node's \`TypeError [CODE]: …\`. Where such an
// error leaves a builtin — thrown, a rejection, a callback's first argument
// — it takes Node's shape in place (node-error.ts reshapeAsNodeError):
// Node's class for its base and code, \`code\` its one own enumerable
// property, its stack headed with the code. What the builtins say and which
// they throw is theirs (node-builtin-errors-match-node-workerd records
// where that differs from Node). Named limit: the methods of a Buffer, an
// EventEmitter or an AsyncLocalStorage, hot paths a wrapper would slow
// (measured 9x on readUInt8), keep workerd's shape.
function __nimbusIsWorkerdNodeError(e) {
  if (e === null || typeof e !== "object" || !__realUtil.types.isNativeError(e)) return false;
  const code = Object.getOwnPropertyDescriptor(e, "code");
  const name = Object.getOwnPropertyDescriptor(e, "name");
  if (!code || !name || typeof code.value !== "string" || typeof name.value !== "string") return false;
  for (let o = e; o !== null && o !== Error.prototype; o = Object.getPrototypeOf(o)) {
    const toString = Object.getOwnPropertyDescriptor(o, "toString");
    if (!toString || typeof toString.value !== "function") continue;
    const text = Function.prototype.toString.call(toString.value);
    return text.includes("this.code") && text.includes("this.name");
  }
  return false;
}
function __nimbusNodeShaped(e) {
  if (!__nimbusIsWorkerdNodeError(e)) return e;
  const Base = e instanceof TypeError ? TypeError : e instanceof RangeError ? RangeError
    : e instanceof SyntaxError ? SyntaxError : e instanceof URIError ? URIError : Error;
  return reshapeAsNodeError(e, Base, e.code);
}
// \`fn\`, its errors Node's; \`callbacks\`: a last function argument is a
// callback, whose first argument is the error. With \`held\` (one of
// __nimbusCallbackWork's: where the API reads its callback from), a call
// given a callback is work the engine runs off the program's turn (zlib's
// and crypto's threadpool), live until that callback, as Node's active
// requests keep its event loop: a one-shot program that waits on nothing
// else is not ended before it. An argument the API ignores holds nothing.
function __nimbusNodeErrorsOf(fn, callbacks, held = null) {
  fn = __nimbusFrontBase(fn);
  // Decided here, once: a function that holds nothing pays nothing per call.
  const shaped = held === null ? function (...args) {
    const last = args.length - 1;
    if (callbacks && last >= 0 && typeof args[last] === "function") {
      const callback = args[last];
      args[last] = function (...results) {
        if (results.length > 0) __nimbusNodeShaped(results[0]);
        return __nimbusReflectApply(callback, this, results);
      };
    }
    let result;
    try {
      result = __nimbusReflectApply(fn, this, args);
    } catch (e) {
      throw __nimbusNodeShaped(e);
    }
    return result instanceof Promise ? result.then(undefined, (e) => { throw __nimbusNodeShaped(e); }) : result;
  } : function (...args) {
    const slot = held(args);
    let settle = null;
    if (slot >= 0 && typeof args[slot] === "function") {
      const callback = args[slot];
      globalThis.__nimbusPendingOps++;
      settle = () => {
        if (settle === null) return;
        settle = null;
        globalThis.__nimbusPendingOps--;
        globalThis.__nimbusHandleReleased?.();
      };
      args[slot] = function (...results) {
        settle?.();
        if (results.length > 0) __nimbusNodeShaped(results[0]);
        return __nimbusReflectApply(callback, this, results);
      };
    }
    let result;
    try {
      result = __nimbusReflectApply(fn, this, args);
    } catch (e) {
      // Refused before it started: no work is live.
      settle?.();
      throw __nimbusNodeShaped(e);
    }
    return result instanceof Promise ? result.then(undefined, (e) => { throw __nimbusNodeShaped(e); }) : result;
  };
  Object.defineProperty(shaped, "name", { value: fn.name, configurable: true });
  Object.defineProperty(shaped, "length", { value: fn.length, configurable: true });
  return __nimbusFronted(shaped, fn);
}
// A class, its constructor's errors Node's (its statics and prototype
// reached through, so \`instanceof\` and subclassing hold), and with
// \`prototypes\` its methods'.
function __nimbusNodeErrorsOfClass(C, prototypes) {
  if (prototypes && C.prototype) {
    for (const key of Object.getOwnPropertyNames(C.prototype)) {
      const d = Object.getOwnPropertyDescriptor(C.prototype, key);
      if (key === "constructor" || !d || typeof d.value !== "function" || !d.configurable) continue;
      Object.defineProperty(C.prototype, key, { ...d, value: __nimbusNodeErrorsOf(d.value, false) });
    }
  }
  const construct = Reflect.construct;
  return new Proxy(C, {
    construct(target, args, newTarget) {
      try { return construct(target, args, newTarget); } catch (e) { throw __nimbusNodeShaped(e); }
    },
    apply(target, self, args) {
      try { return __nimbusReflectApply(target, self, args); } catch (e) { throw __nimbusNodeShaped(e); }
    },
  });
}
// A module's functions and classes with their errors Node's: a copy of it,
// or with \`inPlace\` (a class that is the module) its own functions
// replaced. A global (URL, Blob, Buffer) stays itself.
function __nimbusNodeErrorsAt(mod, { callbacks = false, prototypes = false, inPlace = false, held = {} } = {}) {
  if (mod === null || (typeof mod !== "object" && typeof mod !== "function")) return mod;
  const target = inPlace ? mod : Object.create(Object.getPrototypeOf(mod));
  for (const key of Reflect.ownKeys(mod)) {
    const d = Object.getOwnPropertyDescriptor(mod, key);
    if (!d) continue;
    const v = d.value;
    if (v === mod && !inPlace) {
      // A module that names itself (default, posix) names its copy.
      Object.defineProperty(target, key, { ...d, value: target });
    } else if (typeof key === "string" && typeof v === "function" && globalThis[key] !== v && v !== mod) {
      const isClass = /^[A-Z]/.test(key) && typeof v.prototype === "object" && v.prototype !== null;
      if (isClass && inPlace) continue;
      if (inPlace && !d.configurable && !d.writable) continue;
      Object.defineProperty(target, key, { ...d, value: isClass ? __nimbusNodeErrorsOfClass(v, prototypes) : __nimbusNodeErrorsOf(v, callbacks, Object.hasOwn(held, key) ? held[key] : null) });
    } else if (!inPlace) {
      Object.defineProperty(target, key, d);
    }
  }
  return target;
}
// The functions whose callback form is work the engine runs off the
// program's turn, until it calls back, each with where it reads its callback
// from, as Node 22 reads it (lib/zlib.js createConvenienceMethod;
// lib/internal/crypto/*.js): an optional argument before it may be the
// callback. A function not named here holds nothing for a function argument
// (crypto.getHashes(() => {}) returns, and never calls it), nor does one
// named here for an argument it ignores.
const __nimbusCallbackAt = (slot) => () => slot;
const __nimbusCallbackAfterOptional = (optional) => (args) => (typeof args[optional] === "function" ? optional : optional + 1);
const __nimbusZlibCallback = __nimbusCallbackAfterOptional(1);
const __nimbusCallbackWork = {
  zlib: Object.fromEntries(["deflate", "deflateRaw", "gzip", "gunzip", "inflate", "inflateRaw", "unzip", "brotliCompress", "brotliDecompress", "zstdCompress", "zstdDecompress"]
    .map((name) => [name, __nimbusZlibCallback])),
  crypto: {
    randomBytes: __nimbusCallbackAt(1),
    // randomFill(buffer[, offset[, size]], callback)
    randomFill: (args) => [1, 2].find((at) => typeof args[at] === "function") ?? 3,
    // randomInt([min, ]max[, callback]): no max after min, no callback.
    randomInt: (args) => (typeof args[1] === "function" ? 1 : args[1] === undefined ? -1 : 2),
    pbkdf2: __nimbusCallbackAt(5),
    scrypt: __nimbusCallbackAfterOptional(3),
    hkdf: __nimbusCallbackAt(5),
    generateKeyPair: __nimbusCallbackAfterOptional(1),
    generateKey: __nimbusCallbackAfterOptional(1),
    generatePrime: __nimbusCallbackAfterOptional(1),
    checkPrime: __nimbusCallbackAfterOptional(1),
    sign: __nimbusCallbackAt(3),
    verify: __nimbusCallbackAt(4),
  },
};
// Those whose functions throw workerd's NodeError (node-builtin-errors-match-node-workerd).
for (const name of ["zlib", "crypto"]) builtins[name] = __nimbusNodeErrorsAt(builtins[name], { callbacks: true, prototypes: true, held: __nimbusCallbackWork[name] });
builtins.string_decoder = __nimbusNodeErrorsAt(builtins.string_decoder, { prototypes: true });
for (const name of ["url", "vm"]) builtins[name] = __nimbusNodeErrorsAt(builtins[name]);
// node:path's posix half throws Node's errors itself (core _shared/posix-path.ts); matchesGlob is workerd's.
builtins.path.matchesGlob = __nimbusNodeErrorsOf(builtins.path.matchesGlob, false, null);
__nimbusNodeErrorsAt(builtins.events, { inPlace: true });
__nimbusNodeErrorsAt(__BufferMod, { inPlace: true });
// Node's argument checks in front of them (node-builtin-fronts.ts).
${NODE_BUILTIN_FRONTS_SOURCE}
__nimbusFrontZlib(builtins.zlib);
__nimbusFrontBuffer(builtins.buffer);
__nimbusFrontCrypto(builtins.crypto);
__nimbusFrontPath(builtins.path);
__nimbusFrontUrl(builtins.url);
__nimbusFrontEvents(builtins.events);

// ═══════════════════════════════════════════════════════════════════════
// ──  require() — full Node.js module resolution ─────────────────────
// ═══════════════════════════════════════════════════════════════════════
// package → why the package ABI policy says it cannot run here (wasm-swap-registry.ts).
const __nimbusAbiAdvisories = new Map(${ABI_ADVISORIES_LITERAL});

// CommonJS's names, which an ES module's scope binds none of: V8's
// ReferenceError for one is the loader's to explain (__nimbusExplainCommonJSGlobalLike).
const __nimbusCommonJSGlobalLike = ${JSON.stringify([...COMMONJS_WRAPPER_NAMES])};

// The errors __nimbusExplainCommonJSGlobalLike has explained.
const __nimbusExplained = new WeakSet();
function __nimbusIsCommonJSGlobalLikeError(e) {
  return e !== null && typeof e === "object" && (__nimbusExplained.has(e)
    || (e.name === "ReferenceError" && __nimbusCommonJSGlobalLike.some((name) => e.message === name + " is not defined")));
}

// Node's explainCommonJSGlobalLikeNotDefinedError (lib/internal/modules/esm/
// module_job.js, v22.23.4): what a ReferenceError for a CommonJS name says
// once it escapes the evaluation of an ES module job the loader ran: a
// program's ES entry, an import(), a require() of an ES module. \`url\` and
// \`hasTopLevelAwait\` are the job's module's. Thrown anywhere else (in a
// callback, or caught inside the module) it says what V8 says.
function __nimbusExplainCommonJSGlobalLike(e, url, hasTopLevelAwait) {
  if (e?.name === "ReferenceError" && __nimbusCommonJSGlobalLike.some((name) => e.message === name + " is not defined")) {
    __nimbusExplained.add(e);
    // The stack Node's error prints was formatted after this, with the
    // message as it ends; one formatted already leads with it too.
    const header = e.name + ": " + e.message;
    const stack = e.stack;
    if (hasTopLevelAwait) {
      e.message = "Cannot determine intended module format because both require() and top-level await are present. If the code is intended to be CommonJS, wrap await in an async function. If the code is intended to be an ES module, replace require() with import.";
      e.code = "ERR_AMBIGUOUS_MODULE_SYNTAX";
    } else {
      e.message += " in ES module scope";
      if (e.message.startsWith("require ")) e.message += ", you can use import instead";
      const packageConfig = url.startsWith("file://") && /\\.js(\\?[^#]*)?(#.*)?$/.exec(url) !== null
        && __esmResolver.packageScopeSync(url);
      if (packageConfig.type === "module") {
        e.message += "\\nThis file is being treated as an ES module because it has a '.js' file extension and '"
          + packageConfig.pjsonPath + "' contains \\"type\\": \\"module\\". To treat it as a CommonJS script, rename it to use the '.cjs' file extension.";
      }
    }
    if (typeof stack === "string" && stack.startsWith(header)) e.stack = e.name + ": " + e.message + stack.slice(header.length);
  }
}

/**
 * The loader's reads, through the process's filesystem's synchronous face
 * (its own writes included): resolver paths are already absolute names, so
 * none goes through the fs shim's cwd resolution.
 */
const __nimbusLoaderDecoder = new TextDecoder();
function __readFileOr(path, fallback) {
  const key = __vfsKey(path);
  // The read a miss of it stops a run at, and its miss: a one-shot's, run again as a resident (stop-replay.ts).
  const replayed = __nimbusReplay && !globalThis.__nimbusVfsSpeculation ? __nimbusReplay : null;
  replayed?.read(key);
  try {
    const bytes = __nimbusResidentFs().synchronous.readFile("/" + key);
    return bytes === null ? fallback : __nimbusLoaderDecoder.decode(bytes);
  } catch (error) {
    if (error && error.code === "EAGAIN") replayed?.miss(key);
    return fallback;
  }
}
// A name's stat as resolution asks it: undefined where there is none, and
// the filesystem's refusal (EAGAIN: a mount it cannot answer for) thrown,
// named, rather than "Cannot find module".
function __resolutionStat(path) {
  try { return __fsMod.statSync("/" + __vfsKey(path), { throwIfNoEntry: false }); }
  catch (error) {
    if (error && error.code === "EAGAIN") throw error;
    return undefined;
  }
}
function __fileExists(path) {
  return __resolutionStat(path) !== undefined;
}
// Resolution is the compiled core generator, over the guest's resident fs.
// Metadata/refusal handling stays here; selection and probing never do.
${NODE_SHIM_RESOLUTION_PREAMBLE}
const __requireResolver = createRequireResolver({
  kind(path) {
    const st = __resolutionStat(path);
    return !st ? null : st.isDirectory() ? "directory" : st.isFile() ? "file" : null;
  },
  readText(path) { return __readFileOr(path, null); },
  realpath(path) { return __fsMod.realpathSync(path); },
  isBuiltin(specifier) {
    return __nimbusBuiltinId(specifier) !== null;
  },
}, { conditions: __nimbusConditions, policy: NIMBUS_TYPESCRIPT_REQUIRE_POLICY, collectPackageScope: false });

/**
 * Load and execute a JS/JSON module from VFS.
 * Returns the module.exports value.
 *
 * A JS module is one of the launch's module cells: the guest's registry
 * compiles it the first time it is required (core/_shared/commonjs-cell.ts),
 * and this calls the wrapper function it exports with the scoped require.
 * Nothing here compiles source: request-time code generation is not
 * available in a Worker, so a file the launch did not map cannot run.
 */
// import.meta of the module file at \`filename\`, evaluated as \`url\`: an
// entry script's or a loaded module's. It lives on the module, not in source
// text, so the five CommonJS arguments stay as they are, and
// import.meta.resolve keeps its parent even when extracted and called later.
// The registry's own import.meta cannot serve: its module URLs all live
// under file:///bundle/, never at the file's own path. dirname and filename
// name the file, without the URL's query or fragment.
// \`main\`: whether the module is the program's entry, as Node 22's import.meta.main.
function __nimbusFileImportMeta(filename, url = __nimbusFileHref(filename), main = false) {
  // Made over nothing, so each assignment meets no setter a program put on Object.prototype.
  const meta = __nimbusObjectCreate(null);
  meta.dirname = __pathMod.dirname(filename);
  meta.filename = filename;
  meta.main = main;
  meta.resolve = (specifier) => globalThis.__nimbusImportMetaResolve(specifier, url);
  meta.url = url;
  return meta;
}

// Errors a known Workers-incompatible package's load threw, advised once.
const __nimbusAdvised = new __NimbusSafeWeakSet();
// The CommonJS modules whose bodies are running now (Node's kIsExecuting):
// an ES module that imports one is in a require(esm) cycle.
const __nimbusExecutingCommonJs = new __NimbusSafeWeakSet();
// \`required\`: loaded by a require() call, not by an import of a CommonJS or
// JSON module (an import of an ES module is its graph's: __nimbusGraphRecord).
// A staged ES module is the registry's (__nimbusEsmRequire): this loads it
// only when the interpreter evaluates it instead.
function __loadModule(resolvedPath, evaluationKey = resolvedPath, required = true, parent = undefined) {
  const cacheKey = evaluationKey === resolvedPath ? "/" + __vfsKey(resolvedPath) : evaluationKey;
  // A CommonJS module an import read the syntax of, not yet run: run now, once (__nimbusCommonJsPending).
  const pending = __nimbusCommonJsPending.get(cacheKey);
  if (pending !== undefined) {
    __nimbusCommonJsPending.delete(cacheKey);
    return __nimbusRunCommonJs(pending);
  }
  // An ES module its graph has a record of: that record's, as require() evaluates one (require(esm)).
  const record = __nimbusGraphRecords.get(cacheKey);
  if (record !== undefined && record.state !== undefined) {
    if (typeof __resident !== "undefined" && __resident.observeRead !== null) __resident.observeRead(__vfsKey(String(resolvedPath)));
    return __nimbusRequireRecord(record, parent);
  }
  const loaded = __nimbusPrepareModule(resolvedPath, evaluationKey, required, parent, false);
  if (loaded.state === undefined) return loaded.exports;
  // An ES module (by its format, its syntax, or staged): its graph's.
  if (__nimbusModuleLink(loaded.state.cell) !== null) return __nimbusRequireRecord(__nimbusInterpretedRecord(loaded.state), parent);
  return __nimbusRunCommonJs(loaded.state);
}
// The CommonJS modules an import read the syntax of (a typeless .js) and has
// not run yet, by cacheKey: each runs once, where its graph evaluates it or
// where a require() of it comes first.
const __nimbusCommonJsPending = new __NimbusSafeMap();
// What loading the file at \`resolvedPath\` as \`evaluationKey\` finds: its
// exports where it is loaded already, or JSON (\`exports\`); else what to
// evaluate it from (\`state\`): its Module, in require.cache, or the ES
// loader's for an import of an ES module (\`esModule\`), its import.meta, and
// its cell compiled, nothing of it run.
function __nimbusPrepareModule(resolvedPath, evaluationKey, required, parent, esModule) {
  if (typeof __resident !== "undefined" && __resident.observeRead !== null) __resident.observeRead(__vfsKey(String(resolvedPath)));
  // A module's load reads its file, held in the map or not: where a miss of it stopped the run before (__readFileOr).
  __nimbusReplay?.read(__vfsKey(String(resolvedPath)));
  const filename = "/" + __vfsKey(resolvedPath);
  const normalizedPath = __pathSlice(filename, 1);
  // A query's or fragment's import is a job of its own, kept by its URL.
  const cacheKey = evaluationKey === resolvedPath ? filename : evaluationKey;
  // A staged ES module: its namespace once the registry evaluated it, else
  // the interpreter's evaluation of it, below (an instance of its own, for
  // a query or a fragment, always).
  const esmId = __nimbusEsmId("module", normalizedPath);
  const adopted = esmId !== -1 && evaluationKey === resolvedPath;
  // An ES module an import loaded is the ES loader's; require.cache has it
  // once a require() loads it (require(esm)), as Node's has.
  const cached = __NodeModule._cache[cacheKey] ?? __nimbusEsmInstances.get(cacheKey);
  // An adopted ES module still evaluating: a require() of it is a cycle.
  if (cached !== undefined && adopted && required && !cached.loaded) __nimbusEsmRequire(esmId, true, parent);
  if (cached !== undefined) {
    // A require() of an ES module whose graph awaits at its top level, imported already: Node's refusal still.
    if (required && cached.loaded && adopted && __nimbusEsmGraphAwaits(esmId)) throw __nimbusRequireAsync(parent, filename);
    __nimbusUpdateChildren(parent, cached, true);
    if (required) __NodeModule._cache[cacheKey] ??= cached;
    const record = adopted ? __nimbusEsmRecords[esmId] : undefined;
    return { exports: required && record?.namespace ? __nimbusEsmRequired(record) : cached.exports };
  }
  if (adopted) {
    const namespace = __nimbusEsmRequire(esmId, required, parent);
    if (namespace !== null) return { exports: namespace };
  }

  const mod = new __NodeModule(filename, parent);
  mod.filename = filename;
  mod.paths = __NodeModule._nodeModulePaths(mod.path);
  // An imported JSON file is require()'s too, as Node's JSON translator
  // keeps it; a query's or a fragment's is its own.
  if (esModule && !required && !(__pathEndsWith(resolvedPath, ".json") && cacheKey === filename)) __nimbusEsmInstances.set(cacheKey, mod);
  else __NodeModule._cache[cacheKey] = mod;
  const unload = () => {
    if (__NodeModule._cache[cacheKey] === mod) delete __NodeModule._cache[cacheKey];
    if (__nimbusEsmInstances.get(cacheKey) === mod) __nimbusEsmInstances.delete(cacheKey);
    const siblings = parent?.children;
    const at = __nimbusIsArray(siblings) ? __nimbusIndexOf(siblings, mod) : -1;
    // Node's own removal (ArrayPrototypeSplice), on the launch's capture.
    if (at !== -1) __nimbusPrimordials.arraySplice(siblings, at, 1);
  };

  // JSON (Module._extensions[".json"])
  if (__pathEndsWith(resolvedPath, ".json")) {
    const code = __readFileOr(resolvedPath, null);
    try {
      if (code === null) throw new Error("Cannot read module: " + resolvedPath);
      try {
        mod.exports = __nimbusJsonParse(__pathCharCodeAt(code, 0) === 0xFEFF ? __pathSlice(code, 1) : code);
      } catch (error) {
        error.message = filename + ": " + error.message;
        throw error;
      }
    } catch (error) {
      unload();
      throw error;
    }
    mod.loaded = true;
    return { exports: mod.exports };
  }

  // JS — the cell's wrapper: a CommonJS module's, called with the module's
  // require (__nimbusRunCommonJs); an ES module's, linked and evaluated by
  // its graph (__nimbusInterpretedRecord).
  const modDir = __pathMod.dirname(filename);

  // X.5-M3: thread currently-loading module path through globalThis so the
  // URL shim null-base fallback (in node-shims url module) can compose
  // relative URLs against the real module location. Save+restore for
  // recursive __loadModule.
  const __prevModulePath = globalThis.__currentModulePath;
  globalThis.__currentModulePath = resolvedPath;
  const moduleUrl = __pathStartsWith(evaluationKey, "file:")
    ? evaluationKey : __nimbusFileHref("/" + resolvedPath);
  __nimbusDefine(mod, "__nimbusImportMeta", __nimbusData(__nimbusFileImportMeta("/" + resolvedPath, moduleUrl), false, false, false));
  try {
    __nimbusLoadsTypeScript(normalizedPath);
    let cell = esmId === -1 ? __nimbusModuleCell(normalizedPath) : null;
    let compiledText = null;
    if (esmId !== -1) {
      // The staged module's own text, as it was before it was staged. Node's
      // ES loader warns of a typeless one it loads; its require() does not.
      if (!required) __nimbusEsmWarnTypeless(esmId);
      compiledText = __nimbusEsmSourceText(esmId);
      cell = __nimbusAdoptedModule(normalizedPath, compiledText);
    } else if (!cell) {
      // Not in the launch's map: written after it started, or not reached by
      // its closure. Kept apart from the read ledger, which settles reads. By
      // path, the next launch stages the file if it is still there; by
      // content, this text wherever it was written (a fresh name each run
      // included) — core/_shared/commonjs-cell.ts, RUNTIME CODE. A content
      // key the launch already carries answers now.
      (globalThis.__nimbusModuleMisses ??= new __NimbusSafeSet()).add(normalizedPath);
      if (typeof __nimbusNotifyRuntimeCode === "function") __nimbusNotifyRuntimeCode();
      const text = __readFileOr(resolvedPath, null);
      if (text === null) throw new Error("Cannot load module '" + resolvedPath + "': it was not in this launch's module map; the next launch of the same command stages it.");
      // In the format the loader gives the file: a typeless .js, imported or
      // required, is CommonJS or an ES module by its syntax, as Node detects it.
      const format = __nimbusFileFormat(filename);
      cell = __nimbusRuntimeModule(normalizedPath, text, format);
      compiledText = text;
      // An imported .js its syntax made an ES module warns as a staged one does.
      if (!required && format === undefined && filename.endsWith(".js") && __nimbusDetectedModule(cell)) {
        const scope = __esmResolver.packageScopeSync(__nimbusEsmUrl(filename));
        if (scope.exists && scope.type === "none") __nimbusWarnTypeless(filename, scope.pjsonPath);
      }
      globalThis.__nimbusModuleMisses.delete(normalizedPath);
    }
    __nimbusCompiling("/" + normalizedPath, () => compiledText ?? __nimbusModuleSourceText(__nimbusModuleAtPath(normalizedPath)));
    return { state: { mod, cell, filename, modDir, moduleUrl, cacheKey, resolvedPath, esmId, adopted, unload, required, data: false } };
  } catch (e) {
    unload();
    // An adopted ES module that does not compile stays failed: the next
    // require() or import() of it throws what it threw (Node's errored module record).
    if (adopted) {
      const record = __nimbusEsmRecord(esmId);
      record.state = __ESM_FAILED;
      record.error = { value: e };
    }
    __nimbusAdvise(e, resolvedPath);
    throw e;
  } finally {
    globalThis.__currentModulePath = __prevModulePath;
  }
}
// Runs a CommonJS module's cell, as Node's loader calls its wrapper: its
// \`this\` its exports, its require its own; its exports.
function __nimbusRunCommonJs(state) {
  const { mod, cell, filename, modDir, resolvedPath } = state;
  const __prevModulePath = globalThis.__currentModulePath;
  globalThis.__currentModulePath = resolvedPath;
  try {
    const scopedRequire = __nimbusMakeRequire(mod, modDir);
    __nimbusExecutingCommonJs.add(mod);
    try {
      __nimbusReflectApply(cell, mod.exports, [mod.exports, scopedRequire, mod, filename, modDir]);
    } finally {
      __nimbusExecutingCommonJs.delete(mod);
    }
  } catch (e) {
    state.unload();
    __nimbusAdvise(e, resolvedPath);
    throw e;
  } finally {
    globalThis.__currentModulePath = __prevModulePath;
  }
  mod.loaded = true;
  return mod.exports;
}
// What escapes a module is the program's own error, as Node leaves it; only
// a package Nimbus knows has no Workers build says so, once. A ReferenceError
// for a CommonJS name is the module loader's to explain, and nothing else's.
function __nimbusAdvise(e, resolvedPath) {
  if (__nimbusIsCommonJSGlobalLikeError(e) || !e || typeof e !== "object" || __nimbusAdvised.has(e)) return;
  try {
    const at = resolvedPath.lastIndexOf("node_modules/");
    const parts = at < 0 ? [] : resolvedPath.slice(at + 13).split("/");
    const pkg = parts[0] && parts[0].startsWith("@") ? parts[0] + "/" + parts[1] : parts[0];
    const advisory = pkg ? __nimbusAbiAdvisories.get(pkg) : undefined;
    if (advisory) {
      __nimbusAdvised.add(e);
      const note = "\\nNimbus: " + pkg + " has no Workers-compatible build: " + advisory;
      if (typeof e.message === "string") e.message += note;
      if (typeof e.stack === "string") e.stack += note;
    }
  } catch {}
}

/**
 * Resolve a module ID from a given directory.
 * Returns the resolved VFS path, or null.
 */
function __resolveFrom(id, fromDir, parentFile) {
  const found = __requireResolver.resolveSync(id, "/" + __vfsKey(String(fromDir)), typeof parentFile === "string" ? { parent: parentFile } : undefined);
  if (!found) return null;
  return found.builtin ? "node:" + found.builtin : __vfsKey(found.path);
}

// ═══════════════════════════════════════════════════════════════════════
// ──  import() — Node's ESM loader ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// A cell's dynamic import() reaches here with its module's URL
// (core/runtime/dynamic-import-rewrite.ts). Resolution is Node's ESM
// algorithm (core/_shared/esm-resolver.ts, interpolated below): the "import"
// conditions, no extension probing, a directory refused by name, file: URLs,
// Node's error codes and messages. What resolves loads through the same
// module cache require uses, shaped as the namespace Node would give.
// Node's ESM resolver (core/_shared/esm-resolver.ts, compiled once by
// scripts/bundle-facet-workers.mjs): declares createEsmResolver.
${ESM_RESOLVER_PREAMBLE}
const __esmResolver = createEsmResolver({
  kind(path) {
    const st = __fsMod.statSync(path, { throwIfNoEntry: false });
    return !st ? null : st.isDirectory() ? "directory" : st.isFile() ? "file" : null;
  },
  realpath(path) {
    try { return __fsMod.realpathSync(path); } catch { return path; }
  },
  readText(path) { return __readFileOr(path, null); },
  // Node's builtins, and the packages the process provides in place of any
  // installed copy (builtins.undici), which load as builtins do.
  isBuiltin(specifier) {
    return __nimbusBuiltinId(specifier) !== null
      || __nimbusFacetProvidedPackages.has(__pathStartsWith(specifier, "node:") ? __pathSlice(specifier, 5) : specifier);
  },
  cjsResolve: __nimbusCjsResolve,
}, { conditions: __nimbusConditions, stripTypes: !__nimbusTypeScriptAsJavaScript, cwd: () => __processMod.cwd() });
// The file require() loads for \`specifier\` from the module at \`parentPath\`, or null.
function __nimbusCjsResolve(specifier, parentPath) {
  try {
    const dir = parentPath.slice(0, parentPath.lastIndexOf("/")).replace(/^\\/+/, "");
    const found = __resolveFrom(specifier, dir);
    return found ? "/" + String(found).replace(/^\\/+/, "") : null;
  } catch { return null; }
}
const __esmNamespaces = new __NimbusSafeMap();
/** A module namespace: its names sorted, read through to the exports. */
function __esmNamespaceOf(names, read) {
  const ns = __nimbusObjectCreate(null);
  // \`names\`: a Set (a SafeSet's own forEach) or a list, in code-unit order as sort() orders strings.
  const sorted = new __PathList();
  if (__nimbusIsArray(names)) for (let i = 0; i < names.length; i++) sorted[sorted.length] = names[i];
  else names.forEach((name) => { sorted[sorted.length] = name; });
  __nimbusSort(sorted, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    const name = sorted[i];
    const getter = __nimbusObjectCreate(null);
    getter.enumerable = true;
    getter.get = () => read(name);
    __nimbusDefine(ns, name, getter);
  }
  __nimbusDefine(ns, __nimbusPrimordials.symbolToStringTag, __nimbusData("Module", false, false, false));
  return __nimbusPreventExtensions(ns);
}
// A builtin's (or a staged N-API binding's) namespace: \`value\` as default, its own names read through.
function __nimbusObjectNamespace(value) {
  const names = new __NimbusSafeSet();
  const keys = value && (typeof value === "object" || typeof value === "function") ? __nimbusKeys(value) : [];
  for (let i = 0; i < keys.length; i++) names.add(keys[i]);
  names.add("default");
  return __esmNamespaceOf(names, (name) => name === "default" ? value : value[name]);
}
function __nimbusCommonJsNames(key) {
  return __nimbusRegistryRequire("./${RUNTIME_ESM_LATE_MODULE}").commonJsNames(__nimbusLateLinkHost, key);
}
// Node's translator's namespace for the CommonJS or JSON module
// \`resolution\` names, one per URL: its names known before the module runs
// (JSON's default; CommonJS's default and its lexer's names), \`fill\` giving
// their values once it has: JSON's value as default; CommonJS's
// module.exports as default (whatever its __esModule) and each lexed name's
// own value then (createCJSModuleWrap). Filled, it is import()'s too.
const __nimbusTranslations = new __NimbusSafeMap();
function __nimbusTranslation(resolution) {
  const known = __nimbusTranslations.get(resolution.url);
  if (known !== undefined) return known;
  const names = resolution.format === "json" ? [] : __nimbusCommonJsNames(__vfsKey(resolution.path));
  const named = new __NimbusSafeSet();
  named.add("default");
  for (let i = 0; i < names.length; i++) named.add(names[i]);
  let read = () => undefined;
  const translation = {
    namespace: __esmNamespaceOf(named, (name) => read(name)),
    filled: false,
    fill(exports) {
      if (translation.filled) return;
      translation.filled = true;
      if (resolution.format === "json") {
        read = () => exports;
      } else {
        const values = new __NimbusSafeMap();
        for (let i = 0; i < names.length; i++) {
          const name = names[i];
          if (name === "default" || !__nimbusPrimordials.objectHasOwn(exports, name)) continue;
          // A getter may throw: the name is then undefined, as Node's.
          try { values.set(name, exports[name]); } catch {}
        }
        read = (name) => name === "default" ? exports : values.get(name);
      }
      __esmNamespaces.set(resolution.url, translation.namespace);
    },
  };
  __nimbusTranslations.set(resolution.url, translation);
  return translation;
}
// An import of a module that is not an ES module, loaded as \`exports\`, as Node's translators make it, one per URL:
// a builtin as default, its names read through; JSON and CommonJS their translation's (__nimbusTranslation).
function __nimbusTranslatedNamespace(resolution, exports) {
  if (resolution.format !== "builtin") {
    const translation = __nimbusTranslation(resolution);
    translation.fill(exports);
    return translation.namespace;
  }
  const cached = __esmNamespaces.get(resolution.url);
  if (cached !== undefined) return cached;
  const ns = __nimbusObjectNamespace(exports);
  __esmNamespaces.set(resolution.url, ns);
  return ns;
}
// Node's defaultLoad: a module the ES loader has no job for must have a format.
// Its jobs are keyed by URL and attribute type; only an implicit-type one can
// have been loaded without a format (by require(esm)).
function __nimbusAssertLoadable(resolution, type) {
  if (type === undefined && (__esmNamespaces.has(resolution.url) || __nimbusEsmJobCached(resolution.path))) return;
  __esmResolver.assertLoadable(resolution);
}
// ═══════════════════════════════════════════════════════════════════════
// ──  Native ES modules (core runtime/native-esm.ts) ─────────────────
// ═══════════════════════════════════════════════════════════════════════
// The launch's ES modules are the registry's: it links them, evaluates them,
// and keeps their bindings live (worker facets/esm-stage.ts stages them).
// Its table, by id (a meta instance's query): [kind, key or builtin, a
// module's targets' ids, 1 for Bun's scope]; and what each refused specifier
// fails with, by the number of the missing module it names.
const __nimbusEsm = typeof __NIMBUS_ESM === "undefined" || __NIMBUS_ESM === null ? { table: [], missing: [] } : __NIMBUS_ESM;
let __nimbusEsmIds = null;
// Node's format for the file at \`filename\` where its extension or its
// package's "type" says it ("module" or "commonjs"), else undefined: its
// syntax decides (detection).
function __nimbusFileFormat(filename) {
  try {
    const url = __nimbusEsmUrl(filename);
    const format = __esmResolver.resolveSync(url, url).format;
    return format === "module" || format === "commonjs" ? format : undefined;
  } catch {
    return undefined;
  }
}
// The map module of row \`id\` (worker facets/esm-stage.ts esmRowName): a
// staged module's cell's module, else its facade by id.
function __nimbusEsmName(id) {
  const row = __nimbusEsm.table[id];
  return row[0] === "module" ? __nimbusCodeCells.get(row[1])[1] : ${JSON.stringify(ESM_FACADE_DIR)} + id + ".js";
}
// The row of the module of \`kind\` at \`key\` (a builtin's name), or -1.
function __nimbusEsmId(kind, key) {
  if (__nimbusEsm.table.length === 0) return -1;
  if (__nimbusEsmIds === null) {
    __nimbusEsmIds = new __NimbusSafeMap();
    for (let id = 0; id < __nimbusEsm.table.length; id++) {
      const row = __nimbusEsm.table[id];
      if (row !== undefined) __nimbusEsmIds.set(row[0] + ":" + row[1], id);
    }
  }
  return __nimbusEsmIds.get(kind + ":" + key) ?? -1;
}
// What became of each module: its meta instance evaluated (linked into an
// evaluation, a "batch"), its body begun, its body done (its namespace
// registered), its body stopped by Nimbus before it began (its record's
// error is Nimbus's own, never the program's), evaluated by the interpreter
// instead (adopted), or its body threw (its record keeps what it threw).
const __ESM_LINKED = 1, __ESM_BEGAN = 2, __ESM_DONE = 3, __ESM_STOPPED = 4, __ESM_ADOPTED = 5, __ESM_FAILED = 6;
const __nimbusEsmRecords = [];
function __nimbusEsmRecord(id) {
  return __nimbusEsmRecords[id] ??= { id, state: 0, batch: null, namespace: null, required: undefined, error: undefined, module: undefined, requirer: undefined };
}
// What a body Nimbus stops throws, and a batch Nimbus cancels rejects with:
// made the first time one is. An Error made as the shims start cost every
// launch 10 to 19 ms, a program that never meets an ES module's included
// (its stack's capture; ThinGerbil's paired measurement).
let __nimbusEsmStopped = null;
function __nimbusEsmStop() {
  return __nimbusEsmStopped ??= new Error("Nimbus: this module was not evaluated by the registry");
}
// Whether \`error\` is that stop, never making it.
function __nimbusIsEsmStop(error) {
  return __nimbusEsmStopped !== null && error === __nimbusEsmStopped;
}
// How often the interpreter evaluated a staged module instead (adoption): the exit's diagnostics.
let __nimbusEsmAdoptions = 0;
// The ES modules the interpreter evaluated for an import (a query's or a
// fragment's instance, an adopted module, a file outside the map), by
// evaluation key: the ES loader's, never require.cache's until required.
const __nimbusEsmInstances = new __NimbusSafeMap();
// The batch the meta instances evaluating now join: one evaluation's, which
// runs every meta instance it links in one synchronous turn, and ends with it.
let __nimbusEsmOpenBatch = null;
// How many evaluations have opened: an import() knows which began after it.
let __nimbusEsmBatches = 0;
// What each import() in flight resolves once its graph has loaded (__nimbusEsmImport).
const __nimbusEsmLoading = new __NimbusSafeSet();
const __nimbusEsmResolved = Promise.resolve();
const __nimbusEsmThen = Promise.prototype.then;
// A builtin facade's reads again of its builtin's names (module.syncBuiltinESMExports).
const __nimbusEsmResyncs = [];
// A file: URL of a VFS path, as Node's loader names a module.
function __nimbusEsmUrl(path) {
  const url = new URL("file://");
  url.pathname = path;
  return url.href;
}
// What a module's meta instance hands it (native-esm.ts metaModuleSource):
// import.meta, its import(), the check its body opens with, and its
// registration; a facade, what it loads; a builtin's, its resync hook.
function __nimbusEsmEnter(metaUrl) {
  const id = Number(String(metaUrl).slice(String(metaUrl).lastIndexOf("?") + 1));
  const row = __nimbusEsm.table[id];
  const record = __nimbusEsmRecord(id);
  if (__nimbusEsmOpenBatch === null) {
    // An evaluation begins: the graphs it loads are loaded.
    const loading = [...__nimbusEsmLoading];
    __nimbusEsmLoading.clear();
    for (const loaded of loading) loaded();
    __nimbusEsmOpenBatch = { running: new __NimbusSafeSet(), stop: null, thrower: null, seq: ++__nimbusEsmBatches };
    __nimbusReflectApply(__nimbusEsmThen, __nimbusEsmResolved, [() => { __nimbusEsmOpenBatch = null; }]);
  }
  record.batch = __nimbusEsmOpenBatch;
  record.state = __ESM_LINKED;
  const c = () => __nimbusEsmCheck(record);
  const r = (namespace) => {
    record.state = __ESM_DONE;
    record.namespace = namespace ?? null;
    record.batch.running.delete(record);
  };
  if (row[0] === "module") {
    const filename = "/" + row[1];
    const url = __nimbusEsmUrl(filename);
    // Compiled now, as Node's loader compiles it: its source map, where source maps are on.
    __nimbusCompiling(url, () => __nimbusEsmSourceText(id));
    const scope = { m: __nimbusFileImportMeta(filename, url, row[1] === __nimbusEsmEntryKey), i: (specifier, options) => globalThis.__nimbusDynamicImport(url, specifier, options), c, r };
    // Bun's scope binds require, __filename and __dirname too (native-esm.ts bunScopeNames).
    if (((row[3] ?? 0) & ${ESM_BUN_SCOPE}) !== 0) Object.assign(scope, { q: __NodeModule.createRequire(filename), f: filename, d: __pathMod.dirname(filename) });
    return scope;
  }
  if (row[0] === "commonjs") return { c, r, l: () => __loadModule(row[1], row[1], true) };
  // An ES module's import of a JSON file: Node's JSON translator, whose value
  // is require()'s for the same file, one object in require.cache whichever
  // loads it first.
  if (row[0] === "json") return { c, r, l: () => __loadModule(row[1], row[1], true) };
  return { c, r, l: () => builtins[row[1]], s: (resync) => { __nimbusEsmResyncs.push(resync); } };
}
// A body begins: unless an earlier body of its batch threw (Node's
// evaluation stops at the first error) or Nimbus cancelled the batch. A body
// that began and has not completed threw, or waits at a top-level await.
function __nimbusEsmCheck(record) {
  const batch = record.batch;
  if (batch.stop === null) {
    for (const began of batch.running) {
      if (__nimbusEsmSuspends(began)) continue;
      batch.stop = __nimbusEsmStop();
      batch.thrower = began;
      began.state = __ESM_FAILED;
      break;
    }
  }
  if (batch.stop !== null) {
    record.state = __ESM_STOPPED;
    throw batch.stop;
  }
  record.state = __ESM_BEGAN;
  batch.running.add(record);
}
// Whether a module's body awaits at its top level, as staging read it.
function __nimbusEsmSuspends(record) {
  const row = __nimbusEsm.table[record.id];
  return row[0] === "module" && ((row[3] ?? 0) & ${ESM_TOP_LEVEL_AWAIT}) !== 0;
}
// Whether a module of row \`id\`'s graph awaits at its top level: Node's
// require() refuses such a graph, evaluated or not. The table does not
// change, so neither does the answer: kept per row.
const __nimbusEsmAwaits = [];
function __nimbusEsmGraphAwaits(id) {
  return __nimbusEsmAwaits[id] ??= __nimbusEsmGraphWalksAwait(id);
}
function __nimbusEsmGraphWalksAwait(id) {
  const seen = new __NimbusSafeSet();
  const stack = [id];
  while (stack.length > 0) {
    const at = stack.pop();
    if (at < 0 || seen.has(at)) continue;
    seen.add(at);
    const row = __nimbusEsm.table[at];
    if (row[0] !== "module") continue;
    if (((row[3] ?? 0) & ${ESM_TOP_LEVEL_AWAIT}) !== 0) return true;
    for (const target of row[2]) stack.push(target);
  }
  return false;
}
// A staged module's text as it was before it was staged: what the
// interpreter evaluates when it adopts the module.
function __nimbusEsmSourceText(id) {
  const module = __nimbusModuleAtPath(__nimbusEsm.table[id][1]);
  const text = __nimbusModuleSourceText(module);
  if (text === null) throw new Error("Nimbus: cannot read the staged module " + __nimbusEsmName(id));
  return module.hashbang ? "#!" + text.slice(2) : text;
}
// Whether the registry cannot evaluate the module with Node's semantics:
// something its graph links to that the registry has not evaluated was
// evaluated by the interpreter instead, which the registry would evaluate
// again. (A module Nimbus stopped fails the registry's evaluation with
// Nimbus's own error, which hands the module to the interpreter then.)
function __nimbusEsmTainted(id) {
  const seen = new __NimbusSafeSet();
  const stack = [id];
  while (stack.length > 0) {
    const at = stack.pop();
    if (at < 0 || seen.has(at)) continue;
    seen.add(at);
    const record = __nimbusEsmRecords[at];
    if (record !== undefined) {
      if (record.state === __ESM_DONE) continue;
      // Evaluated by the interpreter, or failed there: what it threw is the
      // interpreter's to give again (Node's errored module), not the registry's to evaluate.
      if (record.state === __ESM_ADOPTED || (record.state === __ESM_FAILED && record.error !== undefined)) return true;
    }
    const row = __nimbusEsm.table[at];
    if (row[0] === "module") for (const target of row[2]) stack.push(target);
  }
  return false;
}
// require() of a staged ES module, or an interpreted module's static import
// of one: its namespace once the registry evaluated it (Node's
// require(esm) shape for a require), null where the interpreter is to
// evaluate it (its record given up), else Node's refusal.
// Node's refusal of a require() whose graph has top-level await.
function __nimbusRequireAsync(parent, filename) {
  return nodeError(Error, "ERR_REQUIRE_ASYNC_MODULE", "require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.\\n  From " + (parent?.filename ?? "") + " \\n  Requiring " + filename + " ");
}
function __nimbusEsmRequire(id, required, parent = undefined) {
  const record = __nimbusEsmRecord(id);
  if (record.state === __ESM_DONE) {
    if (!required) return record.namespace;
    const filename = "/" + __nimbusEsm.table[id][1];
    if (__nimbusEsmGraphAwaits(id)) throw __nimbusRequireAsync(parent, filename);
    // Node's require(esm) leaves a Module in require.cache, and takes it again after a delete.
    if (record.module === undefined) {
      record.module = new __NodeModule(filename, null);
      record.module.filename = filename;
      record.module.paths = __NodeModule._nodeModulePaths(__pathMod.dirname(filename));
      record.module.exports = __nimbusEsmRequired(record);
      record.module.loaded = true;
    }
    __NodeModule._cache[filename] ??= record.module;
    return record.module.exports;
  }
  // Evaluated by the interpreter already: its result, its Module in require.cache again.
  if (record.state === __ESM_ADOPTED && record.module !== undefined && record.namespace !== null) {
    if (required && __nimbusEsmGraphAwaits(id)) throw __nimbusRequireAsync(parent, "/" + __nimbusEsm.table[id][1]);
    if (required) __NodeModule._cache[record.module.filename] ??= record.module;
    return required ? __nimbusEsmRequired(record) : record.module.exports;
  }
  // It threw: what it threw, once its evaluation's rejection said.
  if (record.state === __ESM_FAILED && record.error !== undefined) throw record.error.value;
  // An import()'s link failed in it: that failure, as Node's loader keeps the ModuleJob (esm-late-link keptFailure).
  const kept = __nimbusLateModule?.keptFailure(__nimbusEsm.table[id][1]);
  if (kept !== undefined) throw kept;
  const filename = "/" + __nimbusEsm.table[id][1];
  // Evaluating, for an import: Node's ESM loader's refusal, naming the requirer.
  if (record.state === __ESM_BEGAN || (record.state === __ESM_ADOPTED && record.namespace === null && record.requirer === undefined)) {
    if (__nimbusEsmSuspends(record)) throw __nimbusRequireAsync(parent, filename);
    throw nodeError(Error, "ERR_REQUIRE_CYCLE_MODULE", "Cannot require() ES Module " + filename + " in a cycle." + (parent?.filename ? " (from " + parent.filename + ")" : "") + " A cycle involving require(esm) is not allowed to maintain invariants mandated by the ECMAScript specification. Try making at least part of the dependency in the graph lazily loaded.");
  }
  // Evaluating, for a require(): Node's CommonJS loader's, naming the require that began it.
  if (record.state === __ESM_ADOPTED && record.namespace === null) {
    throw nodeError(Error, "ERR_REQUIRE_CYCLE_MODULE", "Cannot require() ES Module " + filename + " in a cycle." + (record.requirer ? " (from " + record.requirer + ")" : ""));
  }
  // A require() refuses a graph with top-level await before any of it runs,
  // as Node's does: its modules evaluated or not (an import() may have
  // completed one already).
  if (required && record.state !== __ESM_ADOPTED && __nimbusEsmGraphAwaits(id)) throw __nimbusRequireAsync(parent, filename);
  // Linked into an evaluation that has not reached it: that evaluation is
  // cancelled (each body yet to begin stops), and the module is the interpreter's.
  if (record.state === __ESM_LINKED && record.batch.stop === null) record.batch.stop = __nimbusEsmStop();
  if (record.state !== __ESM_ADOPTED) {
    record.state = __ESM_ADOPTED;
    // Who began it, for a cycle's refusal: a require()'s module, or none for an import.
    record.requirer = required ? parent?.filename ?? "" : undefined;
    __nimbusEsmAdoptions++;
    // NIMBUS_DIAG_ESM=1: each adoption named on stderr, to count them in a workload.
    if (__processMod.env.NIMBUS_DIAG_ESM === "1") {
      try { __processMod.stderr.write("nimbus-esm: adopted /" + __nimbusEsm.table[id][1] + (required ? " (require)" : " (import)") + "\\n"); } catch {}
    }
  }
  return null;
}
// Node's require(esm) result of a record's namespace (core runtime/native-esm-runtime.ts requiredEsModule).
const __nimbusEsmRequired = ${ESM_REQUIRED_SOURCE}.requiredEsModule;
const { importCallArguments: __nimbusImportCallArguments, dataModule: __nimbusDataModuleOf } = ${ESM_LOADER_POLICY_SOURCE};
// ECMA-262's module graph algorithm (core runtime/esm-graph.ts), made before any program runs: it calls only the
// built-ins it took then.
const __nimbusGraph = ${ESM_GRAPH_SOURCE};
// The package.json files Node's loader has warned are typeless (MODULE_TYPELESS_PACKAGE_JSON).
const __nimbusTypelessWarned = new __NimbusSafeSet();
// Node's warning of an imported .js that is an ES module by its syntax alone
// under \`pjsonPath\`, a package.json with no "type" (get_format.js
// warnTypelessPackageJsonFile): once per package.json, never under node_modules.
function __nimbusWarnTypeless(path, pjsonPath) {
  if (__nimbusTypelessWarned.has(pjsonPath) || path.includes("/node_modules/")) return;
  __nimbusTypelessWarned.add(pjsonPath);
  __processMod.emitWarning("Module type of " + __nimbusEsmUrl(path) + " is not specified and it doesn't parse as CommonJS.\\n"
    + "Reparsing as ES module because module syntax was detected. This incurs a performance overhead.\\n"
    + "To eliminate this warning, add \\"type\\": \\"module\\" to " + pjsonPath + ".", { code: "MODULE_TYPELESS_PACKAGE_JSON" });
}
// Node's warning as it loads a \`.js\` that is a module by its syntax alone
// under a package.json with no "type", once per package.json, naming the
// first such module it loads: \`id\`'s graph, in the order a load reaches
// it (each module, then the modules it imports, level by level).
function __nimbusEsmWarnTypeless(id) {
  const seen = new __NimbusSafeSet();
  seen.add(id);
  const queue = [id];
  for (let at = 0; at < queue.length; at++) {
    const row = __nimbusEsm.table[queue[at]];
    if (row[0] !== "module") continue;
    if (((row[3] ?? 0) & ${ESM_TYPELESS}) !== 0) __nimbusWarnTypeless("/" + row[1], row[4]);
    for (const target of row[2]) {
      if (target >= 0 && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
}
// The namespace of the staged module (or facade) \`id\`, evaluated by the
// registry where it can be; the one place Nimbus calls the registry's import().
async function __nimbusEsmImport(id, entry = false) {
  const record = __nimbusEsmRecord(id);
  if (record.state === __ESM_DONE && record.namespace !== null) return record.namespace;
  const row = __nimbusEsm.table[id];
  // The entry's typeless warning waits for its evaluation to begin: Node's,
  // a next tick's, never prints where the entry's graph does not link and
  // its failure ends the process first (__nimbusHeldEntryWarning). An
  // import()'s failure, which the program may catch, does not wait.
  let warns = row[0] === "module" && record.state === 0;
  const tainted = row[0] === "module" && __nimbusEsmTainted(id);
  if (warns && (!entry || tainted)) {
    warns = false;
    __nimbusEsmWarnTypeless(id);
  }
  if (tainted) return __nimbusEsmInterpret(id, false);
  let batch = null;
  let since = __nimbusEsmBatches;
  try {
    // The program's own work while its graph loads, until its evaluation
    // begins (its first meta instance) or it settles: a host whose loading
    // reads keeps the process, as Node's loader keeps it while it reads;
    // a top-level await that never settles does not. Armed before the
    // import(), which may link and begin evaluating within the call.
    let resolve;
    __nimbusTrackOp(new Promise((settle) => { resolve = settle; }));
    // Settled once, by whichever comes first; never left waiting in the
    // list (a cached module's import() enters no meta instance to empty it).
    // \`linked\`: false where it settled without its evaluation beginning.
    const loaded = (linked = true) => {
      __nimbusEsmLoading.delete(loaded);
      if (warns) {
        warns = false;
        if (linked) __nimbusEsmWarnTypeless(id);
        else __nimbusHeldEntryWarning = () => __nimbusEsmWarnTypeless(id);
      }
      resolve();
    };
    __nimbusEsmLoading.add(loaded);
    since = __nimbusEsmBatches;
    const evaluation = import(__NIMBUS_BUNDLE_URL + __nimbusEsmName(id));
    // The evaluation it began, when it began within the call (workerd's).
    batch = __nimbusEsmOpenBatch;
    __nimbusReflectApply(__nimbusEsmThen, evaluation, [() => loaded(), () => loaded(false)]);
    return await evaluation;
  } catch (error) {
    // Its evaluation was cancelled or stopped short of a module (a require()
    // took a module of it; an earlier evaluation stopped at a sibling's
    // throw), its graph linked; or it links to a module the launch did not
    // stage: the interpreter's.
    if (row[0] === "module" && __nimbusIsEsmStop(error)) return __nimbusEsmInterpret(id, true);
    if (row[0] === "module" && __nimbusEsmMissingOf(error)?.code === "ERR_NIMBUS_NOT_STAGED") return __nimbusEsmInterpret(id, false);
    // The body that threw: one its evaluation began and did not complete
    // (marked already where a later body's check stopped). It keeps what it
    // threw, for a require() of it. A body suspended in its top-level await
    // is the thrower only where no other is.
    // Only a body of this import's own evaluation: one that began after
    // the call (an import that failed to link began none), never an earlier
    // evaluation's, suspended in its top-level await.
    const own = (record) => record !== undefined && record.batch !== null
      && (batch !== null ? record.batch === batch : record.batch.seq > since);
    let thrower = null;
    for (const record of __nimbusEsmRecords) {
      if (!own(record)) continue;
      if (record.state === __ESM_FAILED && record.error === undefined) thrower = record;
      else if (record.state === __ESM_BEGAN && thrower === null && !__nimbusEsmSuspends(record)) thrower = record;
    }
    if (thrower === null) {
      for (const record of __nimbusEsmRecords) {
        if (own(record) && record.state === __ESM_BEGAN) thrower = record;
      }
    }
    if (thrower !== null) {
      thrower.state = __ESM_FAILED;
      thrower.batch?.running.delete(thrower);
      thrower.error = { value: error };
    }
    // Node's ModuleJob explains what escapes its evaluation by the job's own
    // module, the one imported: its URL and its top-level await.
    if (row[0] === "module") __nimbusExplainCommonJSGlobalLike(error, __nimbusEsmUrl("/" + row[1]), __nimbusEsmSuspends(__nimbusEsmRecord(id)));
    throw __nimbusEsmLinkError(error, id);
  }
}
// The interpreter's evaluation of staged module \`id\` (an adoption), as
// import() gives it: its graph's (__nimbusAdoptedRecord). A graph workerd
// did not link (\`linked\` false: it reaches a module staging handed on, or
// one the interpreter took) is checked first as a late graph is (core
// esm-late-link.ts linkAdopted): every imported name, before any of it
// runs, unless a link checked it already.
// A module an import() of failed to link (its late link, or its record),
// by its record's key: the failure stays, as Node's loader keeps a
// ModuleJob that did not link, and a later import of it rejects with it,
// whatever the program wrote since. import()'s alone: require() retries.
const __nimbusImportFailures = new __NimbusSafeMap();
async function __nimbusEsmInterpret(id, linked) {
  const key = __nimbusEsm.table[id][1];
  const url = __nimbusEsmUrl("/" + key);
  let record = __nimbusGraphRecords.get("/" + key);
  if (record === undefined) {
    if (__nimbusImportFailures.has("/" + key)) throw __nimbusImportFailures.get("/" + key);
    try {
      if (!linked) __nimbusLateOf().linkAdopted(__nimbusLateLinkHost, id, key, url);
      record = __nimbusAdoptedRecord(id, key);
    } catch (e) {
      __nimbusExplainCommonJSGlobalLike(e, url, false);
      __nimbusImportFailures.set("/" + key, e);
      throw e;
    }
  }
  return __nimbusImportRecord(record, url);
}
// A refusal staging recorded (EsmStage.missing), as the error Node's loader throws.
function __nimbusEsmRefusal(missing) {
  // A specifier that is no URL against its importer's: the resolver's own
  // error, its cause the URL parser's (the record's own field: one a program
  // gave Object.prototype is none).
  const invalidUrl = __nimbusPrimordials.ownField(missing, "invalidUrl");
  if (invalidUrl !== undefined) return unsupportedResolveRequest(invalidUrl.input, invalidUrl.base);
  const Type = missing.name === "TypeError" ? TypeError : missing.name === "SyntaxError" ? SyntaxError : missing.name === "RangeError" ? RangeError : Error;
  const refused = missing.code ? nodeError(Type, missing.code, missing.message) : new Type(missing.message);
  if (missing.url !== undefined) refused.url = missing.url;
  return refused;
}
// The refusal a link error names (a specifier staging refused), or null.
function __nimbusEsmMissingOf(error) {
  const message = error && typeof error.message === "string" ? error.message : "";
  const at = /nimbus\\/missing\\/(\\d+)\\.js/.exec(message);
  return at === null ? null : __nimbusEsm.missing[Number(at[1])] ?? null;
}
// What a failed evaluation of \`id\`'s graph rejects with, as Node's loader
// words it: a refused specifier's own error; a missing export named as the
// importing module wrote it, with its arrow; a module that does not
// compile, with its arrow; else the program's error as it threw it.
function __nimbusEsmLinkError(error, id) {
  const missing = __nimbusEsmMissingOf(error);
  if (missing !== null) return __nimbusEsmRefusal(missing);
  if (!(error instanceof SyntaxError) || __nimbusDecorated.has(error)) return error;
  try {
    const exported = /^The requested module '([^']*)' does not provide an export named '([^']*)'$/.exec(error.message);
    if (exported !== null) __nimbusEsmExportError(error, id, exported[1], exported[2]);
    else __nimbusEsmCompileError(error, id);
  } catch {}
  return error;
}
// The unevaluated modules of \`id\`'s graph, in link order.
function __nimbusEsmPending(id) {
  const seen = new __NimbusSafeSet();
  const order = [];
  const visit = (at) => {
    if (at < 0 || seen.has(at)) return;
    seen.add(at);
    const row = __nimbusEsm.table[at];
    const state = __nimbusEsmRecords[at]?.state;
    // Evaluated, or being evaluated by the interpreter: not this graph's to run.
    if (row[0] !== "module" || state === __ESM_DONE || state === __ESM_ADOPTED) return;
    order.push(at);
    for (const target of row[2]) visit(target);
  };
  visit(id);
  return order;
}
// A module of the graph that does not compile: the error's arrow is its.
function __nimbusEsmCompileError(error, id) {
  const { fatalLocation } = __nimbusRegistryRequire("./${RUNTIME_PARSER_MODULE}");
  for (const at of __nimbusEsmPending(id)) {
    const name = __nimbusEsmName(at);
    const text = __nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + name, "utf8");
    if (fatalLocation(text, "module", -1) === null) continue;
    __nimbusDecorateSyntaxError(error, name);
    return;
  }
}
// A missing export, as Node words it for the specifier the importing module
// wrote (a CommonJS module's in Node's words for one), its arrow under the
// imported name: the declaration that imports \`name\` from \`requested\`,
// as the parser reads the staged module, its places the source's.
function __nimbusEsmExportError(error, id, requested, name) {
  const { importedName } = __nimbusRegistryRequire("./${RUNTIME_PARSER_MODULE}");
  for (const at of __nimbusEsmPending(id)) {
    const module = __nimbusModuleAtPath(__nimbusEsm.table[at][1]);
    const text = __nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + module.name, "utf8");
    const place = importedName(text, requested, name);
    if (place === null) continue;
    const [nameStart, nameEnd, sourceStart, sourceEnd] = place;
    // The specifier as written: staging's edit at its place, else as it is.
    let specifier = requested;
    const lines = text.slice(0, sourceStart).split(/\\r\\n|[\\n\\r\\u2028\\u2029]/);
    const line = lines.length;
    const column = lines[line - 1].length - (line === 1 ? module.head : 0);
    let delta = 0;
    // A SafeList of the line's edits, read by index.
    const edits = __nimbusColumnEdits(module)?.get(line);
    for (let i = 0; edits !== undefined && i < edits.length; i++) {
      const editAt = edits[i][1], length = edits[i][2], written = edits[i][3];
      if (editAt + delta === column && length === sourceEnd - sourceStart) { specifier = __pathSlice(written, 1, -1); break; }
      delta += length - written.length;
    }
    // The module the importer's specifier names, as the registry resolved it.
    let requestedUrl = null;
    try { requestedUrl = new URL(requested, __NIMBUS_BUNDLE_URL + module.name).href; } catch {}
    const target = __nimbusEsm.table[__nimbusEsm.table[at][2].find((t) => t >= 0 && __NIMBUS_BUNDLE_URL + __nimbusEsmName(t) === requestedUrl) ?? -1];
    if (target === undefined) continue;
    error.message = __nimbusEsmExportMessage(specifier, name, target[0] === "commonjs");
    // Node's arrow: the imported name, on the declaration's line.
    const arrow = __nimbusArrowOf(module, text, nameStart, nameEnd);
    // Its frames as they were, under the message as Node words it.
    const frames = typeof error.stack === "string" ? error.stack.split("\\n").filter((frame) => frame.startsWith("    at ")) : [];
    error.stack = (arrow === null ? "" : arrow) + "SyntaxError: " + error.message + (frames.length > 0 ? "\\n" + frames.join("\\n") : "");
    __nimbusDecorated.add(error);
    return;
  }
}
// A missing export, as Node words it for the specifier the importing module
// wrote: a CommonJS module's in Node's words for one.
function __nimbusEsmExportMessage(specifier, name, commonjs) {
  return commonjs
    ? "Named export '" + name + "' not found. The requested module '" + specifier + "' is a CommonJS module, which may not support all module.exports as named exports.\\nCommonJS modules can always be imported via the default export, for example using:\\n\\nimport pkg from '" + specifier + "';\\nconst { " + name + " } = pkg;\\n"
    : "The requested module '" + specifier + "' does not provide an export named '" + name + "'";
}
// The program's ES entry, imported: its evaluation is its job, and what
// escapes it is explained as Node's loader explains it.
let __nimbusEsmEntryKey = null;
function __nimbusEsmRunEntry(key) {
  __nimbusEsmEntryKey = key;
  __nimbusEvalStripped(__nimbusModuleAtPath(key));
  const id = __nimbusEsmId("module", key);
  const url = __nimbusEsmUrl("/" + key);
  return __nimbusEsmImport(id, true).then(() => undefined, (e) => {
    __nimbusExplainCommonJSGlobalLike(e, url, __nimbusEsmSuspends(__nimbusEsmRecord(id)));
    throw e;
  });
}
if (typeof __nimbusEsmHost !== "undefined" && __nimbusEsmHost !== null) __nimbusEsmHost.enter = __nimbusEsmEnter;

// ═══════════════════════════════════════════════════════════════════════
// ──  The late ES module graph (core runtime/esm-graph.ts) ────────────
// ═══════════════════════════════════════════════════════════════════════
// The ES modules the interpreter evaluates (a file the launch did not stage,
// a query's or fragment's instance, a data: module, a staged module it
// adopts) are linked and evaluated as ECMA-262 does: Link(), then
// Evaluate(), over a record of every module their graph reaches, whatever
// its kind. Each by its key: a file's module by its cacheKey (its path, or a
// query's or fragment's URL), a data: module by its URL, a CommonJS or JSON
// module's translation by its URL, a builtin by "node:" and its name, a
// staged module the registry evaluates by "row:" and its id.
const __nimbusGraphRecords = new __NimbusSafeMap();
// The late link (core runtime/esm-late-link.ts), loaded the first time a late graph is linked.
let __nimbusLateModule = null;
const __nimbusLateOf = () => __nimbusLateModule ??= __nimbusRegistryRequire("./${RUNTIME_ESM_LATE_MODULE}");
// Whether a require() is linking its graph: one that cannot wait, so a staged
// module the registry has not evaluated is the interpreter's.
let __nimbusGraphSync = false;
function __nimbusGraphSet(key, record) {
  __nimbusGraphRecords.set(key, record);
  return record;
}
// The record of the module \`resolution\` names, imported by \`parent\` (its
// Module, or undefined), made the first time it is asked for.
function __nimbusGraphRecord(resolution, parent) {
  if (resolution.format === "builtin") {
    const key = "node:" + resolution.builtin;
    return __nimbusGraphRecords.get(key) ?? __nimbusGraphSet(key, __nimbusEvaluatedRecord(__nimbusTranslatedNamespace(resolution, builtins[resolution.builtin])));
  }
  if (resolution.format === "data") return __nimbusGraphRecords.get(resolution.url) ?? __nimbusDataRecord(resolution.url);
  const key = __vfsKey(resolution.path);
  // Made with the captured constructor, its members read live as Node's are (package-map.ts).
  const parsed = __nimbusPrimordials.newURL(resolution.url);
  const variant = parsed.search !== "" || parsed.hash !== "";
  if (!variant) {
    const id = __nimbusEsmId("module", key);
    if (id !== -1) return __nimbusStagedRecord(id, key, parent);
  }
  // A CommonJS module (by its extension or its package type) is one module by
  // its file, whatever the URL (Node's CommonJS translator keys its cache by
  // filename); JSON, and a query's or fragment's ES module, an instance of its own, by its URL.
  if (resolution.format === "commonjs") return __nimbusTranslatedRecord(resolution, key, key, parent);
  const instance = variant ? resolution.url : key;
  if (resolution.format === "json") return __nimbusTranslatedRecord(resolution, key, instance, parent);
  const known = __nimbusGraphRecords.get(instance === key ? "/" + key : instance);
  if (known !== undefined) return known;
  // A typeless .js's syntax decides (detect): CommonJS, it is one module by
  // its file, whatever the URL; an ES module, a query's or fragment's
  // instance is one of its own. A staged one is an ES module already, its
  // row left to the import of its own URL.
  if (resolution.format === "detect" && variant && !__nimbusGraphRecords.has("/" + key) && __nimbusEsmId("module", key) === -1) {
    if (__nimbusCommonJsPending.has("/" + key)) return __nimbusTranslatedRecord(resolution, key, key, parent);
    const plain = __nimbusPrepareModule(key, key, false, parent, false);
    if (plain.state === undefined || __nimbusModuleLink(plain.state.cell) === null) return __nimbusTranslatedRecord(resolution, key, key, parent, plain);
    // An ES module: only the query's or fragment's instance was asked for, and the file's own URL is a module of
    // its own, made from the file as it is when it is imported.
    plain.state.unload();
  }
  // An ES module by its format, or by its syntax (detect): compiled now, run by its graph.
  const prepared = __nimbusPrepareModule(key, instance, false, parent, resolution.format === "module");
  if (prepared.state === undefined || __nimbusModuleLink(prepared.state.cell) === null) return __nimbusTranslatedRecord(resolution, key, key, parent, prepared);
  return __nimbusInterpretedRecord(prepared.state);
}
// A module evaluated already (a builtin; a staged module the registry
// evaluated; a package the facet provides): its namespace, as it is.
function __nimbusEvaluatedRecord(namespace) {
  const record = new __nimbusGraph.OtherModuleRecord({ link() {}, evaluateSync() {} });
  record.namespace = () => namespace;
  return record;
}
// A CommonJS or JSON module's record, Node's translator of it: run when its
// graph evaluates it, as an import loads it (\`prepared\` where its syntax was
// read first: pending until then); its namespace's names known before it
// runs, their values once it has.
function __nimbusTranslatedRecord(resolution, key, instance, parent, prepared = undefined) {
  const known = __nimbusGraphRecords.get(resolution.url);
  if (known !== undefined) return known;
  if (prepared?.state !== undefined) __nimbusCommonJsPending.set(prepared.state.cacheKey, prepared.state);
  const translation = __nimbusTranslation(resolution);
  let outcome = null;
  const record = new __nimbusGraph.OtherModuleRecord({
    link() {},
    evaluateSync() {
      if (outcome !== null) {
        if (outcome.error !== undefined) throw outcome.error.value;
        return;
      }
      try {
        translation.fill(__loadModule(key, instance, false, parent));
        outcome = {};
      } catch (e) {
        outcome = { error: { value: e } };
        throw e;
      }
    },
  });
  record.namespace = () => translation.namespace;
  // A CommonJS module not yet run runs code where its graph evaluates it (JSON does not).
  record.runs = () => outcome === null && resolution.format !== "json";
  return __nimbusGraphSet(resolution.url, record);
}
// A staged ES module's record: the registry's evaluation of it, where the
// registry evaluates it with Node's semantics (its graph untainted, reaching
// nothing staging handed on, awaiting nowhere at its top level) and its
// import's plan reaches it before any module of the graph runs
// (__nimbusPlanGraph); else the interpreter's, from its text before it was
// staged (adopted). Undecided until that plan: a placeholder.
function __nimbusStagedRecord(id, key, parent) {
  const row = __nimbusEsmRecord(id);
  const known = __nimbusGraphRecords.get("/" + key) ?? __nimbusGraphRecords.get("row:" + id);
  if (known !== undefined) return known.decided ?? known;
  if (row.state === __ESM_DONE && row.namespace !== null) {
    const evaluated = __nimbusEvaluatedRecord(row.namespace);
    // A require() refuses it where its graph awaits at its top level, evaluated or not.
    evaluated.awaits = __nimbusEsmGraphAwaits(id);
    return __nimbusGraphSet("row:" + id, evaluated);
  }
  if (!__nimbusGraphSync && !__nimbusEsmTainted(id) && !__nimbusEsmHandsOn(id) && !__nimbusEsmGraphAwaits(id)) {
    return __nimbusGraphSet("row:" + id, { staged: true, id, key, parent, decided: null });
  }
  return __nimbusAdoptedRecord(id, key, parent);
}
// A staged module's placeholder decided: the registry's, evaluated before
// its graph's evaluation (\`first\`: nothing of the graph runs before it),
// its namespace the registry's; else the interpreter's.
function __nimbusDecideStaged(placeholder, first) {
  if (placeholder.decided !== null) return placeholder.decided;
  if (first) {
    const record = __nimbusEvaluatedRecord(null);
    let namespace = null;
    record.namespace = () => namespace;
    // The registry's evaluation of it, begun once: what every graph that reaches it waits for.
    let ready = null;
    record.begin = () => ready ??= __nimbusReflectApply(__nimbusEsmThen, __nimbusEsmImport(placeholder.id), [(value) => { namespace = value; }]);
    placeholder.decided = record;
  } else {
    placeholder.decided = __nimbusAdoptedRecord(placeholder.id, placeholder.key, placeholder.parent);
  }
  __nimbusGraphRecords.set("row:" + placeholder.id, placeholder.decided);
  return placeholder.decided;
}
// Plans the evaluation of \`root\`'s graph before it is linked, in the order
// Evaluate() runs it (InnerModuleEvaluation's: each module after the
// modules it imports, in their order), deciding each staged module it
// reaches: the registry's where nothing of the graph runs before it in that
// order, else the interpreter's (\`sync\`, a require()'s graph, which cannot
// wait: the interpreter's always). The registry's modules it decided, in
// that order: evaluated before the graph's evaluation, they run just where
// Node's would, though the registry evaluates asynchronously.
function __nimbusPlanGraph(root, sync) {
  const visited = new __NimbusSafeSet();
  const first = new __PathList();
  let ran = false;
  const visit = (record) => {
    if (visited.has(record)) return;
    visited.add(record);
    if (!(record instanceof __nimbusGraph.CyclicModuleRecord)) {
      if (record.begin !== undefined) first[first.length] = record;
      if (record.runs?.() === true) ran = true;
      return;
    }
    if (record.status === "evaluated" || record.status === "evaluating-async") return;
    const requested = record.host.requestedModules();
    for (let i = 0; i < requested.length; i++) {
      if (requested[i].staged === true) requested[i] = __nimbusDecideStaged(requested[i], !sync && !ran);
      visit(requested[i]);
    }
    ran = true;
  };
  visit(root);
  return first;
}
// The interpreter's record of staged module \`id\` (an adoption).
function __nimbusAdoptedRecord(id, key, parent = undefined) {
  const prepared = __nimbusPrepareModule(key, key, false, parent, true);
  if (prepared.state === undefined) return __nimbusGraphSet("row:" + id, __nimbusEvaluatedRecord(prepared.exports));
  return __nimbusInterpretedRecord(prepared.state);
}
// Whether staged module \`id\`'s graph reaches a module staging handed on (the
// registry cannot link it: the interpreter adopts it where it is imported).
function __nimbusEsmHandsOn(id) {
  const seen = new __NimbusSafeSet();
  const stack = [id];
  while (stack.length > 0) {
    const at = stack.pop();
    if (seen.has(at)) continue;
    seen.add(at);
    if (at < 0) {
      if (__nimbusEsm.missing[-2 - at]?.code === "ERR_NIMBUS_NOT_STAGED") return true;
      continue;
    }
    if (__nimbusEsmRecords[at]?.state === __ESM_DONE) continue;
    const row = __nimbusEsm.table[at];
    if (row[0] === "module") for (const target of row[2]) stack.push(target);
  }
  return false;
}
// A data: module's record: JSON its default; JavaScript an ES module,
// whatever its syntax (its MIME type's goal), its importer its own URL.
function __nimbusDataRecord(url) {
  const data = __nimbusDataModuleOf(url);
  if (data.format === "json") {
    const value = JSON.parse(data.source);
    return __nimbusGraphSet(url, __nimbusEvaluatedRecord(__esmNamespaceOf(["default"], () => value)));
  }
  if (data.format !== "module") throw nodeError(RangeError, "ERR_UNKNOWN_MODULE_FORMAT", "Unknown module format: " + data.mime + " for URL " + url);
  const mod = { exports: {} };
  Object.defineProperty(mod, "__nimbusImportMeta", { value: {
    url,
    resolve: (id) => globalThis.__nimbusImportMetaResolve(id, url),
  } });
  // A data URL produced at runtime is a module body, just like a written
  // file. It is staged by the same runtime-code service, retaining its URL
  // as the import base (relative imports from data URLs remain invalid).
  const cell = __nimbusRuntimeModule(url, data.source, "module");
  return __nimbusInterpretedRecord({ mod, cell, filename: undefined, modDir: undefined, moduleUrl: url, cacheKey: url, resolvedPath: url, esmId: -1, adopted: false, unload() {}, required: false, data: true });
}
// An interpreted ES module's record (core interpreter/modules.ts moduleLink):
// its requests resolved as Node's ES loader resolves them, its link binding
// each to its module's namespace, its execution its body. Its namespace is
// one, made the first time it is asked for, with every name its link
// exports: the late link's (export * included), else its exports' once
// linked; taken in a cycle before either, its exports themselves.
function __nimbusInterpretedRecord(state) {
  const { mod, cell, cacheKey, moduleUrl } = state;
  // A module its syntax made an ES module is the ES loader's, not require.cache's, until a require() loads it.
  if (!state.required && !state.data && __NodeModule._cache[cacheKey] === mod) {
    delete __NodeModule._cache[cacheKey];
    __nimbusEsmInstances.set(cacheKey, mod);
  }
  const late = __nimbusLateOf();
  const importer = state.data ? undefined : mod;
  const parentUrl = state.data ? moduleUrl : __nimbusFileHref(state.filename);
  const requests = __nimbusModuleRequestsOf(cell);
  // Each request's index in \`requested\`, by its specifier and type (the plan may replace a staged module's placeholder there).
  const targets = new __NimbusSafeMap();
  let requested = null;
  let execute = null;
  let namespace = null;
  // Whether an InitializeEnvironment of it ran: a Link that failed (here, or in a module after it) left it
  // ~unlinked~, and the next makes its environment again, as the spec's makes a new one each time.
  let environment = false;
  const at = (source, type) => source + "\\0" + (type ?? "");
  // What its link requires: each static import's module's namespace
  // (ESM_LOAD_HELPER: the specifier, the marker, the type attribute), and the
  // names its \`export *\`s leave out (ESM_CONFLICTS_HELPER: its late link's).
  const linkRequire = (id, marker, type = null) => marker === ${JSON.stringify(ESM_STAR_CONFLICTS)}
    ? late.starConflicts(__nimbusLateLinkHost, moduleUrl)
    : requested[targets.get(at(id, type))].namespace();
  const record = new __nimbusGraph.CyclicModuleRecord({
    hasTLA: __nimbusModuleAwaits(cell),
    requestedModules() {
      if (requested === null) {
        // Kept once all resolve: a link that fails resolves them again (Link() leaves the module ~unlinked~).
        const resolved = [];
        // The interpreter's own list: no iterator, read by index.
        for (let i = 0; i < requests.length; i++) {
          const { source, type } = requests[i];
          targets.set(at(source, type), resolved.length);
          resolved.push(__nimbusStaticRecord(source, type, parentUrl, importer, state.data));
        }
        requested = resolved;
      }
      return requested;
    },
    initializeEnvironment() {
      // Its export getters are not configurable: a second link publishes them on a fresh exports object.
      if (environment) {
        mod.exports = {};
        execute = null;
      }
      environment = true;
      const before = globalThis.__currentModulePath;
      if (!state.data) globalThis.__currentModulePath = state.resolvedPath;
      try {
        execute = __nimbusModuleLink(cell)(mod.exports, linkRequire, mod, state.filename, state.modDir);
      } finally {
        globalThis.__currentModulePath = before;
      }
    },
    executeModule(capability) {
      const before = globalThis.__currentModulePath;
      if (!state.data) globalThis.__currentModulePath = state.resolvedPath;
      let result;
      try {
        result = execute();
      } catch (e) {
        __nimbusInterpretedFailed(state, e);
        throw e;
      } finally {
        globalThis.__currentModulePath = before;
      }
      if (capability === undefined) {
        __nimbusInterpretedDone(state, record);
        return;
      }
      __nimbusReflectApply(__nimbusEsmThen, result, [() => {
        __nimbusInterpretedDone(state, record);
        capability.resolve();
      }, (e) => {
        __nimbusInterpretedFailed(state, e);
        capability.reject(e);
      }]);
    },
  });
  record.state = state;
  record.awaits = record.host.hasTLA;
  record.namespace = () => {
    if (namespace !== null) return namespace;
    const names = late.namespaceNames(__nimbusLateLinkHost, moduleUrl) ?? (execute !== null ? Object.keys(mod.exports) : null);
    if (names === null) return mod.exports;
    return namespace = __esmNamespaceOf(names, (name) => mod.exports[name]);
  };
  return __nimbusGraphSet(cacheKey, record);
}
// An interpreted ES module's body has completed: its Module loaded; an
// adopted module's record its namespace, its Module for a require().
function __nimbusInterpretedDone(state, record) {
  state.mod.loaded = true;
  if (!state.adopted) return;
  const row = __nimbusEsmRecord(state.esmId);
  row.module = state.mod;
  row.namespace = record.namespace();
}
// An interpreted ES module's body threw: its Module unloaded; an adopted
// module's record keeps what it threw (Node's errored module record).
function __nimbusInterpretedFailed(state, e) {
  state.unload();
  if (state.adopted) {
    const row = __nimbusEsmRecord(state.esmId);
    row.state = __ESM_FAILED;
    row.error = { value: e };
  }
  __nimbusAdvise(e, state.resolvedPath);
}
// The record of what an interpreted ES module (at \`parentUrl\`, its Module
// \`importer\`) imports as \`id\`, with its \`type\` attribute, as Node's ES loader
// resolves it: a package the facet provides and a staged N-API binding as
// their namespaces; a CommonJS module whose require() of an ES module led
// here refused (a cycle); else resolved (refused with no arrow of the importer's).
function __nimbusStaticRecord(id, type, parentUrl, importer, data) {
  if (!data) {
    const fromDir = __nimbusModuleDir(importer);
    const binding = __nimbusFacetProvidedPackages.has(id) ? null : __stagedBinding(id);
    const provided = binding ? __loadStagedBinding(binding, fromDir) : __nimbusFacetProvidedPackages.has(id) ? builtins[id] : undefined;
    if (provided !== undefined) return __nimbusEvaluatedRecord(__nimbusObjectNamespace(provided));
    const notCarried = __stagedBindingNotCarried(id, fromDir);
    if (notCarried) throw notCarried;
  }
  const resolution = __nimbusResolveImport(id, parentUrl, type ?? null);
  if (resolution.path && resolution.format !== "module") {
    const key = resolution.path.replace(/^\\/+/, "");
    const loading = resolution.format === "detect" && __nimbusEsmId("module", key) !== -1 ? undefined : __NodeModule._cache["/" + key];
    if (loading !== undefined && __nimbusExecutingCommonJs.has(loading)) {
      // Refused where the importer's link binds it: its link fails, nothing of its graph run, and the
      // refusal's stack is the interpreter's (none of the program's frames, as Node's loader gives it).
      const refused = __nimbusEvaluatedRecord(null);
      refused.namespace = () => {
        throw nodeError(Error, "ERR_REQUIRE_CYCLE_MODULE", "Cannot import CommonJS Module " + id + " in a cycle." + (importer?.filename ? " (from " + importer.filename + ")" : ""));
      };
      return refused;
    }
  }
  return __nimbusGraphRecord(resolution, importer);
}
// Whether a module of \`record\`'s graph awaits at its top level.
function __nimbusGraphAwaits(record, seen) {
  if (seen.has(record)) return false;
  seen.add(record);
  if (record.awaits === true) return true;
  if (!(record instanceof __nimbusGraph.CyclicModuleRecord)) return false;
  for (const target of record.host.requestedModules()) if (__nimbusGraphAwaits(target, seen)) return true;
  return false;
}
// import() of a record: linked, then evaluated (core esm-graph.ts), its
// namespace once its evaluation completes. What escapes it is explained as
// Node's loader explains it, by the module imported.
async function __nimbusImportRecord(record, url) {
  try {
    if (!(record instanceof __nimbusGraph.CyclicModuleRecord)) {
      record.host.link();
      record.host.evaluateSync();
      return record.namespace();
    }
    const leaves = __nimbusPlanGraph(record, false);
    for (let i = 0; i < leaves.length; i++) await leaves[i].begin();
    __nimbusGraph.link(record);
  } catch (e) {
    __nimbusExplainCommonJSGlobalLike(e, url, false);
    throw e;
  }
  try {
    await __nimbusGraph.evaluate(record);
  } catch (e) {
    __nimbusExplainCommonJSGlobalLike(e, url, record.host.hasTLA);
    throw e;
  }
  return record.namespace();
}
// import() of an ES module the interpreter evaluates (a file the launch did
// not stage, a query's or fragment's instance, a data: module): its late
// graph's names checked first, the first time (a name it imports that its
// module does not export rejects before any body runs, in Node's words),
// then its graph's.
async function __nimbusImportGraph(resolution) {
  const key = resolution.format === "data" ? resolution.url : __vfsKey(resolution.path);
  const recordKey = resolution.format === "data" || __pathIncludes(resolution.url, "?") || __pathIncludes(resolution.url, "#") ? resolution.url : "/" + key;
  let record = __nimbusGraphRecords.get(recordKey);
  if (record === undefined || record.status === "unlinked") {
    if (__nimbusImportFailures.has(recordKey)) throw __nimbusImportFailures.get(recordKey);
    try {
      if (resolution.format !== "data" || __nimbusDataModuleOf(resolution.url).format === "module") __nimbusLateLink(key, resolution.url, true);
      record ??= __nimbusGraphRecord(resolution, undefined);
    } catch (e) {
      __nimbusExplainCommonJSGlobalLike(e, resolution.url, false);
      __nimbusImportFailures.set(recordKey, e);
      throw e;
    }
  }
  const namespace = await __nimbusImportRecord(record, resolution.url);
  __esmNamespaces.set(resolution.url, namespace);
  return namespace;
}
// require() of an ES module the interpreter evaluates (require(esm)): its
// graph refused where any of it awaits at its top level, before any of it
// runs, as Node's require does; else linked and evaluated now. A require()
// of one evaluating already is a cycle: an adopted module's refused as Node
// refuses it, another's exports as they are. Its result: an adopted
// module's in Node's shape of a required namespace (__nimbusEsmRequired);
// another's, its exports.
function __nimbusRequireRecord(record, parent) {
  const state = record.state;
  if (record.status === "linking" || record.status === "evaluating") {
    if (state.adopted) __nimbusEsmRequire(state.esmId, true, parent);
    return state.mod.exports;
  }
  if (record.status !== "evaluated" && record.status !== "evaluating-async") {
    const previous = __nimbusGraphSync;
    __nimbusGraphSync = true;
    try {
      // Its late graph's names, as its import() checks them: a runtime module's.
      if (record.status === "unlinked" && !state.adopted && !state.data) __nimbusLateLink(state.resolvedPath.replace(/^\\/+/, ""), state.moduleUrl, false);
      __nimbusPlanGraph(record, true);
      if (__nimbusGraphAwaits(record, new __NimbusSafeSet())) throw __nimbusRequireAsync(parent, state.filename);
      __nimbusGraph.link(record);
    } finally {
      __nimbusGraphSync = previous;
    }
    __nimbusReflectApply(__nimbusEsmThen, __nimbusGraph.evaluate(record), [undefined, () => {}]);
  } else if (__nimbusGraphAwaits(record, new __NimbusSafeSet())) {
    throw __nimbusRequireAsync(parent, state.filename);
  }
  if (record.status !== "evaluated") throw __nimbusRequireAsync(parent, state.filename);
  if (record.evaluationError !== null) {
    // A ReferenceError for a CommonJS name is explained by the module required, as Node's ModuleJobSync explains it.
    __nimbusExplainCommonJSGlobalLike(record.evaluationError.value, state.moduleUrl, false);
    throw record.evaluationError.value;
  }
  __nimbusUpdateChildren(parent, state.mod, true);
  __NodeModule._cache[state.cacheKey] ??= state.mod;
  return state.adopted ? __nimbusEsmRequired(__nimbusEsmRecord(state.esmId)) : state.mod.exports;
}

// What import() of a resolution gives: a staged module's (or facade's)
// namespace from the registry; a builtin's, a data: URL's, a JSON file's and
// a file the launch did not stage, made here, once per URL.
function __esmLoad(resolution) {
  const cached = __esmNamespaces.get(resolution.url);
  if (cached) return cached;
  if (resolution.format === "builtin") {
    const id = __nimbusEsmId("builtin", resolution.builtin);
    if (id !== -1) return __nimbusEsmImport(id);
    return __nimbusTranslatedNamespace(resolution, builtins[resolution.builtin]);
  }
  if (resolution.format === "data") return __nimbusImportGraph(resolution);
  const key = __vfsKey(resolution.path);
  // A query or a fragment is a module instance of its own: the interpreter's.
  const variant = __pathIncludes(resolution.url, "?") || __pathIncludes(resolution.url, "#");
  if (!variant) {
    const id = __nimbusEsmId("module", key);
    if (id !== -1) return __nimbusEsmImport(id);
    const facade = resolution.format === "json" ? __nimbusEsmId("json", key) : __nimbusEsmId("commonjs", key);
    if (facade !== -1) return __nimbusEsmImport(facade);
  }
  if (resolution.format === "module" || resolution.format === "detect") return __nimbusImportGraph(resolution);
  // A CommonJS or JSON module: Node's translator of it, as require() loads it.
  let exports;
  try {
    exports = __loadModule(key, variant ? resolution.url : key);
  } catch (e) {
    __nimbusExplainCommonJSGlobalLike(e, resolution.url, false);
    throw e;
  }
  return __nimbusTranslatedNamespace(resolution, exports);
}
// The facts of the launch a late graph's link reads (core esm-late-link.ts LateLinkHost).
const __nimbusLateLinkHost = {
  row: __nimbusEsmId,
  rowKind: (row) => __nimbusEsm.table[row][0],
  rowKey: (row) => __nimbusEsm.table[row][1],
  rowBindings: () => __nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + ${JSON.stringify(ESM_BINDINGS_MODULE)}, "utf8"),
  rowTargets: (row) => __nimbusEsm.table[row][2],
  rowSettled: (row) => __nimbusEsmRecords[row]?.state === __ESM_DONE || __nimbusEsmRecords[row]?.state === __ESM_ADOPTED,
  missing: (i) => {
    const missing = __nimbusEsm.missing[i];
    if (missing === undefined) return null;
    if (missing.code === "ERR_NIMBUS_NOT_STAGED" && typeof missing.url === "string") return { handedOn: missing.url };
    return { refusal: __nimbusEsmRefusal(missing) };
  },
  source: (key, row) => row === -1 ? __readFileOr(key, null) : __nimbusEsmSourceText(row),
  fileFormat: (key) => __nimbusFileFormat("/" + key),
  loadUnread: (key, text, format) => { __nimbusRuntimeModule(key, text, format); },
  resolve: __nimbusResolveImport,
  builtinNames: (name) => Object.keys(__nimbusObjectNamespace(builtins[name])),
  cjsResolve: __nimbusCjsResolve,
  exportMessage: __nimbusEsmExportMessage,
  decorate: (error) => {
    __nimbusDecorated.add(error);
    return error;
  },
  requests: (path, text, javaScript, goal) => __nimbusModuleRequests(path, text, javaScript, goal),
};
// Links the late graph of the module at \`key\` (\`url\`), an import()'s
// (\`kept\`: a module it fails in keeps the failure) or a require()'s; the
// staged rows it imports, in order.
function __nimbusLateLink(key, url, kept) {
  return __nimbusLateOf().linkLateGraph(__nimbusLateLinkHost, key, url, kept);
}
// A bundled copy of a package the runtime provides, bound to the runtime's
// (provided-packages.ts rewriteProvidedCommonJsModules, PROVIDED_PACKAGE_HOOK):
// what require() serves for it, from any module, an ES module included.
globalThis.__nimbusProvidedPackage = (name) => builtins[name];

// import() may reach installed files the launch did not stage. A launch's
// store holds its closure and its data plan; anything else on disk is named
// by the namespace but not held, and the synchronous load that import()
// ends in (__esmLoad, __loadModule, resolution's package.json reads) cannot
// fetch it. import() is asynchronous, so it reads ahead first, as the load
// will read: the files its resolution reads, then the target and every
// module it requests, breadth first, each read that misses faulted in and
// made again. Vite's runtime-bundled config (node_modules/.vite-temp, a
// fresh name each run) and its SSR runner's externalised imports reach
// installed packages this way. Bounded: past the bound the import() fails,
// naming it, rather than load on a closure it only half fetched.
const __IMPORT_STAGE_FILES = 4096;
const __IMPORT_STAGE_BYTES = 64 * 1024 * 1024;
// Rounds of fault-in one step may take; each round is a level of a path's
// links or listings the namespace did not hold.
const __IMPORT_HYDRATE_ROUNDS = 32;

// What one import() may fetch ahead: one quota of files and raw bytes, which
// the fs charges at the repair and read boundary, before any data I/O
// (_faultIn admits the file, _observeThenFill its size from the stat): a
// module's text and a manifest or link a resolution read alike. Once a charge
// does not fit, nothing more is issued under it, and the import() fails with
// the bound once the fills already admitted have landed. \`limits\` is for
// tests: the bound itself is fixed.
function __nimbusPrefetchQuota(specifier, limits) {
  const maxFiles = (limits && limits.files) || __IMPORT_STAGE_FILES;
  const maxBytes = (limits && limits.bytes) || __IMPORT_STAGE_BYTES;
  let files = 0;
  let bytes = 0;
  let error = null;
  const exceed = (what) => {
    error = nodeError(Error, "ERR_NIMBUS_PREFETCH_BOUND", "import() of '" + specifier + "' would fetch more than " + what
      + " ahead (the bound on one import()'s prefetch); it is not loaded on a closure fetched in part");
    return false;
  };
  return {
    get error() { return error; },
    // One more file fetched: whether it may be.
    file() {
      if (error) return false;
      if (files + 1 > maxFiles) return exceed(maxFiles + " files");
      files++;
      return true;
    },
    // Its size, before its bytes are read: whether they may be.
    bytes(size) {
      if (error) return false;
      if (bytes + size > maxBytes) return exceed(maxBytes + " bytes");
      bytes += size;
      return true;
    },
  };
}

// Run a synchronous step (resolutions, reads) until it stops missing. Its
// reads of files that exist but are not held are faulted in: under a
// speculation (the filesystem's residency, __nimbusVfsSpeculation), so they
// are the prefetch's own and never the program's misses, and charged to the
// quota before they are issued. The step waits for every fetch it issued or
// joined, whatever comes next, so none outlives it, and then runs again. A
// miss with no fetch behind it (the filesystem gave the file up) fails the
// import(), named: the step's answer would rest on a read that did not
// happen (a resolver falling back past an unread manifest).
// A speculation as the filesystem's residency takes one: its misses, a
// SafeSet, the fetches to wait on and the key each brings, SafeLists, and
// its quota's charge for each fetch, before it is issued.
function __nimbusSpeculation(quota) {
  const speculation = {
    misses: new __NimbusSafeSet(), fetches: new __PathList(), fetched: new __PathList(),
    missed(key, fetch) {
      speculation.misses.add(key);
      if (fetch === null) return;
      speculation.fetched[speculation.fetched.length] = key;
      speculation.fetches[speculation.fetches.length] = fetch;
    },
    charge: (size) => quota.file() && quota.bytes(size),
  };
  return speculation;
}
/** The keys of \`speculation\` whose fetch landed (each tells whether its bytes are held), once every one has ended. */
async function __nimbusLanded(speculation) {
  const held = await __nimbusAll(speculation.fetches);
  const landed = new __NimbusSafeSet();
  for (let i = 0; i < held.length; i++) if (held[i]) landed.add(speculation.fetched[i]);
  return landed;
}
/** The first \`count\` of \`list\`, each through \`each\`, joined by ", ". */
function __nimbusFirstJoined(list, count, each) {
  let text = "";
  for (let i = 0; i < list.length && i < count; i++) text += (i === 0 ? "" : ", ") + each(list[i]);
  return text;
}
async function __nimbusHydrated(step, quota) {
  for (let round = 1; ; round++) {
    const speculation = __nimbusSpeculation(quota);
    const outer = globalThis.__nimbusVfsSpeculation;
    globalThis.__nimbusVfsSpeculation = speculation;
    let value;
    let error;
    let threw = false;
    try { value = step(); } catch (e) { error = e; threw = true; } finally { globalThis.__nimbusVfsSpeculation = outer; }
    const landed = await __nimbusLanded(speculation);
    if (quota.error) throw quota.error;
    if (speculation.misses.size === 0) {
      if (threw) throw error;
      return value;
    }
    const misses = __nimbusListOf(speculation.misses);
    const given = new __PathList();
    for (let i = 0; i < misses.length; i++) if (!landed.has(misses[i])) given[given.length] = misses[i];
    if (given.length > 0) {
      const unread = nodeError(Error, "ERR_NIMBUS_PREFETCH_UNREADABLE", "import() prefetch: could not fetch " + __nimbusFirstJoined(given, 3, (k) => "/" + k)
        + (given.length > 3 ? " and " + (given.length - 3) + " more" : "") + "; its fetches did not land");
      throw unread;
    }
    if (round >= __IMPORT_HYDRATE_ROUNDS) {
      const bound = nodeError(Error, "ERR_NIMBUS_PREFETCH_BOUND", "import() prefetch: a resolution still misses after " + __IMPORT_HYDRATE_ROUNDS + " rounds of fetching ("
        + __nimbusFirstJoined(misses, 3, (k) => k) + ")");
      throw bound;
    }
  }
}

// Read data files ahead of the modules that will read them synchronously,
// under the import()'s quota, and wait for the fills that issues. Nothing
// rests on these reads: one that does not land (a file the store has no room
// for) is left to the module's own read, which reports it as any refused read.
async function __nimbusReadAhead(paths, quota) {
  const speculation = __nimbusSpeculation(quota);
  const outer = globalThis.__nimbusVfsSpeculation;
  globalThis.__nimbusVfsSpeculation = speculation;
  try {
    for (let i = 0; i < paths.length; i++) { try { __fsMod.readFileSync("/" + paths[i]); } catch {} }
  } finally { globalThis.__nimbusVfsSpeculation = outer; }
  await __nimbusSettled(speculation.fetches);
  if (quota.error) throw quota.error;
}

// What a module's text requests (import and export-from sources, import()
// and require() of a string), as the runtime-code interpreter's parser reads
// it (core/interpreter moduleRequests): a request in a comment is none, one
// in a template or with escapes is read as the language reads it.
function __nimbusModuleRequests(path, text, javaScript = false, goal = undefined) {
  if (typeof __nimbusRegistryRequire !== "function") return { requests: [] };
  try { return __nimbusRegistryRequire("./${RUNTIME_INTERPRETER_MODULE}").moduleRequests(path, text, javaScript, goal); }
  catch { return { requests: [] }; }
}

// Where a request from the module at importer leads, by the loader's own
// rule, the one place it is decided: import() and a static import or
// export-from resolve as Node's ESM loader does (__nimbusDynamicImport,
// __requireFrom for an interpreted ES module); require() as require does.
function __nimbusRequestTarget(kind, specifier, importer) {
  if (kind === "dynamic" || kind === "static") {
    const resolution = __esmResolver.resolveSync(specifier, __nimbusFileHref("/" + importer));
    return resolution && resolution.path ? resolution.path : null;
  }
  if (__nimbusBuiltinId(specifier) !== null || __nimbusFacetProvidedPackages.has(specifier)) return null;
  if (__stagedBinding(specifier)) return null;
  return __resolveFrom(specifier, __pathIncludes(importer, "/") ? __pathSlice(importer, 0, __pathLastIndexOf(importer, "/")) : "");
}

// core/_shared/relative-wasm-paths.ts, compiled once by the build (a
// function's own text differs between compilers, so it is never spliced).
${RELATIVE_WASM_PATHS_PREAMBLE}
const __nimbusRelativeWasmPaths = relativeWasmPaths;
function __nimbusImportStager(quota) {
  // The fetch a synchronous read's miss starts (the filesystem's residency),
  // which only a process with a filesystem has.
  if (__nimbusProcessFilesystem === null) return null;
  const strip = (path) => __vfsKey(String(path));
  const target = (request, importer) => {
    try {
      const found = __nimbusRequestTarget(request.kind, request.specifier, importer);
      return found ? strip(found) : null;
    } catch { return null; }
  };
  return {
    // The target and what it requests, and theirs, each read as the load
    // will read it, through the fs: its lookup follows links component by
    // component, and a miss is faulted in (ranged, any size) and read again.
    // Lists here are SafeLists, sets SafeSets: a closure is walked after the program may have replaced their methods.
    async closure(root) {
      const visited = new __NimbusSafeSet();
      let frontier = new __PathList();
      frontier[0] = strip(root);
      while (frontier.length > 0) {
        const round = new __PathList();
        for (let i = 0; i < frontier.length; i++) {
          const k = frontier[i];
          if (visited.has(k)) continue;
          visited.add(k);
          if (!(typeof __nimbusCodeCells !== "undefined" && __nimbusCodeCells.has(k))) round[round.length] = k;
        }
        const texts = await __nimbusHydrated(() => {
          const read = new __PathList();
          for (let i = 0; i < round.length; i++) read[i] = __readFileOr(round[i], null);
          return read;
        }, quota);
        const wanted = new __PathList();
        const images = new __NimbusSafeSet();
        for (let i = 0; i < round.length; i++) {
          const text = texts[i];
          if (typeof text !== "string") continue;
          // /\\.[cm]?js$/, by its endings.
          if (!(__pathEndsWith(round[i], ".js") || __pathEndsWith(round[i], ".cjs") || __pathEndsWith(round[i], ".mjs"))) continue;
          // A late module's image was not in the launch's data-read table.
          // Read it ahead by the same relative-path rule the image collector
          // uses; the file/byte quota applies before any fill is issued.
          const named = __nimbusRelativeWasmPaths(text, round[i]);
          for (let j = 0; j < named.length; j++) images.add(named[j]);
          // An import() in the closure is its own: it prefetches when it runs.
          const requests = __nimbusModuleRequests(round[i], text).requests;
          for (let j = 0; j < requests.length; j++) if (requests[j].kind !== "dynamic") wanted[wanted.length] = { request: requests[j], from: round[i] };
        }
        if (images.size > 0) await __nimbusReadAhead(__nimbusListOf(images), quota);
        const found = await __nimbusHydrated(() => {
          const targets = new __PathList();
          for (let i = 0; i < wanted.length; i++) targets[i] = target(wanted[i].request, wanted[i].from);
          return targets;
        }, quota);
        const next = new __NimbusSafeSet();
        for (let i = 0; i < found.length; i++) if (found[i] !== null && !visited.has(found[i])) next.add(found[i]);
        frontier = __nimbusListOf(next);
      }
      return visited;
    },
  };
}
async function __nimbusStageImport(specifier, parentUrl) {
  const quota = __nimbusPrefetchQuota(specifier);
  const stager = __nimbusImportStager(quota);
  if (stager === null) return __esmResolver.resolveSync(specifier, parentUrl);
  const resolution = await __nimbusHydrated(() => __esmResolver.resolveSync(specifier, parentUrl), quota);
  // A module this process has loaded already brought what it requests.
  if (resolution.path && !__esmNamespaces.has(resolution.url)) {
    const walked = await stager.closure(resolution.path);
    // What the modules it evaluates read synchronously, which the launch
    // did not stage because only this import() reaches them: the target's
    // entry (the planner's lazyReadsByTarget), and the entry of each module
    // the walk read because the map lacks it (an evicted one's,
    // evictedModuleReads). Read here, under the quota, so a miss is fetched.
    const table = globalThis.__nimbusLazyReads instanceof __NimbusMap ? globalThis.__nimbusLazyReads : null;
    const unheld = new __PathList();
    if (table !== null) {
      // The entry's first, then each module the walk read.
      const keys = new __PathList();
      keys[0] = __vfsKey(String(resolution.path));
      if (walked) walked.forEach((k) => { keys[keys.length] = k; });
      for (let i = 0; i < keys.length; i++) {
        const reads = __nimbusMapGet(table, keys[i]);
        if (!reads) continue;
        for (let j = 0; j < reads.length; j++) {
          const k = reads[j];
          if (!__resident.cells.has(k)) unheld[unheld.length] = k;
        }
      }
    }
    if (unheld.length > 0) await __nimbusReadAhead(unheld, quota);
  }
  return resolution;
}
// What a runner call's code requires and imports statically (FacetManager
// runnerRun), with what each of those modules requests in turn, read ahead
// before the code runs, as an import() reads ahead (__nimbusStageImport): its
// synchronous require then finds the files held. An import() in the code
// reads ahead when it runs. Nothing rests on this: a request that does not
// resolve, or a closure past the bound, is left to the code's own require,
// which reports it as any refused read.
async function __nimbusStageRequests(text, importer) {
  const requests = __nimbusModuleRequests(importer, text, true).requests;
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    if (request.kind === "dynamic") continue;
    const quota = __nimbusPrefetchQuota(request.specifier);
    const stager = __nimbusImportStager(quota);
    if (stager === null) return;
    try {
      const target = await __nimbusHydrated(() => __nimbusRequestTarget(request.kind, request.specifier, importer), quota);
      if (target !== null) await stager.closure(target);
    } catch {}
  }
}
globalThis.__nimbusDynamicImport = function __nimbusDynamicImport(parentUrl, specifier, options) {
  return Promise.resolve().then(async () => {
    // V8's own checks and messages (node 22), which run before resolution.
    const { specifier: text, attributes } = __nimbusImportCallArguments(specifier, options);
    // Counted as the program's own work: a floating import(...).then(...) keeps
    // the process while it fetches, as Node's loader keeps it while it reads.
    const resolution = await __nimbusTrackOp(__nimbusStageImport(text, parentUrl));
    // Loaded, then checked against its attributes, as Node's loader does.
    __nimbusAssertLoadable(resolution, attributes.type);
    __esmResolver.validateAttributes(resolution.url, resolution.format, attributes);
    return __esmLoad(resolution);
  });
};

// The command line's preloads, before the program, as Node runs them
// (pre_execution.js loadPreloadModules, then run_main.js
// runEntryPointWithESMLoader): \`-r\` modules required from the working
// directory in order, then \`--import\` ones imported from it, each awaited.
async function __nimbusPreload() {
  const fromDir = String(cwd || "/home/user").replace(/^\\/+/, "");
  const preload = new __NodeModule("internal/preload", null);
  preload.paths = __NodeModule._nodeModulePaths("/" + fromDir);
  for (const specifier of __nimbusNodeCommandLine?.require ?? []) __requireFrom(String(specifier), fromDir, preload);
  const imports = __nimbusNodeCommandLine?.import ?? [];
  if (imports.length === 0) return;
  const parentUrl = __nimbusFileHref("/" + fromDir + "/");
  for (const specifier of imports) await globalThis.__nimbusDynamicImport(parentUrl, String(specifier));
}

// \`node -p\`: its code returns the eval's completion value (core
// runtime/node-eval.ts), printed when the process exits by the console.log the
// code left in place (Node's runScriptInContext). Otherwise the entry's own result.
function __nimbusEntryOutcome(result) {
  if (__nimbusNodeCommandLine?.print !== true) return result;
  const log = __consoleMod.log;
  __processMod.on("exit", () => { log(result); });
  return undefined;
}

// Node's import.meta.resolve, synchronous as in Node: the URL a specifier
// names, even for a file or directory that will not load.
globalThis.__nimbusImportMetaResolve = function __nimbusImportMetaResolve(specifier, parentUrl) {
  const parent = typeof parentUrl === "string" && __pathStartsWith(parentUrl, "file:")
    ? parentUrl
    : "file:///" + __vfsKey(String(globalThis.__currentModulePath || "[eval]"));
  return __esmResolver.metaResolveSync(String(specifier), parent);
};

/**
 * Staged N-API bindings (PACKAGE_ABI_POLICY stagedArtifacts of kind
 * "binding"). A launch whose closure requires one carries the staged wasm
 * builds of the versions installed in its module map and registers them on
 * globalThis.__nimbusStagedBindings under the package name the binding is
 * required by, by version. require() answers that name from the registry
 * ahead of node_modules, with the build its owner's version names: the
 * published package of that name (rolldown's wasm32-wasip1-threads build, or
 * a platform shard) cannot run in a Worker isolate.
 */
function __stagedBinding(id) {
  const registry = globalThis.__nimbusStagedBindings;
  return registry instanceof __NimbusMap ? __nimbusMapGet(registry, id) : undefined;
}

/**
 * Every binding build Nimbus stages, carried or not: a launch registers only
 * those its closure names (staged-bindings.ts stagedBindingsRequiredBy).
 */
const __NIMBUS_STAGED_BINDINGS = ${JSON.stringify(STAGED_BINDING_ARTIFACTS.map(({ name, owner, version, requiredAs }) => ({ name, owner, version, requiredAs })))};
const __stagedBindingsNamed = new __NimbusSafeSet();

// The version of \`owner\` a require from \`fromDir\` comes from, and its
// package.json: the installed package \`fromDir\` is in, when its package.json
// names \`owner\`, whatever its folder is called (an alias,
// \`rd@npm:rolldown@1.2.13\`, installs rolldown as node_modules/rd). A require
// from outside the owner has none.
function __stagedOwnerVersion(owner, fromDir) {
  const dir = fromDir + "/";
  const at = dir.lastIndexOf("node_modules/");
  if (at < 0) return { version: null, manifest: null };
  const parts = dir.slice(at + "node_modules/".length).split("/");
  const depth = parts[0].startsWith("@") ? 2 : 1;
  if (parts.length <= depth || parts[depth - 1] === "") return { version: null, manifest: null };
  const manifest = "/" + dir.slice(0, at) + "node_modules/" + parts.slice(0, depth).join("/") + "/package.json";
  let found = null;
  try { found = JSON.parse(packageJsonText(builtins.fs.readFileSync(manifest, "utf8"))); } catch {}
  if (!found || found.name !== owner || typeof found.version !== "string") return { version: null, manifest: null };
  return { version: found.version, manifest };
}

// What a require of \`owner\`'s binding from \`owner\`@\`version\` (read from
// \`manifest\`) has to do when Nimbus stages no build of that version: which
// versions it does, and how to install one.
function __stagedVersionUnbuilt(owner, version, manifest) {
  const versions = __NIMBUS_STAGED_BINDINGS.filter((b) => b.owner === owner).map((b) => b.version);
  const newest = versions[versions.length - 1];
  return Object.assign(new Error("Nimbus runs " + owner + "'s N-API binding from staged wasm builds of " + versions.join(", ")
    + ", and this process loaded " + owner + "@" + version + " (" + manifest + "), which has none yet; no native build loads in a"
    + " Worker. Install a version Nimbus builds: npm install " + owner + "@" + newest + ", or where another package requires "
    + owner + ", pin it in package.json (" + '"overrides": { "' + owner + '": "' + newest + '" }' + ")."), { code: "ERR_NIMBUS_BINDING_VERSION" });
}

/**
 * A require of a staged binding's package (its wasm32-wasi build, or a
 * platform shard named like it) or of its owner's native \`.node\`, when the
 * launch carries no binding for it: none of those loads in a Worker, and a
 * napi-rs loader tries them all, swallows the wasi failures, and reports the
 * missing native file. Refused by name instead, and said once on stderr:
 * which binding, the version Nimbus stages, and why this launch lacks it.
 * Null when the id is none of those, or the binding is carried (the loader's
 * own fallbacks then reach it).
 */
function __stagedBindingNotCarried(id, fromDir) {
  // Every require that is not a builtin's or a staged binding's asks this, after the program ran: by index, on captures.
  for (let b = 0; b < __NIMBUS_STAGED_BINDINGS.length; b++) {
    const binding = __NIMBUS_STAGED_BINDINGS[b];
    let shard = false;
    let carried = false;
    for (let i = 0; i < binding.requiredAs.length; i++) {
      const wasi = binding.requiredAs[i];
      // wasi.replace(/wasm32-wasi$/, "")
      const stem = __pathEndsWith(wasi, "wasm32-wasi") ? __pathSlice(wasi, 0, wasi.length - 11) : wasi;
      if (id === wasi || __pathStartsWith(id, stem)) shard = true;
      if (__stagedBinding(wasi)) carried = true;
    }
    const native = __pathEndsWith(id, ".node") && __stagedOwnerVersion(binding.owner, fromDir).version !== null;
    if (!shard && !native) continue;
    if (carried) return null;
    // A version with no staged build is the version's to fix, not the launch's.
    const loaded = __stagedOwnerVersion(binding.owner, fromDir);
    if (loaded.version !== null && !__NIMBUS_STAGED_BINDINGS.some((b) => b.owner === binding.owner && b.version === loaded.version)) {
      return __stagedVersionUnbuilt(binding.owner, loaded.version, loaded.manifest);
    }
    const versions = __NIMBUS_STAGED_BINDINGS.filter((b) => b.name === binding.name).map((b) => b.version).join(", ");
    const message = "Nimbus runs " + binding.owner + "'s N-API binding from staged builds of " + versions + ", and this launch"
      + " does not carry it: no module the launch staged names " + binding.requiredAs[0] + " (the package was loaded by a name"
      + " its code computes), so " + id + " was asked for instead, and no native build loads in a Worker. The next launch of"
      + " this command, which learns the modules this one loaded, carries it.";
    if (!__stagedBindingsNamed.has(binding.name)) {
      __stagedBindingsNamed.add(binding.name);
      try { builtins.process.stderr.write("Nimbus: " + message + "\\n"); } catch {}
    }
    return Object.assign(new Error(message), { code: "ERR_NIMBUS_BINDING_NOT_CARRIED" });
  }
  return null;
}

function __loadStagedBinding(builds, fromDir) {
  // A build is of one upstream version: the package requiring it must be
  // that version, or its JavaScript and the binding disagree about every
  // class and option. So the owner's own package.json picks the build; a
  // require from outside the owner has no version, and takes the one build
  // the launch carries.
  const first = builds.values().next().value;
  const loaded = __stagedOwnerVersion(first.owner, fromDir);
  const entry = loaded.version !== null ? builds.get(loaded.version) : builds.size === 1 ? first : undefined;
  if (entry === undefined) {
    if (loaded.version === null) {
      throw new Error("Nimbus carries " + first.owner + "'s N-API binding at " + [...builds.keys()].join(", ")
        + ", and this require of it comes from outside " + first.owner + " (" + fromDir + "), so no version says which.");
    }
    if (!__NIMBUS_STAGED_BINDINGS.some((b) => b.owner === first.owner && b.version === loaded.version)) {
      throw __stagedVersionUnbuilt(first.owner, loaded.version, loaded.manifest);
    }
    throw new Error("Nimbus runs " + first.owner + "'s N-API binding from staged builds, and this launch carries "
      + [...builds.keys()].join(", ") + ", not " + loaded.version + ", which this process loaded (" + loaded.manifest
      + "). The next launch of this command, which learns the modules this one loaded, carries it.");
  }
  if (entry.exports !== undefined) return entry.exports;
  entry.exports = entry.create({
    fs: builtins.fs,
    env: builtins.process.env,
    writeStdout: (bytes) => builtins.process.stdout.write(bytes),
    writeStderr: (bytes) => builtins.process.stderr.write(bytes),
  });
  return entry.exports;
}

/**
 * require() from a specific directory context.
 * This is what each loaded module gets as its require function.
 */
// Whether the ES loader has the module at \`path\`: an ES module require() loaded
// (require(esm)), whose job it keeps. A CommonJS module require() loaded is no job of its.
function __nimbusEsmJobCached(path) {
  if (typeof path !== "string") return false;
  const id = __nimbusEsmId("module", __vfsKey(path));
  const state = id === -1 ? 0 : __nimbusEsmRecords[id]?.state ?? 0;
  return state === __ESM_DONE || state === __ESM_ADOPTED;
}
// \`specifier\` from \`parentUrl\` resolved as an import and loadable, and (\`type\` not undefined) checked
// against its type attribute, as Node's loader does; else its error, the loader's own (no arrow of the importer's).
function __nimbusResolveImport(specifier, parentUrl, type) {
  try {
    const resolution = __esmResolver.resolveSync(specifier, parentUrl);
    __nimbusAssertLoadable(resolution, type ?? undefined);
    if (type !== undefined) __esmResolver.validateAttributes(resolution.url, resolution.format, type === null ? {} : { type });
    return resolution;
  } catch (error) {
    __nimbusDecorated.add(error);
    throw error;
  }
}
// Module.prototype.require from \`parent\`, its requests resolving from \`fromDir\`.
function __requireFrom(id, fromDir, parent) {
  if (typeof id !== "string") throw invalidArgType("id", "string", id);
  if (id === "") throw new nodeErrorCodes.ERR_INVALID_ARG_VALUE("id", id, "must be a non-empty string");
  // A builtin; a facet's package or a staged N-API binding.
  const builtin = __nimbusBuiltinId(id);
  if (builtin !== null) return builtins[builtin];
  const binding = __nimbusFacetProvidedPackages.has(id) ? null : __stagedBinding(id);
  const provided = binding ? __loadStagedBinding(binding, fromDir) : __nimbusFacetProvidedPackages.has(id) ? builtins[id] : undefined;
  if (provided !== undefined) return provided;
  if (__pathStartsWith(id, "node:")) throw nodeError(Error, "ERR_UNKNOWN_BUILTIN_MODULE", "No such built-in module: " + id);
  const notCarried = __stagedBindingNotCarried(id, fromDir);
  if (notCarried) throw notCarried;
  const resolved = __resolveFrom(id, fromDir, parent?.filename);
  if (!resolved) throw __nimbusModuleNotFound(id, parent);
  return __loadModule(resolved, resolved, true, parent);
}
// V8's errors compiling CommonJS that an ES module would not have
// (lib/internal/modules/helpers.js esmSyntaxErrorMessages), and those only
// CommonJS throws, which Node retries as a module (throwsOnlyInCommonJSErrorMessages).
const __NIMBUS_ESM_SYNTAX_ERRORS = ["Cannot use import statement outside a module", "Unexpected token 'export'", "Cannot use 'import.meta' outside a module"];
const __NIMBUS_COMMONJS_ONLY_ERRORS = [
  "Identifier 'module' has already been declared", "Identifier 'exports' has already been declared",
  "Identifier 'require' has already been declared", "Identifier '__filename' has already been declared",
  "Identifier '__dirname' has already been declared", "await is only valid in async functions and the top level bodies of modules",
];
// Node's enrichCJSError, for the main module (CJS loader wrapSafe): a
// SyntaxError compiling it, whose source has module syntax, is preceded by a
// warning, emitted at once, as the process is about to end.
// Whether \`e\`, compiling \`source\` as CommonJS, is the error of module syntax, which Node's loader retries as an ES module.
function __nimbusModuleSyntaxError(e, source) {
  if (!(e instanceof SyntaxError)) return false;
  if (__NIMBUS_ESM_SYNTAX_ERRORS.includes(e.message)) return true;
  if (!__NIMBUS_COMMONJS_ONLY_ERRORS.includes(e.message)) return false;
  const text = source();
  return text !== null && __nimbusRegistryRequire("./${RUNTIME_PARSER_MODULE}").fatalLocation(text, "module", -1) === null;
}
function __nimbusEnrichCommonJsError(e, source, filename) {
  if (!__nimbusModuleSyntaxError(e, source)) return;
  const warning = new Error("Failed to load the ES module: " + filename + ". Make sure to set \\"type\\": \\"module\\" in the nearest package.json file or use the .mjs extension.");
  warning.name = "Warning";
  Error.captureStackTrace(warning, __nimbusEnrichCommonJsError);
  __processMod.emit("warning", warning);
}
// -c of a cell that compiled: its body must be one function body, or it
// compiled only by closing the wrapper's, and is the SyntaxError Node reports
// at the brace that does, its arrow as a compile's (__nimbusDecorateSyntaxError).
function __nimbusCheckedAlone() {
  const module = __nimbusEntryModule();
  const text = module === null ? null : __nimbusFrameModuleText(module);
  if (text === null) return undefined;
  const at = __nimbusRegistryRequire("./${RUNTIME_PARSER_MODULE}").strayClosingBrace(text.slice(module.head, text.length - module.tail));
  if (at === null) return undefined;
  const error = new SyntaxError("Unexpected token '}'");
  error.stack = __nimbusArrowOf(module, text, module.head + at[0], module.head + at[1]) + "\\n" + error.stack;
  __nimbusDecorated.add(error);
  throw error;
}
// A CommonJS entry evaluated as Node's loader runs it (manager.ts
// entryModule; an ES entry is the registry's, __nimbusEsmRunEntry).
function __nimbusEvaluateEntry(load, mod, filename, dirname) {
  __nimbusLoadsTypeScript(filename);
  __nimbusEvalStripped(__nimbusEntryModule());
  const source = () => __nimbusModuleSourceText(__nimbusEntryModule() ?? __nimbusModuleAtPath(String(filename).replace(/^\\/+/, "")));
  __nimbusCompiling(filename, source);
  // A file's \`this\` is its exports, as Node's wrapper is called; -e and
  // stdin code is a script, whose \`this\` is the global object.
  const evaluated = filename === "<eval>" || filename === "[stdin]";
  // -c: compiled as Node's check compiles it (check_syntax.js wrapSafe, stdin's
  // too). Its cell stops at its first statement (manager.ts programEntry), so
  // a compile that succeeds runs nothing of it.
  const check = __nimbusNodeCommandLine?.check === true;
  let wrapper;
  try {
    wrapper = load();
  } catch (e) {
    if (check && e === ${JSON.stringify(ENTRY_CHECKED)}) return __nimbusCheckedAlone();
    // TypeScript's module syntax Node retries as an ES module (wrapSafe), which cannot be checked here without running it.
    if (check && typescriptLoader(filename) === "ts" && __nimbusModuleSyntaxError(e, source)) {
      __processMod.stderr.write("node: -c cannot check an ES module entry in Nimbus without running it\\n");
      __processMod.exit(9);
    }
    if (!evaluated || check) __nimbusEnrichCommonJsError(e, source, filename);
    throw e;
  }
  if (check) return undefined;
  // A file entry is process.mainModule and require.main (Module._load's
  // isMain), after the preloads, whose are undefined; -e's and stdin's are too.
  if (!evaluated) {
    Object.defineProperty(__processMod, "mainModule", { value: mod, writable: true, enumerable: true, configurable: true });
    mod.id = ".";
    __NodeModule._cache[mod.filename] = mod;
  }
  const self = evaluated ? globalThis : mod.exports;
  let threw = true;
  __nimbusExecutingCommonJs.add(mod);
  try {
    const result = __nimbusReflectApply(wrapper, self, [mod.exports, __nimbusMakeRequire(mod), mod, evaluated ? mod.id : filename, evaluated ? "." : dirname]);
    threw = false;
    return result;
  } finally {
    __nimbusExecutingCommonJs.delete(mod);
    // Module._load: a module whose load threw leaves the cache.
    if (!evaluated && threw) delete __NodeModule._cache[mod.filename];
    else if (!evaluated) mod.loaded = true;
  }
}
// The program's entry as Node's run_main makes it: a file's Module; -e's
// and stdin's "[eval]" and "[stdin]" at the working directory, an ES one's
// import.meta there as "[eval1]".
function __nimbusEntryModuleOf(filename, esModule) {
  const evaluated = filename === undefined || filename === "<eval>" || filename === "[stdin]";
  const id = evaluated ? (filename === "[stdin]" ? "[stdin]" : "[eval]") : filename;
  const mod = new __NodeModule(id, evaluated ? undefined : null);
  mod.filename = evaluated ? __pathMod.join(cwd || "/home/user", id) : filename;
  mod.paths = __NodeModule._nodeModulePaths(__pathMod.dirname(mod.filename));
  const metaFile = evaluated && esModule ? __pathMod.join(cwd || "/home/user", "[eval1]") : mod.filename;
  Object.defineProperty(mod, "__nimbusImportMeta", { value: __nimbusFileImportMeta(metaFile) });
  return mod;
}

// ═══════════════════════════════════════════════════════════════════════
// ── END OF GENERATED SHIMS — closing marker ─────────────────────────
// (builtins block has been moved above the resolver functions)
// ═══════════════════════════════════════════════════════════════════════
`;
}
