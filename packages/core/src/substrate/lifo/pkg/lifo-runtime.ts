import { synchronousFilesystem } from '../node-compat/filesystem.js';
/**
 * Lifo Runtime -- enhanced execution context for lifo-native packages.
 *
 * Packages with a "lifo" field in package.json get this runtime instead of
 * the plain CJS node runner.  It provides:
 *   - lifo.import()   – load ESM modules from a configurable CDN (default esm.sh)
 *   - lifo.loadWasm() – load startup-registered WebAssembly modules
 *   - lifo.resolve()  – resolve a path relative to cwd
 */

import type { Command, CommandContext } from '../commands/types.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { ProcessView as VFS } from '../../../runtime/process-files.js';
import { resolve, dirname, join } from '../utils/path.js';
import { createProcess } from '../node-compat/process.js';
import { createConsole } from '../node-compat/console.js';
import { Buffer } from '../node-compat/buffer.js';
import { ProcessExitError } from '../node-compat/index.js';
import { createCjsLoader, isEsmSource } from '../node-compat/cjs-loader.js';
import type { NodeContext } from '../node-compat/index.js';


// ─── Types ───

export interface LifoPackageManifest {
  commands: Record<string, string>;  // command name -> relative path to entry JS
}

export interface LifoAPI {
  /** Import an ESM module from CDN.  Cached after first load. */
  import(specifier: string): Promise<unknown>;

  /** Load a WebAssembly module registered during Worker startup. */
  loadWasm(url: string): Promise<WebAssembly.Module>;

  /** Resolve a path relative to the command's cwd. */
  resolve(path: string): string;

  /** The CDN base URL currently in use. */
  readonly cdn: string;
}

// ─── CDN + WASM module registry ───

const DEFAULT_CDN = 'https://esm.sh';

/** In-memory cache for CDN imports (survives across command invocations). */
const esmCache = new Map<string, unknown>();

const wasmModules = new Map<string, WebAssembly.Module>();

export function registerLifoWasmModule(url: string, module: WebAssembly.Module): void {
  wasmModules.set(url, module);
}

function getCdn(env: Record<string, string>): string {
  return env.LIFO_CDN || DEFAULT_CDN;
}

function createLifoAPI(ctx: CommandContext): LifoAPI {
  const cdn = getCdn(ctx.env);

  return {
    cdn,

    async import(specifier: string): Promise<unknown> {
      // Allow full URLs to pass through
      const url = specifier.startsWith('http://') || specifier.startsWith('https://')
        ? specifier
        : `${cdn}/${specifier}`;

      const cached = esmCache.get(url);
      if (cached) return cached;

      const mod = await import(/* @vite-ignore */ url);
      esmCache.set(url, mod);
      return mod;
    },

    async loadWasm(url: string): Promise<WebAssembly.Module> {
      const module = wasmModules.get(url);
      if (module) return module;

      throw new Error(
        `lifo.loadWasm("${url}") requires a startup-registered WebAssembly module; ` +
        'Workers do not allow compiling fetched WebAssembly bytes during request handling.',
      );
    },

    resolve(path: string): string {
      return resolve(ctx.cwd, path);
    },
  };
}

// ─── Command loader ───

// ─── ESM rewriting ───

/**
 * Rewrite bare specifier imports/exports to CDN URLs so the module
 * can be loaded via blob URL + import().
 *
 *   import { X } from 'foo'  →  import { X } from 'https://esm.sh/foo'
 *   import('foo')             →  import('https://esm.sh/foo')
 */
function rewriteImportsToCdn(source: string, cdn: string): string {
  // Static imports/re-exports: from 'specifier' or from "specifier"
  let result = source.replace(
    /(from\s+)(["'])([^"'./][^"']*)\2/g,
    (_, prefix, quote, spec) => `${prefix}${quote}${cdn}/${spec}${quote}`,
  );
  // Dynamic import(): import('specifier') or import("specifier")
  result = result.replace(
    /(import\s*\(\s*)(["'])([^"'./][^"']*)\2(\s*\))/g,
    (_, prefix, quote, spec, suffix) => `${prefix}${quote}${cdn}/${spec}${quote}${suffix}`,
  );
  return result;
}

/**
 * Create a Command that executes a lifo-native package entry.
 *
 * Supports two module formats:
 *   - ESM: import/export syntax → loaded through a data URL module
 *   - CJS: module.exports = async function(ctx, lifo) { ... }
 */
export function createLifoCommand(
  entryPath: string,
  vfs: VFS,
): Command {
  return async (ctx: CommandContext): Promise<number> => {
    const source = (await vfs.readFileString(entryPath));
    const lifo = createLifoAPI(ctx);

    // ── ESM path: rewrite imports to CDN, load through a data URL ──
    if (isEsmSource(source)) {
      return executeEsmCommand(source, ctx, lifo);
    }

    // ── CJS path: the source read above, run by the shared loader ──
    return executeCjsCommand(entryPath, source, ctx, lifo);
  };
}

