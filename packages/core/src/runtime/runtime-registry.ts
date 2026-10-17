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
 *   - supportsBinSpawn: true for node and bun (the child_process broker
 *     or a background job propagates a callerPid);
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
import { stripsTypeScript, typescriptLoader } from '../_shared/typescript-specifiers.js';
import { parseFacetBundleProfile, type FacetBundleProfile } from './bundle-profile.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type { ResolveContext } from '../substrate/lifo/commands/registry.js';
import { errorText } from '../_shared/error-text.js';
import { SinkWriter } from '../_shared/byte-stream.js';
import { isEsModuleFile, isEsModuleInput, typeScriptEntryRefused, typeScriptUnderNodeModules, type ModuleScope, type PackageType } from './module-format.js';
import type { TypeScriptStripOptions } from './typescript-strip.js';
import { nodeModulesRefusal, typeScriptRefusalShim, unknownExtensionRefusal } from './typescript-refusal.js';
import { packageScopeType } from './require-resolution.js';
import { exists, isDirectory } from '../vfs/vfs.js';
import { programLaunchesServer, SERVER_LAUNCH_MODULE_BYTES, type ServerIdentity, type ServerLaunchHost } from './server-launch.js';
import { parseNodeCommandLine, typeScriptStripOptions, type NodeCommandLine, type NodeLaunch } from './node-cli.js';
import { resolveRuntimeScriptPath } from './script-path.js';
import { evalProgram, evalScriptSource, nodeEvalInput, type EvalTypeScriptStrip } from './node-eval.js';

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
 * A program run as an npm bin (worker shell/npm-bin-entrypoints.ts): how its
 * process is shown, and hints to start it as a resident.
 */
