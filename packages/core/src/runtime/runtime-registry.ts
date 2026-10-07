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
 *   - supportsBinSpawn: true for node and bun (a .bin handler, the
 *     child_process broker or a background job propagates a callerPid);
 *     other runtimes use a plain spawn flow.
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
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type { ResolveContext } from '../substrate/lifo/commands/registry.js';
import { errorText } from '../_shared/error-text.js';
import { exists } from '../vfs/vfs.js';
import { programLaunchesServer, SERVER_LAUNCH_MODULE_BYTES, type ServerLaunchHost } from './server-launch.js';

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
  /** Host-local byte sink. Runners stream here instead of a text capture result. */
  output?: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void | Promise<void>;
  /** Existing fd-0 channel (a broker child or attached terminal), inherited without read-ahead. */
  stdinPid?: number;
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
  /**
   * A resident whose stdin its launcher writes and ends without waiting for
   * the boot: a synchronous read of stdin while it boots waits for that
   * input (worker runtime/stop-replay.ts). A resident started from the
   * terminal has no such writer, and the read fails naming why.
   */
  stdinWriter?: boolean;
  bundleProfile?: FacetBundleProfile;
  /** Invoking process credentials for credential-bound runtime snapshots. */
  cred?: VfsCred;
  /**
   * The process whose command runs the program. A process the runner spawns
   * for the run is its child: it takes its credential, and its exec id
   * (`ProcessEntry.execId`).
   */
  invokerPid?: number;
  /** Shell abort (Ctrl+C): forwarded to the run so it ends the program. */
  signal?: AbortSignal;
  /**
   * The pipe or redirect the program's stdin is (`echo hi | node x.js`,
   * `node x.js < in.txt`); absent when stdin is the terminal. A runner
   * delivers its bytes as they arrive, never holding the program for the
   * pipe's end (`tail -f log | node x.js` runs x.js at once).
   */
  stdin?: { read(): Promise<string | null>; readBytes?(maxLength: number): Promise<Uint8Array | null> };
  /**
   * The regular file a `< file` redirect opened, and the offset its stream is
   * at: the program's fd 0 is that file (read at a position, streamed as it
   * is read), in place of `stdin`.
   */
  stdinFile?: { path: string; offset: number };
  /**
   * Running the program starts a server (server-launch.ts). Set only for a
   * runtime that routes servers (RuntimeSpec.routesServers), when no .bin
   * wrapper has decided residency already.
   */
  launchesServer?: boolean;
}

/**
 * The nearest directory at or above `dir` that holds a package.json, or null.
 * The first one wins (Node's rule); the filesystem root is not a package.
 */
async function nearestPackageDir(
  fs: { exists(path: string): boolean | Promise<boolean> },
  dir: string,
): Promise<string | null> {
  for (let at = normalizeVfsPath(dir); at !== ''; at = at.slice(0, Math.max(0, at.lastIndexOf('/')))) {
    if (await fs.exists(`${at}/package.json`)) return at;
  }
  return null;
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
   * The runner routes a program that starts a server to a resident process
   * (node-runner.ts runFresh), so the handler reports whether it does
   * (RuntimeRunOpts.launchesServer).
   */
  routesServers?: boolean;
  /**
   * The program run with no script at a terminal, its stdin the terminal's
   * lines: the runtime's REPL (js-repl.ts), as `node` runs its own. With no
   * script and stdin not a terminal, the program is stdin (`echo code | node`).
   */
  repl?: string;
}

/**
 * Minimal registry shape we depend on. Avoids importing the full vendored
 * shell registry type tree when the runtime path only needs resolve().
 */
