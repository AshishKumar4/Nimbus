/**
 * bun-repl.ts — Bun REPL adapter.
 *
 * Bun is native (workerd nodejs_compat) — no facet-bootstrap like
 * Pyodide. We dispatch eval through a long-lived child-facet that
 * holds a vm.Context across submits, so user-defined variables /
 * functions / imports persist.
 *
 * Design:
 *   - One child-facet per REPL session (NimbusLoaderPool with
 *     concurrency=1, omitSupervisor=true).
 *   - Facet-side: globalThis.__nimbus_bun_ctx caches a vm.createContext()
 *     dict; each push() runs vm.runInContext(line, ctx) and returns
 *     {stdout, stderr, isIncomplete, isExit}.
 *   - Continuation detection: probe parse via `new Function(...code)`
 *     wrapped in try/catch — recoverable SyntaxError patterns
 *     (per Node's repl.Recoverable shape) → incomplete.
 *   - Expression displayhook: vm.runInContext returns the last
 *     expression value; if !== undefined, util.inspect(value) → stdout.
 *   - Exit: override process.exit inside the context to throw a
 *     sentinel; catch sentinel → kind:'exit'.
 *
 * NOT supported in v1 (deferred):
 *   - Top-level await at the REPL prompt (Bun supports this natively
 *     but vm.runInContext doesn't unwrap top-level await — would need
 *     vm.SourceTextModule or evaluation pre-wrap).
 *   - Ctrl-C mid-execution (no SIGINT plumbing across facet boundary).
 *   - Tab-completion.
 *
 * No setTimeout / sleep / retry / defensive-catch on hot paths. Errors
 * thrown by vm bubble up; we surface them as stderr via the runtime
 * stderr capture.
 */

import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { ReplAdapter, ReplPushResult } from './repl-session.js';
import { ReplSession } from './repl-session.js';
import { BUN_SHIM_PREAMBLE, BUN_VERSION } from './bun-runner.js';

export interface BunReplDeps {
  facetMgr: FacetManager;
  terminal: WebSocketTerminal;
}

/** Result returned by the REPL-step facet fn. */
interface BunReplFacetResult {
  stdout: string;
  stderr: string;
  incomplete?: boolean;
  exit?: boolean;
  exitCode?: number;
  error?: string;
}

class BunReplAdapter implements ReplAdapter {
  private pool: any = null;
  private initDone: boolean = false;
  private deps: BunReplDeps;

  ps1: string = '> ';
  ps2: string = '... ';

  constructor(deps: BunReplDeps) {
    this.deps = deps;
  }

  banner(): string {
    return (
      `Bun ${BUN_VERSION} (Nimbus)\r\n` +
      'Type ".exit" or press Ctrl-D to exit.\r\n'
    );
  }

