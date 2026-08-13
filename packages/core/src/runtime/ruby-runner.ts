/**
 * ruby-runner.ts — ruby.wasm (Ruby 3.3.x) runner.
 *
 * Mirror of python-runner.ts patterns adapted to Ruby's wasi-vfs +
 * canonical-abi binding. v1 scope:
 *   - `ruby --version` / `ruby -e '<code>'` / `ruby <file.rb>`
 *   - stdout/stderr → the process supervisor's log ring (Process tab integration)
 *   - exit code via `exit N` / unhandled exception → 1
 *   - argv passed through to ARGV; $PROGRAM_NAME / $0 set
 *   - stdlib loaded from the packed wasi-vfs inside the wasm
 *   - compatible pure Ruby gems through Nimbus RubyGems
 *   - WEBrick/Rack-style preview through Nimbus virtual sockets
 *
 * Out of v1:
 *   - native extension gems
 *
 * `ruby` with no args is handled by the session-level ruby-repl wrapper;
 * this file owns args-bearing Ruby execution and Ruby package commands.
 *
 * Architecture: the interpreter runs in a FACET (runtime/facet-host.ts), and
 * ruby+stdlib.wasm reaches it as a `wasmModules` entry the HOST compiles —
 * because on workerd nothing else may. Per-user-VFS path:
 * ~/.nimbus/runtimes/ruby/3.3.4/share/ruby/.
 *
 * Two things follow from that being a port rather than a Durable Object, and
 * they are the whole of what is host-specific here:
 *   - the seed is whatever `seedFilesystem` returned — a manifest the facet
 *     demand-loads against where a guest can be parked mid-syscall, the bytes
 *     themselves where it cannot. Nothing below branches on which it got.
 *   - a program that keeps serving needs an actor to hold it, which is
 *     {@link RubyResidentStart}: supplied on Cloudflare, absent elsewhere, and
 *     where it is absent such a program is refused by name.
 *
 *   - Wasm size 34.3 MiB (well under empirical 32 MiB-ish per-call
 *     ceiling we cleared with Pyodide + clang).
 *   - 35 wasi_snapshot_preview1 imports (provided by wasi-instance.ts).
 *   - 21 rb-js-abi-host imports (implemented for the `js` bridge used
 *     by the Ruby socket adapter).
 *   - 3 canonical_abi imports (resource lifecycle — implemented as
 *     a minimal Slab<number,object>).
 *   - Exports: _initialize, __wasi_vfs_rt_init, ruby-init,
 *     ruby-init-loadpath, rb-eval-string-protect, cabi_realloc,
 *     canonical_abi_drop_rb-abi-value, memory.
 */

import type { RuntimeManifest } from './runtime-manifest.js';
import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import { z } from 'zod';
import { hasLeadingCliFlag } from './cli-flags.js';
import type { FacetHost } from './facet-host.js';
import { CRED_KERNEL, requireVfsCred } from './os-contracts.js';
import { WASI_INSTANCE_PREAMBLE_SRC, type WasiFsSnapshot } from './wasi-instance.js';
import { resolveVfsPath } from '../vfs/path.js';
import { RUBY_SOCKET_SHIM } from './ruby-socket-shim.js';
import { RUBY_GREEN_THREADS } from './ruby-green-threads.js';
import {
  defaultGemHome,
  installRubyBundle,
  installRubyGems,
  installedGemBins,
  installedGemLibRoots,
  parseRubyGemRequirements,
  type RubyGemRequest,
} from './ruby-gems.js';

const RUBY_RUNTIME_BIN_NAMES = new Set(['ruby', 'ruby3', 'gem', 'bundle', 'bundler']);
const RUBY_VERSION_FLAGS = new Set(['--version', '-v']);

type RubyRunnerFactory = (
  manifest: RuntimeManifest,
  installRoot: string,
  binName: string,
  binKind: string | undefined,
) => Command;

/**
 * Build the ruby-runner factory. Called once at session init; the
 * returned factory binds the manifest + install root for each
 * registered entrypoint (`ruby`, `ruby3`).
 */