async function executeEsmCommand(
  source: string,
  ctx: CommandContext,
  lifo: LifoAPI,
): Promise<number> {
  const cdn = getCdn(ctx.env);
  const rewritten = rewriteImportsToCdn(source, cdn);
  const encoded = Buffer.from(rewritten, 'utf-8').toString('base64');
  const url = `data:text/javascript;base64,${encoded}`;

  try {
    const mod = await import(/* @vite-ignore */ url);
    const handler = mod.default;

    if (typeof handler !== 'function') {
      ctx.stderr.write('lifo: ESM module does not export a default command function\n');
      return 1;
    }

    const exitCode = await handler(ctx, lifo);
    return typeof exitCode === 'number' ? exitCode : 0;
  } catch (e) {
    if (e instanceof Error) {
      ctx.stderr.write(`${e.stack || e.message}\n`);
    } else {
      ctx.stderr.write(`${String(e)}\n`);
    }
    return 1;
  }
}

/**
 * A CommonJS entry, run with the node command's loader (cjs-loader.ts) from
 * the source already read: its requires resolve and cache as a node
 * program's do. It exports the command's function,
 * `module.exports = async function(ctx, lifo) { ... }`
 * (or as `default`), which runs here in the shell's realm, since ctx and
 * lifo are the shell's own objects.
 */
async function executeCjsCommand(
  entryPath: string,
  source: string,
  ctx: CommandContext,
  lifo: LifoAPI,
): Promise<number> {
  const nodeCtx: NodeContext = {
    filesystem: synchronousFilesystem(ctx.vfs),
    cwd: ctx.cwd,
    env: ctx.env,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    argv: [entryPath, ...ctx.args],
    filename: entryPath,
    dirname: dirname(entryPath),
    signal: ctx.signal,
  };
  const loader = createCjsLoader(nodeCtx, () => ({
    process: createProcess({ argv: nodeCtx.argv, env: nodeCtx.env, cwd: nodeCtx.cwd, stdout: ctx.stdout, stderr: ctx.stderr }),
    console: createConsole(ctx.stdout, ctx.stderr),
  }));

  try {
    // Its own source, already read: an entry with no dependencies needs no synchronous read at all.
    const exported = loader.load(entryPath, { source, esm: false });
    const handler = typeof exported === 'function'
      ? exported
      : (exported as Record<string, unknown> | null)?.default;

    if (typeof handler !== 'function') {
      await ctx.stderr.write(`lifo: ${entryPath} does not export a command function\n`);
      return 1;
    }
    const code = await (handler as (c: CommandContext, l: LifoAPI) => Promise<number>)(ctx, lifo);
    return typeof code === 'number' ? code : 0;
  } catch (e) {
    if (e instanceof ProcessExitError) return e.exitCode;
    await ctx.stderr.write(e instanceof Error ? `${e.stack || e.message}\n` : `${String(e)}\n`);
    return 1;
  }
}

// ─── Package detection ───

export interface LifoPackageJson {
  name?: string;
  version?: string;
  lifo?: LifoPackageManifest;
  bin?: string | Record<string, string>;
}

/**
 * Read a package.json and return the lifo manifest if present.
 */
export async function readLifoManifest(vfs: VFS, pkgDir: string): Promise<LifoPackageManifest | null> {
  const pkgJsonPath = join(pkgDir, 'package.json');
  try {
    const pkg: LifoPackageJson = JSON.parse((await vfs.readFileString(pkgJsonPath)));
    return pkg.lifo || null;
  } catch {
    return null;
  }
}

/**
 * Register each command a lifo manifest declares, its entry under `pkgDir`.
 * `requireEntry` skips a command whose entry file is not there (an install,
 * a boot restore); a dev link registers every declared command, so a
 * missing entry fails when it runs. Returns the names registered, in the
 * manifest's order.
 */
export async function registerLifoManifestCommands(
  vfs: VFS,
  registry: CommandRegistry,
  pkgDir: string,
  manifest: LifoPackageManifest,
  options: { requireEntry: boolean },
): Promise<string[]> {
  const registered: string[] = [];
  for (const [cmdName, entryRelPath] of Object.entries(manifest.commands)) {
    const entryPath = join(pkgDir, entryRelPath);
    if (options.requireEntry && !(await vfs.exists(entryPath))) continue;
    registry.register(cmdName, createLifoCommand(entryPath, vfs));
    registered.push(cmdName);
  }
  return registered;
}
