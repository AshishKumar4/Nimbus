/**
 * opencode-facet-runner.ts — facet runner for the staged opencode ESM bundle.
 *
 * opencode is ESM-only (its CLI entry uses top-level await, so it cannot be
 * bundled to CJS) and imports a broad set of node: builtins plus node:sqlite.
 * It therefore cannot run through the standard `new Function` CJS facet path
 * (that path wraps entry code in a function body, which forbids ESM syntax).
 *
 * Instead the bundle rides into the facet Worker Loader module map as a real
 * ESM module (`opencode-bundle.js`) and this runner is the mainModule that:
 *
 *   1. Builds the Nimbus VFS-backed node-compat `builtins` (node-shims.ts) at
 *      module-init scope over the per-invocation VFS snapshot bundle, and
 *      parks them on `globalThis.__nimbusOpencodeBuiltins`. The module map
 *      supplies `node:fs`, `node:fs/promises`, and `node:os` as bridge
 *      modules that re-export from that global, so opencode's filesystem and
 *      home-directory access (e.g. `~/.local/share/opencode`) lands in the
 *      live SQLite VFS via the supervisor bridge instead of hitting workerd's
 *      empty, read-only nodejs_compat filesystem (EPERM on mkdir).
 *   2. Installs the Bun-global polyfill (Bun.stdin.text, Bun.stringWidth,
 *      Bun.file, Bun.hash) — opencode references `Bun.*` even on node target.
 *   3. Seeds process.argv / env / cwd from the per-invocation constants.
 *   4. Captures stdout/stderr and process.exit.
 *   5. Imports the opencode bundle and invokes its exported nimbusMain()
 *      INSIDE the fetch handler. The bundle is built so its CLI is a deferred
 *      function rather than a module top-level await: workerd runs module TLA
 *      in "global scope", where the VFS supervisor RPC is a disallowed async
 *      I/O operation. Running from the handler gives opencode the request I/O
 *      context it needs.
 *
 * Builtins not bridged (path, process, util, url, crypto, stream, …) resolve
 * through workerd's nodejs_compat. node:sqlite is not provided by
 * nodejs_compat; it is bridged to the VFS-backed sql.js shim (the same
 * DatabaseSync the CJS facet path uses), and its wasm rides in via the module
 * map (see SQLITE_WASM_MODULE_NAME) and is booted before opencode opens the
 * DB at ~/.local/share/opencode/*.db.
 */

import { generateSqliteFacetPreamble } from './sqlite-shim.js';
import {
  OPENTUI_BACKEND_FACET_SRC,
  OPENTUI_BACKEND_GLOBAL,
  OPENTUI_WASM_MODULE_NAME,
  generateOpenTUIBackendBootCode,
} from './opentui-facet-backend.js';
import { OPENCODE_TREE_SITTER_WASMS, OPENCODE_YOGA_WASM } from '../opencode-artifact.generated.js';

// The ~230 KiB node-compat shim source is staged as a static asset
// (scripts/bundle-node-shims.mjs) — promoted out of the worker bundle for the
// ≤6 MiB gate. The caller (FacetManager.execStagedArtifact) awaits the
// memoized fetchNodeShimsCode and threads it in via opts.shimsCode.

/** Map-module specifier for the opencode ESM bundle. */
export const OPENCODE_BUNDLE_MODULE_NAME = 'opencode-bundle.js';


/**
 * Module-map specifier for the yoga-layout WebAssembly.Module. OpenTUI lays
 * out every TUI frame with yoga; the runner parks the pre-compiled Module on
 * `globalThis.__nimbusYogaModule` so the bundle's patched loader instantiates
 * it instead of doing the blocked request-time WebAssembly.instantiate(bytes).
 */
export const YOGA_WASM_MODULE_NAME = 'yoga.wasm';

/** Module-map specifier for the sql.js WebAssembly.Module. */
export const SQLITE_WASM_MODULE_NAME = 'sqlite.wasm';

/**
 * Runner argv sentinel for the tree-sitter wasm diagnostic. `opencode
 * __nimbus-tree-sitter-diag [command]` runs web-tree-sitter core init +
 * bash/powershell grammar loads + a bash parse through the bundle's OWN
 * (Nimbus-patched) web-tree-sitter instance — the exact module-map/registry
 * path the bash tool's parser uses — without needing a model. Reported as
 * JSON on stdout; probed by
 * tests/behavioral/agentic-cli/new/opencode-tree-sitter-bash-parse.mjs.
 */
export const OPENCODE_TREE_SITTER_DIAG_ARG = '__nimbus-tree-sitter-diag';

/**
 * The registry contract with the Nimbus-patched opencode bundle: the runner
 * parks `Map<wasm basename, WebAssembly.Module>` on this global at
 * module-init; web-tree-sitter's two byte→compile seams (Emscripten
 * createWasm for the core, Language.load for grammars) consult it instead of
 * compiling bytes (request-time WebAssembly.compile is blocked in facets)
 * and fail loud on unregistered wasm names. See
 * scripts/opencode/build-node.ts (nimbusPatchWebTreeSitter).
 */
const TREE_SITTER_REGISTRY_GLOBAL = '__nimbusTreeSitterModules';

/** Global key under which the runner parks the VFS-backed node builtins. */
const BUILTINS_GLOBAL = '__nimbusOpencodeBuiltins';

/**
 * Bridge-module specifiers and the node builtin each forwards to. opencode
 * imports these from the empty nodejs_compat filesystem; we redirect them to
 * the VFS-backed shim builtins parked on globalThis by the runner.
 */
interface BuiltinBridge {
  specifier: string;
  /** Key into the shim `builtins` map. */
  builtin: string;
  /** Named exports to surface (the public node API; superset of opencode use). */
  names: readonly string[];
}

// node:fs public surface (the contract Nimbus' shim implements). Listed
// explicitly because ESM named exports must be static; `import * as fs`
// resolves these as the namespace. Members the shim omits export as
// undefined — opencode only consumes the implemented subset.
const FS_NAMES: readonly string[] = [
  'access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync',
  'chown', 'chownSync', 'close', 'closeSync', 'constants', 'copyFile',
  'copyFileSync', 'cp', 'cpSync', 'createReadStream', 'createWriteStream',
  'exists', 'existsSync', 'fstat', 'fstatSync', 'lchown', 'lchownSync',
  'link', 'linkSync', 'lstat', 'lstatSync', 'mkdir', 'mkdirSync', 'mkdtemp',
  'mkdtempSync', 'open', 'openSync', 'opendir', 'opendirSync', 'read',
  'readSync', 'readdir', 'readdirSync', 'readFile', 'readFileSync', 'readlink',
  'readlinkSync', 'realpath', 'realpathSync', 'rename', 'renameSync', 'rm',
  'rmSync', 'rmdir', 'rmdirSync', 'stat', 'statSync', 'statfs', 'statfsSync',
  'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'unlink', 'unlinkSync',
  'utimes', 'utimesSync', 'watch', 'watchFile', 'unwatchFile', 'write',
  'writeSync', 'writeFile', 'writeFileSync', 'writev', 'writevSync',
  'Dirent', 'Stats', 'ReadStream', 'WriteStream', 'Dir', 'promises',
];