export interface ShellRegistry {
  resolve(name: string, from?: ResolveContext): Promise<Command | null | undefined> | Command | null | undefined;
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
        /**
         * Whoever started the reserved process writes its stdin and ends it,
         * and does not wait for it to boot (the SDK's startProcess): its boot
         * may wait for that input (RuntimeRunOpts.stdinWriter).
         */
        stdinWriter?: boolean;
        /**
         * The reserved process's own live input channel is its stdin (a
         * child_process child's: the broker's queue for its pid), which
         * ctx.stdin streams too. The program reads that channel itself; piping
         * ctx.stdin into a second one for the same pid would have the
         * parent's writes land in either, out of order.
         */
        liveInput?: boolean;
      };
    };
    // A facet-hosted runtime streams its output to the session terminal over
    // the supervisor RPC and hands the shell an empty string. That is live and
    // cheap, and it is only correct while the process's stdout IS the terminal:
    // the stream bypasses the shell's stdout chain, so the moment fd 1 or fd 2
    // is a file, a pipe, a command substitution, or the capture sink of a
    // programmatic exec, the bytes have to come back in the result and be
    // written through ctx.stdout instead. A context with no fd table of its own
    // — the child_process broker synthesizes one — says so directly, and that
    // wins: a broker child's fds are pipes, and its live output reaches the
    // parent through them (the broker routes a child pid's output to its queue).
    const captureOutput = typeof nimbusCtx.__nimbusCaptureOutput === 'boolean'
      ? nimbusCtx.__nimbusCaptureOutput
      : ctx.isFdTerminal?.(1) === false || ctx.isFdTerminal?.(2) === false;
    // A bin wrapper or child-process broker may already own the process
    // entry; preserve it for eval/stdin programs as well as script files.
    const binSpawn = spec.supportsBinSpawn ? nimbusCtx.__nimbusBinSpawn : undefined;
    // fd 0 the same way: a pipe or redirect is the program's stdin. It used
    // to be dropped, so `echo hi | node x.js` read nothing. A process whose
    // live input channel already is that stdin reads the channel.
    const pipedStdin = binSpawn?.liveInput !== true && ctx.stdin && ctx.stdin !== ctx.terminalStdin && ctx.isFdTerminal?.(0) === false
      ? ctx.stdin : undefined;
    const reservedProcess = binSpawn ? {
      skipSpawn: true, callerPid: binSpawn.callerPid,
      forceLongRunning: binSpawn.forceLongRunning === true, attachedTty: binSpawn.attachedTty === true,
      ...(binSpawn.stdinWriter === true ? { stdinWriter: true } : {}),
    } : {};
    const bundleProfile = parseFacetBundleProfile(nimbusCtx.__nimbusBundleProfile);
    // How the analyses of a program's code read its modules: the command's
    // own view of the filesystem.
    const programHost: ServerLaunchHost = {
      resolve: (from, specifier) => resolveRuntimeScriptPath(fs, from, specifier),
      read: async (path) => {
        try {
          // Past the bound it is not walked, so it is not read either.
          if (((await fs.stat(path))?.size ?? 0) > SERVER_LAUNCH_MODULE_BYTES) return null;
          return await fs.readFileString(path);
        } catch { return null; }
      },
    };
    // Whether the program starts a server, so the runner can give it a
    // resident process; a .bin wrapper has already decided that by its own rule.
    const launches = async (code: string, path: string | null, dir: string, programArgs: string[]): Promise<boolean> => {
      if (spec.routesServers !== true || binSpawn !== undefined) return false;
      const key = normalizeVfsPath(dir);
      return programLaunchesServer({
        source: code,
        path,
        dir: key,
        packageRoot: (await nearestPackageDir(fs, key)) ?? key,
        argv: [name, ...programArgs],
      }, programHost);
    };
    // The program's piped stdin: a pipe streams to it as it arrives, and a
    // `< file` is the file itself, nothing read from its stream here. A
    // process whose own channel is its stdin (a child_process child's) reads
    // that channel itself. Nothing is read ahead for the program: a
    // synchronous read that needs more than has arrived waits for it in the
    // runner, which stops the run and runs it again once the input is there
    // (worker runtime/stop-replay.ts).
    const programStdin: Pick<RuntimeRunOpts, 'stdin' | 'stdinFile' | 'output' | 'stdinPid'> = {
      ...(nimbusCtx.__nimbusBinSpawn?.liveInput ? { stdinPid: nimbusCtx.__nimbusBinSpawn.callerPid } : {}),
      output: binSpawn?.liveInput ? undefined : (stream, bytes) => {
        const sink = stream === 'stdout' ? ctx.stdout : ctx.stderr;
        return sink.writeBytes ? sink.writeBytes(bytes) : sink.write(new TextDecoder().decode(bytes));
      },
      ...(pipedStdin === undefined ? (spec.bypassesScriptRead && ctx.stdin ? { stdin: ctx.stdin } : {})
      : pipedStdin.file
        ? { stdinFile: { path: pipedStdin.file.path, offset: pipedStdin.file.offset } }
        : { stdin: pipedStdin }),
    };
    /**
     * Run `code` as this invocation's program, whichever way the arguments
     * named it (-e, the REPL, stdin, a file): what the program is (its argv,
     * file, command line, stdin) with what every mode shares, and its output
     * written through. `reserved` is false where the runner keeps no process
     * a bin wrapper reserved (wasm-runner's).
     */
    const runProgram = async (code: string, program: {
      argv: string[];
      filename: string;
      dirname: string;
      command: string;
      stdin?: Pick<RuntimeRunOpts, 'stdin' | 'stdinFile' | 'output' | 'stdinPid'>;
      reserved?: boolean;
      launchesServer?: boolean;
    }): Promise<number> => {
      const result = await spec.run(code, {
        cred: ctx.cred,
        invokerPid: ctx.pid,
        signal: ctx.signal,
        argv: program.argv,
        env: ctx.env,
        cwd: ctx.cwd,
        filename: program.filename,
        dirname: program.dirname,
        command: program.command,
        output: programStdin.output,
        ...program.stdin,
        ...(program.reserved === false ? {} : reservedProcess),
        ...(captureOutput ? { captureOutput: true } : {}),
        ...(bundleProfile ? { bundleProfile } : {}),
        ...(program.launchesServer ? { launchesServer: true } : {}),
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    };

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
      return runProgram(code, {
        argv: args.slice(evalIdx + 2),
        filename: '<eval>',
        dirname: ctx.cwd || '/home/user',
        command: binSpawn?.command || `${name} -e ...`,
        stdin: programStdin,
        launchesServer: await launches(code, null, ctx.cwd || '/home/user', args.slice(evalIdx + 2)),
      });
    }

    // ── script path (or .wasm path for bypassesScriptRead) ──
    const scriptIdx = flagSpan;
    // No script: the REPL at a terminal, otherwise the program is stdin, as
    // Node decides between them by whether stdin is a TTY.
    const terminalInput = ctx.terminalStdin !== undefined && (ctx.stdin === undefined || ctx.stdin === ctx.terminalStdin) && ctx.isFdTerminal?.(0) !== false;
    if (args[scriptIdx] === undefined && spec.repl !== undefined && terminalInput && ctx.terminalStdin) {
      // The REPL takes Ctrl-C as input, as Node's readline does: the
      // terminal's signal keys are off while it runs (termios ISIG).
      const terminal = ctx.terminalStdin;
      terminal.signalKeys = false;
      try {
        return await runProgram(spec.repl, {
          argv: args.slice(0, scriptIdx),
          filename: '<repl>',
          dirname: ctx.cwd || '/home/user',
          command: binSpawn?.command || name,
          stdin: { stdin: terminal },
        });
      } finally {
        terminal.signalKeys = true;
      }
    }
    const scriptPath = args[scriptIdx] ?? (spec.repl !== undefined && ctx.stdin !== undefined ? '-' : undefined);
    if (!scriptPath) {
      ctx.stderr.write(
        `${name}: no program. Use ${name} -e "code" or ${name} script.js\n`,
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
      return runProgram(code, {
        argv: [...args.slice(0, scriptIdx), '-', ...args.slice(scriptIdx + 1)],
        filename: '[stdin]',
        dirname: ctx.cwd || '/home/user',
        command: binSpawn?.command || `${name} -`,
        stdin: { output: programStdin.output },
        launchesServer: await launches(code, null, ctx.cwd || '/home/user', ['-', ...args.slice(scriptIdx + 1)]),
      });
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
      return runProgram('', {
        argv: args.slice(scriptIdx + 1),
        filename,
        dirname,
        command: `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
        stdin: programStdin,
        reserved: false,
      });
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
        const absUrl = 'file:///' + resolvedPath.replace(/^\/+/, '');
        const transformed = await eb.transform(code, {
          loader,
          format: 'cjs',
          // Its import() calls are the process's: kept, and routed to the
          // process's ESM loader (dynamic-import-rewrite.ts).
          dynamicImportParent: absUrl,
          // Its import.meta is the module's own, as every loaded module's:
          // url, resolve, dirname and filename name the script, read
          // directly, as an object or destructured (the runner's
          // __nimbusFileImportMeta). CommonJS output alone would make it {}.
          moduleMetadata: true,
        });
        code = transformed.code;
      } catch (e) {
        ctx.stderr.write(`${name}: transform error for ${scriptPath}: ${errorText(e)}\n`);
        return 1;
      }
    }

    const filename = '/' + resolvedPath;
    const dirname = filename.includes('/')
      ? filename.substring(0, filename.lastIndexOf('/'))
      : '/';
    return runProgram(code, {
      argv: [...args.slice(0, scriptIdx), filename, ...args.slice(scriptIdx + 1)],
      filename,
      dirname,
      command: binSpawn?.command || `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
      stdin: programStdin,
      // Judged on the code as it will run, after any TypeScript/ESM transform.
      launchesServer: await launches(code, resolvedPath, dirname, [filename, ...args.slice(scriptIdx + 1)]),
    });
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
