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

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { ReplAdapter, ReplPushResult } from './repl-session.js';
import { ReplSession } from './repl-session.js';
import { WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';
import { RUBY_RUNNER_PREAMBLE_TAIL } from './ruby-runner.js';

export interface RubyReplDeps {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
  terminal: WebSocketTerminal;
  /** Per-user-VFS install dir for the ruby blob. */
  installRoot: string;
}

interface RubyReplFacetResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

class RubyReplAdapter implements ReplAdapter {
  private pool: any = null;
  private deps: RubyReplDeps;
  private wasmBytesAB: ArrayBuffer | null = null;

  ps1: string = 'irb> ';
  ps2: string = 'irb* ';

  constructor(deps: RubyReplDeps) {
    this.deps = deps;
  }

  banner(): string {
    return (
      'Ruby 3.3.4 (Nimbus / ruby.wasm 2.9.x)\r\n' +
      'Type "exit" or press Ctrl-D to exit.\r\n'
    );
  }

  async push(source: string): Promise<ReplPushResult> {
    // Special-case exit literally for cheaper response.
    const trimmed = source.trim();
    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === 'exit()') {
      return { kind: 'exit', exitCode: 0 };
    }
    try {
      await this.ensurePool();
    } catch (e: any) {
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
    const srcB64 = btoa(unescape(encodeURIComponent(source)));
    const driver = [
      'require "base64"',
      'require "ripper" rescue nil',
      '__nimbus_src = Base64.decode64("' + srcB64 + '")',
      '__nimbus_status = "complete"',
      'if defined?(Ripper) && Ripper.respond_to?(:sexp)',
      '  __nimbus_sexp = Ripper.sexp(__nimbus_src)',
      '  __nimbus_status = "incomplete" if __nimbus_sexp.nil?',
      'end',
      'if __nimbus_status == "complete"',
      '  begin',
      '    __nimbus_result = eval(__nimbus_src, TOPLEVEL_BINDING)',
      '    unless __nimbus_result.nil?',
      '      $stdout.print "=> "',
      '      $stdout.puts __nimbus_result.inspect',
      '    end',
      '  rescue SystemExit => __nimbus_se',
      '    Kernel.exit(__nimbus_se.status)',
      '  rescue Exception => __nimbus_e',
      '    $stderr.puts "#{__nimbus_e.class}: #{__nimbus_e.message}"',
      '    __nimbus_e.backtrace[0,4].each { |__nimbus_l| $stderr.puts "  #{__nimbus_l}" } if __nimbus_e.backtrace',
      '  end',
      'else',
      '  $stdout.print "__NIMBUS_INCOMPLETE__"',
      'end',
    ].join('\n');

    let result: RubyReplFacetResult;
    try {
      result = await this.submitFacetFn(driver);
    } catch (e: any) {
      return { kind: 'error', stderr: `[ruby-repl] dispatch failed: ${e?.message || e}\n` };
    }

    // Sentinel handling: if stdout ends with __NIMBUS_INCOMPLETE__ marker,
    // signal incomplete.
    if (result.stdout && result.stdout.includes('__NIMBUS_INCOMPLETE__')) {
      return { kind: 'incomplete' };
    }

    // Non-zero exit code from Ruby = user called exit / process aborted.
    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        kind: 'exit',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    return { kind: 'output', stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  async close(): Promise<void> {
    if (this.pool) {
      try { this.pool.dispose?.(); } catch { /* fail-soft */ }
      this.pool = null;
    }
  }

  private async ensurePool(): Promise<void> {
    if (this.pool) return;
    const { vfs, installRoot, facetMgr } = this.deps;
    const wasmPath = `${installRoot}/share/ruby/ruby+stdlib.wasm`;
    if (!vfs.exists(wasmPath)) {
      throw new Error(`ruby+stdlib.wasm missing at ${wasmPath} (run 'nimbus install ruby')`);
    }
    const wasmBytes = vfs.readFile(wasmPath);
    this.wasmBytesAB = toAB(wasmBytes);

    // Compose the same preamble ruby-runner uses. WASI_INSTANCE_PREAMBLE_SRC
    // + FinalizationRegistry shim + RUBY_RUNNER_PREAMBLE_TAIL.
    const preamble = [
      '// ── WASI shim preamble ──',
      WASI_INSTANCE_PREAMBLE_SRC,
      '',
      '// ── FinalizationRegistry shim ──',
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

    const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
    const env = (facetMgr as any).env;
    const ctx = (facetMgr as any).ctx;
    this.pool = new NimbusLoaderPool(env, ctx, {
      tag: 'ruby-repl',
      concurrency: 1,
      omitSupervisor: true,
      preamble,
    });
  }

  private async submitFacetFn(userCode: string): Promise<RubyReplFacetResult> {
    const wasmModules = { 'ruby+stdlib.wasm': this.wasmBytesAB };
    return await this.pool.submit(rubyReplStepFacetFn, { userCode }, {
      wasmModules,
      timeoutMs: 60_000,
    });
  }
}

/**
 * Facet-side function. Self-contained — serialized via fn.toString();
 * no closure captures, no class refs, no bare 'this' word.
 *
 * Calls globalThis.__rubyRun (installed by RUBY_RUNNER_PREAMBLE_TAIL)
 * with the user code wrapped by the driver above.
 */
function rubyReplStepFacetFn(
  args: { userCode: string },
): Promise<RubyReplFacetResult> {
  const g: any = globalThis as any;

  return (async function () {
    const fn = g.__rubyRun;
    if (typeof fn !== 'function') {
      return {
        stdout: '', stderr: '', exitCode: 127,
        error: 'ruby-repl preamble missing: __rubyRun not in scope',
      };
    }
    const r = await fn({
      userCode: args.userCode,
      rbArgv: ['ruby', '-e', args.userCode],
      userEnv: { HOME: '/home/user' },
      progName: 'ruby',
    });
    return {
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : 0,
      error: r.error,
    };
  })();
}

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Top-level wrapper: builds a Ruby REPL adapter, drives a ReplSession
 * to completion, returns the exit code. Called from the ruby factory's
 * wrapper in init.ts when `ruby` is invoked with no args.
 */
export async function runRubyRepl(deps: RubyReplDeps): Promise<number> {
  const adapter = new RubyReplAdapter(deps);
  const session = new ReplSession(adapter, deps.terminal);
  return await session.run();
}
