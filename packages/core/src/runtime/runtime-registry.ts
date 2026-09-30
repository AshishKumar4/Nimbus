/**
 * runtime-registry.ts — shared shell-command factory for runtime
 * dispatchers (node, bun, and future native-WASM / Python / Ruby /
 * AssemblyScript runtimes).
 *
 * Why this exists
 * ───────────────
 * `node` and `bun` shell-command handlers in src/session/init.ts
 * shared ~85% of their code: argv parsing for --version / --help /
 * -e / script-path, VFS lookup, shebang strip, esbuild transform for
 * .ts/.tsx/.jsx, dispatch to the runner. The duplication had drifted
 * — only `node` had the primitive #1 nodeFlagSpan fix
 * (init.ts:233-243), only `node` had primitive-#2 binSpawn ctx
 * propagation (init.ts:391-403), only `bun` had install / run
 * subcommand routing.
 *
 * `buildRuntimeHandler` returns a single shell-handler function that
 * encodes the shared contract. Per-runtime variation is supplied
 * via the `RuntimeSpec` parameter:
 *
 *   - name + version + helpText
 *   - run(): runner fn (runFresh / runBunScript / wasm-runner)
 *   - subcommands: optional map of `<verb> → handler` for
 *     bun-style `bun install`, `bun run` (node has none today)
 *   - transform(): optional code rewriter (bun prepends BUN_SHIM_PREAMBLE)
 *   - supportsBinSpawn: true for node (the .bin handler propagates
 *     a callerPid); other runtimes use a plain spawn flow.
 *
 * Anti-requirements observed
 * ──────────────────────────
 *   - NO setTimeout / NO retry / NO defensive-catch added.
 *   - NO behavioral change vs the pre-refactor handlers — every
 *     runtime-specific quirk is preserved exactly.
 *   - Per-runtime test parity: existing runtime-primitives probes
 *     (#1 npx / #2 .bin) and runtime-pkg probes (G1-G4) MUST still
 *     pass against the refactored handlers — the contract is
 *     observable behaviour, not implementation shape.
 */

import { normalizeVfsPath, resolveVfsPath, vfsPathExtension } from '../vfs/path.js';
import { CRED_KERNEL, type VfsCred } from './os-contracts.js';
import type { EsbuildService } from './esbuild-service.js';
import { typescriptLoader } from '../_shared/typescript-specifiers.js';
import { parseFacetBundleProfile, type FacetBundleProfile } from './bundle-profile.js';
import { bindImportMetaResolve, importMetaDefines } from './import-meta-transform.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import { errorText } from '../_shared/error-text.js';
import { exists } from '../vfs/vfs.js';

/**
 * Result shape that runtime-registry expects from a runner. Mirrors
 * the existing RunFreshResult / RunBunResult shapes — kept narrow so
 * future runtimes don't have to plumb runtime-internal state.
 */
export interface RuntimeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Options the handler passes to the runner. Mirrors RunFreshOpts.
 */
export interface RuntimeRunOpts {
  argv: string[];
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  filename: string;
  dirname: string;
  command: string;
  /** Primitive #1/G4 hooks. node-runner consumes these; other
   *  runtimes ignore them safely. */
  skipSpawn?: boolean;
  callerPid?: number;
  /** Capture stdout/stderr in the result instead of streaming to the
   *  terminal supervisor. Used by child_process pipe semantics. */
  captureOutput?: boolean;
  forceLongRunning?: boolean;
  attachedTty?: boolean;
  bundleProfile?: FacetBundleProfile;
  /** Invoking process credentials for credential-bound runtime snapshots. */
  cred?: VfsCred;
  /** Shell abort (Ctrl+C): forwarded to the run so it ends the program. */
  signal?: AbortSignal;
  /**
   * The entry launches a server from one of its own modules (see
   * entryLaunchesServer). Set only for a runtime that routes servers
   * (RuntimeSpec.routesServers), for a script it reads.
   */
  launchesServer?: boolean;
}

