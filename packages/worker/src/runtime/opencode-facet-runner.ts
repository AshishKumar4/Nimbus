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

/** Map-module specifier for the opencode ESM bundle. */
export const OPENCODE_BUNDLE_MODULE_NAME = 'opencode-bundle.js';

/** Module-map specifier for the sql.js WebAssembly.Module. */
export const SQLITE_WASM_MODULE_NAME = 'sqlite.wasm';

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
}

/**
 * Generate the mainModule that boots the opencode ESM bundle in a facet.
 * stdout/stderr are buffered and returned in the JSON response.
 */
export function generateOpencodeRunnerCode(opts: OpencodeRunnerOptions): string {
  const safe = {
    argv: JSON.stringify(opts.argv),
    env: JSON.stringify(opts.env),
    cwd: JSON.stringify(opts.cwd),
    stdin: JSON.stringify(opts.stdin),
  };
  return `
// ── sql.js wasm + glue factory (module-init scope) ─────────────────────────
// The pre-compiled WebAssembly.Module rides in via the module map; the glue
// factory is built with new Function at startup (request-time codegen is
// blocked). globalThis.__nimbusInitSqlite (defined by the sqlite shim below)
// is awaited inside fetch() before opencode opens its DB.
import __nimbusSqliteWasmModule from "${SQLITE_WASM_MODULE_NAME}";
globalThis.__nimbusSqliteWasmModule = __nimbusSqliteWasmModule;
${generateSqliteFacetPreamble()}

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
// Defer opencode's CLI so it runs inside fetch() (handler I/O context), not at
// module top-level await (workerd "global scope", where the VFS supervisor RPC
// is a disallowed operation). The bundle reads this flag and exports
// nimbusMain() instead of self-invoking.
globalThis.__NIMBUS_OPENCODE_DEFER = true;

${BUN_GLOBAL_POLYFILL}

const __ocHostResponse = globalThis.Response;
let __ocExited = false;
let __ocLoadError = null;

// process state seeding (argv/env/cwd) + stdout/stderr/exit capture.
try { process.argv = argv; } catch {}
try { Object.assign(process.env, env); } catch {}
try { process.chdir(cwd); } catch {}

process.exit = (code) => {
  exitCode = typeof code === "number" ? code : 0;
  __ocExited = true;
  throw { __ocProcessExit: true, code: exitCode };
};
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
const __ocFmt = (...a) => a.map((x) => {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}).join(" ");
console.log = (...a) => { stdout += __ocFmt(...a) + "\\n"; };
console.info = console.log;
console.debug = console.log;
console.error = (...a) => { stderr += __ocFmt(...a) + "\\n"; };
console.warn = console.error;

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

export default {
  async fetch(request, workerEnv) {
    __supervisor = (workerEnv && workerEnv.SUPERVISOR) || null;
    try {
      // Instantiate sql.js before opencode opens its DatabaseSync (the shim's
      // constructor is synchronous and needs a ready engine). Runs in the
      // handler, not module init (instantiation touches crypto for RNG).
      if (globalThis.__nimbusInitSqlite) { await globalThis.__nimbusInitSqlite(); }
      const __ocBundle = await import("${OPENCODE_BUNDLE_MODULE_NAME}");
      if (typeof __ocBundle.nimbusMain !== "function") {
        throw new Error(
          "opencode bundle does not export nimbusMain() — the staged build is " +
          "missing the Nimbus deferred-entry patch (see build-node.ts)"
        );
      }
      await __ocBundle.nimbusMain();
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
  },
};
`;
}
