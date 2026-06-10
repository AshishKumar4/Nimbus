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
 *   1. Installs the Bun-global polyfill at module-init scope (Bun.stdin.text,
 *      Bun.stringWidth, Bun.file, Bun.hash) — opencode references `Bun.*` even
 *      on the node target.
 *   2. Seeds process.argv / env / cwd from the per-invocation constants baked
 *      into this module (the runner is regenerated per exec).
 *   3. Captures stdout/stderr and process.exit.
 *   4. Statically imports the opencode bundle, which runs the CLI for the
 *      seeded argv at module evaluation, before the fetch handler returns.
 *
 * node: builtins resolve through workerd's nodejs_compat. node:sqlite is not
 * provided by nodejs_compat, so it is supplied as an override module in the
 * facet map (see OPENCODE_NODE_SQLITE_MODULE_NAME). The `--version` path does
 * not construct a DatabaseSync, so the stub is sufficient there; the bash-tool
 * / serve paths that do open a DB hit the stub's clear diagnostic until the
 * VFS-backed sql.js shim is wired into the ESM path.
 */
/** Map-module specifier for the opencode ESM bundle. */
export const OPENCODE_BUNDLE_MODULE_NAME = 'opencode-bundle.js';
/**
 * node:sqlite override module placed in the facet map. opencode statically
 * imports node:sqlite; workerd's nodejs_compat does not provide it, so the
 * static import would fail at link time and the whole module would never
 * load. This module satisfies the import. DatabaseSync throws a precise
 * diagnostic if actually constructed (the bash-tool/serve DB paths).
 */
export const OPENCODE_NODE_SQLITE_MODULE = `
export class DatabaseSync {
  constructor() {
    throw new Error(
      "node:sqlite (DatabaseSync) is not yet available to the opencode ESM " +
      "runtime: the VFS-backed sql.js shim is wired into the CJS facet path, " +
      "not the ESM mainModule path. This blocks opencode's persistent DB " +
      "(~/.local/share/opencode/*.db) — bash-tool/serve paths. --version and " +
      "other DB-free commands work."
    );
  }
}
export class StatementSync {}
export default { DatabaseSync, StatementSync };
`;
/** The ~30-line Bun-global polyfill, as a facet module-init block. */
const BUN_GLOBAL_POLYFILL = `
import __ocFs from "node:fs";
import __ocCrypto from "node:crypto";
if (typeof globalThis.Bun === "undefined") {
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
 * Generate the mainModule that boots the opencode ESM bundle in a facet.
 * captureOutput is implied: stdout/stderr are buffered and returned in the
 * JSON response (the staged-artifact path does not stream via SUPERVISOR
 * yet).
 */
export function generateOpencodeRunnerCode(opts) {
    const safe = {
        argv: JSON.stringify(opts.argv),
        env: JSON.stringify(opts.env),
        cwd: JSON.stringify(opts.cwd),
        stdin: JSON.stringify(opts.stdin),
    };
    return `${BUN_GLOBAL_POLYFILL}

const __ocHostResponse = globalThis.Response;
let __ocStdout = "";
let __ocStderr = "";
let __ocExitCode = 0;
let __ocExited = false;

// Seed process state BEFORE importing the bundle (opencode reads argv and
// runs its CLI at module evaluation).
try { process.argv = [process.argv[0] || "node", "/opencode", ...${safe.argv}]; } catch {}
try { Object.assign(process.env, ${safe.env}); } catch {}
try { process.chdir(${safe.cwd}); } catch {}

const __ocOrigExit = process.exit.bind(process);
process.exit = (code) => {
  __ocExitCode = typeof code === "number" ? code : 0;
  __ocExited = true;
  throw { __ocProcessExit: true, code: __ocExitCode };
};
process.stdout.write = (d, enc, cb) => {
  if (typeof enc === "function") cb = enc;
  __ocStdout += String(d);
  if (typeof cb === "function") queueMicrotask(cb);
  return true;
};
process.stderr.write = (d, enc, cb) => {
  if (typeof enc === "function") cb = enc;
  __ocStderr += String(d);
  if (typeof cb === "function") queueMicrotask(cb);
  return true;
};
const __ocFmt = (...a) => a.map((x) => {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}).join(" ");
console.log = (...a) => { __ocStdout += __ocFmt(...a) + "\\n"; };
console.info = console.log;
console.debug = console.log;
console.error = (...a) => { __ocStderr += __ocFmt(...a) + "\\n"; };
console.warn = console.error;

let __ocLoadError = null;
const __ocBundlePromise = import("${OPENCODE_BUNDLE_MODULE_NAME}").catch((e) => {
  if (e && e.__ocProcessExit) { __ocExited = true; __ocExitCode = e.code; return; }
  __ocLoadError = (e && e.stack) || (e && e.message) || String(e);
});

export default {
  async fetch() {
    try {
      await __ocBundlePromise;
      // Let the CLI's microtasks/timers settle so deferred writes flush.
      for (let i = 0; i < 8 && !__ocExited; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      if (e && e.__ocProcessExit) { __ocExitCode = e.code; }
      else { __ocStderr += ((e && e.stack) || String(e)) + "\\n"; __ocExitCode = 1; }
    }
    if (__ocLoadError) {
      __ocStderr += __ocLoadError + "\\n";
      if (__ocExitCode === 0) __ocExitCode = 1;
    }
    return __ocHostResponse.json({
      exitCode: __ocExitCode,
      stdout: __ocStdout,
      stderr: __ocStderr,
      vfsWrites: {},
    });
  },
};
`;
}
