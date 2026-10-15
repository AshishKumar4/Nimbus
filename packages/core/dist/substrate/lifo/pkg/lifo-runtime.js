import { Buffer } from 'node:buffer';
import realm from 'node:process';
import { synchronousFilesystem } from '../node-compat/filesystem.js';
import { resolve, dirname, join } from '../utils/path.js';
import { createProcess } from '../node-compat/process.js';
import { createConsole } from '../node-compat/console.js';
import { ProcessExitError } from '../node-compat/index.js';
import { createCjsLoader } from '../node-compat/cjs-loader.js';
import { createNativeEsmLoader } from '../node-compat/native-esm-loader.js';
import { leaveStandardStreamsOpen } from '../node-compat/standard-streams.js';
import { applySourceEdits, containsModuleSyntax } from '../../../runtime/javascript-ast.js';
import { readModuleImportSites, unusedIdentifier } from '../../../runtime/dynamic-import-rewrite.js';
// ─── CDN + WASM module registry ───
const DEFAULT_CDN = 'https://esm.sh';
/** In-memory cache for CDN imports (survives across command invocations). */
const esmCache = new Map();
const wasmModules = new Map();
export function registerLifoWasmModule(url, module) {
    wasmModules.set(url, module);
}
function getCdn(env) {
    return env.LIFO_CDN || DEFAULT_CDN;
}
function createLifoAPI(ctx) {
    const cdn = getCdn(ctx.env);
    return {
        cdn,
        async import(specifier) {
            // Allow full URLs to pass through
            const url = specifier.startsWith('http://') || specifier.startsWith('https://')
                ? specifier
                : `${cdn}/${specifier}`;
            const cached = esmCache.get(url);
            if (cached)
                return cached;
            const mod = await import(/* @vite-ignore */ url);
            esmCache.set(url, mod);
            return mod;
        },
        async loadWasm(url) {
            const module = wasmModules.get(url);
            if (module)
                return module;
            throw new Error(`lifo.loadWasm("${url}") requires a startup-registered WebAssembly module; ` +
                'Workers do not allow compiling fetched WebAssembly bytes during request handling.');
        },
        resolve(path) {
            return resolve(ctx.cwd, path);
        },
    };
}
// ─── Command loader ───
// ─── ESM rewriting ───
/** A bare specifier: neither relative nor absolute, and not a URL (`node:`, `https:`, `data:`). */
const BARE_SPECIFIER = /^(?![./]|[A-Za-z][A-Za-z0-9+.-]*:)/;
/**
 * The module with its bare module requests sent to the CDN, as the language
 * reads them (readModuleImportSites): each static specifier, and every
 * import() through one helper that maps its specifier when it is bare, so a
 * computed one is mapped too. A string or a comment is the program's text.
 *
 *   import { X } from 'foo'  →  import { X } from 'https://esm.sh/foo'
 *   import('foo')             →  __lifoCdnImport0('foo')
 */
function rewriteImportsToCdn(source, cdn) {
    const sites = readModuleImportSites(source);
    // A function declaration, so the module's code reaches it wherever it is,
    // under a name the module never spells, so none of its bindings meets it.
    const helperName = sites.calls.length === 0 ? '' : unusedIdentifier(source, '__lifoCdnImport');
    const edits = [
        ...sites.statics.filter((site) => BARE_SPECIFIER.test(site.specifier))
            .map((site) => ({ start: site.start, end: site.end, text: JSON.stringify(`${cdn}/${site.specifier}`) })),
        ...sites.calls.map((site) => ({ start: site.start, end: site.open + 1, text: `${helperName}(` })),
    ];
    if (edits.length === 0)
        return source;
    const helper = sites.calls.length === 0 ? '' : `\nfunction ${helperName}(specifier, options) { return import(typeof specifier === 'string' && ${BARE_SPECIFIER}.test(specifier) ? ${JSON.stringify(`${cdn}/`)} + specifier : specifier, options); }\n`;
    return applySourceEdits(source, edits) + helper;
}
/**
 * Create a Command that executes a lifo-native package entry.
 *
 * Supports two module formats:
 *   - ESM: import/export syntax → loaded through a data URL module
 *   - CJS: module.exports = async function(ctx, lifo) { ... }
 */
