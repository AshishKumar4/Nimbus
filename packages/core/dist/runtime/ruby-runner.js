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
 *   - the filesystem is the session authority reached through the supervisor
 *     stub: over a suspending import where a guest can be parked
 *     mid-syscall, over the authority's synchronous view where it cannot.
 *     Nothing below branches on which it got.
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
import { withHostView } from './process-files.js';
import { z } from 'zod';
import { hasLeadingCliFlag } from './cli-flags.js';
import { CRED_KERNEL, gateSyncLaunch, requireVfsCred } from './os-contracts.js';
import { WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';
import { resolveVfsPath } from '../vfs/path.js';
import { RUBY_SOCKET_SHIM } from './ruby-socket-shim.js';
import { RUBY_GREEN_THREADS } from './ruby-green-threads.js';
import { gemHomeFor, installRubyBundle, installRubyGems, installedGemBins, installedGemLibRoots, parseRubyGemRequirements, } from './ruby-gems.js';
import { errorText } from '../_shared/error-text.js';
import { openRuntimeStdio, runtimeOutput } from './runtime-stdio.js';
const RUBY_RUNTIME_BIN_NAMES = new Set(['ruby', 'ruby3', 'gem', 'bundle', 'bundler']);
const RUBY_VERSION_FLAGS = new Set(['--version', '-v']);
/**
 * Build the ruby-runner factory. Called once at session init; the
 * returned factory binds the manifest + install root for each
 * registered entrypoint (`ruby`, `ruby3`).
 */
export function makeRubyRunnerFactory(deps) {
    const { registry } = deps;
    return async function rubyRunnerFactory(manifest, installRoot, binName, binKind) {
        const findFile = (rel) => {
            const entry = manifest.files.find((f) => f.path === rel);
            return entry ? `${installRoot}/${entry.path}` : null;
        };
        const wasmVfs = findFile('share/ruby/ruby+stdlib.wasm');
        const registerGemBins = async (vfs, home) => {
            if (!registry)
                return;
            for (const bin of (await installedGemBins(vfs, gemHomeFor(home)))) {
                if (RUBY_RUNTIME_BIN_NAMES.has(bin.name))
                    continue;
                // The name is registered once for the session; which script it runs
                // is the invoking HOME's, as a PATH lookup of ~/.gem/bin would find.
                registry.register(bin.name, async (ctx) => {
                    const script = `/${gemHomeFor(ctx.env?.HOME || deps.getHome())}/bin/${bin.name}`;
                    if (!(await ctx.vfs.exists(script))) {
                        ctx.stderr.write(`${bin.name}: command not found\n`);
                        return 127;
                    }
                    const args = [script, ...(ctx.args ?? [])];
                    const ruby = typeof registry.resolve === 'function' ? await registry.resolve('ruby') : null;
                    if (!ruby) {
                        ctx.stderr.write(`${bin.name}: Ruby runtime is not registered\n`);
                        return 127;
                    }
                    return ruby({ ...ctx, args });
                });
            }
        };
        const rubyBinHandler = async function rubyBinHandler(ctx) {
            const cred = requireVfsCred('cred' in ctx ? ctx.cred : undefined, binName);
            const vfs = ctx.vfs;
            const argv = ctx.args ?? [];
            const cwd = ctx.cwd || '/home/user';
            const notHydrated = await gateSyncLaunch(vfs.process, cwd, null, argv);
            if (notHydrated !== null) {
                ctx.stderr.write(`${binName}: ${notHydrated}\n`);
                return 1;
            }
            const home = ctx.env?.HOME || deps.getHome();
            const packageCommand = await maybeHandleRubyPackageCommand(binKind, binName, argv, cwd, home, vfs, ctx, deps.network);
            if (packageCommand.handled) {
                if (packageCommand.exitCode === 0)
                    (await registerGemBins(vfs, home));
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
            // The interpreter image must be installed.
            if (!wasmVfs || !(await vfs.exists(wasmVfs))) {
                ctx.stderr.write(`${binName}: ruby+stdlib.wasm missing (re-run 'nimbus install ruby')\n`);
                return 127;
            }
            // Parse argv.
            const parsed = toolInvocation.mode === 'tool'
                ? {
                    mode: 'inline',
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
            let rbArgv = [binName];
            if (parsed.mode === 'inline') {
                userCode = parsed.inlineCode;
                progName = '-e';
                rbArgv = ['-e', ...parsed.scriptArgs];
            }
            else if (parsed.mode === 'script') {
                const absPath = resolveVfsPath(parsed.scriptPath, cwd);
                try {
                    if (!(await vfs.exists(absPath))) {
                        ctx.stderr.write(`${binName}: No such file or directory -- ${parsed.scriptPath} (LoadError)\n`);
                        return 1;
                    }
                    userCode = new TextDecoder('utf-8').decode((await vfs.readFile(absPath)));
                }
                catch (e) {
                    ctx.stderr.write(`${binName}: ${parsed.scriptPath}: ${errorText(e)}\n`);
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
            const userEnv = { ...(ctx.env || {}) };
            if (!userEnv.HOME)
                userEnv.HOME = home;
            if (!userEnv.LANG)
                userEnv.LANG = 'C.UTF-8';
            userEnv.GEM_HOME ||= '/' + gemHomeFor(home);
            userEnv.GEM_PATH ||= userEnv.GEM_HOME;
            userEnv.NIMBUS_GEM_LIBS = (await installedGemLibRoots(vfs, gemHomeFor(home))).join(':');
            // Ruby looks for charset hints via these vars; set sensible
            // defaults so puts of non-ASCII strings doesn't trip on the
            // wasi default of "ASCII-8BIT".
            if (!userEnv.LC_ALL)
                userEnv.LC_ALL = 'C.UTF-8';
            const facetArgs = {
                wasmVfsPath: wasmVfs,
                userCode,
                rbArgv,
                userEnv,
                progName,
                binName,
                cwd,
            };
            let result = { exitCode: 1, stdout: '', stderr: '' };
            if (needsResidentProcess(parsed)) {
                if (!deps.startResident) {
                    ctx.stderr.write(`${binName}: this program keeps running after it starts, and this host has no `
                        + 'process substrate to keep it on\n');
                    return 1;
                }
                result = await deps.startResident({
                    wasmVfsPath: facetArgs.wasmVfsPath,
                    startArgs: toRubyCallArgs(facetArgs),
                    cwd,
                    command: formatRubyCommand(binName, argv),
                    argv: [binName, ...argv],
                    invokerPid: ctx.pid,
                    signal: ctx.signal,
                    write: runtimeOutput(ctx),
                });
            }
            else {
                const stdio = openRuntimeStdio(deps, ctx, formatRubyCommand(binName, argv));
                try {
                    result = await dispatchRubyFacet(deps.facets, stdio.syscalls, facetArgs, await vfs.readArrayBufferUncached(wasmVfs), stdio.pid, stdio.signal);
                }
                finally {
                    stdio.finish(result?.exitCode ?? 1);
                }
            }
            if (result.stdout)
                ctx.stdout.write(result.stdout);
            if (result.stderr)
                ctx.stderr.write(result.stderr);
            if (result.error) {
                ctx.stderr.write(`${binName}: ${result.error}\n`);
                return 1;
            }
            return result.exitCode;
        };
        if (deps.registry)
            await withHostView(deps.filesystem, CRED_KERNEL, (vfs) => registerGemBins(vfs, deps.getHome()));
        return rubyBinHandler;
    };
}
async function maybeHandleRubyPackageCommand(binKind, binName, argv, cwd, home, vfs, ctx, network) {
    const tool = rubyPackageTool(binKind, binName);
    if (tool === 'gem' && argv[0] === 'install') {
        const parsed = parseGemInstallArgs(argv.slice(1));
        if (parsed.error) {
            ctx.stderr.write(`gem install: ${parsed.error}\n`);
            return { handled: true, exitCode: 2 };
        }
        try {
            const report = await installRubyGems(vfs, parsed.requests, { gemHome: gemHomeFor(home), includeDependencies: true, network });
            const processed = writeInstallReport(ctx, report);
            ctx.stdout.write(`${processed} gem(s) processed\n`);
            return { handled: true, exitCode: 0 };
        }
        catch (e) {
            ctx.stderr.write(`gem install: ${errorText(e)}\n`);
            return { handled: true, exitCode: 1 };
        }
    }
    if (tool === 'bundle' && argv[0] === 'install') {
        try {
            const { requests, report, lockfilePath } = await installRubyBundle(vfs, cwd, { gemHome: gemHomeFor(home), network });
            const processed = writeInstallReport(ctx, report);
            ctx.stdout.write(`Bundle complete! ${requests.length} Gemfile dependency(s), ${processed} gem(s) now installed.\n`);
            ctx.stdout.write(`Bundled lockfile written to /${lockfilePath}\n`);
            return { handled: true, exitCode: 0 };
        }
        catch (e) {
            ctx.stderr.write(`bundle install: ${errorText(e)}\n`);
            return { handled: true, exitCode: 1 };
        }
    }
    return { handled: false, exitCode: 0 };
}
/** Which RubyGems tool a bin is: `gem`, `bundle`/`bundler`, or neither. */
function rubyPackageTool(binKind, binName) {
    if (binKind === 'gem' || binName === 'gem')
        return 'gem';
    if (binKind === 'bundle' || binName === 'bundle' || binName === 'bundler')
        return 'bundle';
    return null;
}
/** Print an install's per-gem lines; returns how many gems it processed. */
function writeInstallReport(ctx, report) {
    for (const name of report.installed)
        ctx.stdout.write(`Successfully installed ${name}\n`);
    for (const name of report.alreadyInstalled)
        ctx.stdout.write(`${name} is already installed\n`);
    return report.installed.length + report.alreadyInstalled.length;
}
function parseGemInstallArgs(argv) {
    const names = [];
    let versionRequirement = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-v' || arg === '--version') {
            const version = argv[i + 1];
            if (!version)
                return { requests: [], error: `${arg}: missing version` };
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
    if (requests.length === 0)
        return { requests, error: 'missing gem name' };
    return { requests };
}
function buildRubyToolInvocation(binKind, binName, argv) {
    const tool = rubyPackageTool(binKind, binName);
    if (tool === null)
        return { mode: 'none', code: '', exitCode: 0 };
    if (tool === 'gem') {
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
function parseRubyArgv(argv) {
    // Ruby's CLI is rich; v1 handles -e, -r, and positional script.
    const requires = [];
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
        if (/^-[wWdEKUI]+$/.test(a)) {
            i++;
            continue;
        }
        if (a === '--disable-gems' || a === '--enable-gems') {
            i++;
            continue;
        }
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
function needsResidentProcess(parsed) {
    if (parsed.mode === 'script')
        return true;
    return parsed.requires.some((name) => {
        const root = name.split('/', 1)[0];
        return root === 'socket' || root === 'webrick' || root === 'rackup' || root === 'un';
    });
}
function formatRubyCommand(binName, argv) {
    return [binName, ...argv].map((part) => {
        if (/^[A-Za-z0-9_./:=@+-]+$/.test(part))
            return part;
        return JSON.stringify(part);
    }).join(' ');
}
const RubyFacetResultSchema = z.object({
    exitCode: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    error: z.string().optional(),
    control: z.record(z.string(), z.string()).optional(),
}).passthrough();
/**
 * A facet's answer, checked at the trust boundary. Exported for the resident
 * substrate, whose boot payload carries the same object from the same VM.
 */
export function normalizeRubyFacetResult(raw) {
    const parsed = RubyFacetResultSchema.safeParse(raw);
    if (!parsed.success)
        return null;
    return {
        exitCode: Number(parsed.data.exitCode || 0),
        stdout: parsed.data.stdout || '',
        stderr: parsed.data.stderr || '',
        error: parsed.data.error,
        control: parsed.data.control,
    };
}
/** The per-call payload, from the invocation's own state. */
function toRubyCallArgs(args) {
    return {
        userCode: args.userCode,
        rbArgv: args.rbArgv,
        userEnv: args.userEnv,
        progName: args.progName,
        binName: args.binName,
        cwd: args.cwd,
    };
}
async function dispatchRubyFacet(facets, syscalls, args, image, pid, signal) {
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
        syscalls,
        preamble: buildRubyPreamble(),
    });
    const facetFn = async function rubyFacetCall(inArgs, facetEnv) {
        const fn = Reflect.get(globalThis, '__rubyRun');
        if (typeof fn !== 'function') {
            return { exitCode: 127, stdout: '', stderr: '',
                error: 'ruby-runner preamble missing: __rubyRun not in scope' };
        }
        const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor');
        const supervisor = facetEnv && facetEnv.SUPERVISOR;
        // Published where __rubyRun re-adopts it after the mount; adopting only
        // here would be undone by __wasiInitFS.
        if (supervisor)
            Reflect.set(globalThis, '__nimbusRubySupervisor', supervisor);
        adopt?.(supervisor);
        return fn({
            userCode: inArgs.userCode,
            rbArgv: inArgs.rbArgv,
            userEnv: inArgs.userEnv,
            progName: inArgs.progName,
            binName: inArgs.binName,
            cwd: inArgs.cwd,
            supervisorPid: inArgs.supervisorPid,
        });
    };
    try {
        const rawResult = await facet.submit(facetFn, { ...toRubyCallArgs(args), supervisorPid: pid }, {
            wasmModules: {
                'ruby+stdlib.wasm': image,
            },
            timeoutMs: 300_000,
            // A kill or Ctrl-C ends the facet too, where the host can.
            signal,
        });
        return normalizeRubyFacetResult(rawResult) || {
            exitCode: 1,
            stdout: '',
            stderr: '',
            error: 'ruby-runner dispatch returned an invalid payload',
        };
    }
    catch (e) {
        // Killed: the program ends as an interrupted one does.
        if (signal.aborted)
            return { exitCode: 130, stdout: '', stderr: '' };
        return {
            exitCode: 1,
            stdout: '',
            stderr: '',
            error: `ruby-runner dispatch failed: ${errorText(e)}`,
        };
    }
    finally {
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
export function buildRubyPreamble() {
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

// One byte relay; the interpreter's private control frames are bounded
// metadata and never a second stored stdout/stderr representation.
let __nimbusRubyOutput = null;
let __nimbusRubyStdoutControl = null;
let __nimbusRubyStderrControl = null;
function __nimbusRubyBindOutput(args) {
  const supervisor = globalThis.__nimbusRubySupervisor;
  __nimbusRubyStdoutControl = args.outputControls?.length ? globalThis.__wasiOutputControl(args.outputControls) : null;
  __nimbusRubyStderrControl = globalThis.__wasiOutputControl([
    { key: 'resumed', prefix: '__NIMBUS_RESUMED_', suffix: '\\n' },
    { key: 'exit', prefix: '__NIMBUS_RUBY_EXIT_', suffix: '\\n' },
  ]);
  __nimbusRubyOutput = globalThis.__wasiSupervisorOutput({
    stdout: (bytes) => { const data = __nimbusRubyStdoutControl ? __nimbusRubyStdoutControl.feed(bytes) : bytes; if (data.length) return supervisor.stdout(data); },
    stderr: (bytes) => { const data = __nimbusRubyStderrControl ? __nimbusRubyStderrControl.feed(bytes) : bytes; if (data.length) return supervisor.stderr(data); },
  });
}
globalThis.__nimbusRubyWriteDiagnostic = function(text) {
  return __nimbusRubyOutput.stderrBytes(new TextEncoder().encode(text));
};

// Whether this facet can suspend the VM mid-syscall, asked of the engine
// rather than passed in: the answer is a property of where this scope was
// built, and the scope is the only thing that knows.
const __nimbusRubyParking = typeof WebAssembly.promising === 'function' ? 'jspi' : 'none';

function __nimbusInstallRubyFs(pid) {
  // The VM sees the whole session tree at '/'; /tmp and /home are preopened
  // as well because ruby.wasm's stdlib resolves them by preopen name.
  __wasiInitFS({
    root: '',
    preopens: [
      { wasiPath: '/',     vfsPath: '' },
      { wasiPath: '/tmp',  vfsPath: 'tmp' },
      { wasiPath: '/home', vfsPath: 'home' },
    ],
    pid,
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
    // Stated, not defaulted. A host that cannot park a guest answers every
    // syscall from the authority's synchronous view, so nothing here blocks —
    // and saying so is what makes a syscall that blocks anyway fail loudly
    // instead of returning a Promise where the guest expects an errno.
    parking: __nimbusRubyParking,
    getMemory: () => memRef,
    // A resident process also streams what it writes; see ruby-resident.ts.
    stdoutBytes: (bytes) => __nimbusRubyOutput.stdoutBytes(bytes),
    stderrBytes: (bytes) => __nimbusRubyOutput.stderrBytes(bytes),
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
  delete __nimbusRubyStderrControl.values.resumed;
  await __nimbusRubyEval(boot, [
    '$__nimbus_resumed = ($__nimbus_main && $__nimbus_main.alive?) ? (begin; $__nimbus_main.resume; true; ' +
      'rescue Exception => e; $stderr.write(e.full_message(highlight: false, order: :top)); $__nimbus_exit = 1; false; end) : false',
    '$stderr.write("__NIMBUS_RESUMED_" + $__nimbus_resumed.to_s' +
      ' + "_" + (($__nimbus_main && $__nimbus_main.alive?) ? "1" : "0")' +
      ' + "_" + ((defined?(Nimbus::Threading) && Nimbus::Threading.host_driven) ? "1" : "0")' +
      ' + "_" + ($__nimbus_wake_after ? $__nimbus_wake_after.to_s : "nil") + "\\n")',
  ].join("\\n"));
  await __nimbusRubyOutput.drain();
  const marker = __nimbusRubyStderrControl.values.resumed?.split('_');
  const wake = marker && marker[3] !== 'nil' ? Number(marker[3]) : NaN;
  return {
    resumed: !!marker && marker[0] === 'true',
    alive: !!marker && marker[1] === '1',
    hostDriven: !!marker && marker[2] === '1',
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
  __nimbusRubyBindOutput(args);
  const result = await __rubyRunOnce(args);
  await __nimbusRubyOutput.drain();
  const stdoutControl = __nimbusRubyStdoutControl;
  const stderrControl = __nimbusRubyStderrControl;
  __nimbusRubyStdoutControl = null;
  __nimbusRubyStderrControl = null;
  const stdoutTail = stdoutControl?.finish();
  const stderrTail = stderrControl?.finish();
  if (stdoutTail?.length) __nimbusRubyOutput.stdoutBytes(stdoutTail);
  if (stderrTail?.length) __nimbusRubyOutput.stderrBytes(stderrTail);
  const lost = await __nimbusRubyOutput.drain();
  __nimbusRubyStderrControl = stderrControl;
  if (stdoutControl) result.control = stdoutControl.values;
  return lost ? { ...result, exitCode: result.exitCode || 1, error: result.error ? result.error + '; ' + lost : lost } : result;
};
async function __rubyRunOnce(args) {

  const boot = await globalThis.__rubyBootstrap;
  if (!boot.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "",
      error: 'ruby bootstrap failed: ' + (boot.error || 'unknown') + (boot.stack ? ' [stack=' + boot.stack + ']' : ''),
    };
  }

  try {
    __nimbusInstallRubyFs(args.supervisorPid || 0);
    // AFTER the mount, never before. __wasiInitFS deliberately drops the
    // supervisor so a pooled isolate cannot serve the previous tenant's
    // filesystem, which means adopting first — as both ruby entry points do,
    // since they must adopt before they know whether a mount is coming —
    // leaves the guest with no filesystem for the whole script load: every
    // require answers EBADF.
    __wasiAdoptSupervisor(globalThis.__nimbusRubySupervisor);
  } catch (e) {
    globalThis.__nimbusRubyWriteDiagnostic('[ruby-runner] VFS mount failed: ' + (e && e.message) + '\\n');
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
        stdout: "",
        stderr: "",
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
        stdout: "",
        stderr: "",
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
  const cwdRefusalRb = rubyStringLiteral(args.binName + ": can't enter working directory '" + (args.cwd || '/home/user') + "': ");

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
    // A cwd it cannot enter fails the run before the program starts (the
    // body below), as a shell's cd fails, rather than running it in '/'. A
    // step that continues a VM (a prompt's next line) names no cwd and keeps
    // the directory the program left.
    '$__nimbus_cwd_error = nil',
    ...(args.cwd === undefined ? [] : ['begin; Dir.chdir(' + cwdRb + '); rescue SystemCallError => e; $__nimbus_cwd_error = e; end']),
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
    '    if $__nimbus_cwd_error',
    '      $stderr.write(' + cwdRefusalRb + ' + "[Errno #{$__nimbus_cwd_error.errno}] #{SystemCallError.new(nil, $__nimbus_cwd_error.errno).message}\\\\n")',
    '      raise SystemExit.new(1)',
    '    end',
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
      stdout: "",
      stderr: "",
      error: 'ruby prelude threw: ' + (e && e.message),
    };
  }
  if (preludeStatus && preludeStatus.status !== 0) {
    globalThis.__nimbusRubyWriteDiagnostic('[ruby-runner-diag] prelude returned non-zero status: ' + preludeStatus.status + '\\n');
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
      stdout: "",
      stderr: "",
      error: 'rb-eval-string-protect threw: ' + (e && e.message),
    };
  }
  if (evalStatus && evalStatus.status !== 0) {
    globalThis.__nimbusRubyWriteDiagnostic('[ruby-runner-diag] user wrapper returned non-zero status: ' + evalStatus.status + '\\n');
  }

  // Exit status is private control metadata on the same live stderr path.
  const NIMBUS_EXIT_MARKER = '__NIMBUS_RUBY_EXIT_';
  let exitCode = 0;
  try {
    // Print the marker + exit code to stderr (a side channel separate
    // from user-visible stdout). We strip it before returning.
    await callEvalStringProtect(
      '$stderr.write(' + JSON.stringify(NIMBUS_EXIT_MARKER) + ' + $__nimbus_exit.to_s + "\\\\n")'
    );
    await __nimbusRubyOutput.drain();
    const code = Number.parseInt(__nimbusRubyStderrControl.values.exit, 10);
    if (Number.isFinite(code)) exitCode = code;
  } catch (e) {
    // Failure to read exit code → assume 0 if no errors observed.
    exitCode = 0;
  }

  return {
    exitCode: exitCode,
    stdout: '',
    stderr: '',
  };
}

// ── END: ruby-runner preamble ──────────────────────────────────────
`;
