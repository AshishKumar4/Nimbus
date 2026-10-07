/**
 * ruby-repl.ts — Ruby REPL adapter.
 *
 * Mirrors python-repl.ts pattern: a long-lived child-facet holds the
 * Ruby VM (instantiated once at facet module-init via the ruby-runner
 * preamble) and per-push calls go through __rubyRun with a generated
 * line wrapper.
 *
 * Approach to result-handling + incomplete detection:
 *   - The wrapper Ruby code captures the LAST line as an expression
 *     where possible (via Kernel#eval at TOPLEVEL_BINDING) and writes
 *     `inspect`'d result to stdout if non-nil.
 *   - SyntaxError-incomplete detection: try Ripper.sexp(src); if nil,
 *     the source has an unterminated construct and we signal
 *     'incomplete'. Ripper ships with ruby.wasm 2.9.x stdlib.
 *     Fallback: if Ripper is unavailable, parse the SyntaxError
 *     message for "unexpected end-of-input" / "unterminated" patterns.
 *   - SystemExit: rescue and return exit_code.
 *
 * Architecture aligned with master plan §1 A5 (~280 LOC).
 *
 * NOT supported in v1 (deferred):
 *   - Top-level Ractor / Fiber.yield at the REPL.
 *   - Ctrl-C mid-execution.
 *   - irb history pickling.
 */