  async push(source: string): Promise<ReplPushResult> {
    // Surface dotted commands the way Node's repl does: .exit, .clear, .help.
    const trimmed = source.trim();
    if (trimmed === '.exit') {
      return { kind: 'exit', exitCode: 0 };
    }
    if (trimmed === '.help') {
      return {
        kind: 'output',
        stdout: '.exit  Exit the REPL\r\n.help  Print this help\r\n.clear Reset context\r\n',
        stderr: '',
      };
    }
    if (trimmed === '.clear') {
      this.initDone = false;
      return { kind: 'output', stdout: 'Context cleared.\r\n', stderr: '' };
    }
    try {
      await this.ensurePool();
    } catch (e: any) {
      return { kind: 'error', stderr: `[bun-repl] bootstrap failed: ${e?.message || e}\n` };
    }
    if (!this.initDone) {
      try {
        const initResult = await this.submitFacetFn({ mode: 'init' });
        if (initResult.error) {
          return { kind: 'error', stderr: `[bun-repl] init failed: ${initResult.error}\n` };
        }
        this.initDone = true;
      } catch (e: any) {
        return { kind: 'error', stderr: `[bun-repl] init dispatch failed: ${e?.message || e}\n` };
      }
    }

    let result: BunReplFacetResult;
    try {
      result = await this.submitFacetFn({ mode: 'push', source });
    } catch (e: any) {
      return { kind: 'error', stderr: `[bun-repl] push dispatch failed: ${e?.message || e}\n` };
    }

    if (result.exit) {
      return {
        kind: 'exit',
        exitCode: result.exitCode || 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    if (result.incomplete) {
      return { kind: 'incomplete' };
    }
    return { kind: 'output', stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  async close(): Promise<void> {
    if (this.pool) {
      try { this.pool.dispose?.(); } catch { /* fail-soft */ }
      this.pool = null;
    }
    this.initDone = false;
  }

  private async ensurePool(): Promise<void> {
    if (this.pool) return;
    const { facetMgr } = this.deps;
    const env = (facetMgr as any).env;
    const ctx = (facetMgr as any).ctx;
    // Preamble: install the Bun shim global at facet startup so the
    // REPL context has Bun.* available like real Bun does.
    const preamble = BUN_SHIM_PREAMBLE;
    const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
    this.pool = new NimbusLoaderPool(env, ctx, {
      tag: 'bun-repl',
      concurrency: 1,
      omitSupervisor: true,
      preamble,
    });
  }

  private async submitFacetFn(args: { mode: 'init' | 'push'; source?: string }):
      Promise<BunReplFacetResult> {
    return await this.pool.submit(bunReplStepFacetFn, args, {
      timeoutMs: 60_000,
    });
  }
}

/**
 * Facet-side function. Self-contained — serialized via fn.toString()
 * across the LOADER boundary, so no closure captures, no class refs.
 *
 * Modes:
 *   - 'init': create vm.createContext() with Bun shim already in
 *     globalThis (from preamble), stash on globalThis.__nimbus_bun_ctx.
 *   - 'push': vm.runInContext(args.source, ctx); capture stdout/stderr
 *     via console hooks; detect SyntaxError-incomplete; detect
 *     process.exit sentinel.
 */
function bunReplStepFacetFn(
  args: { mode: 'init' | 'push'; source?: string },
): Promise<BunReplFacetResult> {
  const g: any = globalThis as any;

  return (async function () {
    if (args.mode === 'init') {
      // workerd's node:vm is a stub (per CF docs: "partially supported,
      // non-functional"). runInContext throws "not implemented". Use a
      // direct Function-based eval against the facet's globalThis,
      // with console overridden to capture stdout/stderr and a
      // process.exit override for SystemExit semantics.
      // @ts-ignore — node:util via workerd nodejs_compat at runtime.
      const utilMod = await import('node:util');
      g.__nimbus_bun_util = utilMod;
      g.__nimbus_bun_stdout = [];
      g.__nimbus_bun_stderr = [];
      // Override console on globalThis so user-written console.log
      // routes through capture buffers. process.exit override via
      // a property mutation.
      const stdoutPush = (xs: any[]) =>
        g.__nimbus_bun_stdout.push(xs.map((x: any) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n');
      const stderrPush = (xs: any[]) =>
        g.__nimbus_bun_stderr.push(xs.map((x: any) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n');
      // Preserve any pre-existing console for the supervisor's own logging.
      g.__nimbus_bun_orig_console = g.console;
      g.console = {
        log: (...xs: any[]) => stdoutPush(xs),
        error: (...xs: any[]) => stderrPush(xs),
        warn: (...xs: any[]) => stderrPush(xs),
        info: (...xs: any[]) => stdoutPush(xs),
        debug: (...xs: any[]) => stdoutPush(xs),
      };
      // process.exit override: throw a sentinel that the eval catches.
      if (g.process && typeof g.process === 'object') {
        g.__nimbus_bun_orig_exit = g.process.exit;
        g.process.exit = function (code?: number) {
          const err: any = new Error('__nimbus_bun_exit__');
          err.__nimbus_exit_code = typeof code === 'number' ? code : 0;
          throw err;
        };
      }
      return { stdout: '', stderr: '' };
    }

    const source = args.source || '';
    const utilMod = g.__nimbus_bun_util;
    if (!utilMod) {
      return { stdout: '', stderr: '', error: 'bun repl not initialised' };
    }
    const stdoutStart = g.__nimbus_bun_stdout.length;
    const stderrStart = g.__nimbus_bun_stderr.length;

    // Recoverable-syntax detection: wrap user source in a Function ctor
    // call; if it throws specific 'Unexpected end of input'-class
    // messages, signal incomplete to the host.
    try {
      new Function('(function(){\n' + source + '\n})');
    } catch (parseErr: any) {
      const msg = parseErr?.message || '';
      const incompletePatterns = [
        /Unexpected end of input/i,
        /Unterminated template literal/i,
        /Unterminated string constant/i,
        /missing \) after argument list/i,
        /Unexpected token \}/i,
      ];
      if (incompletePatterns.some((re) => re.test(msg))) {
        return {
          stdout: g.__nimbus_bun_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_bun_stderr.slice(stderrStart).join(''),
          incomplete: true,
        };
      }
    }

    // Eval the source. Try expression-mode first (wrap in parens) so
    // `1+2` yields a value for displayhook; on SyntaxError fall back to
    // statement-mode. `(0, eval)` invokes indirect eval so var/let/const
    // bindings go to globalThis, giving state persistence across pushes.
    let result: any;
    let evaluatedAs: 'expr' | 'stmt' = 'stmt';
    try {
      // Indirect eval at global scope. Expression wrapping with newline
      // before/after avoids ASI hazards on lines ending with operators.
      result = (0, eval)('(' + source + '\n)');
      evaluatedAs = 'expr';
    } catch (exprErr: any) {
      if (exprErr && exprErr.__nimbus_exit_code !== undefined) {
        return {
          stdout: g.__nimbus_bun_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_bun_stderr.slice(stderrStart).join(''),
          exit: true,
          exitCode: exprErr.__nimbus_exit_code,
        };
      }
      try {
        result = (0, eval)(source);
        evaluatedAs = 'stmt';
      } catch (stmtErr: any) {
        if (stmtErr && stmtErr.__nimbus_exit_code !== undefined) {
          return {
            stdout: g.__nimbus_bun_stdout.slice(stdoutStart).join(''),
            stderr: g.__nimbus_bun_stderr.slice(stderrStart).join(''),
            exit: true,
            exitCode: stmtErr.__nimbus_exit_code,
          };
        }
        const errStr = (stmtErr && stmtErr.stack) || String(stmtErr);
        return {
          stdout: g.__nimbus_bun_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_bun_stderr.slice(stderrStart).join('') + errStr + '\n',
        };
      }
    }

    // Resolve thenables — user code may return a Promise from an
    // expression (e.g. `fetch('/api')`). Await it so the displayhook
    // shows the resolved value, not "[object Promise]".
    if (result && typeof result.then === 'function') {
      try {
        result = await result;
      } catch (awaitErr: any) {
        const errStr = (awaitErr && awaitErr.stack) || String(awaitErr);
        return {
          stdout: g.__nimbus_bun_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_bun_stderr.slice(stderrStart).join('') + errStr + '\n',
        };
      }
    }

    if (evaluatedAs === 'expr' && result !== undefined) {
      let rendered: string;
      try {
        rendered = utilMod.inspect(result, { colors: false, depth: 4 });
      } catch (_e) {
        rendered = '<inspect failed>';
      }
      g.__nimbus_bun_stdout.push(rendered + '\n');
    }

    return {
      stdout: g.__nimbus_bun_stdout.slice(stdoutStart).join(''),
      stderr: g.__nimbus_bun_stderr.slice(stderrStart).join(''),
    };
  })();
}

/**
 * Top-level wrapper: builds a Bun REPL adapter, drives a ReplSession
 * to completion, returns the exit code. Called from the bun factory's
 * wrapper in init.ts when `bun` is invoked with no args.
 */
export async function runBunRepl(deps: BunReplDeps): Promise<number> {
  const adapter = new BunReplAdapter(deps);
  const session = new ReplSession(adapter, deps.terminal);
  return await session.run();
}