/** A relative module specifier a source names by string literal. */
const RELATIVE_SPECIFIER_RE = /\brequire\s*\(\s*(['"])(\.{1,2}\/[^'"\n]*)\1\s*\)|\bfrom\s*(['"])(\.{1,2}\/[^'"\n]*)\3|\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"\n]*)\5\s*\)|\bimport\s+(['"])(\.{1,2}\/[^'"\n]*)\7/g;

/** A server being created: http, https, http2 and net all name it so. */
const CREATES_SERVER_RE = /\bcreateServer\s*\(/;

/** How many of an entry's own modules are read: a launcher names a handful. */
const LAUNCHER_MODULE_LIMIT = 8;

/** The VFS surface the launcher check reads through: the command's own view. */
interface LauncherFs extends ScriptResolutionFs {
  exists(path: string): boolean | Promise<boolean>;
}

/**
 * The nearest directory at or above `dir` that holds a package.json, or null.
 * The first one wins (Node's rule); the filesystem root is not a package.
 */
async function nearestPackageDir(fs: Pick<LauncherFs, 'exists'>, dir: string): Promise<string | null> {
  for (let at = normalizeVfsPath(dir); at !== ''; at = at.slice(0, Math.max(0, at.lastIndexOf('/')))) {
    if (await fs.exists(`${at}/package.json`)) return at;
  }
  return null;
}

/**
 * Whether the entry at `entryPath` is a launcher for a server: a module its
 * source names by relative path, inside its own package (its own directory
 * when it has none), creates one.
 *
 * A server's port is reachable only from a resident process, which has to be
 * chosen before the program runs, so the runner judges a program by its
 * source (node-runner.ts looksLikeServer). The entry alone misses the usual
 * bin: a few lines that parse argv and hand off to the package's server
 * module (static-server's bin requires ../server.js, sirv-cli's ./index). One
 * hop is where that module sits. Following further, or taking `.listen(` as
 * a bind, also reaches the serve subcommands and event listeners of CLIs that
 * finish (degit, concurrently, nx, vitest, measured against 40 packages), and
 * a program that finishes in a resident process is never reported ended.
 */
async function entryLaunchesServer(fs: LauncherFs, entryPath: string, source: string): Promise<boolean> {
  const slash = entryPath.lastIndexOf('/');
  const dir = slash > 0 ? entryPath.slice(0, slash) : '';
  const root = (await nearestPackageDir(fs, dir)) ?? dir;
  let read = 0;
  for (const match of source.matchAll(RELATIVE_SPECIFIER_RE)) {
    if (read >= LAUNCHER_MODULE_LIMIT) break;
    const specifier = match[2] ?? match[4] ?? match[6] ?? match[8];
    if (!specifier || specifier.endsWith('.json')) continue;
    const target = await resolveRuntimeScriptPath(fs, dir, specifier);
    if (target === null || target === entryPath) continue;
    if (root !== '' && !target.startsWith(`${root}/`)) continue;
    read++;
    try {
      if (CREATES_SERVER_RE.test(await fs.readFileString(target))) return true;
    } catch { /* unreadable: not a server module we can see */ }
  }
  return false;
}

/** Extensions probed when a target names no exact file, in Node's order. */
const SCRIPT_RESOLUTION_CANDIDATES = ['.js', '.ts', '.tsx', '.mjs', '.jsx', '/index.js', '/index.ts'];

/** The VFS surface script resolution needs. */
export interface ScriptResolutionFs {
  isFile(path: string): boolean | Promise<boolean>;
  readFileString(path: string): string | Promise<string>;
}

/**
 * Resolve a runtime target — `./cli.ts`, `sub/x`, `.`, or a bare name — to a
 * canonical VFS key, or null when nothing runnable sits there.
 *
 * A directory never resolves to itself: it falls through to the index
 * candidates, so `bun ./tools` finds `tools/index.js` the way real bun does
 * rather than trying to read the directory as source.
 */
export async function resolveRuntimeScriptPath(
  fs: ScriptResolutionFs,
  cwd: string,
  target: string,
  opts?: { preferModuleField?: boolean },
): Promise<string | null> {
  const base = normalizeVfsPath(cwd || '/home/user');
  let resolved: string;
  if (target === '.' || target === './') {
    // `node .` / `bun .` — the package's declared entry point.
    let main = 'index.js';
    try {
      const pkg = JSON.parse(await fs.readFileString(`${base}/package.json`));
      main = (opts?.preferModuleField ? pkg.module : undefined) || pkg.main || 'index.js';
    } catch { /* no readable package.json — index.js */ }
    resolved = resolveVfsPath(main, base);
  } else {
    resolved = resolveVfsPath(target, base);
  }
  if (await fs.isFile(resolved)) return resolved;
  for (const candidate of SCRIPT_RESOLUTION_CANDIDATES) {
    if (await fs.isFile(resolved + candidate)) return resolved + candidate;
  }
  return null;
}

/**
 * A subcommand handler. `runAsRuntime` re-enters the standard flow — flag
 * span, script resolution, transform, exec — with a rewritten argv, as if
 * the verb had never been typed. `bun run <file>` uses it to hand a path
 * to the very same execution path `bun <file>` takes, rather than growing
 * a second one.
 */
export type RuntimeSubcommand = (
  ctx: CommandContext,
  registry: ShellRegistry,
  runAsRuntime: (args: string[]) => Promise<number>,
) => Promise<number>;

export interface RuntimeSpec {
  /** Shell-command name: 'node' / 'bun' / 'wasm-runner' / 'python'. */
  name: string;
  /** Output of `<name> --version`. Includes the leading 'v' if the
   *  runtime convention does (Node: 'v20.0.0'; Bun: '1.1.42'). */
  version: string;
  /** Multi-line help text for `<name> --help`. */
  helpText: string;
  /**
   * Runner function. Closes over whatever substrate the runtime executes on —
   * a FacetManager for node and bun, a {@link ./facet-host.js FacetHost} for
   * wasm-runner — because this factory never inspects it. It used to travel
   * through here as a first parameter, which is the only thing that tied the
   * shared handler to a Durable Object.
   */
  run(code: string, opts: RuntimeRunOpts): Promise<RuntimeRunResult>;
  /**
   * Subcommand router. When the first positional arg is a key in
   * this map, the handler is invoked instead of the standard
   * script-execution flow. Used by `bun install`, `bun run <script>`.
   */
  subcommands?: Record<string, RuntimeSubcommand>;
  /**
   * When true, the runtime treats the args list as a binary file
   * path (NOT a JS script). Used by `wasm-runner` — the args[0] is a
   * .wasm path, args[1+] are the function name + integer args.
   * The handler skips the read-and-transform-script flow and calls
   * `run()` with a synthetic empty `code` — runtimes that set this
   * flag implement the actual bytes-load inside their runner.
   */
  bypassesScriptRead?: boolean;
  /**
   * Primitive #1 / G4 — when true, the script-execution branch
   * propagates `ctx.__nimbusBinSpawn` into RuntimeRunOpts. Only
   * `node` enables this; bun's runFresh chain doesn't share PID
   * state with the .bin handler today. Future runtimes set this
   * iff they share the runFresh contract.
   */
  supportsBinSpawn?: boolean;
  /**
   * The runner routes a server-shaped program to a resident process
   * (node-runner.ts runFresh), so the handler reports whether a script's entry
   * launches one from its own modules (RuntimeRunOpts.launchesServer).
   */
  routesServers?: boolean;
}

/**
 * Minimal registry shape we depend on. Avoids importing the full vendored
 * shell registry type tree when the runtime path only needs resolve().
 */
export interface ShellRegistry {
  resolve(name: string): Promise<Command | null | undefined> | Command | null | undefined;
}

/**
 * Build a shell-handler function for a runtime. The returned function
 * is the value passed to `registry.register('<name>', handler)`.
 *
 * Captures `getEsbuild` (for lazy init) + the spec. The same factory is used for every runtime; the only
 * runtime-specific code lives in `spec`.
 */
export function buildRuntimeHandler(
  spec: RuntimeSpec,
  ctx0: {
    /** Lazy esbuild initialiser. Called once per first .ts/.tsx/.jsx
     *  invocation — the host owns the init lifecycle, including whether
     *  the module is loaded eagerly or on this call. */
    getEsbuild(): EsbuildService | Promise<EsbuildService>;
    registry: ShellRegistry;
  },
): Command {
  const { getEsbuild, registry } = ctx0;

  /**
   * The standard invocation: flag span, --version/--help/-e, then the
   * script-path flow. Subcommand verbs are NOT considered here — the
   * caller has already consumed them — so a verb handler can delegate
   * back in with a rewritten argv without re-triggering itself.
   */
  async function runtimeInvocation(ctx: CommandContext, args: string[]): Promise<number> {
    const fs = ctx.vfs;
    const name = spec.name;
    const nimbusCtx = ctx as {
      __nimbusCaptureOutput?: unknown;
      __nimbusBundleProfile?: unknown;
      __nimbusBinSpawn?: {
        callerPid?: number;
        command?: string;
        forceLongRunning?: boolean;
        attachedTty?: boolean;
      };
    };
    // A facet-hosted runtime streams its output to the session terminal over
    // the supervisor RPC and hands the shell an empty string. That is live and
    // cheap, and it is only correct while the process's stdout IS the terminal:
    // the stream bypasses the shell's stdout chain, so the moment fd 1 or fd 2
    // is a file, a pipe, a command substitution, or the capture sink of a
    // programmatic exec, the bytes have to come back in the result and be
    // written through ctx.stdout instead. A context with no fd table of its own
    // — the child_process broker synthesizes one — says so directly.
    const captureOutput = !!nimbusCtx.__nimbusCaptureOutput
      || ctx.isFdTerminal?.(1) === false
      || ctx.isFdTerminal?.(2) === false;
    // A bin wrapper or child-process broker may already own the process
    // entry; preserve it for eval/stdin programs as well as script files.
    const binSpawn = spec.supportsBinSpawn ? nimbusCtx.__nimbusBinSpawn : undefined;
    const reservedProcess = binSpawn ? {
      skipSpawn: true, callerPid: binSpawn.callerPid,
      forceLongRunning: binSpawn.forceLongRunning === true, attachedTty: binSpawn.attachedTty === true,
    } : {};
    const bundleProfile = parseFacetBundleProfile(nimbusCtx.__nimbusBundleProfile);

    // ── Flag-span computation (primitive #1) ──
    //
    // Real-Node only treats args UP TO the first non-flag token as
    // CLI flags. Pre-refactor, version/help/eval scanned the entire
    // args array, breaking `node /path/to/tsc --version` (the user's
    // --version was misinterpreted as a node flag).
    let flagSpan = 0;
    // A bare `-` is not a flag: it is the program itself, read from stdin
    // (`node - a b <<'EOF' ... EOF`, as installers pipe their helper scripts).
    while (flagSpan < args.length && args[flagSpan].startsWith('-') && args[flagSpan] !== '-') {
      flagSpan++;
      const prev = args[flagSpan - 1];
      // -e / --eval consumes one value; advance past it.
      if ((prev === '-e' || prev === '--eval') && flagSpan < args.length) {
        flagSpan++;
      }
    }
    const flagSlice = args.slice(0, flagSpan);

    // ── --version ──
    if (flagSlice.includes('-v') || flagSlice.includes('--version')) {
      ctx.stdout.write(spec.version + '\n');
      return 0;
    }

    // ── --help ──
    if (flagSlice.includes('--help') || flagSlice.includes('-h')) {
      ctx.stdout.write(spec.helpText);
      if (!spec.helpText.endsWith('\n')) ctx.stdout.write('\n');
      return 0;
    }

    // ── -e / --eval ──
    const evalIdx = flagSlice.indexOf('-e') !== -1
      ? flagSlice.indexOf('-e')
      : flagSlice.indexOf('--eval');
    if (evalIdx !== -1) {
      const code = args[evalIdx + 1];
      if (!code) {
        ctx.stderr.write(`${name}: -e requires an argument\n`);
        return 1;
      }
      const result = await spec.run(code, {
        cred: ctx.cred,
        signal: ctx.signal,
        argv: args.slice(evalIdx + 2),
        env: ctx.env,
        cwd: ctx.cwd,
        filename: '<eval>',
        dirname: ctx.cwd || '/home/user',
        command: binSpawn?.command || `${name} -e ...`,
        ...reservedProcess,
        ...(captureOutput ? { captureOutput: true } : {}),
        ...(bundleProfile ? { bundleProfile } : {}),
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    }

    // ── script path (or .wasm path for bypassesScriptRead) ──
    const scriptIdx = flagSpan;
    const scriptPath = args[scriptIdx];
    if (!scriptPath) {
      ctx.stderr.write(
        `${name}: REPL not supported. Use ${name} -e "code" or ${name} script.js\n`,
      );
      return 1;
    }

    // ── `-`: the program is stdin ──
    //
    // Every runtime here reads it so (`node -`, `python -`, `ruby -`), and
    // `process.argv[1]` stays `-` so the script's own arguments start at
    // `process.argv[2]`, where a program written for real Node looks. The
    // program's own stdin is what is left after the read: nothing.
    if (scriptPath === '-') {
      const code = ctx.stdin ? (await ctx.stdin.readAll()) : '';
      const result = await spec.run(code, {
        cred: ctx.cred,
        signal: ctx.signal,
        argv: [...args.slice(0, scriptIdx), '-', ...args.slice(scriptIdx + 1)],
        env: ctx.env,
        cwd: ctx.cwd,
        filename: '[stdin]',
        dirname: ctx.cwd || '/home/user',
        command: binSpawn?.command || `${name} -`,
        ...reservedProcess,
        ...(captureOutput ? { captureOutput: true } : {}),
        ...(bundleProfile ? { bundleProfile } : {}),
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    }

    // ── bypassesScriptRead branch (wasm-runner) ──
    //
    // The runner takes the path AS-IS (it's a .wasm, not JS source).
    // We don't read or transform here; the runner reads the bytes
    // and instantiates them. `.` resolution and extension probing are
    // meaningless for a .wasm target and stay out of this branch.
    if (spec.bypassesScriptRead) {
      const filename = '/' + resolveVfsPath(scriptPath, ctx.cwd || '/home/user');
      const dirname = filename.includes('/')
        ? filename.substring(0, filename.lastIndexOf('/'))
        : '/';
      // `args.slice(scriptIdx + 1)` are the runner's user args (e.g.
      // [exportName, intArg1, intArg2, ...] for wasm-runner).
      const result = await spec.run('', {
        cred: ctx.cred,
        signal: ctx.signal,
        argv: args.slice(scriptIdx + 1),
        env: ctx.env,
        cwd: ctx.cwd,
        filename,
        dirname,
        command: `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
        ...(captureOutput ? { captureOutput: true } : {}),
        ...(bundleProfile ? { bundleProfile } : {}),
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    }

    // Resolve against cwd: `.` → the package entry, then extension probing.
    const resolvedPath = (await resolveRuntimeScriptPath(fs, ctx.cwd || '/home/user', scriptPath, {
      // bun prefers .module over .main when both exist; node uses .main.
      preferModuleField: name === 'bun',
    }));

    let code: string | null = null;
    if (resolvedPath !== null) {
      try {
        code = (await fs.readFileString(resolvedPath));
      } catch { /* unreadable — reported below */ }
    }
    if (resolvedPath === null || code === null) {
      ctx.stderr.write(`${name}: cannot find module '${scriptPath}'\n`);
      return 1;
    }

    // Shebang strip (primitive #1).
    if (code.startsWith('#!')) {
      const nl = code.indexOf('\n');
      code = nl >= 0 ? code.substring(nl + 1) : '';
    }

    // Read before the ESM rewrite: the entry's own specifiers, as written. A
    // .bin wrapper has already decided residency by its own rule.
    const launchesServer = spec.routesServers === true && binSpawn === undefined
      && await entryLaunchesServer(fs, resolvedPath, code);

    // ── ESM-source detection (primitive: type:module entry scripts) ──
    //
    // A node facet runs every entry script as a CommonJS module body
    // (core/_shared/commonjs-cell.ts). A real `node script.js`
    // dispatch honours the nearest package.json's `"type"` field
    // (and the file extension) to decide whether to parse as ESM:
    //
    //   - .mjs          → always ESM
    //   - .cjs          → always CJS
    //   - .js           → ESM iff nearest package.json has "type": "module"
    //   - no extension  → same rule as .js. Node allows an extensionless
    //                     main entry and resolves its format from the
    //                     package type, and that is the shape of nearly
    //                     every npm `bin` script (typescript's `bin/tsc`,
    //                     and the `node_modules/.bin/<cli>` target the bin
    //                     dispatcher hands us).
    //
    // Without this, every modern ESM-only npm initialiser
    // (create-vite, create-astro, create-svelte, modern create-*)
    // crashes immediately with "Cannot use import statement outside
    // a module" because their bin entry is `index.js` and the
    // package.json declares `type: module`.
    //
    // We transform to CJS (format: 'cjs') so the facet runs it as a CJS
    // module body — same path that the bundle's `transformEsmInBundle`
    // (W3.5 Fix B) takes for sub-module ESM files. esbuild's CJS output
    // emits __require / module.exports / exports.X, ordinary CJS source.
    // The guest's registry could take the ES module itself, but not resolve
    // its package imports or give it the file's own URL (commonjs-cell.ts).
    async function nearestPackageTypeIsModule(absPath: string): Promise<boolean> {
      // The nearest package.json decides; ancestors past it are not consulted.
      const key = absPath.replace(/^\/+/, '');
      const slash = key.lastIndexOf('/');
      const dir = await nearestPackageDir(fs, slash > 0 ? key.substring(0, slash) : '');
      if (dir === null) return false;
      try {
        const pkg = JSON.parse((await fs.readFileString(`${dir}/package.json`)));
        return pkg && pkg.type === 'module';
      } catch {
        return false;
      }
    }

    const scriptExt = vfsPathExtension(resolvedPath);
    const needsEsmTransform =
      scriptExt === '.mjs' ||
      ((scriptExt === '.js' || scriptExt === '') && (await nearestPackageTypeIsModule(resolvedPath)));
    // TypeScript by the same table the bundle's ESM pass reads.
    const typescript = typescriptLoader(resolvedPath);

    // esbuild transform for TypeScript / TSX / JSX (both node and bun)
    // AND for ESM entry scripts (primitive ESM-detect).
    if (typescript !== null || scriptExt === '.jsx' || needsEsmTransform) {
      try {
        const eb = await getEsbuild();
        const loader = typescript ?? (scriptExt === '.jsx' ? 'jsx' : 'js');
        // Substitute `import.meta.url` at compile-time so esbuild's
        // CJS output doesn't reduce it to `undefined` (its default
        // for unknown import.meta references). The substitution
        // value is a real `file://<absolute-path>` URL — exactly
        // what real Node returns when running this script. Tools
        // that compute `fileURLToPath(import.meta.url)` (create-vite,
        // most modern CLIs) then resolve relative paths against
        // the actual script location.
        //
        // Without this, `create-vite` does
        //   r(import.meta.url) → fileURLToPath(undefined) → throws
        //   → falls into a different code path
        //   → readdirSync(wrong-template-dir) returns []
        //   → "Scaffolding..." but writes no files.
        const absUrl = 'file:///' + resolvedPath.replace(/^\/+/, '');
        const transformed = await eb.transform(code, {
          loader,
          format: 'cjs',
          define: importMetaDefines(absUrl),
          // Its import() calls are the process's: kept, and routed to the
          // process's ESM loader (dynamic-import-rewrite.ts).
          dynamicImportParent: absUrl,
        });
        code = bindImportMetaResolve(transformed.code, absUrl);
      } catch (e) {
        ctx.stderr.write(`${name}: transform error for ${scriptPath}: ${errorText(e)}\n`);
        return 1;
      }
    }

    const filename = '/' + resolvedPath;
    const dirname = filename.includes('/')
      ? filename.substring(0, filename.lastIndexOf('/'))
      : '/';

    const leadingFlags = args.slice(0, scriptIdx);
    const result = await spec.run(code, {
      cred: ctx.cred,
      signal: ctx.signal,
      argv: [...leadingFlags, filename, ...args.slice(scriptIdx + 1)],
      env: ctx.env,
      cwd: ctx.cwd,
      filename,
      dirname,
      command:
        binSpawn?.command || `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
      ...reservedProcess,
      ...(captureOutput ? { captureOutput: true } : {}),
      ...(bundleProfile ? { bundleProfile } : {}),
      ...(launchesServer ? { launchesServer: true } : {}),
    });
    if (result.stdout) ctx.stdout.write(result.stdout);
    if (result.stderr) ctx.stderr.write(result.stderr);
    return result.exitCode;
  }

  return async function runtimeHandler(ctx: CommandContext): Promise<number> {
    const args: string[] = ctx.args || [];

    // ── Subcommand dispatch ──
    //
    // BEFORE flag-span computation: subcommands like `bun install`
    // have their first positional arg as the verb, NOT a node-style
    // flag. A verb owns the whole invocation, but it may hand a
    // rewritten argv back to the standard flow — that is how
    // `bun run <file>` reaches the same execution path as `bun <file>`.
    if (spec.subcommands && args.length > 0 && spec.subcommands[args[0]]) {
      return spec.subcommands[args[0]](
        ctx,
        registry,
        async (rewritten: string[]) => (await runtimeInvocation(ctx, rewritten)),
      );
    }

    return (await runtimeInvocation(ctx, args));
  };
}
