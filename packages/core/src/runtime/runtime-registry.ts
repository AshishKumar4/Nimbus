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
import { esModuleSyntaxError, isEsModuleFile, isEsModuleInput, type ModuleScope } from './module-format.js';
import { packageScopeType } from './require-resolution.js';
import { exists, isDirectory } from '../vfs/vfs.js';
import { programLaunchesServer, SERVER_LAUNCH_MODULE_BYTES, type ServerLaunchHost } from './server-launch.js';
import { parseNodeCommandLine, type NodeCommandLine, type NodeLaunch } from './node-cli.js';
import { nodeEvalProgram, nodeStdinPrintProgram, type NodeEvalMode } from './node-eval.js';

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
   * A Node program's command line (RuntimeSpec.nodeCommandLine): its options
   * (`process.execArgv`), its conditions, what it preloads, and its `-e`
   * code; with `print`, the program's code returns the value to print.
   */
  node?: NodeLaunch;
  /**
   * The program is an ES module the handler lowered (module-format.ts): its
   * own require is its static imports, and what escapes its evaluation is
   * explained as Node's loader explains it.
   */
  esModule?: boolean;
  /** Whose scope its ES modules run in (RuntimeSpec.moduleScope): absent, Node's. */
  moduleScope?: ModuleScope;
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
/**
 * Another runtime's command line, as the registry has always read it:
 * flags up to the program (a bare `-` is the program, read from stdin), the
 * first `-e`/`--eval` taking its code; `-v`/`--version` and `-h`/`--help`
 * among them.
 */