export function createLifoCommand(entryPath, vfs) {
    return async (ctx) => {
        const source = (await vfs.readFileString(entryPath));
        const lifo = createLifoAPI(ctx);
        // ── ESM path: rewrite imports to CDN, load through a data URL ──
        if (containsModuleSyntax(source)) {
            return executeEsmCommand(source, ctx, lifo);
        }
        // ── CJS path: the source read above, run by the shared loader ──
        return executeCjsCommand(entryPath, source, ctx, lifo);
    };
}
async function executeEsmCommand(source, ctx, lifo) {
    try {
        const rewritten = rewriteImportsToCdn(source, getCdn(ctx.env));
        const url = `data:text/javascript;base64,${Buffer.from(rewritten, 'utf-8').toString('base64')}`;
        const mod = await import(/* @vite-ignore */ url);
        const handler = mod.default;
        if (typeof handler !== 'function') {
            ctx.stderr.write('lifo: ESM module does not export a default command function\n');
            return 1;
        }
        const exitCode = await handler(ctx, lifo);
        return typeof exitCode === 'number' ? exitCode : 0;
    }
    catch (e) {
        if (e instanceof Error) {
            ctx.stderr.write(`${e.stack || e.message}\n`);
        }
        else {
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
async function executeCjsCommand(entryPath, source, ctx, lifo) {
    // The command's own mask, a copy of the shell's as it started, as a child's is.
    let mask = ctx.cred.umask;
    // fd 0 a piece at a time: a read still waiting when the command ends is withdrawn.
    const ended = new AbortController();
    const stdin = ctx.stdin;
    const nodeCtx = {
        filesystem: synchronousFilesystem(ctx.vfs, () => mask),
        identity: { pid: ctx.pid, uid: ctx.cred.uid, gid: ctx.cred.gid, groups: ctx.cred.groups, umask: mask, setUmask: (next) => { mask = next; } },
        cwd: ctx.cwd,
        env: ctx.env,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        argv: [entryPath, ...ctx.args],
        filename: entryPath,
        dirname: dirname(entryPath),
        signal: ctx.signal,
        input: {
            read: async () => {
                if (!stdin)
                    return null;
                if (stdin.readBytes)
                    return stdin.readBytes(65536, ended.signal);
                const text = await stdin.read();
                return text === null ? null : new TextEncoder().encode(text);
            },
            // The command's own promise is what it waits on.
            waiting: () => { },
        },
        terminal: {
            isatty: (fd) => ctx.isFdTerminal?.(fd) ?? false,
            setRawMode: (on) => { ctx.setRawMode?.(on); },
        },
        reachStreams: leaveStandardStreamsOpen,
    };
    const process = createProcess({ argv: nodeCtx.argv, env: nodeCtx.env, cwd: nodeCtx.cwd, stdio: nodeCtx, identity: nodeCtx.identity });
    const console = createConsole(ctx.stdout, ctx.stderr);
    // A command runs in the shell's realm, whose globalThis is the shell's: its
    // modules share a global of their own instead.
    const scope = { process, console, global: { process, Buffer, console } };
    const loader = createCjsLoader(nodeCtx, scope);
    try {
        return await commandsRunning().run(scope.process, () => runCjsCommand(entryPath, source, ctx, lifo, nodeCtx, loader));
    }
    finally {
        ended.abort();
    }
}
/**
 * The CommonJS command whose code is running. The commands run in the
 * shell's realm, whose process is the host's, so a warning the engine's own
 * builtins raise for one (util.deprecate, Buffer()) is raised on the host's
 * process; its emitWarning, wrapped once, gives it to the command's process,
 * as Node delivers a warning to the process that raised it, and to the
 * host's own outside the commands.
 */
let running;
function commandsRunning() {
    if (running !== undefined)
        return running;
    const { AsyncLocalStorage } = realm.getBuiltinModule('node:async_hooks');
    const commands = new AsyncLocalStorage();
    const hostEmitWarning = realm.emitWarning;
    realm.emitWarning = (...warning) => {
        const command = commands.getStore();
        if (command === undefined)
            hostEmitWarning.call(realm, ...warning);
        else
            command.emitWarning(...warning);
    };
    running = commands;
    return commands;
}
async function runCjsCommand(entryPath, source, ctx, lifo, nodeCtx, loader) {
    let native;
    try {
        native = await createNativeEsmLoader(nodeCtx, loader);
        // Its own source, already read: an entry with no dependencies needs no synchronous read at all.
        const exported = loader.load(entryPath, { source, esm: false });
        const handler = typeof exported === 'function'
            ? exported
            : exported?.default;
        if (typeof handler !== 'function') {
            await ctx.stderr.write(`lifo: ${entryPath} does not export a command function\n`);
            return 1;
        }
        const code = await handler(ctx, lifo);
        return typeof code === 'number' ? code : 0;
    }
    catch (e) {
        if (e instanceof ProcessExitError)
            return e.exitCode;
        await ctx.stderr.write(e instanceof Error ? `${e.stack || e.message}\n` : `${String(e)}\n`);
        return 1;
    }
    finally {
        native?.dispose();
    }
}
/**
 * Read a package.json and return the lifo manifest if present.
 */
export async function readLifoManifest(vfs, pkgDir) {
    const pkgJsonPath = join(pkgDir, 'package.json');
    try {
        const pkg = JSON.parse((await vfs.readFileString(pkgJsonPath)));
        return pkg.lifo || null;
    }
    catch {
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
export async function registerLifoManifestCommands(vfs, registry, pkgDir, manifest, options) {
    const registered = [];
    for (const [cmdName, entryRelPath] of Object.entries(manifest.commands)) {
        const entryPath = join(pkgDir, entryRelPath);
        if (options.requireEntry && !(await vfs.exists(entryPath)))
            continue;
        registry.register(cmdName, createLifoCommand(entryPath, vfs));
        registered.push(cmdName);
    }
    return registered;
}