export function makeRubyRunnerFactory(deps: {
  facets: FacetHost;
  vfs: SqliteVFS;
  registry?: {
    register(name: string, handler: Command): void;
    resolve?(name: string): Promise<Command | null | undefined> | Command | null | undefined;
  };
  /** Where a program that keeps serving goes. See {@link RubyResidentStart}. */
  startResident?: RubyResidentStart;
}): RubyRunnerFactory {
  const { registry } = deps;

  return function rubyRunnerFactory(manifest, installRoot, binName, binKind) {
    const findFile = (rel: string): string | null => {
      const entry = manifest.files.find((f) => f.path === rel);
      return entry ? `${installRoot}/${entry.path}` : null;
    };
    const wasmVfs = findFile('share/ruby/ruby+stdlib.wasm');
    let fsSnapshotCache:
      { cred: string; cwd: string; revision: number; result: ReturnType<FacetHost['seedFilesystem']> } | null = null;

    const registerGemBins = (vfs: CredentialedVfs): void => {
      if (!registry) return;
      for (const bin of installedGemBins(vfs, defaultGemHome())) {
        if (RUBY_RUNTIME_BIN_NAMES.has(bin.name)) continue;
        registry.register(bin.name, async (ctx: CommandContext) => {
          const args = [bin.path.startsWith('/') ? bin.path : '/' + bin.path, ...(ctx.args ?? [])];
          const ruby = typeof registry.resolve === 'function' ? await registry.resolve('ruby') : null;
          if (!ruby) {
            ctx.stderr.write(`${bin.name}: Ruby runtime is not registered\n`);
            return 127;
          }
          return ruby({ ...ctx, args });
        });
      }
    };

    const rubyBinHandler = async function rubyBinHandler(ctx: CommandContext): Promise<number> {
      const cred = requireVfsCred('cred' in ctx ? ctx.cred : undefined, binName);
      const credKey = `${cred.uid}:${cred.gid}:${cred.groups.join(',')}`;
      const vfs = deps.vfs.as(cred);
      const argv = ctx.args ?? [];
      const cwd = ctx.cwd || '/home/user';

      const packageCommand = await maybeHandleRubyPackageCommand(binKind, binName, argv, cwd, vfs, ctx);
      if (packageCommand.handled) {
        if (packageCommand.exitCode === 0) registerGemBins(vfs);
        return packageCommand.exitCode;
      }

      const toolInvocation = buildRubyToolInvocation(binKind, binName, argv);
      if (toolInvocation.error) {
        ctx.stderr.write(`${binName}: ${toolInvocation.error}\n`);
        return toolInvocation.exitCode;
      }

      // --version / --help fast paths (no wasm boot).
      if (toolInvocation.mode !== 'tool' && hasLeadingCliFlag(argv, RUBY_VERSION_FLAGS)) {
        ctx.stdout.write(`ruby 3.3.3 (ruby.wasm, Nimbus runtime) [wasm32-wasi]\n`);
        return 0;
      }
      if (toolInvocation.mode !== 'tool' && (argv.includes('--help') || argv.includes('-h'))) {
        ctx.stdout.write(`Usage: ${binName} [switches] [--] [programfile] [arguments]\n`);
        ctx.stdout.write(`Nimbus Ruby runtime (ruby.wasm).\n`);
        ctx.stdout.write(`Supported: -e <code>, <file.rb>, -r <lib>, VFS-backed require_relative and file IO\n`);
        ctx.stdout.write(`WEBrick/Rack preview uses Nimbus virtual sockets; native extension gems are rejected with a precise diagnostic.\n`);
        return 0;
      }

      // Resolve install bytes.
      if (!wasmVfs || !vfs.exists(wasmVfs)) {
        ctx.stderr.write(`${binName}: ruby+stdlib.wasm missing (re-run 'nimbus install ruby')\n`);
        return 127;
      }
      const wasmBytes = vfs.readFile(wasmVfs);

      // Parse argv.
      const parsed = toolInvocation.mode === 'tool'
        ? {
            mode: 'inline' as const,
            inlineCode: toolInvocation.code,
            scriptPath: '',
            scriptArgs: [],
            requires: [],
            exitCode: 0,
          }
        : parseRubyArgv(argv);
      if (parsed.error) {
        ctx.stderr.write(`${binName}: ${parsed.error}\n`);
        return parsed.exitCode;
      }

      // Build user program text + ARGV per mode.
      let userCode = '';
      let progName = binName;
      let rbArgv: string[] = [binName];
      if (parsed.mode === 'inline') {
        userCode = parsed.inlineCode;
        progName = '-e';
        rbArgv = ['-e', ...parsed.scriptArgs];
      } else if (parsed.mode === 'script') {
        const absPath = resolveVfsPath(parsed.scriptPath, cwd);
        try {
          if (!vfs.exists(absPath)) {
            ctx.stderr.write(`${binName}: No such file or directory -- ${parsed.scriptPath} (LoadError)\n`);
            return 1;
          }
          userCode = new TextDecoder('utf-8').decode(vfs.readFile(absPath));
        } catch (e: unknown) {
          ctx.stderr.write(`${binName}: ${parsed.scriptPath}: ${errorMessage(e)}\n`);
          return 1;
        }
        progName = parsed.scriptPath;
        rbArgv = [parsed.scriptPath, ...parsed.scriptArgs];
      }

      // -r flags add prelude `require '<lib>'` lines (stdlib only).
      const preludeRequires = parsed.requires.map((r) => `require ${JSON.stringify(r)}`).join('\n');
      if (preludeRequires) {
        userCode = preludeRequires + '\n' + userCode;
      }

      const userEnv: Record<string, string> = { ...(ctx.env || {}) };
      if (!userEnv.HOME) userEnv.HOME = '/home/user';
      if (!userEnv.LANG) userEnv.LANG = 'C.UTF-8';
      userEnv.GEM_HOME ||= '/' + defaultGemHome();
      userEnv.GEM_PATH ||= userEnv.GEM_HOME;
      userEnv.NIMBUS_GEM_LIBS = installedGemLibRoots(vfs, defaultGemHome()).join(':');
      // Ruby looks for charset hints via these vars; set sensible
      // defaults so puts of non-ASCII strings doesn't trip on the
      // wasi default of "ASCII-8BIT".
      if (!userEnv.LC_ALL) userEnv.LC_ALL = 'C.UTF-8';

      // Per-subtree watermark over exactly what the snapshot covers (cwd +
      // gem home), so unrelated VFS writes don't evict the cache.
      const revision = Math.max(vfs.revision(cwd), vfs.revision(defaultGemHome()));
      let fsSnapshot = fsSnapshotCache && fsSnapshotCache.cred === credKey
        && fsSnapshotCache.cwd === cwd && fsSnapshotCache.revision === revision
        ? fsSnapshotCache.result
        : null;
      if (!fsSnapshot) {
        // The host decides what a seed IS: a manifest whose entries the facet
        // demand-loads through its supervisor, or the bytes themselves. Which
        // one follows from whether that host can park a guest mid-syscall, and
        // nothing here depends on the answer.
        fsSnapshot = deps.facets.seedFilesystem(vfs, cwd, {
          extraRoots: [defaultGemHome()],
          revision,
        });
        fsSnapshotCache = { cred: credKey, cwd, revision, result: fsSnapshot };
      }
      if ('error' in fsSnapshot) {
        ctx.stderr.write(`${binName}: ${fsSnapshot.error}\n`);
        return 1;
      }

      const facetArgs = {
        wasmBytes,
        wasmVfsPath: wasmVfs,
        userCode,
        rbArgv,
        userEnv,
        progName,
        cwd,
        fsSnapshot: fsSnapshot.snapshot,
      };

      let result: RubyFacetResult;
      if (needsResidentProcess(parsed)) {
        if (!deps.startResident) {
          ctx.stderr.write(
            `${binName}: this program keeps running after it starts, and this host has no `
            + 'process substrate to keep it on\n',
          );
          return 1;
        }
        result = await deps.startResident({
          wasmVfsPath: facetArgs.wasmVfsPath,
          startArgs: toRubyCallArgs(facetArgs),
          cwd,
          command: formatRubyCommand(binName, argv),
        });
      } else {
        result = await dispatchRubyFacet(deps.facets, vfs, facetArgs, ctx.pid);
      }

      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      if (result.error) {
        ctx.stderr.write(`${binName}: ${result.error}\n`);
        return 1;
      }
      return result.exitCode;
    };

    registerGemBins(deps.vfs.as(CRED_KERNEL));
    return rubyBinHandler;
  };
}

interface RubyToolInvocation {
  mode: 'tool' | 'none';
  code: string;
  error?: string;
  exitCode: number;
}

async function maybeHandleRubyPackageCommand(
  binKind: string | undefined,
  binName: string,
  argv: string[],
  cwd: string,
  vfs: CredentialedVfs,
  ctx: CommandContext,
): Promise<{ handled: boolean; exitCode: number }> {
  const isGem = binKind === 'gem' || binName === 'gem';
  const isBundle = binKind === 'bundle' || binName === 'bundle' || binName === 'bundler';

  if (isGem && argv[0] === 'install') {
    const parsed = parseGemInstallArgs(argv.slice(1));
    if (parsed.error) {
      ctx.stderr.write(`gem install: ${parsed.error}\n`);
      return { handled: true, exitCode: 2 };
    }
    try {
      const report = await installRubyGems(vfs, parsed.requests, { gemHome: defaultGemHome(), includeDependencies: true });
      for (const name of report.installed) ctx.stdout.write(`Successfully installed ${name}\n`);
      for (const name of report.alreadyInstalled) ctx.stdout.write(`${name} is already installed\n`);
      ctx.stdout.write(`${report.installed.length + report.alreadyInstalled.length} gem(s) processed\n`);
      return { handled: true, exitCode: 0 };
    } catch (e: unknown) {
      ctx.stderr.write(`gem install: ${errorMessage(e)}\n`);
      return { handled: true, exitCode: 1 };
    }
  }

  if (isBundle && argv[0] === 'install') {
    try {
      const { requests, report, lockfilePath } = await installRubyBundle(vfs, cwd, { gemHome: defaultGemHome() });
      for (const name of report.installed) ctx.stdout.write(`Successfully installed ${name}\n`);
      for (const name of report.alreadyInstalled) ctx.stdout.write(`${name} is already installed\n`);
      ctx.stdout.write(`Bundle complete! ${requests.length} Gemfile dependency(s), ${report.installed.length + report.alreadyInstalled.length} gem(s) now installed.\n`);
      ctx.stdout.write(`Bundled lockfile written to /${lockfilePath}\n`);
      return { handled: true, exitCode: 0 };
    } catch (e: unknown) {
      ctx.stderr.write(`bundle install: ${errorMessage(e)}\n`);
      return { handled: true, exitCode: 1 };
    }
  }

  return { handled: false, exitCode: 0 };
}

function parseGemInstallArgs(argv: string[]): { requests: RubyGemRequest[]; error?: string } {
  const names: string[] = [];
  let versionRequirement: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-v' || arg === '--version') {
      const version = argv[i + 1];
      if (!version) return { requests: [], error: `${arg}: missing version` };
      versionRequirement = version;
      i++;
      continue;
    }
    if (arg.startsWith('--version=')) {
      versionRequirement = arg.slice('--version='.length);
      continue;
    }
    if (arg === '--no-document' || arg === '--no-doc' || arg === '--user-install') {
      continue;
    }
    if (arg.startsWith('-')) {
      return { requests: [], error: `option '${arg}' is not supported in Nimbus yet` };
    }
    names.push(arg);
  }
  const requirements = versionRequirement ? parseRubyGemRequirements(versionRequirement) : [];
  const requests = names.map((name) => ({ name, requirements }));
  if (requests.length === 0) return { requests, error: 'missing gem name' };
  return { requests };
}