// node:fs/promises public surface.
const FS_PROMISES_NAMES: readonly string[] = [
  'access', 'appendFile', 'chmod', 'chown', 'constants', 'copyFile', 'cp',
  'lchown', 'link', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readdir',
  'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat',
  'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'writeFile',
];

// node:os public surface.
const OS_NAMES: readonly string[] = [
  'arch', 'constants', 'cpus', 'devNull', 'endianness', 'EOL', 'freemem',
  'getPriority', 'homedir', 'hostname', 'loadavg', 'machine', 'networkInterfaces',
  'platform', 'release', 'setPriority', 'tmpdir', 'totalmem', 'type', 'uptime',
  'userInfo', 'version', 'availableParallelism',
];
// The shim http surface (node-shims.ts builtins.http). request/get throw
// "Use fetch()" — honest failure; nodejs_compat's fetch-backed client is NOT
// preserved by this bridge, so a chunk that does http.request() fails loud.
const HTTP_NAMES: readonly string[] = [
  'createServer', 'Server', 'IncomingMessage', 'ServerResponse',
  'Agent', 'STATUS_CODES', 'METHODS', 'request', 'get',
];

const BUILTIN_BRIDGES: readonly BuiltinBridge[] = [
  { specifier: 'node:fs', builtin: 'fs', names: FS_NAMES },
  { specifier: 'node:fs/promises', builtin: 'fs/promises', names: FS_PROMISES_NAMES },
  { specifier: 'node:os', builtin: 'os', names: OS_NAMES },
  // node:sqlite is not in nodejs_compat; bridge to the VFS-backed sql.js shim.
  { specifier: 'node:sqlite', builtin: 'sqlite', names: ['DatabaseSync', 'StatementSync'] },
  // node:http MUST land on the shim server, not nodejs_compat: the serve
  // facet's HTTP server is only routeable (loopback + external preview +
  // the /doc readiness gate) if listen() registers on globalThis.__portRegistry
  // and SUPERVISOR.registerPort. nodejs_compat's http.Server binds invisibly —
  // "listening" is printed but no request can ever be routed to it (the
  // empty-registry 502). CJS require("http") already resolves to this shim;
  // this bridge gives the ESM `import "node:http"` chunks the same server.
  { specifier: 'node:http', builtin: 'http', names: HTTP_NAMES },
];

// node:process public surface opencode/OpenTUI consume by name. The bundle uses
// bare global `process`, `import … from "node:process"`, AND runtime
// `require("process")` (split-build chunks force some CJS dependencies, e.g.
// OpenTelemetry's resource detectors, to evaluate their requires at chunk
// init). workerd aliases the bare require to `node:process` but provides NO
// such module for require — so the facet module map must carry the bridge in
// BOTH modes or any chunk that requires process dies with `No such module
// "node:process"`. The bridge reads `globalThis.process`, which is
// mode-correct by construction: the attached-TTY boot block parks the Nimbus
// shim process there (raw-mode stdin pump, live stdout, SIGWINCH) before the
// bundle links, and the one-shot path keeps workerd's process.
const PROCESS_NAMES: readonly string[] = [
  'argv', 'argv0', 'env', 'platform', 'arch', 'version', 'versions', 'pid',
  'ppid', 'title', 'execPath', 'execArgv', 'stdin', 'stdout', 'stderr',
  'cwd', 'chdir', 'exit', 'exitCode', 'nextTick', 'hrtime', 'memoryUsage',
  'uptime', 'kill', 'on', 'once', 'off', 'addListener', 'removeListener',
  'removeAllListeners', 'prependListener', 'emit', 'listeners', 'listenerCount',
  'eventNames', 'setMaxListeners', 'getMaxListeners', 'umask', 'getuid',
  'getgid', 'features', 'config', 'release', 'binding',
];
// node:console. workerd's node:console does not implement the `Console`
// constructor (it throws "The Console method is not implemented"); OpenTUI's
// console capture does `new Console({ stdout, stderr, ... })` during renderer
// setup, so the TUI aborts before its first frame. The attached path bridges
// node:console to the shim's console (which provides a working Console writing
// to the supplied streams); the one-shot path bridges the global console so
// runtime `require("console")` resolves.
const CONSOLE_NAMES: readonly string[] = [
  'Console', 'log', 'info', 'debug', 'dir', 'error', 'warn', 'trace', 'assert',
  'table', 'group', 'groupEnd', 'time', 'timeEnd', 'timeLog', 'clear', 'count',
  'countReset',
];

/**
 * One bridge module: re-export a VFS-backed shim builtin (parked on
 * globalThis by the runner at module-init, BEFORE any bridge evaluates) as a
 * proper ESM module with default + named exports.
 */
function generateBuiltinBridge(bridge: BuiltinBridge): string {
  const names = bridge.names
    .map((n) => `export const ${n} = __m[${JSON.stringify(n)}];`)
    .join('\n');
  return `
const __m = (globalThis.${BUILTINS_GLOBAL} && globalThis.${BUILTINS_GLOBAL}[${JSON.stringify(bridge.builtin)}]) || {};
export default __m;
${names}
`;
}

/**
 * A bridge module that re-exports a GLOBAL (process, console) as a proper ESM
 * module. Evaluates when the opencode bundle links — after the runner's boot
 * block, so `globalThis.process` is already the mode-correct object (the shim
 * process in attached-TTY mode, workerd's process one-shot).
 */
function generateGlobalBridge(globalName: string, names: readonly string[]): string {
  const exports = names
    .map((n) => `export const ${n} = __m[${JSON.stringify(n)}];`)
    .join('\n');
  return `
const __m = globalThis.${globalName};
export default __m;
${exports}
`;
}

/**
 * Module-map entries for the VFS-backed node builtin bridges. The Worker
 * Loader requires non-`.js`/`.py` module names (like `node:fs`) to use the
 * explicit `{ js }` content form.
 */
export function opencodeBuiltinBridgeModules(attachedTty = false): Record<string, { js: string }> {
  const out: Record<string, { js: string }> = {};
  for (const bridge of BUILTIN_BRIDGES) {
    out[bridge.specifier] = { js: generateBuiltinBridge(bridge) };
  }
  // Both modes: workerd resolves bare `require("process")` to node:process
  // but ships no such require-able module, so the map must provide it.
  out['node:process'] = { js: generateGlobalBridge('process', PROCESS_NAMES) };
  // console: the attached TUI needs the shim's working `Console` class; the
  // one-shot path re-exports the global so runtime requires resolve.
  out['node:console'] = attachedTty
    ? { js: generateBuiltinBridge({ specifier: 'node:console', builtin: 'console', names: CONSOLE_NAMES }) }
    : { js: generateGlobalBridge('console', CONSOLE_NAMES) };
  return out;
}