export interface BinLaunch {
  command: string;
  attachedTty: boolean;
  /** A server by the hints (worker facets/server-hints.ts): resident without its code's analysis. */
  serves: boolean;
  server: ServerIdentity;
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
  /** The bin it runs, learned a server when it runs on as one (worker facets/server-hints.ts). */
  server?: ServerIdentity;
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
   * The program is an ES module (module-format.ts), or TypeScript or JSX the
   * launch compiles, which may be one: the runner imports the launch's
   * staged module of it, and what escapes its evaluation is explained as
   * Node's loader explains it.
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

export { resolveRuntimeScriptPath, type ScriptResolutionFs } from './script-path.js';

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
    check: false,
    version: flags.includes('-v') || flags.includes('--version'),
    help: flags.includes('--help') || flags.includes('-h'),
  };
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
      __nimbusBin?: BinLaunch;
      __nimbusBinSpawn?: {
        callerPid?: number;
        command?: string;
        forceLongRunning?: boolean;
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
    // A child-process broker or a launch wrapper may already own the process
    // entry; preserve it for eval/stdin programs as well as script files.
    const binSpawn = spec.supportsBinSpawn ? nimbusCtx.__nimbusBinSpawn : undefined;
    const bin = nimbusCtx.__nimbusBin;
    const command = binSpawn?.command || bin?.command;
    // fd 0 the same way: a pipe or redirect is the program's stdin. It used
    // to be dropped, so `echo hi | node x.js` read nothing. A process whose
    // live input channel already is that stdin reads the channel.
    const pipedStdin = binSpawn?.liveInput !== true && ctx.stdin && ctx.stdin !== ctx.terminalStdin && ctx.isFdTerminal?.(0) === false
      ? ctx.stdin : undefined;
    const reservedProcess = binSpawn ? {
      skipSpawn: true, callerPid: binSpawn.callerPid,
      // A bin's hints judge it, its launcher's reservation or not.
      forceLongRunning: binSpawn.forceLongRunning === true || bin?.serves === true,
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
    // resident process: a bin by its hints, a program by its code. A process
    // a launcher reserved is its launcher's to judge. One that listens
    // unforeseen runs on as a resident once it does.
    const launches = async (code: string, path: string | null, dir: string, programArgs: string[]): Promise<boolean> => {
      if (spec.routesServers !== true || binSpawn !== undefined) return false;
      if (bin) return bin.serves;
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
    const outputStreams = { stdout: new SinkWriter(ctx.stdout), stderr: new SinkWriter(ctx.stderr) };
    const programStdin: Pick<RuntimeRunOpts, 'stdin' | 'stdinFile' | 'output' | 'stdinPid'> = {
      ...(nimbusCtx.__nimbusBinSpawn?.liveInput ? { stdinPid: nimbusCtx.__nimbusBinSpawn.callerPid } : {}),
      output: nimbusCtx.__nimbusBinSpawn?.liveInput ? undefined : (stream, bytes) => outputStreams[stream].write(bytes),
      ...(pipedStdin === undefined ? (spec.bypassesScriptRead && ctx.stdin ? { stdin: ctx.stdin } : {})
      : pipedStdin.file
        ? { stdinFile: { path: pipedStdin.file.path, offset: pipedStdin.file.offset } }
        : { stdin: pipedStdin }),
    };
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
    const { programIndex: _programIndex, version: _version, help: _help, print, inputType, defaultType, ...launch } = line;
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
      stdin?: Pick<RuntimeRunOpts, 'stdin' | 'stdinFile' | 'output' | 'stdinPid'>;
      reserved?: boolean;
      launchesServer?: boolean;
      /** The code returns the value `node -p` prints (node-eval.ts): Node prints only an eval's, not a file's. */
      print?: boolean;
      /** Node refuses the code before it loads `--import`'s modules (NodeEvalProgram.refusedBeforeImports): none load. */
      refusedBeforeImports?: boolean;
      /** The code is Node's refusal of the file, run as -c's answer: it holds none of the program. */
      runsRefusal?: boolean;
      esModule?: boolean;
      /** The eval's TypeScript, as Node took it (NodeLaunch.evalTypeScript). */
      evalTypeScript?: NodeLaunch['evalTypeScript'];
    }): Promise<number> => {
      let result: RuntimeRunResult;
      try {
        result = await spec.run(code, {
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
          ...(spec.nodeCommandLine
            ? { node: { ...launch, print: program.print === true, ...(program.refusedBeforeImports ? { import: [] } : {}), ...(program.runsRefusal ? { check: false } : {}), ...(program.evalTypeScript ? { evalTypeScript: program.evalTypeScript } : {}) } }
            : {}),
          ...program.stdin,
          ...(program.reserved === false ? {} : reservedProcess),
          ...(bin ? { attachedTty: bin.attachedTty, server: bin.server } : {}),
          ...(captureOutput ? { captureOutput: true } : {}),
          ...(bundleProfile ? { bundleProfile } : {}),
          ...(program.launchesServer ? { launchesServer: true } : {}),
          ...(program.esModule ? { esModule: true } : {}),
          moduleScope,
        });
      } finally {
        // Flush a trailing incomplete character at the actual display edge,
        // including a runner that failed after publishing some output.
        await outputStreams.stdout.end();
        await outputStreams.stderr.end();
      }
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    };

    /**
     * A TypeScript entry as Node takes it: its types stripped, and whether
     * Node runs it as an ES module. A file Node refuses is code that throws
     * Node's error. Null when the strip failed otherwise, which it has reported.
     */
    async function stripTypeScriptEntry(
      code: string, path: string, packageType: PackageType, stripTypes: TypeScriptStripOptions, what: string,
    ): Promise<{ code: string; esModule: boolean } | null> {
      if (typeScriptUnderNodeModules(path)) return { code: typeScriptRefusalShim(nodeModulesRefusal('/' + path)), esModule: false };
      try {
        const [outcome] = await (await getEsbuild()).transformMany([{ code, options: { stripTypes, packageType, stripOnly: true, sourcefile: '/' + path } }]);
        if ('typescript' in outcome) return { code: typeScriptRefusalShim(outcome.typescript), esModule: false };
        if ('error' in outcome) throw new Error(outcome.error);
        return { code: outcome.code, esModule: outcome.esModule !== undefined };
      } catch (e) {
        ctx.stderr.write(`${name}: transform error for ${what}: ${errorText(e)}\n`);
        return null;
      }
    }

    /**
     * `-e` code or a program read from stdin as the process runs it: what
     * Node's eval runs, by `--input-type` and its TypeScript (node-eval.ts
     * nodeEvalInput), an ES module the launch stages as it stages every ES
     * module and `-p` refuses as Node does, else Node's eval code. Null when
     * a strip failed otherwise, which it has reported.
     */
    async function inputProgram(source: string, what: '[eval]' | '[stdin]'): Promise<{
      code: string; written: string; refusedBeforeImports: boolean; esModule: boolean; evalTypeScript?: NonNullable<NodeLaunch['evalTypeScript']>;
    } | null> {
      if (!spec.nodeCommandLine) {
        const esModule = isEsModuleInput(source, inputType) && !print;
        return { code: source, written: source, refusedBeforeImports: false, esModule };
      }
      const stripTypes = typeScriptStripOptions(launch);
      const strip: EvalTypeScriptStrip | null = stripTypes === 'javascript' ? null : async (code) => {
        const [outcome] = await (await getEsbuild()).transformMany([{ code, options: { stripTypes, stripOnly: true, sourcefile: '[eval]' } }]);
        if ('typescript' in outcome) return { refusal: outcome.typescript };
        if ('error' in outcome) throw new Error(outcome.error);
        return { code: outcome.code };
      };
      let input;
      try {
        input = await nodeEvalInput(source, what === '[eval]' ? evalScriptSource(source, print) : source, inputType, strip);
      } catch (e) {
        ctx.stderr.write(`${name}: transform error for ${what}: ${errorText(e)}\n`);
        return null;
      }
      const transforms = stripTypes !== 'javascript' && stripTypes.mode === 'transform';
      const sourceUrl = input.stripped && !transforms;
      // Node's warning is a next tick's, which a CommonJS eval's synchronous refusal ends the process before.
      const transformWarning = transforms && input.stripAttempted && input.refusal === undefined && (input.hint === undefined || input.esModule);
      const typeScript = sourceUrl || transformWarning || input.hint !== undefined
        ? { evalTypeScript: { sourceUrl, transformWarning, ...(input.hint !== undefined ? { hint: input.hint } : {}) } }
        : {};
      if (input.refusal !== undefined) {
        const code = typeScriptRefusalShim(input.refusal);
        return { code, written: input.code, refusedBeforeImports: true, esModule: false };
      }
      if (input.esModule && !print) return { code: input.code, written: input.code, refusedBeforeImports: false, esModule: true, ...typeScript };
      const prepared = evalProgram(input.code, print, input.mode);
      const refusedBeforeImports = prepared.refusedBeforeImports || input.refusedBeforeImports === true;
      return { ...prepared, refusedBeforeImports, written: prepared.code, esModule: false, ...typeScript };
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

    // ── What this node does not take ──
    // Nimbus decides a module's format as Node 22 does without the option.
    if (defaultType !== undefined) {
      ctx.stderr.write('node: --experimental-default-type is not supported by this node\n');
      return 9;
    }
    // -c compiles a CommonJS program without running it (check_syntax.js); an
    // ES module cannot be compiled here without being evaluated.
    const refuseModuleCheck = (): number => {
      ctx.stderr.write('node: -c cannot check an ES module entry in Nimbus without running it\n');
      return 9;
    };

    // ── -e / --eval, and -p / --print ──
    // Node's eval code as Node prepares it (node-eval.ts); `-p`'s returns
    // the value the process prints when it exits.
    if (line.eval !== undefined) {
      const input = await inputProgram(line.eval, '[eval]');
      if (input === null) return 1;
      const { code, written, refusedBeforeImports, esModule, evalTypeScript } = input;
      const programArgs = args.slice(flagSpan);
      return runProgram(code, {
        print,
        refusedBeforeImports,
        esModule,
        evalTypeScript,
        argv: programArgs,
        filename: '<eval>',
        dirname: ctx.cwd || '/home/user',
        command: command || `${name} -e ...`,
        stdin: programStdin,
        launchesServer: await launches(written, null, ctx.cwd || '/home/user', programArgs),
      });
    }

    // ── script path (or .wasm path for bypassesScriptRead) ──
    const scriptIdx = flagSpan;
    // No script: the REPL at a terminal, otherwise the program is stdin, as
    // Node decides between them by whether stdin is a TTY.
    const terminalInput = ctx.terminalStdin !== undefined && (ctx.stdin === undefined || ctx.stdin === ctx.terminalStdin) && ctx.isFdTerminal?.(0) !== false;
    if (args[scriptIdx] === undefined && spec.repl !== undefined && terminalInput && ctx.terminalStdin && !launch.check) {
      // The REPL takes Ctrl-C as input, as Node's readline does: the
      // terminal's signal keys are off while it runs (termios ISIG).
      const terminal = ctx.terminalStdin;
      terminal.signalKeys = false;
      try {
        return await runProgram(spec.repl, {
          argv: leadingFlags,
          filename: '<repl>',
          dirname: ctx.cwd || '/home/user',
          command: command || name,
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
      // -c checks stdin as CommonJS, whatever its syntax, unless --input-type says module (check_syntax.js).
      if (launch.check) {
        if (inputType === 'module') return refuseModuleCheck();
        return runProgram(input, {
          argv: [...leadingFlags, '-', ...args.slice(scriptIdx + 1)],
          filename: '[stdin]',
          dirname: ctx.cwd || '/home/user',
          command: command || `${name} -`,
          stdin: { output: programStdin.output },
        });
      }
      // `-p` prints the value of the code it read (eval_stdin.js).
      const program = await inputProgram(input, '[stdin]');
      if (program === null) return 1;
      const { code, written, refusedBeforeImports, esModule, evalTypeScript } = program;
      return runProgram(code, {
        print,
        refusedBeforeImports,
        esModule,
        evalTypeScript,
        argv: [...leadingFlags, '-', ...args.slice(scriptIdx + 1)],
        filename: '[stdin]',
        dirname: ctx.cwd || '/home/user',
        command: command || `${name} -`,
        stdin: { output: programStdin.output },
        launchesServer: await launches(written, null, ctx.cwd || '/home/user', ['-', ...args.slice(scriptIdx + 1)]),
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

    // Shebang strip (primitive #1): its line stays, empty, so every line and
    // column is the file's own, as Node reports them.
    if (code.startsWith('#!')) {
      const nl = code.indexOf('\n');
      code = nl >= 0 ? code.substring(nl) : '';
    }

    // ── Module format ──
    //
    // An entry Node runs as an ES module is the launch's staged module of it
    // (native-esm.ts), else a CommonJS module body
    // (core/_shared/commonjs-cell.ts), decided as a real `node script.js`
    // decides (module-format.ts isEsModuleFile):
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
    const scriptExt = vfsPathExtension(resolvedPath);
    // The package scope's "type", through the resolver's own lookup.
    const packageType = scriptExt === '.js' || scriptExt === '' || stripsTypeScript(resolvedPath)
      ? await packageScopeType({
        exists: (path) => fs.exists(path),
        isDirectory: (path) => isDirectory(fs, path),
        readFileString: (path) => fs.readFileString(path),
        stat: (path) => fs.stat(path),
      }, resolvedPath.slice(0, Math.max(0, resolvedPath.lastIndexOf('/'))))
      : null;
    // -c of TypeScript, a declaration file's too: Node compiles its own text as CommonJS
    // (check_syntax.js: its format is never 'module'), or, stripping off, refuses its extension.
    const checksTypeScript = launch.check && typescriptLoader(resolvedPath) === 'ts';
    // Node's own TypeScript is stripped, then JavaScript of Node's format for it.
    const stripTypes = spec.nodeCommandLine && moduleScope === 'node' && stripsTypeScript(resolvedPath) && !launch.check ? typeScriptStripOptions(launch) : null;
    let stripped: { code: string; esModule: boolean } | null = null;
    if (stripTypes === 'javascript') {
      const refused = typeScriptEntryRefused(packageType, code, launch.import.length > 0);
      stripped = { code: refused ? typeScriptRefusalShim(unknownExtensionRefusal('/' + resolvedPath)) : code, esModule: false };
    } else if (stripTypes !== null) {
      stripped = await stripTypeScriptEntry(code, resolvedPath, packageType, stripTypes, scriptPath);
      if (stripped === null) return 1;
    }
    if (stripped !== null) code = stripped.code;
    // TypeScript by the same table the bundle's ESM pass reads.
    const typescript = stripped === null ? typescriptLoader(resolvedPath) : null;

    // An ES module, or TypeScript or JSX the launch compiles, is the launch's
    // staged module of the entry file (worker facets/manager.ts entryModule):
    // the program's own module, never a copy of it.
    const esm = checksTypeScript
      ? false
      : stripped === null
        ? typescript !== null || scriptExt === '.jsx' || isEsModuleFile(resolvedPath, code, () => packageType)
        : stripped.esModule;
    if (launch.check && esm) return refuseModuleCheck();

    const filename = '/' + resolvedPath;
    const dirname = filename.includes('/')
      ? filename.substring(0, filename.lastIndexOf('/'))
      : '/';
    const refusesExtension = checksTypeScript && launch.stripTypes === false;
    return runProgram(refusesExtension ? typeScriptRefusalShim(unknownExtensionRefusal(filename)) : code, {
      ...(refusesExtension ? { runsRefusal: true } : {}),
      esModule: esm,
      argv: [...leadingFlags, filename, ...args.slice(scriptIdx + 1)],
      filename,
      dirname,
      command: command || `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
      stdin: programStdin,
      launchesServer: !launch.check && await launches(code, resolvedPath, dirname, [filename, ...args.slice(scriptIdx + 1)]),
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