function buildRubyToolInvocation(
  binKind: string | undefined,
  binName: string,
  argv: string[],
): RubyToolInvocation {
  const isGem = binKind === 'gem' || binName === 'gem';
  const isBundle = binKind === 'bundle' || binName === 'bundle' || binName === 'bundler';
  if (!isGem && !isBundle) return { mode: 'none', code: '', exitCode: 0 };

  if (isGem) {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      return {
        mode: 'tool',
        code: [
          'puts "Usage: gem --version"',
          'puts "       gem env"',
          'puts "       gem install <name>  # installs pure Ruby gems through Nimbus RubyGems"',
        ].join('\n'),
        exitCode: 0,
      };
    }
    if (argv.includes('--version') || argv[0] === '-v') {
      return { mode: 'tool', code: 'require "rubygems"; puts Gem::VERSION', exitCode: 0 };
    }
    if (argv[0] === 'env') {
      return {
        mode: 'tool',
        code: [
          'require "rubygems"',
          'puts "RubyGems #{Gem::VERSION}"',
          'puts "Ruby #{RUBY_VERSION} (#{RUBY_PLATFORM})"',
          'puts "GEM_HOME=#{ENV["GEM_HOME"] || File.join(ENV["HOME"], ".gem")}"',
          'puts "GEM_PATH=#{ENV["GEM_PATH"] || ENV["GEM_HOME"]}"',
        ].join('\n'),
        exitCode: 0,
      };
    }
    if (argv[0] === 'install') {
      return {
        mode: 'none',
        code: '',
        error: 'gem install command was not handled by Nimbus RubyGems',
        exitCode: 1,
      };
    }
    return {
      mode: 'none',
      code: '',
      error: `gem subcommand '${argv[0]}' is not supported yet`,
      exitCode: 2,
    };
  }

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return {
      mode: 'tool',
      code: [
        'puts "Usage: bundle --version"',
        'puts "       bundle install  # installs compatible pure Ruby gems through Nimbus RubyGems"',
      ].join('\n'),
      exitCode: 0,
    };
  }
  if (argv.includes('--version') || argv[0] === '-v') {
    return {
      mode: 'tool',
      code: [
        'begin',
        '  require "bundler"',
        '  puts "Bundler #{Bundler::VERSION}"',
        'rescue LoadError',
        '  warn "Bundler is not bundled in this ruby.wasm runtime"',
        '  exit 127',
        'end',
      ].join('\n'),
      exitCode: 0,
    };
  }
  if (argv[0] === 'install') {
    return {
      mode: 'none',
      code: '',
      error: 'bundle install command was not handled by Nimbus RubyGems',
      exitCode: 1,
    };
  }
  return {
    mode: 'none',
    code: '',
    error: `bundle subcommand '${argv[0]}' is not supported yet`,
    exitCode: 2,
  };
}

// ── argv parser ──────────────────────────────────────────────────────

interface ParsedRbArgv {
  mode: 'inline' | 'script';
  inlineCode: string;
  scriptPath: string;
  scriptArgs: string[];
  requires: string[];
  error?: string;
  exitCode: number;
}

function parseRubyArgv(argv: string[]): ParsedRbArgv {
  // Ruby's CLI is rich; v1 handles -e, -r, and positional script.
  const requires: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-e') {
      const code = argv[i + 1];
      if (code === undefined) {
        return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
          requires, exitCode: 2, error: "no code specified for -e (RuntimeError)" };
      }
      // -e <code> [args...]  — code into program, rest into ARGV.
      // Note: Ruby allows multiple -e; concatenated with \n.
      let concat = code;
      let j = i + 2;
      while (j < argv.length && argv[j] === '-e') {
        const more = argv[j + 1];
        if (more === undefined) {
          return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
            requires, exitCode: 2, error: "no code specified for -e (RuntimeError)" };
        }
        concat = concat + '\n' + more;
        j += 2;
      }
      return {
        mode: 'inline',
        inlineCode: concat,
        scriptPath: '',
        scriptArgs: argv.slice(j),
        requires,
        exitCode: 0,
      };
    }
    if (a === '-r') {
      const lib = argv[i + 1];
      if (lib === undefined) {
        return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
          requires, exitCode: 2, error: "missing argument for -r" };
      }
      requires.push(lib);
      i += 2;
      continue;
    }
    if (a.startsWith('-r') && a.length > 2) {
      // -rjson form (no space).
      requires.push(a.slice(2));
      i++;
      continue;
    }
    if (!a.startsWith('-')) {
      return {
        mode: 'script',
        inlineCode: '',
        scriptPath: a,
        scriptArgs: argv.slice(i + 1),
        requires,
        exitCode: 0,
      };
    }
    // Unknown flag — v1 silently ignores common harmless ones, errors on others.
    if (/^-[wWdEKUI]+$/.test(a)) { i++; continue; }
    if (a === '--disable-gems' || a === '--enable-gems') { i++; continue; }
    return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
      requires, exitCode: 2, error: `invalid option: ${a}` };
  }
  return { mode: 'inline', inlineCode: '', scriptPath: '', scriptArgs: [],
    requires, exitCode: 2, error: "REPL not supported in v1. Use 'ruby -e \"code\"' or 'ruby script.rb'." };
}

/**
 * Which process shape this invocation needs - and NOTHING else. Both shapes
 * run the same language: threads, queues and the socket classes come from the
 * VM preamble, so what is decided here is how long the process lives, not what
 * Ruby the program gets.
 *
 * A script is a program and gets a process that can outlive the command. A
 * one-liner is an expression and is answered from the pooled VM, which is an
 * order of magnitude faster (measured: 101ms against 1355ms) and cannot hold a
 * port open afterwards. The requires listed here are the ways a one-liner asks
 * for a server anyway - `ruby -run -e httpd` is the built-in one. When the
 * guess is wrong the program still gets a straight answer, because binding a
 * port without a process to hold it says exactly that.
 */
function needsResidentProcess(parsed: ParsedRbArgv): boolean {
  if (parsed.mode === 'script') return true;
  return parsed.requires.some((name) => {
    const root = name.split('/', 1)[0];
    return root === 'socket' || root === 'webrick' || root === 'rackup' || root === 'un';
  });
}