/** The Bun-global polyfill, as a facet module-init block. */
const BUN_GLOBAL_POLYFILL: string = `
if (typeof globalThis.Bun === "undefined") {
  const __ocFs = globalThis.${BUILTINS_GLOBAL}.fs;
  const __ocCrypto = globalThis.${BUILTINS_GLOBAL}.crypto;
  globalThis.Bun = {
    stdin: { text: () => new Promise((resolve) => {
      let data = "";
      try {
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", () => resolve(data));
      } catch { resolve(data); }
    }) },
    stringWidth: (s) => {
      const clean = String(s).replace(/\\x1b\\[[0-9;]*m/g, "");
      return [...clean].length;
    },
    file: (p) => ({
      text: () => __ocFs.promises.readFile(p, "utf8"),
      arrayBuffer: async () => (await __ocFs.promises.readFile(p)).buffer,
      exists: async () => __ocFs.existsSync(p),
    }),
    hash: (s) => {
      const h = __ocCrypto.createHash("sha256").update(String(s)).digest();
      return h.readBigUInt64BE(0);
    },
  };
}
`;

export interface OpencodeRunnerOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  /** The node-compat shim source (fetchNodeShimsCode — the staged asset). */
  shimsCode: string;
  /**
   * Serialized VFS snapshot bundle (the `_serializeBundleForFacet` IIFE
   * string). Provides sync VFS reads; async writes/mkdir flush live through
   * the SUPERVISOR RPC binding.
   */
  vfsBundle: string;
  /** Serialized VFS directory manifest (JSON) for readdir/stat coherence. */
  vfsManifest: string;
  /**
   * Runtime disposition of this opencode invocation:
   *   - 'oneshot'  buffer stdout/stderr into the JSON response and return
   *                (opencode run / models / --version).
   *   - 'attached' drive opencode's real createCliRenderer path: stdout/stderr
   *                stream LIVE to the SUPERVISOR (→ xterm), the live stdin pump
   *                (SUPERVISOR.cpReadStdin → process.stdin, with setRawMode/
   *                resize/signal) feeds keystrokes, and the facet stays alive on
   *                workerCtx.waitUntil until opencode exits. The env must carry
   *                NIMBUS_ATTACHED_TTY=1 + NIMBUS_CP_CHILD_PID so the shim TTY
   *                activates its raw-mode stdin and columns/rows.
   *   - 'server'   run a headless `opencode serve` HTTP server: no renderer, no
   *                stdin pump, logs stream live, the facet stays resident, and
   *                routed HTTP (the in-session loopback + external /port/<n>)
   *                is dispatched to the in-facet server via handleHttpRequest.
   */
  mode: OpencodeRunnerMode;
}

export type OpencodeRunnerMode = 'oneshot' | 'attached' | 'server';

/**
 * The facet-side TTY stdout for the OpenTUI span-feed path. createCliRenderer
 * allocates the NativeSpanFeed iff `stdout !== process.stdout`; opencode passes
 * no custom stdout, so bundle seam 7 defaults config.stdout to this global. It
 * is a DISTINCT object (≠ process.stdout) that forwards every write to the
 * facet's process.stdout (which streams live to the terminal RPC). The feed
 * emits Uint8Array chunks; they are decoded latin1 (byte-preserving) so the raw
 * ANSI bytes reach xterm intact. columns/rows/isTTY mirror the shim TTY so the
 * renderer reads the live terminal geometry.
 */
const OPENTUI_TTY_STDOUT_SRC: string = `
globalThis.__nimbusOpenTUITtyStdout = {
  isTTY: true,
  get columns() { return __nimbusTtyColumns; },
  get rows() { return __nimbusTtyRows; },
  write(chunk, enc, cb) {
    const s = typeof chunk === "string"
      ? chunk
      : __BufferMod.from(chunk).toString("latin1");
    process.stdout.write(s);
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") done();
    return true;
  },
  getColorDepth: () => 24,
  hasColors: () => true,
  on() { return this; },
  once() { return this; },
  removeListener() { return this; },
  emit() { return false; },
};
`;

/**
 * The render clock OpenTUI's loop schedules against. Bundle seam 7 defaults
 * config.clock to this when present. It delegates to the facet's real timers
 * (workerd provides performance.now + setTimeout/setInterval). The render loop
 * self-reschedules via clock.setTimeout; workerd only advances timers across
 * real I/O yields, and the attached-TTY stdin pump (cpReadStdin round-trips)
 * supplies them — so frames flush on keystrokes and at the idle pump cadence.
 * Owning the clock here keeps the facet tick policy in one seam.
 */
const OPENTUI_CLOCK_SRC: string = `
globalThis.__nimbusOpenTUIClock = {
  now: () => globalThis.performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h),
};
`;

/**
 * In-isolate Web Worker polyfill for the opencode TUI client/server split.
 *
 * opencode's TUI (the bare `opencode` process) is a CLIENT that spawns its API
 * SERVER as `new Worker("./worker.js", {env})` and talks to it over birpc
 * (cli/cmd/tui/worker.ts). OpenTUI's syntax-highlight tree-sitter parser
 * likewise runs in `new Worker("./parser.worker.js")`. On a real platform each
 * is a separate OS thread / V8 isolate; on workerd there is one isolate per
 * facet and no real `Worker` global (node-shims stubs worker_threads.Worker as
 * a no-op), so `client.call(...)` hangs forever before the renderer mounts.
 *
 * This polyfill runs BOTH the client and the worker module in the same isolate,
 * cooperating over an in-memory MessageChannel. `new Worker(file, opts)`:
 *
 *   1. Maps the worker `file` (`./worker.js` / `./parser.worker.js`) to its
 *      staged module-map specifier.
 *   2. Builds a worker-side context (the `__nimbusWorker` the worker bundle's
 *      build-time banner claims via globalThis.__nimbusWorkerClaim) carrying
 *      the worker's own `postMessage` (→ the Worker instance's message
 *      listeners) and `onmessage` (← messages the client posts). `self` members
 *      other than messaging fall through to globalThis.
 *   3. Parks that context for the claim, then dynamically imports the staged
 *      worker module — running its top-level (Rpc.listen / OTUI parser setup),
 *      which installs `context.onmessage`.
 *   4. Bridges the two directions: the Worker instance's postMessage delivers to
 *      the worker context's onmessage; the worker's postMessage delivers to the
 *      instance's message listeners. Messages sent before the worker installs
 *      its handler are buffered and flushed on install.
 *
 * The Worker instance exposes the EventEmitter + DOM surface opencode uses:
 * `onmessage`, `onerror`, `postMessage`, `terminate`, and `on/once/off/
 * addEventListener/removeEventListener` for `message`/`error`. Only wired in
 * attachedTty mode (the one-shot path never reaches the TUI command).
 */