import { ReplSession } from './repl-session.js';
import { buildRubyPreamble } from '@nimbus-sh/core/runtime/ruby-runner.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { withHostView } from '@nimbus-sh/core/runtime/process-files.js';
import { toArrayBuffer } from '@nimbus-sh/core/_shared/bytes.js';
import { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { getFacetManagerLoaderHost } from './facet-loader-host.js';
class RubyReplAdapter {
    pool = null;
    deps;
    wasmBytesAB = null;
    ps1 = 'irb> ';
    ps2 = 'irb* ';
    constructor(deps) {
        this.deps = deps;
    }
    banner() {
        return ('Ruby 3.3.4 (Nimbus / ruby.wasm 2.9.x)\r\n' +
            'Type "exit" or press Ctrl-D to exit.\r\n');
    }
    async push(source) {
        // Special-case exit literally for cheaper response.
        const trimmed = source.trim();
        if (trimmed === 'exit' || trimmed === 'quit' || trimmed === 'exit()') {
            return { kind: 'exit', exitCode: 0 };
        }
        try {
            await this.ensurePool();
        }
        catch (e) {
            return { kind: 'error', stderr: `[ruby-repl] bootstrap failed: ${e?.message || e}\n` };
        }
        // Build the wrapper Ruby code. We:
        //   1. Use Ripper.sexp(source) to test for incomplete input. nil → incomplete.
        //   2. Wrap the eval in begin/rescue. Catch SystemExit, capture status.
        //   3. eval(src, TOPLEVEL_BINDING) — preserves user-defined ivars/locals
        //      at the top-level binding across REPL submits.
        //   4. If the eval returned a non-nil result, print "=> #{result.inspect}\n"
        //      mimicking irb's display convention.
        //
        // The src is encoded as base64 to avoid string-escape hazards on
        // multi-line input (heredocs, embedded quotes, unicode).
        // Pass source via a base64-encoded literal to avoid string-escape
        // hazards on multi-line input. The driver:
        //   - Tries Ripper.sexp for incomplete-detection if available
        //     (ruby.wasm stdlib may not include ripper). Fall back to a
        //     SyntaxError-message heuristic.
        //   - eval(source, TOPLEVEL_BINDING) preserves user-defined vars
        //     across submits.
        //   - irb-style `=> result.inspect` for non-nil result.
        //   - SystemExit → exit with status.
        //   - Other exceptions → write to $stderr and continue.
        const srcB64 = btoa(unescape(encodeURIComponent(source)));
        const driver = [
            'require "base64"',
            '__nimbus_src = Base64.decode64("' + srcB64 + '")',
            '__nimbus_incomplete = false',
            'begin',
            '  require "ripper"',
            '  __nimbus_incomplete = true if Ripper.sexp(__nimbus_src).nil?',
            'rescue LoadError',
            '  # ripper unavailable; rely on SyntaxError-message fallback',
            'end',
            'if __nimbus_incomplete',
            '  $stdout.print "__NIMBUS_INCOMPLETE__"',
            'else',
            '  begin',
            '    __nimbus_result = eval(__nimbus_src, TOPLEVEL_BINDING)',
            '    unless __nimbus_result.nil?',
            '      $stdout.print "=> "',
            '      $stdout.puts __nimbus_result.inspect',
            '    end',
            '  rescue SystemExit => __nimbus_se',
            '    Kernel.exit(__nimbus_se.status)',
            '  rescue SyntaxError => __nimbus_syn',
            '    msg = __nimbus_syn.message.to_s',
            '    if msg =~ /unexpected end-of-input|unterminated/',
            '      $stdout.print "__NIMBUS_INCOMPLETE__"',
            '    else',
            '      $stderr.puts "SyntaxError: " + msg',
            '    end',
            '  rescue Exception => __nimbus_exc',
            '    $stderr.puts __nimbus_exc.class.to_s + ": " + __nimbus_exc.message.to_s',
            '  end',
            'end',
        ].join('\n');
        let result;
        try {
            result = await this.submitFacetFn(driver);
        }
        catch (e) {
            return { kind: 'error', stderr: `[ruby-repl] dispatch failed: ${e?.message || e}\n` };
        }
        // Sentinel handling: if stdout ends with __NIMBUS_INCOMPLETE__ marker,
        // signal incomplete.
        if (result.control?.incomplete !== undefined) {
            return { kind: 'incomplete' };
        }
        // Non-zero exit code from Ruby = user called exit / process aborted.
        // A runner-level failure (result.error) must reach the terminal: it is
        // the only account of WHY the session is ending, and dropping it turns
        // a broken interpreter into a silent exit to the shell.
        if (result.exitCode !== 0 && result.exitCode !== undefined) {
            return {
                kind: 'exit',
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: (result.stderr || '') + (result.error ? `[ruby-repl] ${result.error}\n` : ''),
            };
        }
        return { kind: 'output', stdout: result.stdout || '', stderr: result.stderr || '' };
    }
    async close() {
        if (this.pool) {
            try {
                this.pool.dispose();
            }
            catch { /* fail-soft */ }
            this.pool = null;
        }
    }
    async ensurePool() {
        if (this.pool)
            return;
        const { installRoot, facetMgr } = this.deps;
        const wasmPath = `${installRoot}/share/ruby/ruby+stdlib.wasm`;
        this.wasmBytesAB = toArrayBuffer(await withHostView(this.deps.authority, CRED_KERNEL, async (vfs) => {
            if (!(await vfs.exists(wasmPath))) {
                throw new Error(`ruby+stdlib.wasm missing at ${wasmPath} (run 'nimbus install ruby')`);
            }
            return vfs.readFile(wasmPath);
        }));
        // The one canonical Ruby facet preamble. A hand-rolled copy here once
        // drifted (it lacked the language-prelude const __rubyRun requires, so
        // every REPL eval died on boot) — compose it in exactly one place.
        const preamble = buildRubyPreamble();
        const { env, ctx, network } = getFacetManagerLoaderHost(facetMgr);
        // The caller's filesystem, under the caller's credential: the prompt
        // starts in the shell's working directory and reads and writes there.
        this.pool = new IsolatePool(env, ctx, {
            tag: 'ruby-repl',
            concurrency: 1,
            supervisorPid: this.deps.pid,
            processSupervisor: supervisorBindingProps(ctx, this.deps.pid, { writerId: crypto.randomUUID() }),
            preamble,
            // The workspace's, as every facet a manager's runtimes open (facetHostForManager).
            network,
        });
    }
    async submitFacetFn(userCode) {
        const { pool, wasmBytesAB } = this;
        if (!pool || !wasmBytesAB)
            throw new Error('Ruby REPL is not initialized');
        const { home, cwd, binName } = this.deps;
        const step = { userCode, home, cwd, binName, supervisorPid: this.deps.pid };
        return await pool.submit(rubyReplStepFacetFn, step, {
            wasmModules: { 'ruby+stdlib.wasm': wasmBytesAB },
            timeoutMs: 60_000,
        });
    }
}
/**
 * Facet-side function. Self-contained — serialized via fn.toString();
 * no closure captures, no class refs, no bare 'this' word.
 *
 * Calls globalThis.__rubyRun (installed by RUBY_RUNNER_PREAMBLE_TAIL)
 * with the user code wrapped by the driver above, in the caller's working
 * directory, over the caller's filesystem (the pool's SUPERVISOR), as the
 * one-shot runner's entry does.
 */
export function rubyReplStepFacetFn(args, facetEnv) {
    const g = globalThis;
    return (async function () {
        const fn = g.__rubyRun;
        if (typeof fn !== 'function') {
            return {
                stdout: '', stderr: '', exitCode: 127,
                error: 'ruby-repl preamble missing: __rubyRun not in scope',
            };
        }
        const adopt = g.__wasiAdoptSupervisor;
        const supervisor = facetEnv && facetEnv.SUPERVISOR;
        // Published where __rubyRun re-adopts it after the mount; adopting only
        // here would be undone by __wasiInitFS.
        if (supervisor)
            Reflect.set(globalThis, '__nimbusRubySupervisor', supervisor);
        adopt?.(supervisor);
        // The prompt starts in the shell's cwd once per VM; a later line keeps
        // whatever directory the program's own Dir.chdir left.
        const started = Reflect.get(globalThis, '__nimbusRubyPromptStarted') === true;
        Reflect.set(globalThis, '__nimbusRubyPromptStarted', true);
        const r = await fn({
            userCode: args.userCode,
            rbArgv: ['ruby', '-e', args.userCode],
            userEnv: { HOME: args.home },
            progName: 'ruby',
            binName: args.binName,
            cwd: started ? undefined : args.cwd,
            supervisorPid: args.supervisorPid,
            outputControls: [{ key: 'incomplete', prefix: '__NIMBUS_INCOMPLETE__' }],
        });
        return {
            stdout: r.stdout || '',
            stderr: r.stderr || '',
            exitCode: typeof r.exitCode === 'number' ? r.exitCode : 0,
            error: r.error,
            control: r.control,
        };
    })();
}
/**
 * Top-level wrapper: builds a Ruby REPL adapter, drives a ReplSession
 * to completion, returns the exit code. Called from the ruby factory's
 * wrapper in init.ts when `ruby` is invoked with no args.
 */
export async function runRubyRepl(deps) {
    const adapter = new RubyReplAdapter(deps);
    const session = new ReplSession(adapter, deps.terminal);
    return await session.run();
}