function formatRubyCommand(binName: string, argv: string[]): string {
  return [binName, ...argv].map((part) => {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(part)) return part;
    return JSON.stringify(part);
  }).join(' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

// ── Facet dispatch ───────────────────────────────────────────────────

interface RubyFacetArgs {
  /** Interpreter+stdlib image bytes, for the facet that answers in place. */
  wasmBytes: Uint8Array;
  /** Where that image lives, for a resident process whose host resolves it itself. */
  wasmVfsPath: string;
  userCode: string;
  rbArgv: string[];
  userEnv: Record<string, string>;
  progName: string;
  cwd: string;
  fsSnapshot: WasiFsSnapshot;
}

/** What one invocation hands the VM. Identical for both process shapes. */
export interface RubyFacetCallArgs {
  userCode: string;
  rbArgv: string[];
  userEnv: Record<string, string>;
  progName: string;
  cwd: string;
  fsSnapshot: WasiFsSnapshot;
}

export interface RubyFacetResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Start a program that outlives the invocation, and report where it went.
 *
 * A separate dependency rather than a branch, for the reason CPython's is
 * ({@link ./cpython-runner.ts}): a resident process is a property of the
 * DEPLOYMENT, not of Ruby. It needs a substrate that keeps an actor alive
 * between requests and routes inbound HTTP into it, and a host with none gets
 * no degraded version — it gets none, and says so.
 */
export type RubyResidentStart = (spawn: {
  /** VFS path of the interpreter. By path, not by value: it is 34.3 MiB. */
  wasmVfsPath: string;
  startArgs: RubyFacetCallArgs;
  cwd: string;
  command: string;
}) => Promise<RubyFacetResult>;

const RubyFacetResultSchema = z.object({
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

/**
 * A facet's answer, checked at the trust boundary. Exported for the resident
 * substrate, whose boot payload carries the same object from the same VM.
 */
export function normalizeRubyFacetResult(raw: unknown): RubyFacetResult | null {
  const parsed = RubyFacetResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    exitCode: Number(parsed.data.exitCode || 0),
    stdout: parsed.data.stdout || '',
    stderr: parsed.data.stderr || '',
    error: parsed.data.error,
  };
}

/** The per-call payload, from the invocation's own state. */
function toRubyCallArgs(args: RubyFacetArgs): RubyFacetCallArgs {
  return {
    userCode: args.userCode,
    rbArgv: args.rbArgv,
    userEnv: args.userEnv,
    progName: args.progName,
    cwd: args.cwd,
    fsSnapshot: args.fsSnapshot,
  };
}

async function dispatchRubyFacet(
  facets: FacetHost,
  vfs: CredentialedVfs,
  args: RubyFacetArgs,
  pid: number,
): Promise<RubyFacetResult> {
  // The Ruby preamble runs the entire bootstrap in the facet's own scope,
  // before any function is submitted: the wasm Module is instantiated where
  // the host permits it, _initialize + __wasi_vfs_rt_init run, and the live
  // instance stays in that scope for every later call.
  //
  // The preamble also includes WASI_INSTANCE_PREAMBLE_SRC so
  // __wasiMakeImports / __wasiInitFS / __wasiRunStart are in scope.
  const facet = facets.open({
    tag: 'ruby-runner',
    concurrency: 1,
    // Never absent. The supervisor derives the write credential from the pid,
    // so a facet given the capability without one has a filesystem it can read
    // and never write — every write-back rejected as an unauthorized process.
    syscalls: { vfs, pid },
    preamble: buildRubyPreamble(),
  });

  const facetFn = async function rubyFacetCall(
    inArgs: RubyFacetCallArgs,
    facetEnv: { SUPERVISOR?: unknown },
  ): Promise<unknown> {
    const fn = Reflect.get(globalThis, '__rubyRun');
    if (typeof fn !== 'function') {
      return { exitCode: 127, stdout: '', stderr: '',
        error: 'ruby-runner preamble missing: __rubyRun not in scope' };
    }
    const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor') as
      ((s: unknown) => void) | undefined;
    const drain = Reflect.get(globalThis, '__wasiDrainPersist') as
      (() => Promise<void>) | undefined;
    const supervisor = facetEnv && facetEnv.SUPERVISOR;
    // Published where __rubyRun re-adopts it after the mount; adopting only
    // here would be undone by __wasiInitFS.
    if (supervisor) Reflect.set(globalThis, '__nimbusRubySupervisor', supervisor);
    adopt?.(supervisor);
    try {
      return await fn({
        userCode: inArgs.userCode,
        rbArgv: inArgs.rbArgv,
        userEnv: inArgs.userEnv,
        progName: inArgs.progName,
        cwd: inArgs.cwd,
        fsSnapshot: inArgs.fsSnapshot,
      });
    } finally {
      // Even on a raised Ruby exception the writes that already happened are
      // the user's data, so the drain is in `finally`, not the success path.
      await drain?.();
    }
  };

  try {
    const rawResult = await facet.submit<RubyFacetCallArgs, unknown>(facetFn, toRubyCallArgs(args), {
      wasmModules: {
        'ruby+stdlib.wasm': toArrayBuffer(args.wasmBytes),
      },
      timeoutMs: 300_000,
    });
    return normalizeRubyFacetResult(rawResult) || {
      exitCode: 1,
      stdout: '',
      stderr: '',
      error: 'ruby-runner dispatch returned an invalid payload',
    };
  } catch (e: unknown) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: '',
      error: `ruby-runner dispatch failed: ${errorMessage(e)}`,
    };
  } finally {
    facet.dispose();
  }
}

/**
 * Compose the facet preamble. It is evaluated once in the facet's scope,
 * instantiates ruby+stdlib.wasm from the module the host compiled, and
 * bootstraps the Ruby VM. Per-call __rubyRun then drives
 * `rb-eval-string-protect` for each invocation.
 *
 * Exported because the resident-process substrate composes the same source
 * into its own worker module: a server and a `ruby -e` one-liner are the same
 * language, and a second hand-rolled copy of this is how ruby-repl once booted
 * a VM whose language prelude was missing.
 */
export function buildRubyPreamble(): string {
  return [
    '// ── WASI shim preamble (wasi-instance.ts) ─────────────────────',
    WASI_INSTANCE_PREAMBLE_SRC,
    '',
    '// ── Ruby language prelude ─────────────────────────────────────',
    '// Green threads and the socket classes, evaluated once with the rest of',
    '// VM startup. It lives in the shared preamble so BOTH process shapes get',
    '// it from the same place: a resident server and a one-shot `ruby -e` are',
    '// the same language, and only differ in how long the process lives.',
    `const RUBY_LANGUAGE_PRELUDE = ${JSON.stringify(`${RUBY_GREEN_THREADS}\n${RUBY_SOCKET_SHIM}`)};`,
    '',
    '// ── FinalizationRegistry shim ─────────────────────────────────',
    '// Ruby ABI guest uses FinalizationRegistry for resource cleanup.',
    '// workerd does not always expose it (compat-flag gated). Same',
    '// no-op pattern as python-runner v2 — leaky but acceptable for',
    '// per-call facet lifetime (each invocation spawns a fresh facet).',
    'if (typeof globalThis.FinalizationRegistry === "undefined") {',
    '  globalThis.FinalizationRegistry = class FinalizationRegistry {',
    '    constructor(_cleanup) {}',
    '    register(_target, _heldValue, _token) {}',
    '    unregister(_token) {}',
    '  };',
    '}',
    '',
    RUBY_RUNNER_PREAMBLE_TAIL,
  ].join('\n');
}

/**
 * The Ruby-specific portion of the preamble. Wires the wasm imports
 * (wasi_snapshot_preview1 from __wasiMakeImports, canonical_abi from a
 * tiny Slab implementation, rb-js-abi-host for the `js` bridge),
 * instantiates the wasm Module from __NIMBUS_WASM at module-init, and
 * runs Ruby's bootstrap sequence.
 *
 * Per-call __rubyRun then mutates WASI argv/env, clears the stdout/
 * stderr capture buffers, and invokes rb-eval-string-protect with a
 * wrapper that captures SystemExit to extract the exit code.
 */