export const WORKER_POLYFILL_SRC: string = `
{
  // Dynamic import of a staged worker module, resolved against the facet's
  // Worker Loader module map (this block is injected into the runner's module
  // scope, so a bare import() resolves the map specifiers). Overridable by
  // unit tests that exercise the message bridge without a real module map.
  if (typeof globalThis.__nimbusWorkerImport !== "function") {
    globalThis.__nimbusWorkerImport = (specifier) => import(specifier);
  }

  // Map a Worker spec (a baked "./worker.js" string, a URL, or a file URL the
  // bundle constructs) to its staged module-map specifier. Fail loud on an
  // unrecognized worker so a future opencode worker is not silently no-op'd.
  const __nimbusWorkerSpecifier = (spec) => {
    let s = "";
    if (typeof spec === "string") s = spec;
    else if (spec && typeof spec.href === "string") s = spec.href;
    else if (spec && typeof spec.pathname === "string") s = spec.pathname;
    else s = String(spec);
    const base = s.split(/[\\\\/]/).pop() || s;
    if (base === "worker.js") return "worker.js";
    if (base === "parser.worker.js") return "parser.worker.js";
    throw new Error("Nimbus: unsupported in-isolate Worker target: " + s);
  };

  // self/globalThis fall-through for the worker context: messaging is owned by
  // the context; everything else (location, crypto, indexedDB, …) reads the
  // real global so the worker bundle's feature detection behaves as upstream.
  const __nimbusWorkerCtx = (worker) => {
    const own = {
      onmessage: null,
      postMessage(data) {
        // worker → client. Deliver asynchronously (a real Worker never calls
        // the client's listener synchronously inside postMessage).
        queueMicrotask(() => worker.__nimbusDeliverToClient(data));
      },
      addEventListener(type, fn) {
        if (type === "message") own.onmessage = (e) => fn(e);
      },
      removeEventListener(type) {
        if (type === "message") own.onmessage = null;
      },
      close() { worker.terminate(); },
    };
    return new Proxy(own, {
      get(t, p) {
        if (p in t) return t[p];
        const g = globalThis[p];
        return typeof g === "function" ? g.bind(globalThis) : g;
      },
      set(t, p, v) {
        if (p === "onmessage" || p in t) { t[p] = v; return true; }
        try { globalThis[p] = v; } catch {}
        return true;
      },
      has(t, p) { return (p in t) || (p in globalThis); },
    });
  };

  // In-polyfill replacement for worker.js's RPC surface (opencode's
  // cli/cmd/tui/worker.ts, spoken over the Rpc JSON protocol). The attach
  // facet's HTTP already flows to the remote serve facet, so the local
  // worker's only load-bearing method here is the fetch proxy; server()
  // must never be called (the serve facet owns the port), and the
  // upgrade/reload/shutdown lifecycle belongs to the serve facet too.
  async function __nimbusStubWorkerRpc(worker, event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg || msg.type !== "rpc.request") return;
    const reply = (payload) => {
      queueMicrotask(() => worker.__nimbusDeliverToClient(JSON.stringify(payload)));
    };
    try {
      let result;
      switch (msg.method) {
        case "fetch": {
          const req = msg.input || {};
          const res = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
          });
          result = {
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body: await res.text(),
          };
          break;
        }
        case "server":
          throw new Error(
            "Nimbus: the attach facet does not host the opencode server — " +
            "it attaches to the dedicated 'opencode serve' facet"
          );
        case "snapshot":
          result = null;
          break;
        case "checkUpgrade":
        case "reload":
        case "shutdown":
          result = void 0;
          break;
        default:
          throw new Error("Nimbus: unsupported TUI worker RPC: " + String(msg.method));
      }
      reply({ type: "rpc.result", result, id: msg.id });
    } catch (e) {
      reply({ type: "rpc.error", error: e instanceof Error ? e.message : String(e), id: msg.id });
    }
  }

  class NimbusWorker {
    constructor(spec, opts) {
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      this.__listeners = { message: new Set(), error: new Set() };
      this.__terminated = false;
      // Messages the client posts before the worker installs its handler.
      this.__inbox = [];
      this.__ctx = __nimbusWorkerCtx(this);
      const specifier = __nimbusWorkerSpecifier(spec);
      // worker.js is the TUI's LOCAL API server. A Nimbus attach facet
      // always talks to a REMOTE opencode-serve facet instead (the dual
      // split), and dynamically importing worker.js's split-build chunk
      // graph into a live facet kills the production workerd process
      // outright — supervisor DO included (defect #20; a workerd platform
      // bug, see scratchpad/oc-attach-reset-rootcause.md). So the worker is
      // answered by an in-polyfill RPC stub and its bundle is NEVER
      // imported. parser.worker.js (flat, no chunk graph) loads for real.
      if (specifier === "worker.js") {
        this.__ctx.onmessage = (o) => { void __nimbusStubWorkerRpc(this, o); };
        queueMicrotask(() => {
          const pending = this.__inbox;
          this.__inbox = null;
          if (pending) for (const m of pending) this.__deliverToWorker(m);
        });
        this.__ready = Promise.resolve();
        return;
      }
      // The worker bundle's banner reads this synchronously at module-init.
      globalThis.__nimbusWorkerClaim = () => this.__ctx;
      this.__ready = (async () => {
        try {
          // The worker env (OPENCODE_PROCESS_ROLE/RUN_ID) rides the shared
          // process.env; apply additively so OPENCODE_RUN_ID etc. are present.
          if (opts && opts.env) { try { Object.assign(process.env, opts.env); } catch {} }
          // Dynamic import of the staged worker module (resolved against the
          // facet module map). Indirected through a global hook so unit tests
          // can substitute a fake worker module without the module map.
          await globalThis.__nimbusWorkerImport(specifier);
          // Flush any buffered inbound messages now that onmessage is wired.
          const pending = this.__inbox;
          this.__inbox = null;
          for (const m of pending) this.__deliverToWorker(m);
        } catch (e) {
          this.__emitError(e);
        }
      })();
    }
    __deliverToWorker(data) {
      const handler = this.__ctx.onmessage;
      if (typeof handler === "function") {
        try { handler({ data }); } catch (e) { this.__emitError(e); }
      }
    }
    // client → worker
    postMessage(data) {
      if (this.__terminated) return;
      if (this.__inbox) { this.__inbox.push(data); return; }
      queueMicrotask(() => this.__deliverToWorker(data));
    }
    // worker → client (invoked by the worker context's postMessage)
    __nimbusDeliverToClient(data) {
      if (this.__terminated) return;
      const evt = { data };
      if (typeof this.onmessage === "function") {
        try { this.onmessage(evt); } catch (e) { this.__emitError(e); }
      }
      for (const fn of this.__listeners.message) {
        try { fn(evt); } catch (e) { this.__emitError(e); }
      }
    }
    __emitError(error) {
      const evt = { message: (error && error.message) || String(error), error, filename: "", lineno: 0, colno: 0 };
      if (typeof this.onerror === "function") { try { this.onerror(evt); } catch {} }
      for (const fn of this.__listeners.error) { try { fn(evt); } catch {} }
    }
    addEventListener(type, fn) {
      if (this.__listeners[type]) this.__listeners[type].add(fn);
    }
    removeEventListener(type, fn) {
      if (this.__listeners[type]) this.__listeners[type].delete(fn);
    }
    // node:worker_threads EventEmitter surface (some code paths use .on).
    on(type, fn) {
      const t = type === "message" ? "message" : type === "error" ? "error" : null;
      if (t) this.__listeners[t].add(fn);
      return this;
    }
    once(type, fn) {
      const wrap = (e) => { this.removeEventListener(type, wrap); fn(e); };
      this.addEventListener(type, wrap);
      return this;
    }
    off(type, fn) { this.removeEventListener(type, fn); return this; }
    removeListener(type, fn) { this.removeEventListener(type, fn); return this; }
    terminate() {
      this.__terminated = true;
      this.__listeners.message.clear();
      this.__listeners.error.clear();
      return Promise.resolve(0);
    }
    ref() { return this; }
    unref() { return this; }
  }
  globalThis.Worker = NimbusWorker;
  try {
    const __wt = globalThis.process && globalThis.process.binding;
    // worker_threads.Worker is consulted by some libraries; point it at the
    // same in-isolate implementation so they cooperate over the channel too.
    if (globalThis.__nimbusOpencodeBuiltins) {
      const __wtMod = globalThis.__nimbusOpencodeBuiltins["worker_threads"];
      if (__wtMod) __wtMod.Worker = NimbusWorker;
    }
  } catch {}
}
`;

