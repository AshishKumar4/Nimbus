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
import { VFS_CURSOR_SEED_SOURCE } from '@nimbus-sh/core/_shared/facet-vfs-cursor.js';
import { VFS_WRITE_LEDGER_SOURCE } from '@nimbus-sh/core/_shared/vfs-write-ledger.js';
import { OPENTUI_BACKEND_FACET_SRC, OPENTUI_BACKEND_GLOBAL, OPENTUI_WASM_MODULE_NAME, generateOpenTUIBackendBootCode, } from './opentui-facet-backend.js';
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
// node:fs public surface (the contract Nimbus' shim implements). Listed
// explicitly because ESM named exports must be static; `import * as fs`
// resolves these as the namespace. Members the shim omits export as
// undefined — opencode only consumes the implemented subset.
const FS_NAMES = [
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
const FS_PROMISES_NAMES = [
    'access', 'appendFile', 'chmod', 'chown', 'constants', 'copyFile', 'cp',
    'lchown', 'link', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readdir',
    'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat',
    'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'writeFile',
];
// node:os public surface.
const OS_NAMES = [
    'arch', 'constants', 'cpus', 'devNull', 'endianness', 'EOL', 'freemem',
    'getPriority', 'homedir', 'hostname', 'loadavg', 'machine', 'networkInterfaces',
    'platform', 'release', 'setPriority', 'tmpdir', 'totalmem', 'type', 'uptime',
    'userInfo', 'version', 'availableParallelism',
];
// The shim http surface (node-shims.ts builtins.http). request/get throw
// "Use fetch()" — honest failure; nodejs_compat's fetch-backed client is NOT
// preserved by this bridge, so a chunk that does http.request() fails loud.
const HTTP_NAMES = [
    'createServer', 'Server', 'IncomingMessage', 'ServerResponse',
    'Agent', 'STATUS_CODES', 'METHODS', 'request', 'get',
];
const BUILTIN_BRIDGES = [
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
const PROCESS_NAMES = [
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
const CONSOLE_NAMES = [
    'Console', 'log', 'info', 'debug', 'dir', 'error', 'warn', 'trace', 'assert',
    'table', 'group', 'groupEnd', 'time', 'timeEnd', 'timeLog', 'clear', 'count',
    'countReset',
];
/**
 * One bridge module: re-export a VFS-backed shim builtin (parked on
 * globalThis by the runner at module-init, BEFORE any bridge evaluates) as a
 * proper ESM module with default + named exports.
 */
function generateBuiltinBridge(bridge) {
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
function generateGlobalBridge(globalName, names) {
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
export function opencodeBuiltinBridgeModules(attachedTty = false) {
    const out = {};
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
const BUN_GLOBAL_POLYFILL = `
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
const OPENTUI_TTY_STDOUT_SRC = `
globalThis.__nimbusOpenTUITtyStdout = {
  isTTY: true,
  get columns() { return __nimbusTtyColumns; },
  get rows() { return __nimbusTtyRows; },
  write(chunk, enc, cb) {
    const s = typeof chunk === "string"
      ? chunk
      : __BufferMod.from(chunk).toString("latin1");
    __ttyC += 1; __ttyB += s.length;
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
const OPENTUI_CLOCK_SRC = `
globalThis.__nimbusOpenTUIClock = {
  now: () => globalThis.performance.now(),
  setTimeout: (fn, ms) => { __ckSt += 1; return globalThis.setTimeout(() => { __ckFi += 1; fn(); }, ms); },
  clearTimeout: (h) => globalThis.clearTimeout(h),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h),
};
`;
/** OpenTUI's cross-copy singleton registry key (@opentui/core, public). */
export const OPENTUI_SINGLETON_SYMBOL = '@opentui/core/singleton';
/** The registry entry holding the live CliRenderer set. */
export const OPENTUI_RENDERER_TRACKER = 'RendererTracker';
/**
 * Terminal-geometry bridge: SIGWINCH → the live renderers' resize().
 *
 * OpenTUI's CliRenderer subscribes to SIGWINCH itself ONLY when its stdout is
 * process.stdout (`_usesProcessStdout`); with a custom stdout the embedding host
 * owns the terminal and drives `renderer.resize(columns, rows)` — the same public
 * geometry API createTestRenderer exposes. Seam 7 hands the renderer the facet
 * TTY stdout (a distinct object, so the span feed gets allocated), which puts
 * Nimbus on exactly that host path. But that stdout IS the process terminal:
 * without this bridge a resize travels the whole way in — WS frame →
 * ProcessInputStore → cpReadStdin → node-shims updates __nimbusTtyColumns/Rows
 * and emits SIGWINCH — and then dies unheard, so the frame never reflows.
 *
 * Live renderers come from OpenTUI's own cross-copy registry (the same one that
 * enforces one renderer per stream). resize() runs the reflow immediately rather
 * than through handleResize's 100ms debounce, a facet timer that only fires on
 * the next I/O yield anyway.
 */
export const OPENTUI_RESIZE_BRIDGE_SRC = `
process.on("SIGWINCH", () => {
  const __otuiRegistry = globalThis[Symbol.for(${JSON.stringify(OPENTUI_SINGLETON_SYMBOL)})];
  const __otuiTracker = __otuiRegistry && __otuiRegistry[${JSON.stringify(OPENTUI_RENDERER_TRACKER)}];
  // No tracker yet: SIGWINCH before @opentui/core's module init (the TUI has not
  // mounted), and the renderer reads the new geometry when it does.
  if (!__otuiTracker) return;
  for (const __renderer of __otuiTracker.renderers) {
    try {
      __renderer.resize(__nimbusTtyColumns, __nimbusTtyRows);
    } catch (e) {
      process.stderr.write("[nimbus] OpenTUI resize failed: " + ((e && e.stack) || e) + "\\n");
    }
  }
});
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
export const WORKER_POLYFILL_SRC = `
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
function yogaImportSrc() {
    if (!OPENCODE_YOGA_WASM) {
        throw new Error('opencode yoga-layout wasm is not staged — rerun scripts/bundle-opencode.mjs ' +
            'with an opencode dist that extracted yoga.wasm (build-node.ts)');
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
export function generateOpencodeRunnerCode(opts) {
    const treeSitter = OPENCODE_TREE_SITTER_WASMS;
    if (!treeSitter) {
        throw new Error('opencode tree-sitter wasm sidecars are not staged — rerun ' +
            'scripts/bundle-opencode.mjs with the opencode dist present');
    }
    const safe = {
        argv: JSON.stringify(opts.argv),
        env: JSON.stringify(opts.env),
        cred: JSON.stringify(opts.cred),
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
// Two bases for two lifecycles, over one module scope. A resident run (the
// attached TUI, opencode serve) is a DO Facet of the session, so NimbusProcess
// extends DurableObject and its startProcess() holds the process open. A
// one-shot run is a single fetch into a stateless entrypoint, which cannot be a
// Durable Object; it keeps the WorkerEntrypoint default export.
import { DurableObject as __NimbusDurableObject, WorkerEntrypoint as __NimbusWorkerEntrypoint } from "cloudflare:workers";

// ── sql.js wasm + glue factory (module-init scope) ─────────────────────────
// The pre-compiled WebAssembly.Module rides in via the module map; the glue
// factory is built with new Function at startup (request-time codegen is
// blocked). The engine itself boots lazily and synchronously on the first
// DatabaseSync open (sqlite-shim.ts __getSQL) — the ~48 MiB engine boot must
// not be paid by processes that never open a DB (the attach TUI client).
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
const cred = ${safe.cred};
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
const __vfsMetadata = ${opts.vfsMetadata};
const __MODULE_VFS_CURSOR = ${opts.vfsCursor};
${VFS_CURSOR_SEED_SOURCE}
${VFS_WRITE_LEDGER_SOURCE}
const __vfsDirs = {};
const __nimbusDeferProcessExitReport = true;
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
// Flow counters for the [oc-mem] diagnostic: bytes/calls queued onto the RPC
// write chain vs settled off it. outstanding = qb - sb is the retained frame
// backlog inside the facet (the chain closure holds each string until settle).
let __rpcQc = 0, __rpcQb = 0, __rpcSc = 0, __rpcSb = 0;
// Date.now() at the chain's last settle — a growing age with queued writes
// pending means the supervisor write chain is wedged, not the event loop.
let __chainSettleAt = 0;
// Renderer frame-output counters (OpenTUI span-feed → TTY stdout writes).
let __ttyC = 0, __ttyB = 0;
// Render-clock counters: setTimeout scheduled vs fired (timer starvation probe).
let __ckSt = 0, __ckFi = 0;
// Microtask-churn counters: process.nextTick / queueMicrotask enqueues.
let __ntC = 0, __qmC = 0;
// fetch() call counter (loopback HTTP from the attach client).
let __fetchC = 0;
// WebAssembly.Memory.grow probe: total grows / pages, last grower's stack.
let __wgC = 0, __wgP = 0, __wgLast = "";
const __queueRpcWrite = (method, s) => {
  if (!__supervisor) return;
  __rpcQc += 1; __rpcQb += s.length;
  const __task = __rpcWriteChain
    .then(() => __supervisor[method](s))
    .catch(() => {});
  __rpcWriteChain = __task.then(() => {}, () => {});
  __pendingWrites.add(__task);
  const __len = s.length;
  __task.finally(() => { __rpcSc += 1; __rpcSb += __len; __chainSettleAt = Date.now(); __pendingWrites.delete(__task); });
  __ocFlowDiag();
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
// modes keep the shim's native exit event + __ProcessExit contract, but the
// supervisor report is deferred until this runner drains VFS durability.
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
// workerd's real console, captured before the overrides below. The [oc-mem]
// diagnostic mirrors its lines here: a host console call reaches the platform
// log (wrangler tail) synchronously, without the facet's RPC write chain or
// event loop — the only channel that still reports from a CPU-bound spin.
const __realConsoleError = console.error.bind(console);
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

// Park the OpenTUI span-feed stdout + render clock for bundle seam 7, and bridge
// terminal resizes into the renderer that stdout belongs to. Only in attachedTty
// mode — the one-shot path never reaches createCliRenderer.
if (__ocAttachedTty) {
${OPENTUI_TTY_STDOUT_SRC}
${OPENTUI_CLOCK_SRC}
${OPENTUI_RESIZE_BRIDGE_SRC}
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

async function __ocDrainVfsWrites() {
  if (!__supervisor) return;
  try {
    await __nimbusDrainVfsWrites(__supervisor);
  } catch (e) {
    const trace = (e && e.stack) || (e && e.message) || String(e);
    __ocLoadError = trace;
    stderr += trace + "\\n";
    exitCode = 1;
    if (__ocResident) {
      try { await __supervisor.stderr(trace + "\\n"); } catch {}
    }
  }
}

async function __ocReportFinalExit() {
  if (!__supervisor || __nimbusProcessExitReported) return;
  await __supervisor.reportExit(
    exitCode,
    __ocLoadError ? (__ocLoadError + "\\n") : "",
  );
  __nimbusProcessExitReported = true;
}

// Memory/flow diagnostic for the resident TUI, gated on the existing
// NIMBUS_DIAG_EXEC surface. Two emitters share one line format:
//   - a paced loop (\`k=t\`) whose own stderr RPC round-trip supplies the I/O
//     yield workerd needs to advance facet timers — the old plain setInterval
//     starved as soon as the facet went idle and reported nothing past t=2;
//   - a hot-path sampler (\`k=f\`) inside __queueRpcWrite, Date.now-gated to
//     ≥500ms apart, which keeps reporting even if the paced loop is starved
//     by a busy event loop (Date.now only advances across real I/O).
// Off by default: __ocDiag.on false keeps the resident path silent.
const __ocDiag = { on: !!(env && env.NIMBUS_DIAG_EXEC === "1"), stop: false, t0: Date.now(), busy: false, lastFlow: 0 };
if (__ocDiag.on) {
  // Microtask-churn probes: count nextTick/queueMicrotask enqueues so a
  // CPU-bound microtask spin (which starves timers AND the paced diag loop)
  // is visible in the counters of whichever sample does get out.
  try {
    const __origNextTick = process.nextTick.bind(process);
    process.nextTick = (fn, ...a) => { __ntC += 1; return __origNextTick(fn, ...a); };
  } catch {}
  try {
    const __origQm = globalThis.queueMicrotask.bind(globalThis);
    globalThis.queueMicrotask = (fn) => { __qmC += 1; return __origQm(fn); };
  } catch {}
  try {
    const __origFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (...a) => { __fetchC += 1; return __origFetch(...a); };
  } catch {}
  // Attribute wasm linear-memory growth: every Emscripten-style glue calls
  // Memory.grow from JS, so the caller's stack names the growing subsystem
  // (tree-sitter / yoga / opentui WASI) even while a sync spin blocks all
  // other reporting — the next sample that escapes carries it.
  try {
    const __origGrow = WebAssembly.Memory.prototype.grow;
    WebAssembly.Memory.prototype.grow = function (pages) {
      __wgC += 1; __wgP += Number(pages) || 0;
      try { __wgLast = String(new Error().stack || "").replace(/\\s+/g, " ").slice(0, 400); } catch {}
      return __origGrow.call(this, pages);
    };
  } catch {}
  // Pump-paced sampler: the shim's live stdin pump calls this after every
  // cpReadStdin round-trip (~1Hz) — the one I/O-yield cadence a resident
  // facet is guaranteed to keep, immune to facet timer starvation.
  globalThis.__nimbusOcPumpDiag = () => { __ocEmitMemDiag("p"); };
  // Per-symbol FFI stats (calls + wasm linear-memory growth attribution),
  // consumed by opentui-wasm-backend's #bindSymbol wrapper. Every 4096 FFI
  // calls force a diag sample — the FFI hot path keeps reporting even when
  // the paced loop is starved.
  globalThis.__nimbusOtuiFfiDiag = {
    calls: 0,
    map: Object.create(null),
    big: [],
    rec(n, g, a, scratch) {
      this.calls += 1;
      const e = this.map[n] || (this.map[n] = { c: 0, g: 0, gc: 0, gmax: 0 });
      e.c += 1;
      if (g > 0) { e.g += g; e.gc += 1; if (g > e.gmax) e.gmax = g; }
      if (g > 4194304 && this.big.length < 24) {
        this.big.push(n + ":+" + g + ":in" + (scratch || 0) + "(" + (a || []).map((x) => (typeof x === "number" ? x : String(x))).join(",") + ")");
      }
      if ((this.calls & 1023) === 0) __ocEmitMemDiag("ffi");
    },
  };
}
function __ocFfiTop() {
  const d = globalThis.__nimbusOtuiFfiDiag;
  if (!d) return "";
  const entries = Object.entries(d.map);
  entries.sort((a, b) => b[1].c - a[1].c);
  const byCalls = entries.slice(0, 4).map(([n, e]) => n + ":" + e.c + (e.g ? "+" + e.g : "")).join(",");
  entries.sort((a, b) => b[1].g - a[1].g);
  const grow = entries.filter(([, e]) => e.g > 0).slice(0, 4)
    .map(([n, e]) => n + ":g" + e.g + ":gc" + e.gc + ":gmax" + e.gmax).join(",");
  const big = d.big.length ? " ffiBig=" + d.big.join(";") : "";
  return " ffiC=" + d.calls + " ffiTop=" + byCalls + (grow ? " ffiGrow=" + grow : "") + big;
}
function __ocEmitMemDiag(tag) {
  if (!__ocDiag.on || __ocDiag.busy) return;
  __ocDiag.busy = true;
  try {
    let __m = null;
    try { __m = __realMemUsage ? __realMemUsage() : null; } catch {}
    let __wasm = -1;
    try { __wasm = globalThis.${OPENTUI_BACKEND_GLOBAL}.memory.buffer.byteLength; } catch {}
    // Zig-side allocator truth: global arena capacity + gpa stats (requested
    // bytes / active allocation counts) — splits wasm growth into
    // arena-retained vs gpa-live vs allocator waste.
    let __zar = -1, __zreq = -1, __zact = -1;
    try {
      const __b = globalThis.${OPENTUI_BACKEND_GLOBAL};
      if (!globalThis.__nimbusOcZigStats && __b) {
        globalThis.__nimbusOcZigStats = __b.dlopen("", {
          getArenaAllocatedBytes: { args: [], returns: "usize" },
          getAllocatorStats: { args: ["ptr"], returns: "void" },
        }).symbols;
      }
      const __z = globalThis.__nimbusOcZigStats;
      if (__z) {
        __zar = Number(__z.getArenaAllocatedBytes());
        const __sb = new Uint8Array(40);
        __z.getAllocatorStats(__b.ptr(__sb));
        const __dv = new DataView(__sb.buffer);
        __zreq = Number(__dv.getBigUint64(0, true));
        __zact = Number(__dv.getBigUint64(8, true));
      }
    } catch {}
    let __vfsB = 0, __vfsN = 0;
    try {
      for (const __k in __vfsWrites) {
        __vfsN += 1;
        const __v = __vfsWrites[__k];
        __vfsB += typeof __v === "string" ? __v.length : (__v && __v.byteLength) || 0;
      }
    } catch {}
    const __line =
      "[oc-mem] k=" + tag +
      " t=" + ((Date.now() - __ocDiag.t0) / 1000).toFixed(1) +
      " pn=" + Math.round(globalThis.performance.now()) +
      " heap=" + (__m ? __m.heapUsed : -1) +
      " ab=" + (__m ? (__m.arrayBuffers || 0) : -1) +
      " ext=" + (__m ? (__m.external || 0) : -1) +
      " wasm=" + __wasm +
      " zar=" + __zar + " zreq=" + __zreq + " zact=" + __zact +
      " ttyC=" + __ttyC + " ttyB=" + __ttyB +
      " qC=" + __rpcQc + " qB=" + __rpcQb +
      " sC=" + __rpcSc + " sB=" + __rpcSb +
      " outB=" + (__rpcQb - __rpcSb) +
      " pend=" + __pendingWrites.size +
      " pio=" + __pendingIO.length +
      " vfsN=" + __vfsN + " vfsB=" + __vfsB +
      " ck=" + __ckSt + "/" + __ckFi +
      " nt=" + __ntC + " qm=" + __qmC +
      " fetch=" + __fetchC +
      " chAge=" + (__rpcQc > __rpcSc && __chainSettleAt ? Date.now() - __chainSettleAt : 0) +
      " wg=" + __wgC + "/" + __wgP +
      (__wgLast ? " wgAt=" + JSON.stringify(__wgLast) : "") +
      __ocFfiTop() + "\\n";
    try { process.stderr.write(__line); } catch {}
    try { __realConsoleError(__line.trimEnd()); } catch {}
    // Pump-paced samples bypass the write chain entirely: a direct supervisor
    // RPC that lands in the process log even when the chain is wedged —
    // discriminates a dead event loop from a wedged outbound chain.
    if (tag === "p" && __supervisor) {
      try { __supervisor.stderr("[oc-mem-direct]" + __line).catch(() => {}); } catch {}
    }
  } finally {
    __ocDiag.busy = false;
  }
}
function __ocFlowDiag() {
  if (!__ocDiag.on || __ocDiag.busy) return;
  const __n = Date.now();
  if (__n - __ocDiag.lastFlow < 500) return;
  __ocDiag.lastFlow = __n;
  __ocEmitMemDiag("f");
}
async function __ocMemDiagLoop() {
  if (!__ocDiag.on) return;
  for (let __i = 0; __i < 900 && !__ocDiag.stop; __i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (__ocDiag.stop) break;
    __ocEmitMemDiag("t");
    // Await the chain head: the stderr RPC above is the real I/O yield that
    // lets the next 1s timer fire even when the facet is otherwise idle.
    try { await __rpcWriteChain; } catch {}
  }
}

// Interactive TUI lifecycle: stream live, run opencode's createCliRenderer path,
// and stay resident until the user quits. opencode's nimbusMain() resolves only
// when the TUI tears down (it awaits the render lifecycle), so awaiting it keeps
// the facet alive; the session keeps the request open via ctx.waitUntil.
async function __ocRunAttachedTui() {
  // Activate the shim's raw-mode stdin pump (SUPERVISOR.cpReadStdin →
  // process.stdin, with setRawMode/resize→SIGWINCH/signal handling).
  try { process.stdin.__nimbusStartLivePump?.(); } catch {}
  void __ocMemDiagLoop();
  try {
    try {
      const __ocBundle = await import("${OPENCODE_BUNDLE_MODULE_NAME}");
      if (typeof __ocBundle.nimbusMain !== "function") {
        throw new Error(
          "opencode bundle does not export nimbusMain() — the staged build is " +
          "missing the Nimbus deferred-entry patch (see build-node.ts)"
        );
      }
      const __exitMarker = {};
      const __mainResult = Promise.resolve(__ocBundle.nimbusMain());
      const __result = await Promise.race([
        __mainResult.then(() => null),
        __nimbusProcessExitPromise.then((code) => {
          exitCode = Number(code ?? 0);
          return __exitMarker;
        }),
      ]);
      if (__result === __exitMarker) __ocExited = true;
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; __ocExited = true; }
      else if (e && e.__ocProcessExit) { exitCode = e.code; __ocExited = true; }
      else {
        __ocLoadError = (e && e.stack) || (e && e.message) || String(e);
        stderr += __ocLoadError + "\\n";
        if (exitCode === 0) exitCode = 1;
      }
    }
    // Apply the shim's recorded exit code (the native process.exit path sets it).
    if (__nimbusProcessExitCode !== null && exitCode === 0) exitCode = __nimbusProcessExitCode;
    await __drainPendingIO();
    await __ocDrainVfsWrites();
    await __ocReportFinalExit();
  } finally {
    __ocDiag.stop = true;
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

export class NimbusProcess extends __NimbusDurableObject {
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
  async fetch(request) { return __ocDispatchHttp(request); }
  async handleHttpRequest(request) { return __ocDispatchHttp(request); }
}

export default class NimbusOpencodeOneShot extends __NimbusWorkerEntrypoint {
  async fetch(request) { return __ocOneShotFetch(request, this.env); }
}

// Headless resident lifecycle for the opencode serve command. Boots the
// bundle's serve command (nimbusMain), whose http server binds via listen() → it
// registers the port with the supervisor and lands on globalThis.__portRegistry
// for __ocDispatchHttp. A real server keeps its event loop alive, so after boot
// we hold the process resident until it is killed (isolate teardown rejects the
// keep-alive). On a boot error we report the exit so the supervisor surfaces it.
async function __ocRunServe() {
  try {
    try {
      // Serve opens the session DB within its first requests — boot the
      // engine eagerly to keep the proven serve boot shape (removing this
      // live-wedged the serve handler's dynamic chunk import of
      // server/server — the #20 shape-sensitivity; measured 2026-07-21).
      // The attach TUI client path stays lazy: it never opens a DB, and
      // the ~48 MiB engine boot was tipping the attach facet into OOM.
      await globalThis.__nimbusInitSqlite();
      const __ocBundle = await import("${OPENCODE_BUNDLE_MODULE_NAME}");
      if (typeof __ocBundle.nimbusMain !== "function") {
        throw new Error(
          "opencode bundle does not export nimbusMain() — the staged build is " +
          "missing the Nimbus deferred-entry patch (see build-node.ts)"
        );
      }
      const __exitMarker = {};
      const __mainResult = Promise.resolve(__ocBundle.nimbusMain());
      const __result = await Promise.race([
        __mainResult.then(() => null),
        __nimbusProcessExitPromise.then((code) => {
          exitCode = Number(code ?? 0);
          return __exitMarker;
        }),
      ]);
      if (__result === __exitMarker) __ocExited = true;
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; __ocExited = true; }
      else if (e && e.__ocProcessExit) { exitCode = e.code; __ocExited = true; }
      else {
        __ocLoadError = (e && e.stack) || (e && e.message) || String(e);
        stderr += __ocLoadError + "\\n";
        if (exitCode === 0) exitCode = 1;
      }
    }
    if (__nimbusProcessExitCode !== null && exitCode === 0) exitCode = __nimbusProcessExitCode;
    await __drainPendingIO();
    await __ocDrainVfsWrites();
    // Booted cleanly and still serving: hold the process resident. The keep-alive
    // ends only when the shim records a process exit/signal. The terminal
    // supervisor report remains deferred until the final durability drain.
    if (exitCode === 0 && !__ocExited) {
      exitCode = Number(await __nimbusProcessExitPromise);
      __ocExited = true;
      await __drainPendingIO();
      await __ocDrainVfsWrites();
    }
    await __ocReportFinalExit();
  } finally {
    __ocDiag.stop = true;
  }
}

async function __ocOneShotFetch(request, workerEnv) {
    __supervisor = (workerEnv && workerEnv.SUPERVISOR) || null;
    try {
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
    await __ocDrainVfsWrites();
    return __ocHostResponse.json({
      exitCode,
      stdout,
      stderr,
      vfsWrites: __supervisor ? {} : __vfsWrites,
    });
}
`;
}