export const RUBY_RUNNER_PREAMBLE_TAIL = `
// ── BEGIN: ruby-runner preamble (Ruby 3.3.4, Nimbus v1) ─────────────

// Capture buffers shared across the bootstrap and per-call paths. The
// preamble's WASI imports route fd_write stdout/stderr into these via
// __wasiMakeImports({stdoutWrite, stderrWrite}). Per-call __rubyRun
// slices from these to isolate output per invocation.
globalThis.__nimbusRubyStdout = globalThis.__nimbusRubyStdout || [];
globalThis.__nimbusRubyStderr = globalThis.__nimbusRubyStderr || [];

// Whether this facet can suspend the VM mid-syscall, asked of the engine
// rather than passed in: the answer is a property of where this scope was
// built, and the scope is the only thing that knows.
const __nimbusRubyParking = typeof WebAssembly.promising === 'function' ? 'jspi' : 'none';

function __nimbusInstallRubyFsSnapshot(snapshot) {
  const dirs = new Set(['tmp', 'home']);
  const files = {};
  // Null-safe like every other field here: a REPL eval calls __rubyRun with
  // no snapshot at all and must get the bootstrap defaults, not a TypeError.
  const modes = { '': 7, tmp: 7, home: 7, ...(snapshot && snapshot.modes) };
  for (const dir of (snapshot && snapshot.dirs) || []) dirs.add(String(dir).replace(/^\\/+/, '').replace(/\\/+$/, ''));
  for (const [path, b64] of Object.entries((snapshot && snapshot.files) || {})) {
    files[String(path).replace(/^\\/+/, '')] = b64;
  }
  // Metadata-only entries: the manifest carries each file's size and content
  // arrives on first read. Canonicalized exactly like the content entries.
  const sizes = {};
  for (const [path, size] of Object.entries((snapshot && snapshot.sizes) || {})) {
    sizes[String(path).replace(/^\\/+/, '')] = size;
  }
  __wasiInitFS({
    root: '',
    preopens: [
      { wasiPath: '/',     vfsPath: '' },
      { wasiPath: '/tmp',  vfsPath: 'tmp' },
      { wasiPath: '/home', vfsPath: 'home' },
    ],
    files,
    sizes,
    dirs: Array.from(dirs).filter(Boolean),
    modes,
    // Forwarded, never invented here: only the producer knows whether it
    // walked those roots completely.
    enumeratedRoots: (snapshot && snapshot.enumeratedRoots) || [],
    revision: snapshot && snapshot.revision,
  });
}

// ── Canonical-ABI resource Slab ────────────────────────────────────
// Pyodide-style minimal resource manager. Ruby's rb-abi-guest.js uses
// these 4 functions for resource_drop / resource_new / resource_get /
// resource_clone, but the wasm itself only imports 3:
//   resource_drop_js-abi-value, resource_new_rb-abi-value, resource_get_rb-abi-value
class __NimbusRubySlab {
  constructor() { this._map = new Map(); this._next = 1; }
  insert(obj) { const id = this._next++; this._map.set(id, obj); return id; }
  get(id) { return this._map.get(id); }
  remove(id) { const v = this._map.get(id); this._map.delete(id); return v; }
}

// ── Bootstrap promise: runs at child-facet module-init time ────────
//
// Mirrors pyodide v2's __pyodideBootstrap pattern. The synchronous
// portion (WebAssembly.instantiate + _initialize + ruby-init-loadpath
// + ruby-init) all completes before the first await — so it executes
// in module-init CSP context where workerd permits wasm code-gen
// from the LOADER-provided Module.
globalThis.__rubyBootstrap = (async function nimbusRubyBootstrap() {
  const wasmTable = globalThis.__NIMBUS_WASM || {};
  const rubyMod = wasmTable['ruby+stdlib.wasm'];
  if (!rubyMod) {
    return { ok: false, error: '__NIMBUS_WASM missing ruby+stdlib.wasm' };
  }

  // WASI init — empty preopens initially. Per-call __rubyRun can mount
  // a cwd preopen if needed (for ruby <file.rb> reading via WASI).
  // For v1 (-e mode) we just need stdout/stderr capture + a minimal
  // FS so Ruby's stdlib init (which probes /tmp + $HOME) doesn't crash.
  __wasiInitFS({
    root: '',
    preopens: [
      // Preopen / so Ruby can resolve all FS paths through WASI.
      // Ruby's __wasi_vfs_rt_init mounts its packed stdlib under /usr
      // inside the wasm's internal VFS — these preopens are for the
      // OUTER (host-visible) FS that wasi_snapshot_preview1 exposes.
      { wasiPath: '/',        vfsPath: '' },
      { wasiPath: '/tmp',     vfsPath: 'tmp' },
      { wasiPath: '/home',    vfsPath: 'home' },
    ],
    files: {},
    dirs: ['tmp', 'home'],
    modes: { '': 7, tmp: 7, home: 7 },
  });

  // Initial argv/env (bootstrap defaults). Per-call __rubyRun re-
  // initializes WASI with the actual user argv/env before evaluating
  // user code.
  let memRef = null;
  const wasi = __wasiMakeImports({
    argv: ['ruby'],
    env: { HOME: '/home/ruby', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    // Stated, not defaulted. A host that cannot park a guest hands over the
    // whole filesystem instead of a manifest, so nothing here needs to block —
    // and saying so is what makes a syscall that blocks anyway fail loudly
    // instead of returning a Promise where the guest expects an errno.
    parking: __nimbusRubyParking,
    getMemory: () => memRef,
    stdoutWrite: (s) => { globalThis.__nimbusRubyStdout.push(s); },
    stderrWrite: (s) => { globalThis.__nimbusRubyStderr.push(s); },
  });

  // canonical_abi imports — 3 resource lifecycle fns. The Slab is
  // shared across the lifetime of the facet (single call, then the
  // facet is reaped).
  const rbValueSlab = new __NimbusRubySlab();
  const jsValueSlab = new __NimbusRubySlab();
  const canonical_abi = {
    'resource_drop_js-abi-value': (i) => { jsValueSlab.remove(i); },
    'resource_new_rb-abi-value': (i) => rbValueSlab.insert({ _wasm_val: i }),
    'resource_get_rb-abi-value': (i) => {
      const r = rbValueSlab.get(i);
      return r ? r._wasm_val : 0;
    },
  };

  const jsAbiResources = jsValueSlab;
  function readGuestString(ptr, len) {
    return new TextDecoder().decode(new Uint8Array(memRef.buffer, ptr, len));
  }
  function writeGuestString(outPtr, value) {
    const bytes = new TextEncoder().encode(String(value));
    const strPtr = cabiRealloc(0, 0, 1, bytes.length);
    new Uint8Array(memRef.buffer).set(bytes, strPtr);
    const dv = new DataView(memRef.buffer);
    dv.setUint32(outPtr + 0, strPtr, true);
    dv.setUint32(outPtr + 4, bytes.length, true);
  }
  function writeJsResult(outPtr, tag, value) {
    const dv = new DataView(memRef.buffer);
    dv.setInt8(outPtr + 0, tag === 'success' ? 0 : 1, true);
    dv.setInt32(outPtr + 4, jsAbiResources.insert(value), true);
  }
  function readJsHandle(id) {
    return jsAbiResources.get(id);
  }
  function readJsHandleList(ptr, len) {
    const dv = new DataView(memRef.buffer);
    const out = [];
    for (let i = 0; i < len; i++) out.push(readJsHandle(dv.getInt32(ptr + i * 4, true)));
    return out;
  }
  function jsFailure(error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const rb_js_abi_host = {
    rb_wasm_throw_prohibit_rewind_exception: () => {
      // This one CAN fire from Ruby internals (Fiber rewind guard).
      // Make it a no-op so Ruby's continuation machinery proceeds.
    },
    'eval-js: func(code: string) -> variant { success(handle<js-abi-value>), failure(handle<js-abi-value>) }': (ptr, len, outPtr) => {
      try {
        writeJsResult(outPtr, 'success', Function(readGuestString(ptr, len))());
      } catch (e) {
        writeJsResult(outPtr, 'failure', jsFailure(e));
      }
    },
    'is-js: func(value: handle<js-abi-value>) -> bool': () => 1,
    'instance-of: func(value: handle<js-abi-value>, klass: handle<js-abi-value>) -> bool': (value, klass) => {
      const ctor = readJsHandle(klass);
      return typeof ctor === 'function' && readJsHandle(value) instanceof ctor ? 1 : 0;
    },
    'global-this: func() -> handle<js-abi-value>': () => jsAbiResources.insert(globalThis),
    'int-to-js-number: func(value: s32) -> handle<js-abi-value>': (value) => jsAbiResources.insert(value),
    'float-to-js-number: func(value: float64) -> handle<js-abi-value>': (value) => jsAbiResources.insert(value),
    'string-to-js-string: func(value: string) -> handle<js-abi-value>': (ptr, len) => jsAbiResources.insert(readGuestString(ptr, len)),
    'bool-to-js-bool: func(value: bool) -> handle<js-abi-value>': (value) => {
      if (value !== 0 && value !== 1) throw new TypeError('Ruby JS bridge received an invalid bool value');
      return jsAbiResources.insert(value === 1);
    },
    'proc-to-js-function: func(value: u32) -> handle<js-abi-value>': () => jsAbiResources.insert(() => {
      throw new Error('Nimbus Ruby JS bridge does not expose Ruby Proc callbacks yet');
    }),
    'rb-object-to-js-rb-value: func(raw-rb-abi-value: u32) -> handle<js-abi-value>': (value) => jsAbiResources.insert({ __nimbusRubyValue: value >>> 0 }),
    'js-value-to-string: func(value: handle<js-abi-value>) -> string': (value, outPtr) => writeGuestString(outPtr, String(readJsHandle(value))),
    'js-value-to-integer: func(value: handle<js-abi-value>) -> variant { as-float(float64), bignum(string) }': (value, outPtr) => {
      const raw = readJsHandle(value);
      const dv = new DataView(memRef.buffer);
      if (typeof raw === 'bigint') {
        dv.setInt8(outPtr + 0, 1, true);
        writeGuestString(outPtr + 8, raw.toString());
        return;
      }
      dv.setInt8(outPtr + 0, 0, true);
      dv.setFloat64(outPtr + 8, Number(raw), true);
    },
    'export-js-value-to-host: func(value: handle<js-abi-value>) -> ()': (value) => {
      globalThis.__nimbusRubyExportedJsValue = readJsHandle(value);
    },
    'import-js-value-from-host: func() -> handle<js-abi-value>': () => jsAbiResources.insert(globalThis.__nimbusRubyExportedJsValue),
    'js-value-typeof: func(value: handle<js-abi-value>) -> string': (value, outPtr) => writeGuestString(outPtr, typeof readJsHandle(value)),
    'js-value-equal: func(lhs: handle<js-abi-value>, rhs: handle<js-abi-value>) -> bool': (lhs, rhs) => readJsHandle(lhs) == readJsHandle(rhs) ? 1 : 0,
    'js-value-strictly-equal: func(lhs: handle<js-abi-value>, rhs: handle<js-abi-value>) -> bool': (lhs, rhs) => readJsHandle(lhs) === readJsHandle(rhs) ? 1 : 0,
    'reflect-apply: func(target: handle<js-abi-value>, this-argument: handle<js-abi-value>, arguments: list<handle<js-abi-value>>) -> variant { success(handle<js-abi-value>), failure(handle<js-abi-value>) }': (target, thisArg, argsPtr, argsLen, outPtr) => {
      try {
        writeJsResult(outPtr, 'success', Reflect.apply(readJsHandle(target), readJsHandle(thisArg), readJsHandleList(argsPtr, argsLen)));
      } catch (e) {
        writeJsResult(outPtr, 'failure', jsFailure(e));
      }
    },
    'reflect-get: func(target: handle<js-abi-value>, property-key: string) -> variant { success(handle<js-abi-value>), failure(handle<js-abi-value>) }': (target, keyPtr, keyLen, outPtr) => {
      try {
        writeJsResult(outPtr, 'success', Reflect.get(readJsHandle(target), readGuestString(keyPtr, keyLen)));
      } catch (e) {
        writeJsResult(outPtr, 'failure', jsFailure(e));
      }
    },
    'reflect-set: func(target: handle<js-abi-value>, property-key: string, value: handle<js-abi-value>) -> variant { success(handle<js-abi-value>), failure(handle<js-abi-value>) }': (target, keyPtr, keyLen, value, outPtr) => {
      try {
        writeJsResult(outPtr, 'success', Reflect.set(readJsHandle(target), readGuestString(keyPtr, keyLen), readJsHandle(value)));
      } catch (e) {
        writeJsResult(outPtr, 'failure', jsFailure(e));
      }
    },
  };

  const imports = {
    wasi_snapshot_preview1: wasi.wasiImport,
    canonical_abi,
    'rb-js-abi-host': rb_js_abi_host,
  };

  let instance;
  try {
    const result = await WebAssembly.instantiate(rubyMod, imports);
    instance = (result instanceof WebAssembly.Instance ? result : result.instance);
  } catch (e) {
    return { ok: false, error: 'WebAssembly.instantiate failed: ' + (e && e.message), stack: e && e.stack };
  }
  memRef = instance.exports.memory;

  // Entering the Ruby VM.
  //
  // The WASI imports this instance is given include ones wrapped in
  // WebAssembly.Suspending — fd_read, fd_write, fd_pread, path_filestat_get,
  // poll_oneoff and the sock_* family. V8 requires an active
  // WebAssembly.promising suspender for ANY call into a suspending import,
  // whether or not that import returns a Promise (measured on workerd:
  // a Suspending import returning a plain i32 off a raw stack throws
  // SuspendError "trying to suspend without WebAssembly.promising"). So every
  // entry into this instance is promising-wrapped, not just the ones that are
  // known to park today: which WASI calls the guest makes is the guest's
  // business, and the suspending set grows.
  //
  // cabi_realloc is deliberately not wrapped. It is the guest allocator, not a
  // VM entry — it never reaches WASI, and it is reached from the synchronous
  // rb-js-abi-host callbacks, which cannot await.
  //
  // Where there is no JSPI there is also nothing suspending to enter, so the
  // wrapper is the identity: same VM, same call, on a plain stack.
  const enterVm = (fn) => (__nimbusRubyParking === 'jspi' ? WebAssembly.promising(fn) : fn);

  // ── Ruby bootstrap sequence ────────────────────────────────────
  // Order matters (per ruby.wasm DefaultRubyVM):
  //   1. _initialize (reactor entry; runs static initializers)
  //   2. __wasi_vfs_rt_init (mount packed stdlib at the wasi-vfs's
  //      internal FS — needed for require to find Ruby's *.rb files)
  //   3. ruby-init([progName])  — initialize VM with argv[0]
  //   4. ruby-init-loadpath()   — set $LOAD_PATH from packed stdlib
  try {
    if (typeof instance.exports._initialize === 'function') {
      await enterVm(instance.exports._initialize)();
    }
    if (typeof instance.exports.__wasi_vfs_rt_init === 'function') {
      await enterVm(instance.exports.__wasi_vfs_rt_init)();
    }
  } catch (e) {
    return { ok: false, error: '_initialize/wasi_vfs_rt_init failed: ' + (e && e.message), stack: e && e.stack };
  }

  // Locate the canonical Ruby ABI exports. Names embed the WIT
  // signature literal (e.g. 'ruby-init: func(args: list<string>) -> ()')
  // because rb-abi-guest is wit-bindgen-generated.
  const rubyInit = instance.exports['ruby-init: func(args: list<string>) -> ()'];
  const rubyInitLoadpath = instance.exports['ruby-init-loadpath: func() -> ()'];
  const rbEvalStringProtect = instance.exports['rb-eval-string-protect: func(str: string) -> tuple<handle<rb-abi-value>, s32>'];
  const cabiRealloc = instance.exports.cabi_realloc;
  if (!rubyInit || !rubyInitLoadpath || !rbEvalStringProtect || !cabiRealloc) {
    return { ok: false, error: 'Required Ruby ABI exports missing (ruby-init/init-loadpath/eval-string-protect/cabi_realloc)' };
  }

  // Encode a list<string> argument for ruby-init. WIT canonical-ABI
  // shape: caller allocates list buffer; each element is (ptr, len).
  // Strings are UTF-8 encoded into separately-allocated buffers.
  function writeListString(strings) {
    const memory = instance.exports.memory;
    const enc = new TextEncoder();
    const len = strings.length;
    const listBufPtr = cabiRealloc(0, 0, 4, len * 8);  // align=4, size=len*8
    const encoded = strings.map((s) => enc.encode(s));
    for (let i = 0; i < len; i++) {
      const bytes = encoded[i];
      const strPtr = cabiRealloc(0, 0, 1, bytes.length);
      new Uint8Array(memory.buffer).set(bytes, strPtr);
      const dv = new DataView(memory.buffer);
      dv.setUint32(listBufPtr + i * 8 + 0, strPtr, true);
      dv.setUint32(listBufPtr + i * 8 + 4, bytes.length, true);
    }
    return { ptr: listBufPtr, len };
  }

  function writeString(s) {
    const memory = instance.exports.memory;
    const enc = new TextEncoder();
    const bytes = enc.encode(s);
    const ptr = cabiRealloc(0, 0, 1, bytes.length);
    new Uint8Array(memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  }

  // NOTE: We DO NOT call ruby-init or ruby-init-loadpath here. Both
  // invoke CPython-like random-seed initialization (random_get via
  // wasi_snapshot_preview1.random_get), which workerd blocks in the
  // global-scope (module-init) context. Same constraint that bit us
  // for Pyodide v2 P21. The per-call __rubyRun runs them at request-
  // handler time where crypto.getRandomValues is permitted.
  //
  // _initialize and __wasi_vfs_rt_init are safe at module-init because
  // they only do static initialization (no entropy reads).

  return {
    ok: true,
    instance,
    wasi,
    rubyInit: enterVm(rubyInit),
    rubyInitLoadpath: enterVm(rubyInitLoadpath),
    rbEvalStringProtect: enterVm(rbEvalStringProtect),
    writeListString,
    writeString,
    rubyInitialized: false,  // mutated to true by __rubyRun on first call
  };
})();

// ── Per-call entry point ───────────────────────────────────────────
//
// Invoked from the LOADER child facet's execute() (which calls the
// serialized facetFn that does globalThis.__rubyRun(args)).
//
// At this point the bootstrap promise has resolved (since it's
// awaited inside the child facet's module-init context — the
// instantiate finishes before the request handler runs). We:
//   1. Update Ruby's $0 / $PROGRAM_NAME / ARGV via rb-eval-string-protect
//   2. Wrap the user code in a begin/rescue SystemExit/StandardError
//      handler so we can extract exit code without losing stdout
//   3. Read stdout/stderr buffers and slice from the per-call start
// Evaluate Ruby source in the booted VM. Hoisted out of __rubyRun so a
// process can also be DRIVEN (resumed) without re-running the whole
// per-invocation wrapper.
async function __nimbusRubyEval(boot, rubyCode) {
  const memory = boot.instance.exports.memory;
  const bytes = new TextEncoder().encode(rubyCode);
  const codePtr = boot.instance.exports.cabi_realloc(0, 0, 1, bytes.length);
  new Uint8Array(memory.buffer).set(bytes, codePtr);
  const retPtr = await boot.rbEvalStringProtect(codePtr, bytes.length);
  // Return is a tuple: (rb-abi-value handle u32, status s32) — 8 bytes
  const dv = new DataView(memory.buffer);
  return { handle: dv.getUint32(retPtr + 0, true), status: dv.getInt32(retPtr + 4, true) };
}

// Resume the process's main fiber, and report what it wants next.
//
// A workerd request context cannot resume a wasm stack suspended by a
// DIFFERENT request, so a server cannot simply block in accept across
// requests. A Ruby fiber can: its state lives in the VM's own memory, so it
// survives the context boundary. The process body therefore runs in a fiber
// that parks when its accept queue is empty, and each inbound request resumes
// it. Returns resumed=false when there is no live process to drive, which the
// kernel reports as "nothing accepted the request".
//
// The report is what makes the process drivable at all:
//   alive       the body is still running - it parked rather than finished
//   hostDriven  it has listened, so inbound requests are what resume it now
//   wakeAfter   seconds until the earliest deadline it owes, or null for none
globalThis.__nimbusRubyResumeMain = async function __nimbusRubyResumeMain() {
  const boot = await globalThis.__rubyBootstrap;
  if (!boot.ok) return { resumed: false, alive: false, hostDriven: false, wakeAfter: null };
  const stderrStart = globalThis.__nimbusRubyStderr.length;
  await __nimbusRubyEval(boot, [
    '$__nimbus_resumed = ($__nimbus_main && $__nimbus_main.alive?) ? (begin; $__nimbus_main.resume; true; ' +
      'rescue Exception => e; $stderr.write(e.full_message(highlight: false, order: :top)); $__nimbus_exit = 1; false; end) : false',
    '$stderr.write("__NIMBUS_RESUMED_" + $__nimbus_resumed.to_s' +
      ' + "_" + (($__nimbus_main && $__nimbus_main.alive?) ? "1" : "0")' +
      ' + "_" + ((defined?(Nimbus::Threading) && Nimbus::Threading.host_driven) ? "1" : "0")' +
      ' + "_" + ($__nimbus_wake_after ? $__nimbus_wake_after.to_s : "nil") + "\\n")',
  ].join("\\n"));
  // Scrub the marker so it never reaches the user's stderr, keeping whatever
  // the resumed program itself wrote.
  const written = globalThis.__nimbusRubyStderr.slice(stderrStart).join('');
  globalThis.__nimbusRubyStderr.length = stderrStart;
  const scrubbed = written.replace(/__NIMBUS_RESUMED_(true|false)_[^\\n]*\\n?/g, '');
  if (scrubbed) globalThis.__nimbusRubyStderr.push(scrubbed);
  const marker = /__NIMBUS_RESUMED_(true|false)_([01])_([01])_([^\\n]*)/.exec(written);
  const wake = marker && marker[4] !== 'nil' ? Number(marker[4]) : NaN;
  return {
    resumed: !!marker && marker[1] === 'true',
    alive: !!marker && marker[2] === '1',
    hostDriven: !!marker && marker[3] === '1',
    wakeAfter: Number.isFinite(wake) ? wake : null,
  };
};

// One resume at a time, for the whole process. Several drivers can be live at
// once — the request that queued a connection, another request waiting out a
// deadline, the invocation that started the process — and two of them entering
// a live fiber together would corrupt it. The queue is on globalThis because
// no single request may own it: a request context is torn down without warning
// when its response is sent, taking anything anchored to it.
globalThis.__nimbusRubyResumeQueue = globalThis.__nimbusRubyResumeQueue || Promise.resolve();
globalThis.__nimbusRubyStep = function __nimbusRubyStep() {
  const run = () => globalThis.__nimbusRubyResumeMain();
  const task = globalThis.__nimbusRubyResumeQueue.then(run, run);
  globalThis.__nimbusRubyResumeQueue = task.then(() => {}, () => {});
  return task;
};

// Drive a process that has just been started, until it no longer owes the
// clock anything.
//
// This is the whole of what a "boot driver" is: the clock only advances
// between turns, so a body that parked on a deadline needs someone outside the
// guest to wait out that deadline on a real timer and resume it. Without one,
// the deadline can never pass and the invocation burns its CPU budget instead.
//
// It stops the moment the process listens: from there the process is resumed
// by inbound requests, and those requests carry the deadlines — a driver
// anchored to this invocation would be cancelled with it.
globalThis.__nimbusRubyDriveBoot = async function __nimbusRubyDriveBoot() {
  for (;;) {
    const step = await globalThis.__nimbusRubyStep();
    if (!step.resumed || !step.alive) return step;
    if (step.hostDriven || step.wakeAfter === null) return step;
    // Always through a timer, even at zero: the turn boundary is what moves
    // the clock, so resuming without one would leave the deadline where it was.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, step.wakeAfter) * 1000));
  }
};

globalThis.__rubyRun = async function __rubyRun(args) {
  const stdoutStart = globalThis.__nimbusRubyStdout.length;
  const stderrStart = globalThis.__nimbusRubyStderr.length;

  const boot = await globalThis.__rubyBootstrap;
  if (!boot.ok) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
      error: 'ruby bootstrap failed: ' + (boot.error || 'unknown') + (boot.stack ? ' [stack=' + boot.stack + ']' : ''),
    };
  }

  try {
    __nimbusInstallRubyFsSnapshot(args.fsSnapshot);
    // AFTER the mount, never before. __wasiInitFS deliberately drops the
    // supervisor so a pooled isolate cannot serve the previous tenant's
    // filesystem, which means adopting first — as both ruby entry points do,
    // since they must adopt before they know whether a mount is coming —
    // leaves the seed with no backing store for the whole script load.
    // Every require then read a manifest entry with nothing behind it.
    __wasiAdoptSupervisor(globalThis.__nimbusRubySupervisor);
  } catch (e) {
    globalThis.__nimbusRubyStderr.push('[ruby-runner] VFS mount failed: ' + (e && e.message) + '\\n');
  }

  // First call into __rubyRun: complete Ruby VM init (ruby-init +
  // ruby-init-loadpath) now that we're in request-handler context
  // where crypto.getRandomValues is permitted. Subsequent calls skip.
  //
  // The language prelude goes in here, once, with the rest of VM startup.
  // Threads, queues, mutexes and the socket classes are what Ruby IS on this
  // runtime, so a program gets them because it is Ruby - not because the
  // invocation was classified one way rather than another. The two process
  // shapes differ in how long the process lives, and in nothing else.
  if (!boot.rubyInitialized) {
    try {
      const initArgs = boot.writeListString(['ruby', '-e_=0']);
      await boot.rubyInit(initArgs.ptr, initArgs.len);
      await boot.rubyInitLoadpath();
      boot.rubyInitialized = true;
    } catch (e) {
      return {
        exitCode: 1,
        stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
        stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
        error: 'ruby-init / ruby-init-loadpath failed at request time: ' + (e && e.message),
      };
    }
    // A broken language prelude is a broken interpreter, so it fails the call
    // rather than leaving the program to trip over whatever is missing.
    let preludeStatus;
    try {
      preludeStatus = await __nimbusRubyEval(boot, RUBY_LANGUAGE_PRELUDE);
    } catch (e) {
      preludeStatus = { status: -1, error: (e && e.message) || String(e) };
    }
    if (!preludeStatus || preludeStatus.status !== 0) {
      boot.rubyInitialized = false;
      return {
        exitCode: 1,
        stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
        stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
        error: 'ruby language prelude failed to load: ' +
          (preludeStatus && preludeStatus.error ? preludeStatus.error : 'eval status ' + (preludeStatus && preludeStatus.status)),
      };
    }
  }

  function rubyStringLiteral(value) {
    const s = String(value ?? '');
    let out = "'";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\\\") out += "\\\\\\\\";
      else if (ch === "'") out += "\\\\'";
      else out += ch;
    }
    return out + "'";
  }

  function rubyArrayLiteral(values) {
    return '[' + (values || []).map((v) => rubyStringLiteral(v)).join(', ') + ']';
  }

  function rubyHashLiteral(obj) {
    return '{' + Object.entries(obj || {})
      .map(([k, v]) => rubyStringLiteral(k) + ' => ' + rubyStringLiteral(v))
      .join(', ') + '}';
  }

  // Wrapper code: set $0/$PROGRAM_NAME/ARGV/ENV, run user code,
  // capture SystemExit. User-controlled strings are emitted as Ruby
  // single-quoted literals so Ruby interpolation inside source text is
  // preserved for the user's eval, not consumed by this wrapper.
  //
  // The wrapper sets __NIMBUS_RUBY_EXIT to the desired exit code so
  // we can read it via a second rb-eval-string-protect call. Failing
  // SystemExit (raise) ends up with __NIMBUS_RUBY_EXIT = 1 + stderr
  // message.
  const userCodeRb = rubyStringLiteral(args.userCode);
  const argvRb = rubyArrayLiteral(args.rbArgv.slice(1));  // exclude argv[0]
  const progNameRb = rubyStringLiteral(args.progName);

  // STAGED execution: we split the prelude (stdout sync + ARGV/ENV/$0
  // setup) from the user-code eval. The prelude has no failure modes
  // we care about; user-code is wrapped in begin/rescue for SystemExit
  // and Exception. Wrapper failures are reported through the captured
  // stderr diagnostic stream.
  // Build env list as string-keyed Ruby hash via the rocket-syntax.
  // Ruby treats colon-style hash literals as Symbol-keyed; we need
  // String keys so ENV[k] = v works without TypeError.
  const envHashRb = rubyHashLiteral(args.userEnv || {});
  const cwdRb = rubyStringLiteral(args.cwd || '/home/user');

  const preludeRb = [
    // Reset exit state FIRST so partial prelude failures still
    // surface a clean exit code (previously: exit 7 left $__nimbus_exit
    // = 7 → next call's prelude could fail before resetting → second
    // exit 0 returned 7).
    '$__nimbus_exit = 0',
    '$stdout.sync = true',
    '$stderr.sync = true',
    '$0 = ' + progNameRb,
    '$PROGRAM_NAME = ' + progNameRb,
    'ARGV.replace(' + argvRb + ')',
    envHashRb + '.each_pair { |k, v| ENV[k] = v }',
    'ENV["HOME"] ||= "/home/user"',
    'ENV["GEM_HOME"] ||= File.join(ENV["HOME"], ".gem")',
    'ENV["GEM_PATH"] ||= ENV["GEM_HOME"]',
    'begin; Dir.mkdir(ENV["GEM_HOME"]) unless Dir.exist?(ENV["GEM_HOME"]); rescue Exception; end',
    'begin; Dir.chdir(' + cwdRb + '); rescue Exception; end',
    'begin; $LOAD_PATH.unshift(Dir.pwd) unless $LOAD_PATH.include?(Dir.pwd); rescue Exception; end',
    'begin; (ENV["NIMBUS_GEM_LIBS"] || "").split(":").reverse_each { |p| $LOAD_PATH.unshift(p) if p && p != "" && !$LOAD_PATH.include?(p) }; rescue Exception; end',
  ].join('; ');

  // The body runs in a fiber; every resume of it goes through the driver
  // below. A program with no server runs to completion across as many turns as
  // its deadlines need; a server parks in accept when its queue is empty and
  // is driven from there, one inbound request at a time. Same fiber, same
  // driver, so this is the single path for every Ruby invocation.
  const userWrapper = [
    '$__nimbus_main = Fiber.new do',
    '  begin',
    '    ' + 'eval(' + userCodeRb + ', TOPLEVEL_BINDING, ' + progNameRb + ', 1)',
    '  rescue SystemExit => e',
    '    $__nimbus_exit = e.status',
    '  rescue Exception => e',
    '    $stderr.write(e.full_message(highlight: false, order: :top))',
    '    $__nimbus_exit = 1',
    '  ensure',
    '    begin; Nimbus::Threading.shutdown if defined?(Nimbus::Threading); rescue Exception; end',
    '    $stdout.flush rescue nil',
    '    $stderr.flush rescue nil',
    '  end',
    'end',
  ].join("\\n");

  const callEvalStringProtect = (rubyCode) => __nimbusRubyEval(boot, rubyCode);

  // Stage 1: run the prelude (sync flags, ARGV, ENV, $0/$PROGRAM_NAME).
  let preludeStatus;
  try {
    preludeStatus = await callEvalStringProtect(preludeRb);
  } catch (e) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
      error: 'ruby prelude threw: ' + (e && e.message),
    };
  }
  if (preludeStatus && preludeStatus.status !== 0) {
    globalThis.__nimbusRubyStderr.push('[ruby-runner-diag] prelude returned non-zero status: ' + preludeStatus.status + '\\n');
  }

  // Stage 2: build the body fiber wrapped for SystemExit/Exception capture,
  // then drive it until it finishes or hands itself to the host.
  let evalStatus;
  try {
    evalStatus = await callEvalStringProtect(userWrapper);
    await globalThis.__nimbusRubyDriveBoot();
  } catch (e) {
    return {
      exitCode: 1,
      stdout: globalThis.__nimbusRubyStdout.slice(stdoutStart).join(''),
      stderr: globalThis.__nimbusRubyStderr.slice(stderrStart).join(''),
      error: 'rb-eval-string-protect threw: ' + (e && e.message),
    };
  }
  if (evalStatus && evalStatus.status !== 0) {
    globalThis.__nimbusRubyStderr.push('[ruby-runner-diag] user wrapper returned non-zero status: ' + evalStatus.status + '\\n');
  }

  // Read $__nimbus_exit through a sentinel on captured stderr, then remove
  // the sentinel before returning user-visible output.
  const NIMBUS_EXIT_MARKER = '__NIMBUS_RUBY_EXIT_';
  let exitCode = 0;
  try {
    // Print the marker + exit code to stderr (a side channel separate
    // from user-visible stdout). We strip it before returning.
    await callEvalStringProtect(
      '$stderr.write(' + JSON.stringify(NIMBUS_EXIT_MARKER) + ' + $__nimbus_exit.to_s + "\\\\n")'
    );
    // Scrape the marker from stderr buffer — using ONLY this call's
    // slice (from stderrStart). The same facet can be reused across
    // multiple __rubyRun invocations (loader-pool dedup by tag), so
    // a previous call's marker would otherwise be matched first.
    const callStderr = globalThis.__nimbusRubyStderr.slice(stderrStart).join('');
    // Match the LAST marker in this slice (the one our just-completed
    // call emitted; if the user wrapper also emitted writes, the
    // marker is appended after them).
    const markerRe = new RegExp(NIMBUS_EXIT_MARKER + '(-?\\\\d+)', 'g');
    let lastMatch = null;
    let mit;
    while ((mit = markerRe.exec(callStderr)) !== null) lastMatch = mit;
    if (lastMatch) exitCode = parseInt(lastMatch[1], 10);
  } catch (e) {
    // Failure to read exit code → assume 0 if no errors observed.
    exitCode = 0;
  }

  // Scrub the marker out of the BUFFER, not just out of what this call
  // returns. A process that parked instead of exiting - any server - leaves
  // __rubyRun finished while the program is still live, and whoever reads the
  // buffer next would otherwise hand the user our side channel.
  const stdoutOut = globalThis.__nimbusRubyStdout.slice(stdoutStart).join('');
  const markerLine = new RegExp(NIMBUS_EXIT_MARKER + '-?\\\\d+\\\\n?', 'g');
  const stderrOut = globalThis.__nimbusRubyStderr.slice(stderrStart).join('').replace(markerLine, '');
  globalThis.__nimbusRubyStderr.length = stderrStart;
  if (stderrOut) globalThis.__nimbusRubyStderr.push(stderrOut);

  return {
    exitCode: exitCode,
    stdout: stdoutOut,
    stderr: stderrOut,
  };
};

// ── END: ruby-runner preamble ──────────────────────────────────────
`;