/**
 * Module-init source that imports the pre-compiled yoga-layout
 * WebAssembly.Module from the module map and parks it on
 * globalThis.__nimbusYogaModule for the bundle's patched yoga loader (the TUI
 * lays out every frame with yoga). Empty when yoga is not staged — fail loud at
 * generation so a TUI facet never boots without its layout engine.
 */
function yogaImportSrc(): string {
  if (!OPENCODE_YOGA_WASM) {
    throw new Error(
      'opencode yoga-layout wasm is not staged — rerun scripts/bundle-opencode.mjs ' +
        'with an opencode dist that extracted yoga.wasm (build-node.ts)',
    );
  }
  return `
// ── yoga-layout wasm (module-init scope) ────────────────────────────────────
// OpenTUI lays out every TUI frame with yoga-layout (an Emscripten wasm). Its
// loader does request-time WebAssembly.instantiate(bytes), which workerd blocks
// in a facet; the pre-compiled Module rides in via the module map and the
// patched loader (bundle-patches.ts seam 8) instantiates THIS instead.
import __nimbusYogaModule from "${YOGA_WASM_MODULE_NAME}";
globalThis.__nimbusYogaModule = __nimbusYogaModule;
`;
}

/**
 * Generate the mainModule that boots the opencode ESM bundle in a facet.
 * One-shot mode buffers stdout/stderr into the JSON response; attachedTty mode
 * streams them live and keeps the facet alive for the interactive TUI.
 */