function genericCommandLine(name: string, args: readonly string[]): NodeCommandLine | { error: string; exitCode: number } {
  let span = 0;
  let evalCode: string | undefined;
  let evalFlag = false;
  while (span < args.length && args[span].startsWith('-') && args[span] !== '-') {
    const flag = args[span++];
    if (flag === '-e' || flag === '--eval') {
      if (!evalFlag) evalCode = args[span];
      evalFlag = true;
      if (span < args.length) span++;
    }
  }
  const flags = args.slice(0, span);
  if (evalFlag && !evalCode) return { error: `${name}: -e requires an argument\n`, exitCode: 1 };
  return {
    execArgv: [],
    programIndex: span,
    conditions: [],
    require: [],
    import: [],
    ...(evalCode !== undefined ? { eval: evalCode } : {}),
    print: false,
    version: flags.includes('-v') || flags.includes('--version'),
    help: flags.includes('--help') || flags.includes('-h'),
  };
}

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
   * The command line is Node's (node-cli.ts): its options take their values
   * as Node's table says, NODE_OPTIONS is read (and refused as Node refuses
   * it), and the program's conditions and execArgv go to the run.
   */
  nodeCommandLine?: boolean;
  /**
   * Whose scope the runtime runs an ES module in (module-format.ts
   * ModuleScope), the entry's and every module it loads: absent, Node's.
   */
  moduleScope?: ModuleScope;
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
    const moduleScope = spec.moduleScope ?? 'node';
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
    const programStdin: Pick<RuntimeRunOpts, 'stdin' | 'stdinFile'> = pipedStdin === undefined ? {}
      : pipedStdin.file
        ? { stdinFile: { path: pipedStdin.file.path, offset: pipedStdin.file.offset } }
        : { stdin: pipedStdin };
    // ── Flag-span computation (primitive #1) ──
    //
    // Real-Node only treats args UP TO the first non-flag token as
    // CLI flags. Pre-refactor, version/help/eval scanned the entire
    // args array, breaking `node /path/to/tsc --version` (the user's
    // --version was misinterpreted as a node flag).
    // The command line: Node's own reading of it (node-cli.ts) for node, the
    // one parser its options, execArgv, conditions and program come from;
    // for the other runtimes, flags up to the program, `-e` taking its code.
    const line = spec.nodeCommandLine ? parseNodeCommandLine(args, ctx.env?.NODE_OPTIONS ?? '') : genericCommandLine(name, args);
    if ('error' in line) {
      ctx.stderr.write(line.error);
      return line.exitCode;
    }
    const flagSpan = line.programIndex;
    // What a node run takes of its command line (RuntimeRunOpts.node).
    const { programIndex: _programIndex, version: _version, help: _help, print, inputType, ...launch } = line;
    // A node program's argv is its own: Node's options are execArgv. Another runtime's carries its flags.
    const leadingFlags = spec.nodeCommandLine ? [] : args.slice(0, flagSpan);

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
      stdin?: Pick<RuntimeRunOpts, 'stdin' | 'stdinFile'>;
      reserved?: boolean;
      launchesServer?: boolean;
      /** The code returns the value `node -p` prints (node-eval.ts): Node prints only an eval's, not a file's. */
      print?: boolean;
      /** Node refuses the code before it loads `--import`'s modules (NodeEvalProgram.refusedBeforeImports): none load. */
      refusedBeforeImports?: boolean;
      esModule?: boolean;
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
        ...(spec.nodeCommandLine
          ? { node: { ...launch, print: program.print === true, ...(program.refusedBeforeImports ? { import: [] } : {}) } }
          : {}),
        ...program.stdin,
        ...(program.reserved === false ? {} : reservedProcess),
        ...(captureOutput ? { captureOutput: true } : {}),
        ...(bundleProfile ? { bundleProfile } : {}),
        ...(program.launchesServer ? { launchesServer: true } : {}),
        // Evaluated as Node's loader runs an ES module, in Node's scope.
        ...(program.esModule && moduleScope === 'node' ? { esModule: true } : {}),
        moduleScope,
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    };

    /**
     * A program's source as the CommonJS a facet runs (core/_shared/commonjs-cell.ts):
     * TypeScript, JSX or an ES module (`esm`) compiled by esbuild, its import() calls kept
     * and routed to the process's ESM loader (dynamic-import-rewrite.ts), its
     * import.meta the module's own (url, resolve, dirname and filename, read
     * directly, as an object or destructured: the runner's __nimbusFileImportMeta;
     * CommonJS output alone would make it {}). An ES module that does not
     * parse is code that throws its SyntaxError as Node's evaluation does
     * (module-format.ts esModuleSyntaxError). Null when the transform failed
     * otherwise, which it has reported.
     */
    async function lowerToCommonJs(code: string, loader: 'js' | 'jsx' | 'ts' | 'tsx', url: string, what: string, esm: boolean): Promise<string | null> {
      try {
        const eb = await getEsbuild();
        // An ES module keeps Node's scope (module-format.ts ModuleScope): strict, no CommonJS wrapper name.
        return (await eb.transform(code, {
          loader, format: 'cjs', dynamicImportParent: url, moduleMetadata: true, ...(esm && moduleScope === 'node' ? { esModuleScope: true } : {}),
        })).code;
      } catch (e) {
        const syntaxError = esm && loader === 'js' ? esModuleSyntaxError(code, url) : null;
        if (syntaxError !== null) return syntaxError;
        ctx.stderr.write(`${name}: transform error for ${what}: ${errorText(e)}\n`);
        return null;
      }
    }
    /** The URL Node gives `-e` code and a program read from stdin: `[eval1]` in the working directory. */
    const evalUrl = () => 'file:///' + normalizeVfsPath((ctx.cwd || '/home/user') + '/[eval1]');
    /**
     * `-e` code or a program read from stdin as the process runs it: an ES
     * module (`--input-type=module`, or its syntax, module-format.ts) lowered,
     * which `-p` refuses as Node does (node-eval.ts); else Node's eval code.
     */
    async function inputProgram(source: string, what: '[eval]' | '[stdin]'): Promise<{ code: string; refusedBeforeImports: boolean; esModule: boolean } | null> {
      const esModule = isEsModuleInput(source, inputType);
      if (esModule && !print) {
        const lowered = await lowerToCommonJs(source, 'js', evalUrl(), what, true);
        return lowered === null ? null : { code: lowered, refusedBeforeImports: false, esModule: true };
      }
      if (!spec.nodeCommandLine) return { code: source, refusedBeforeImports: false, esModule: false };
      const mode: NodeEvalMode = esModule ? 'module' : inputType === 'commonjs' ? 'commonjs' : 'default';
      const prepared = what === '[eval]' ? nodeEvalProgram(source, print, mode) : print ? nodeStdinPrintProgram(source, mode) : { code: source, refusedBeforeImports: false };
      return { ...prepared, esModule: false };
    }

    // ── --version ──
    if (line.version) {
      ctx.stdout.write(spec.version + '\n');
      return 0;
    }

    // ── --help ──
    if (line.help) {
      ctx.stdout.write(spec.helpText);
      if (!spec.helpText.endsWith('\n')) ctx.stdout.write('\n');
      return 0;
    }

    // ── -e / --eval, and -p / --print ──
    // Node's eval code as Node prepares it (node-eval.ts); `-p`'s returns
    // the value the process prints when it exits.
    if (line.eval !== undefined) {
      const program = await inputProgram(line.eval, '[eval]');
      if (program === null) return 1;
      const { code, refusedBeforeImports, esModule } = program;
      const programArgs = args.slice(flagSpan);
      return runProgram(code, {
        print,
        refusedBeforeImports,
        esModule,
        argv: programArgs,
        filename: '<eval>',
        dirname: ctx.cwd || '/home/user',
        command: binSpawn?.command || `${name} -e ...`,
        stdin: programStdin,
        launchesServer: await launches(code, null, ctx.cwd || '/home/user', programArgs),
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
          argv: leadingFlags,
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
      const input = ctx.stdin ? (await ctx.stdin.readAll()) : '';
      // `-p` prints the value of the code it read (eval_stdin.js).
      const program = await inputProgram(input, '[stdin]');
      if (program === null) return 1;
      const { code, refusedBeforeImports, esModule } = program;
      return runProgram(code, {
        print,
        refusedBeforeImports,
        esModule,
        argv: [...leadingFlags, '-', ...args.slice(scriptIdx + 1)],
        filename: '[stdin]',
        dirname: ctx.cwd || '/home/user',
        command: binSpawn?.command || `${name} -`,
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

    // ── Module format ──
    //
    // A node facet runs every entry script as a CommonJS module body
    // (core/_shared/commonjs-cell.ts), so one Node runs as an ES module is
    // lowered first, decided as a real `node script.js` decides
    // (module-format.ts isEsModuleFile):
    //
    //   - .mjs          → always ESM
    //   - .cjs          → always CJS
    //   - .js           → as the nearest package.json's "type" says
    //   - no extension  → same rule as .js. Node allows an extensionless
    //                     main entry and resolves its format from the
    //                     package type, and that is the shape of nearly
    //                     every npm `bin` script (typescript's `bin/tsc`,
    //                     and the `node_modules/.bin/<cli>` target the bin
    //                     dispatcher hands us).
    //   - no "type"     → by its syntax: an import or export, import.meta,
    //                     a top-level await, or a top-level `const require`
    //                     (Node's syntax detection, on by default in 22).
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
    const scriptExt = vfsPathExtension(resolvedPath);
    // The package scope's "type", through the resolver's own lookup.
    const packageType = scriptExt === '.js' || scriptExt === ''
      ? await packageScopeType({
        exists: (path) => fs.exists(path),
        isDirectory: (path) => isDirectory(fs, path),
        readFileString: (path) => fs.readFileString(path),
        stat: (path) => fs.stat(path),
      }, resolvedPath.slice(0, Math.max(0, resolvedPath.lastIndexOf('/'))))
      : null;
    // TypeScript by the same table the bundle's ESM pass reads.
    const typescript = typescriptLoader(resolvedPath);

    // esbuild transform for TypeScript / TSX / JSX (both node and bun)
    // AND for ESM entry scripts.
    const esm = typescript === null && scriptExt !== '.jsx' && isEsModuleFile(resolvedPath, code, () => packageType);
    if (typescript !== null || scriptExt === '.jsx' || esm) {
      const loader = typescript ?? (scriptExt === '.jsx' ? 'jsx' : 'js');
      const lowered = await lowerToCommonJs(code, loader, 'file:///' + resolvedPath.replace(/^\/+/, ''), scriptPath, esm);
      if (lowered === null) return 1;
      code = lowered;
    }

    const filename = '/' + resolvedPath;
    const dirname = filename.includes('/')
      ? filename.substring(0, filename.lastIndexOf('/'))
      : '/';
    return runProgram(code, {
      esModule: esm,
      argv: [...leadingFlags, filename, ...args.slice(scriptIdx + 1)],
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
