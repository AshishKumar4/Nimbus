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

import { generateShimsCode } from './node-shims.js';
import { generateSqliteFacetPreamble } from './sqlite-shim.js';
import {
  OPENTUI_BACKEND_FACET_SRC,
  OPENTUI_WASM_MODULE_NAME,
  generateOpenTUIBackendBootCode,
} from './opentui-facet-backend.js';
import { OPENCODE_TREE_SITTER_WASMS } from '../opencode-artifact.generated.js';

/** Map-module specifier for the opencode ESM bundle. */
export const OPENCODE_BUNDLE_MODULE_NAME = 'opencode-bundle.js';

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

const BUILTIN_BRIDGES: readonly BuiltinBridge[] = [
  { specifier: 'node:fs', builtin: 'fs', names: FS_NAMES },
  { specifier: 'node:fs/promises', builtin: 'fs/promises', names: FS_PROMISES_NAMES },
  { specifier: 'node:os', builtin: 'os', names: OS_NAMES },
  // node:sqlite is not in nodejs_compat; bridge to the VFS-backed sql.js shim.
  { specifier: 'node:sqlite', builtin: 'sqlite', names: ['DatabaseSync', 'StatementSync'] },
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
 * Module-map entries for the VFS-backed node builtin bridges. The Worker
 * Loader requires non-`.js`/`.py` module names (like `node:fs`) to use the
 * explicit `{ js }` content form.
 */
export function opencodeBuiltinBridgeModules(): Record<string, { js: string }> {
  const out: Record<string, { js: string }> = {};
  for (const bridge of BUILTIN_BRIDGES) {
    out[bridge.specifier] = { js: generateBuiltinBridge(bridge) };
  }
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
  /**
   * Serialized VFS snapshot bundle (the `_serializeBundleForFacet` IIFE
   * string). Provides sync VFS reads; async writes/mkdir flush live through
   * the SUPERVISOR RPC binding.
   */
  vfsBundle: string;
  /** Serialized VFS directory manifest (JSON) for readdir/stat coherence. */
  vfsManifest: string;
  /**
   * Interactive TUI mode. When set, the runner drives opencode's real
   * createCliRenderer path: stdout/stderr stream LIVE to the SUPERVISOR
   * (→ xterm) instead of being buffered, the live stdin pump
   * (SUPERVISOR.cpReadStdin → process.stdin, with setRawMode/resize/signal)
   * feeds keystrokes, and the facet stays alive on workerCtx.waitUntil until
   * opencode exits — the same attached-TTY substrate the long-running node
   * path (manager.ts) uses, but over the ESM bundle. The env must carry
   * NIMBUS_ATTACHED_TTY=1 + NIMBUS_CP_CHILD_PID so the shim TTY (node-shims.ts)
   * activates its raw-mode stdin and columns/rows.
   */
  attachedTty?: boolean;
}

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

// ── OpenTUI wasm FFI backend module (module-init scope) ─────────────────────
// The pre-compiled OpenTUI wasm32-wasi reactor Module rides in via the module
// map; the WASI host preamble + the backend class are injected below, and the
// backend is constructed + parked on globalThis right after env is seeded (the
// boot block) so it is in place before the opencode bundle (which inlines the
// Nimbus-patched @opentui/core) is imported in fetch().
import __nimbusOpenTUIWasmModule from "${OPENTUI_WASM_MODULE_NAME}";
${OPENTUI_BACKEND_FACET_SRC}

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
const __vfsBaseUrl = "";
const __pendingIO = [];

${generateShimsCode()}

globalThis.${BUILTINS_GLOBAL} = builtins;
${generateOpenTUIBackendBootCode()}
// Defer opencode's CLI so it runs inside fetch() (handler I/O context), not at
// module top-level await (workerd "global scope", where the VFS supervisor RPC
// is a disallowed operation). The bundle reads this flag and exports
// nimbusMain() instead of self-invoking.
globalThis.__NIMBUS_OPENCODE_DEFER = true;

${BUN_GLOBAL_POLYFILL}

const __ocHostResponse = globalThis.Response;
let __ocExited = false;
let __ocLoadError = null;
const __ocAttachedTty = ${opts.attachedTty ? 'true' : 'false'};

// Live-stream RPC chain for the attached-TTY TUI: serialize SUPERVISOR.stdout/
// stderr writes so the ANSI frames reach xterm in order (same ordering the
// long-running node path uses).
let __rpcWriteChain = Promise.resolve();
const __queueRpcWrite = (method, s) => {
  if (!__supervisor) return;
  const __task = __rpcWriteChain
    .then(() => __supervisor[method](s))
    .catch(() => {});
  __rpcWriteChain = __task.then(() => {}, () => {});
  __pendingIO.push(__task);
};

// process state seeding (argv/env/cwd) + stdout/stderr/exit capture.
try { process.argv = argv; } catch {}
try { Object.assign(process.env, env); } catch {}
try { process.chdir(cwd); } catch {}

process.exit = (code) => {
  exitCode = typeof code === "number" ? code : 0;
  __ocExited = true;
  throw { __ocProcessExit: true, code: exitCode };
};
if (__ocAttachedTty) {
  // Live TUI: span-feed ANSI flows process.stdout.write → SUPERVISOR.stdout →
  // xterm. Keep the buffer mirror so a teardown error tail can still surface.
  process.stdout.write = (d, enc, cb) => {
    if (typeof enc === "function") cb = enc;
    const s = String(d);
    stdout += s;
    __queueRpcWrite("stdout", s);
    if (typeof cb === "function") queueMicrotask(cb);
    return true;
  };
  process.stderr.write = (d, enc, cb) => {
    if (typeof enc === "function") cb = enc;
    const s = String(d);
    stderr += s;
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
if (__ocAttachedTty) {
  console.log = (...a) => { const s = __ocFmt(...a) + "\\n"; stdout += s; __queueRpcWrite("stdout", s); };
  console.error = (...a) => { const s = __ocFmt(...a) + "\\n"; stderr += s; __queueRpcWrite("stderr", s); };
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
  let __settledIO = 0;
  for (let __pass = 0; __pass < maxPasses; __pass++) {
    await new Promise((r) => setTimeout(r, 0));
    if (__pendingIO.length <= __settledIO) break;
    const __slice = __pendingIO.slice(__settledIO);
    __settledIO = __pendingIO.length;
    await Promise.allSettled(__slice);
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
    if (e && e.__ocProcessExit) { exitCode = e.code; }
    else {
      __ocLoadError = (e && e.stack) || (e && e.message) || String(e);
      stderr += __ocLoadError + "\\n";
      if (exitCode === 0) exitCode = 1;
    }
  }
  await __drainPendingIO();
  const __failedWrites = {};
  if (__supervisor && Object.keys(__vfsWrites).length > 0) {
    for (const [path, content] of Object.entries(__vfsWrites)) {
      __pendingIO.push(__supervisor.writeFile(path, content).catch(() => { __failedWrites[path] = content; }));
    }
  }
  await __drainPendingIO();
  if (__supervisor) {
    try { await __supervisor.reportExit(exitCode, __ocLoadError ? (__ocLoadError + "\\n") : ""); } catch {}
  }
}

class NimbusOpencodeProcess extends __NimbusWorkerEntrypoint {
  async startProcess() {
    __supervisor = (this.env && this.env.SUPERVISOR) || null;
    // Hold the facet open for the interactive TUI's lifetime.
    this.ctx.waitUntil(__ocRunAttachedTui());
    return { ok: true };
  }
  async fetch(request) {
    return __ocOneShotFetch(request, this.env);
  }
}
export default NimbusOpencodeProcess;

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