export function generateOpencodeRunnerCode(opts: OpencodeRunnerOptions): string {
  const treeSitter = OPENCODE_TREE_SITTER_WASMS;
  if (!treeSitter) {
    throw new Error(
      'opencode tree-sitter wasm sidecars are not staged — rerun ' +
        'scripts/bundle-opencode.mjs with the opencode dist present',
    );
  }
  const safe = {
    argv: JSON.stringify(opts.argv),
    env: JSON.stringify(opts.env),
    cwd: JSON.stringify(opts.cwd),
    stdin: JSON.stringify(opts.stdin),
  };
  // 'attached' drives the interactive TUI (worker polyfill, yoga, OpenTUI span
  // feed, raw-mode stdin pump). 'server' is a headless resident HTTP server
  // (opencode serve): it streams logs live and stays resident like the attached
  // path, but never renders and never grabs the TTY. 'oneshot' buffers.
  const mode = opts.mode;
  const attachedTty = mode === 'attached';
  const resident = mode === 'attached' || mode === 'server';
  return `
// WorkerEntrypoint base: the attached-TTY TUI runs as a resident process whose
// startProcess() holds the facet open via this.ctx.waitUntil — the same
// lifecycle the long-running node path (manager.ts) uses.
import { WorkerEntrypoint as __NimbusWorkerEntrypoint } from "cloudflare:workers";

// ── sql.js wasm + glue factory (module-init scope) ─────────────────────────
// The pre-compiled WebAssembly.Module rides in via the module map; the glue
// factory is built with new Function at startup (request-time codegen is
// blocked). globalThis.__nimbusInitSqlite (defined by the sqlite shim below)
// is awaited inside fetch() before opencode opens its DB.
import __nimbusSqliteWasmModule from "${SQLITE_WASM_MODULE_NAME}";
globalThis.__nimbusSqliteWasmModule = __nimbusSqliteWasmModule;
${generateSqliteFacetPreamble()}

// ── tree-sitter wasm registry (module-init scope) ───────────────────────────
// Pre-compiled core + bash + powershell grammar WebAssembly.Modules from the
// module map, keyed by staged basename. The Nimbus-patched web-tree-sitter
// inside the opencode bundle instantiates these (workerd allows Instance-of-
// precompiled-Module) instead of the blocked request-time compile, and fails
// loud on any wasm name missing from this registry.
import __nimbusTsCore from "${treeSitter.core}";
import __nimbusTsBash from "${treeSitter.bash}";
import __nimbusTsPowershell from "${treeSitter.powershell}";
globalThis.${TREE_SITTER_REGISTRY_GLOBAL} = new Map([
  [${JSON.stringify(treeSitter.core)}, __nimbusTsCore],
  [${JSON.stringify(treeSitter.bash)}, __nimbusTsBash],
  [${JSON.stringify(treeSitter.powershell)}, __nimbusTsPowershell],
]);

// ── OpenTUI wasm FFI backend module (module-init scope, attach only) ───────
// The pre-compiled OpenTUI wasm32-wasi reactor Module rides in via the module
// map; the WASI host preamble + the backend class are injected below, and the
// backend is constructed + parked on globalThis right after env is seeded (the
// boot block) so it is in place before the opencode bundle (which inlines the
// Nimbus-patched @opentui/core) is imported in fetch(). Only the attach facet
// renders; serve/oneshot never link the TUI graph, and the ~17 MiB wasm
// instance + backend would waste their tight facet memory budget.
${attachedTty ? `import __nimbusOpenTUIWasmModule from "${OPENTUI_WASM_MODULE_NAME}";
${OPENTUI_BACKEND_FACET_SRC}
${yogaImportSrc()}` : ''}

// ── VFS-backed node-compat shim scope (node-shims.ts) ──────────────────────
// Declared at module-init so the node:fs / node:os bridge modules (which
// evaluate when the opencode bundle is linked) find a populated builtins map.
// __supervisor is assigned in fetch() from the request env; the shim reads it
// lazily, so late assignment is correct.
const argv = ["node", "/opencode", ...${safe.argv}];
const env = ${safe.env};
let cwd = ${safe.cwd};
const filename = "/opencode";
const dirname = "/opencode";
const stdin = ${safe.stdin};
let stdout = "";
let stderr = "";
let exitCode = 0;
let __supervisor = null;
const __vfsBundle = ${opts.vfsBundle};
const __vfsManifest = ${opts.vfsManifest};
const __vfsWrites = {};
const __vfsDirs = {};
// Ledger of in-flight facet I/O the teardown drain must await. The shims push
// here on every fs/sqlite/child-process op, so over a resident TUI's lifetime a
// plain append-only array would grow without bound. Keep it a real Array (a
// shim guard checks Array.isArray) but self-prune: each pushed promise removes
// itself once settled, so length tracks only outstanding I/O.
const __pendingIO = [];
const __pendingIOAppend = __pendingIO.push.bind(__pendingIO);
__pendingIO.push = (p) => {
  const __wrapped = Promise.resolve(p);
  __pendingIOAppend(__wrapped);
  __wrapped.finally(() => {
    const __i = __pendingIO.indexOf(__wrapped);
    if (__i >= 0) __pendingIO.splice(__i, 1);
  });
  return __pendingIO.length;
};

// The shim (node-shims.ts) throws/catches this sentinel for process.exit and
// the SIGINT stdin-pump teardown; the host runner must provide the class (same
// contract as the long-running node entrypoint). Only exercised when the shim
// process is authoritative (attachedTty), but defined unconditionally so the
// shim's references always resolve.
class __ProcessExit extends Error {
  constructor(code) { super("process.exit(" + code + ")"); this.code = code; }
}

${opts.shimsCode}

globalThis.${BUILTINS_GLOBAL} = builtins;
// Capture workerd's real process.memoryUsage BEFORE the shim process takes over
// (the shim's memoryUsage is a stub returning zeros). workerd exposes a working
// memoryUsage inside dynamic isolates; the [oc-mem] diagnostic reads it to watch
// the OpenTUI wasm heap. Bound to the current process so the globalThis.process
// swap below cannot detach it.
const __realMemUsage = (() => {
  try {
    const __p = globalThis.process;
    if (__p && typeof __p.memoryUsage === "function") return __p.memoryUsage.bind(__p);
  } catch {}
  return null;
})();
// Resident modes: make the Nimbus shim process authoritative for the bundle's
// BARE \`process\` references. The attach TUI needs it for the raw-mode stdin
// pump, live stdout/stderr and SIGWINCH/columns/rows; the serve facet needs it
// for a truthful process.cwd() — workerd's nodejs_compat process pins cwd to
// "/bundle" and silently ignores chdir, which made the server's default app
// directory (and every session it creates) point at a nonexistent path whose
// instance bootstrap hangs. The node:process bridge (module map) covers the
// aliased \`import … from "node:process"\` refs. The one-shot path leaves
// workerd's proven process in place.
if (${resident ? 'true' : 'false'}) {
  try { globalThis.process = __processMod; } catch {}
}
${attachedTty ? generateOpenTUIBackendBootCode() : ''}
// Interactive TUI: install the in-isolate Worker polyfill so opencode's TUI
// client can spawn its API server (cli/cmd/tui/worker.ts → ./worker.js) and
// OpenTUI its syntax-highlight parser (./parser.worker.js) inside this facet.
// Without it \`new Worker(...)\` is a no-op and the client's first RPC hangs
// before the renderer mounts. One-shot \`opencode run\` never reaches the TUI
// command, so the polyfill is attachedTty-only.
if (${attachedTty ? 'true' : 'false'}) {
${WORKER_POLYFILL_SRC}
}
// Defer opencode's CLI so it runs inside fetch() (handler I/O context), not at
// module top-level await (workerd "global scope", where the VFS supervisor RPC
// is a disallowed operation). The bundle reads this flag and exports
// nimbusMain() instead of self-invoking.
globalThis.__NIMBUS_OPENCODE_DEFER = true;

${BUN_GLOBAL_POLYFILL}

const __ocHostResponse = globalThis.Response;
let __ocExited = false;
let __ocLoadError = null;
const __ocMode = ${JSON.stringify(mode)};
const __ocAttachedTty = __ocMode === "attached";
// Resident modes (attached TUI + headless serve) stream stdout/stderr LIVE to
// the supervisor and stay alive on ctx.waitUntil; one-shot buffers and returns.
const __ocResident = __ocMode === "attached" || __ocMode === "server";

// Live-stream RPC chain for the attached-TTY TUI: serialize SUPERVISOR.stdout/
// stderr writes so the ANSI frames reach xterm in order (same ordering the
// long-running node path uses). Settled write tasks are dropped from the
// pending set — a resident TUI writes frames for hours, and retaining every
// settled promise (or every frame byte) would grow without bound inside a
// memory-limited facet.
let __rpcWriteChain = Promise.resolve();
const __pendingWrites = new Set();
const __queueRpcWrite = (method, s) => {
  if (!__supervisor) return;
  const __task = __rpcWriteChain
    .then(() => __supervisor[method](s))
    .catch(() => {});
  __rpcWriteChain = __task.then(() => {}, () => {});
  __pendingWrites.add(__task);
  __task.finally(() => { __pendingWrites.delete(__task); });
};
// Bounded tail mirror for the attached path: keeps enough context for a
// teardown error tail without retaining the whole frame stream.
const __ocTailCap = 64 * 1024;
const __ocTail = (buf, s) => {
  const merged = buf + s;
  return merged.length > __ocTailCap ? merged.slice(merged.length - __ocTailCap) : merged;
};

// process state seeding (argv/env/cwd) + stdout/stderr/exit capture.
try { process.argv = argv; } catch {}
try { Object.assign(process.env, env); } catch {}
try { process.chdir(cwd); } catch {}

// One-shot: capture process.exit as a throw the fetch handler unwinds. Resident
// modes (attached TUI + headless serve): keep the shim's native exit (it emits
// "exit", reports to the supervisor, and throws __ProcessExit) so the
// resident-facet lifecycle and the shim's own SIGINT/stdin-pump exit path stay
// coherent.
if (__ocMode === "oneshot") {
  process.exit = (code) => {
    exitCode = typeof code === "number" ? code : 0;
    __ocExited = true;
    throw { __ocProcessExit: true, code: exitCode };
  };
}
if (__ocResident) {
  // Resident: stdout/stderr flow process.*.write → SUPERVISOR.* → the terminal
  // (attached TUI span-feed) or the process log store (serve). Keep a BOUNDED
  // tail mirror so a teardown/health error tail can still surface — the full
  // stream would grow without bound over a resident process's lifetime.
  process.stdout.write = (d, enc, cb) => {
    if (typeof enc === "function") cb = enc;
    const s = String(d);
    stdout = __ocTail(stdout, s);
    __queueRpcWrite("stdout", s);
    if (typeof cb === "function") queueMicrotask(cb);
    return true;
  };
  process.stderr.write = (d, enc, cb) => {
    if (typeof enc === "function") cb = enc;
    const s = String(d);
    stderr = __ocTail(stderr, s);
    __queueRpcWrite("stderr", s);
    if (typeof cb === "function") queueMicrotask(cb);
    return true;
  };
} else {
  process.stdout.write = (d, enc, cb) => {
    if (typeof enc === "function") cb = enc;
    stdout += String(d);
    if (typeof cb === "function") queueMicrotask(cb);
    return true;
  };
  process.stderr.write = (d, enc, cb) => {
    if (typeof enc === "function") cb = enc;
    stderr += String(d);
    if (typeof cb === "function") queueMicrotask(cb);
    return true;
  };
}
const __ocFmt = (...a) => a.map((x) => {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}).join(" ");
if (__ocResident) {
  console.log = (...a) => { const s = __ocFmt(...a) + "\\n"; stdout = __ocTail(stdout, s); __queueRpcWrite("stdout", s); };
  console.error = (...a) => { const s = __ocFmt(...a) + "\\n"; stderr = __ocTail(stderr, s); __queueRpcWrite("stderr", s); };
} else {
  console.log = (...a) => { stdout += __ocFmt(...a) + "\\n"; };
  console.error = (...a) => { stderr += __ocFmt(...a) + "\\n"; };
}
console.info = console.log;
console.debug = console.log;
console.warn = console.error;

// Park the OpenTUI span-feed stdout + render clock for bundle seam 7. Only in
// attachedTty mode — the one-shot path never reaches createCliRenderer.
if (__ocAttachedTty) {
${OPENTUI_TTY_STDOUT_SRC}
${OPENTUI_CLOCK_SRC}
}

async function __drainPendingIO(maxPasses = 12) {
  for (let __pass = 0; __pass < maxPasses; __pass++) {
    await new Promise((r) => setTimeout(r, 0));
    // Both ledgers self-prune settled entries, so a snapshot holds only what is
    // still outstanding; await it and loop until both drain (or the pass cap).
    const __live = [...__pendingWrites];
    if (__pendingIO.length === 0 && __live.length === 0) break;
    await Promise.allSettled([...__pendingIO, ...__live]);
  }
}

// Bounded 1Hz memory diagnostic for the resident TUI, gated on the existing
// NIMBUS_DIAG_EXEC surface. Emits one line/second through the facet's bounded
// stderr chain so the OpenTUI wasm heap (\`wasm=\`) and the I/O ledgers can be
// watched for a flat slope while live-gating the span-feed OOM fix. Off by
// default: returns null (no interval) so the resident path stays silent.
function __startOcMemDiag() {
  if (!(env && env.NIMBUS_DIAG_EXEC === "1")) return null;
  let __t = 0;
  return setInterval(() => {
    __t += 1;
    let __m = null;
    try { __m = __realMemUsage ? __realMemUsage() : null; } catch {}
    let __wasm = -1;
    try { __wasm = globalThis.${OPENTUI_BACKEND_GLOBAL}.memory.buffer.byteLength; } catch {}
    const __line =
      "[oc-mem] t=" + __t +
      " heap=" + (__m ? __m.heapUsed : -1) +
      " ab=" + (__m ? (__m.arrayBuffers || 0) : -1) +
      " ext=" + (__m ? (__m.external || 0) : -1) +
      " wasm=" + __wasm +
      " pend=" + __pendingWrites.size +
      " pio=" + __pendingIO.length + "\\n";
    try { process.stderr.write(__line); } catch {}
  }, 1000);
}

// Interactive TUI lifecycle: stream live, run opencode's createCliRenderer path,
// and stay resident until the user quits. opencode's nimbusMain() resolves only
// when the TUI tears down (it awaits the render lifecycle), so awaiting it keeps
// the facet alive; the session keeps the request open via ctx.waitUntil.
async function __ocRunAttachedTui() {
  // Activate the shim's raw-mode stdin pump (SUPERVISOR.cpReadStdin →
  // process.stdin, with setRawMode/resize→SIGWINCH/signal handling).
  try { process.stdin.__nimbusStartLivePump?.(); } catch {}
  const __memDiag = __startOcMemDiag();
  try {
    try {
      if (globalThis.__nimbusInitSqlite) { await globalThis.__nimbusInitSqlite(); }
      const __ocBundle = await import("${OPENCODE_BUNDLE_MODULE_NAME}");
      if (typeof __ocBundle.nimbusMain !== "function") {
        throw new Error(
          "opencode bundle does not export nimbusMain() — the staged build is " +
          "missing the Nimbus deferred-entry patch (see build-node.ts)"
        );
      }
      await __ocBundle.nimbusMain();
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; }
      else if (e && e.__ocProcessExit) { exitCode = e.code; }
      else {
        __ocLoadError = (e && e.stack) || (e && e.message) || String(e);
        stderr += __ocLoadError + "\\n";
        if (exitCode === 0) exitCode = 1;
      }
    }
    // Apply the shim's recorded exit code (the native process.exit path sets it).
    if (__nimbusProcessExitCode !== null && exitCode === 0) exitCode = __nimbusProcessExitCode;
    await __drainPendingIO();
    const __failedWrites = {};
    if (__supervisor && Object.keys(__vfsWrites).length > 0) {
      for (const [path, content] of Object.entries(__vfsWrites)) {
        __pendingIO.push(__supervisor.writeFile(path, content).catch(() => { __failedWrites[path] = content; }));
      }
    }
    await __drainPendingIO();
    // The shim's native exit already reported via __nimbusReportProcessExit;
    // report here only if it did not (load error / external teardown).
    if (__supervisor && !__nimbusProcessExitReported) {
      try { await __supervisor.reportExit(exitCode, __ocLoadError ? (__ocLoadError + "\\n") : ""); } catch {}
    }
  } finally {
    if (__memDiag) clearInterval(__memDiag);
  }
}

// Routed-HTTP dispatch for the resident serve facet. A request forwarded by the
// port registry (in-session loopback OR external /port/<n>, both stamped with
// X-Nimbus-Port) is served by the in-facet opencode HTTP server registered on
// globalThis.__portRegistry by the http shim's listen(). Mirrors the long-running
// node path's __nimbusDispatchHttp: pick the server for the hinted port, replay
// the request through its _handleRequest, and return the buffered Response.
async function __ocDispatchHttp(request) {
  // Streaming dispatch lives in the node-shims http shim (globalThis.__nimbusServeHttp),
  // built at module-init over the shared builtins: it replays the request
  // through the in-facet opencode server's _handleRequest and returns a
  // streaming host Response the moment headers are known. This is what lets
  // opencode's TUI live-sync SSE (GET /event, a response that never ends) flow
  // live over the loopback → RPC boundary instead of being buffered to a dead
  // finish-capped response (the frozen-TUI defect).
  return globalThis.__nimbusServeHttp(request);
}

class NimbusOpencodeProcess extends __NimbusWorkerEntrypoint {
  async startProcess() {
    __supervisor = (this.env && this.env.SUPERVISOR) || null;
    // Run the resident lifecycle and hold THIS RPC open until it exits — the
    // same contract the long-running node path uses (its startProcess awaits
    // the resident lifecycle). The open call keeps the caller's stubs live for
    // the process's lifetime, and a facet death (e.g. an OOM kill) rejects it so
    // the supervisor can report the real reason; resolving immediately instead
    // released the stubs ~3s after spawn and turned any facet death into a
    // silent, unattributed stall.
    const __lifecycle = __ocMode === "server" ? __ocRunServe() : __ocRunAttachedTui();
    this.ctx.waitUntil(__lifecycle);
    await __lifecycle;
    return { ok: true };
  }
  async fetch(request) {
    // Routed HTTP (X-Nimbus-Port) → serve it from the in-facet opencode server;
    // otherwise this is the one-shot run entrypoint.
    if (request.headers.has("X-Nimbus-Port")) return __ocDispatchHttp(request);
    return __ocOneShotFetch(request, this.env);
  }
  async handleHttpRequest(request) { return __ocDispatchHttp(request); }
}
export default NimbusOpencodeProcess;

// Headless resident lifecycle for the opencode serve command. Boots the
// bundle's serve command (nimbusMain), whose http server binds via listen() → it
// registers the port with the supervisor and lands on globalThis.__portRegistry
// for __ocDispatchHttp. A real server keeps its event loop alive, so after boot
// we hold the process resident until it is killed (isolate teardown rejects the
// keep-alive). On a boot error we report the exit so the supervisor surfaces it.
async function __ocRunServe() {
  const __memDiag = __startOcMemDiag();
  try {
    try {
      if (globalThis.__nimbusInitSqlite) { await globalThis.__nimbusInitSqlite(); }
      const __ocBundle = await import("${OPENCODE_BUNDLE_MODULE_NAME}");
      if (typeof __ocBundle.nimbusMain !== "function") {
        throw new Error(
          "opencode bundle does not export nimbusMain() — the staged build is " +
          "missing the Nimbus deferred-entry patch (see build-node.ts)"
        );
      }
      await __ocBundle.nimbusMain();
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; }
      else if (e && e.__ocProcessExit) { exitCode = e.code; }
      else {
        __ocLoadError = (e && e.stack) || (e && e.message) || String(e);
        stderr += __ocLoadError + "\\n";
        if (exitCode === 0) exitCode = 1;
      }
    }
    if (__nimbusProcessExitCode !== null && exitCode === 0) exitCode = __nimbusProcessExitCode;
    await __drainPendingIO();
    const __failedWrites = {};
    if (__supervisor && Object.keys(__vfsWrites).length > 0) {
      for (const [path, content] of Object.entries(__vfsWrites)) {
        __pendingIO.push(__supervisor.writeFile(path, content).catch(() => { __failedWrites[path] = content; }));
      }
    }
    await __drainPendingIO();
    // Booted cleanly and still serving: hold the process resident. The keep-alive
    // never resolves; it is released when the facet isolate is torn down (kill /
    // session teardown), matching a real server whose event loop stays alive.
    if (exitCode === 0 && !__ocExited) {
      await new Promise(() => {});
    }
    if (__supervisor && !__nimbusProcessExitReported) {
      try { await __supervisor.reportExit(exitCode, __ocLoadError ? (__ocLoadError + "\\n") : ""); } catch {}
    }
  } finally {
    if (__memDiag) clearInterval(__memDiag);
  }
}

async function __ocOneShotFetch(request, workerEnv) {
    __supervisor = (workerEnv && workerEnv.SUPERVISOR) || null;
    try {
      // Instantiate sql.js before opencode opens its DatabaseSync (the shim's
      // constructor is synchronous and needs a ready engine). Runs in the
      // handler, not module init (instantiation touches crypto for RNG).
      if (globalThis.__nimbusInitSqlite) { await globalThis.__nimbusInitSqlite(); }
      const __ocBundle = await import("${OPENCODE_BUNDLE_MODULE_NAME}");
      if (argv[2] === "${OPENCODE_TREE_SITTER_DIAG_ARG}") {
        // Model-free diagnostic: drive the bundle's OWN web-tree-sitter
        // (the instance the bash tool's parser uses) through core init +
        // grammar loads + a bash parse, via the module-map registry.
        const { Parser, Language } = __ocBundle;
        if (!Parser || typeof Parser.init !== "function" || !Language || typeof Language.load !== "function") {
          throw new Error(
            "opencode bundle does not export Parser/Language — the staged build is " +
            "missing the Nimbus tree-sitter export patch (see nimbus-tree-sitter-exports.patch)"
          );
        }
        await Parser.init({ locateFile: () => "/opencode/${treeSitter.core}" });
        const [__tsBashLang, __tsPsLang] = await Promise.all([
          Language.load("/opencode/${treeSitter.bash}"),
          Language.load("/opencode/${treeSitter.powershell}"),
        ]);
        const __tsParser = new Parser();
        __tsParser.setLanguage(__tsBashLang);
        const __tsCommand = argv[3] || "echo hello | wc -l";
        const __tsTree = __tsParser.parse(__tsCommand);
        const __tsRoot = __tsTree && __tsTree.rootNode;
        if (!__tsRoot) throw new Error("tree-sitter bash parse returned no tree");
        const __tsOk = __tsRoot.type === "program" && !__tsRoot.hasError;
        stdout += JSON.stringify({
          ok: __tsOk,
          command: __tsCommand,
          rootType: __tsRoot.type,
          childCount: __tsRoot.childCount,
          sexpr: __tsRoot.toString(),
          powershellLoaded: !!__tsPsLang,
        }) + "\\n";
        if (!__tsOk) exitCode = 1;
      } else {
        if (typeof __ocBundle.nimbusMain !== "function") {
          throw new Error(
            "opencode bundle does not export nimbusMain() — the staged build is " +
            "missing the Nimbus deferred-entry patch (see build-node.ts)"
          );
        }
        await __ocBundle.nimbusMain();
      }
      // Let the CLI's microtasks/timers settle so deferred writes flush.
      for (let i = 0; i < 8 && !__ocExited; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      if (e && e.__ocProcessExit) { exitCode = e.code; }
      else { __ocLoadError = (e && e.stack) || (e && e.message) || String(e); }
    }
    if (__ocLoadError) {
      stderr += __ocLoadError + "\\n";
      if (exitCode === 0) exitCode = 1;
    }
    await __drainPendingIO();
    const __failedWrites = {};
    if (__supervisor && Object.keys(__vfsWrites).length > 0) {
      for (const [path, content] of Object.entries(__vfsWrites)) {
        __pendingIO.push(__supervisor.writeFile(path, content).catch(() => { __failedWrites[path] = content; }));
      }
    }
    await __drainPendingIO();
    return __ocHostResponse.json({
      exitCode,
      stdout,
      stderr,
      vfsWrites: __supervisor ? __failedWrites : __vfsWrites,
    });
}
`;
}
