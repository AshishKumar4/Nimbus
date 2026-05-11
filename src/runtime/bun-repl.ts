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
      // @ts-ignore — node:vm provided by workerd's nodejs_compat at runtime;
      // not in TS typings unless @types/node is wired in.
      const vmMod = await import('node:vm');
      // @ts-ignore — node:util via nodejs_compat at runtime.
      const utilMod = await import('node:util');
      g.__nimbus_bun_util = utilMod;
      // Build a context sandbox that exposes a curated set of globals.
      // Console output is captured via overrides on the sandbox console;
      // process.exit is overridden to throw a sentinel.
      const sandbox: any = {
        globalThis: null as any,
        console: {
          log: (...xs: any[]) => g.__nimbus_bun_stdout.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
          error: (...xs: any[]) => g.__nimbus_bun_stderr.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
          warn: (...xs: any[]) => g.__nimbus_bun_stderr.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
          info: (...xs: any[]) => g.__nimbus_bun_stdout.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
          debug: (...xs: any[]) => g.__nimbus_bun_stdout.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
        },
        process: new Proxy((globalThis as any).process || {}, {
          get(target: any, prop: string | symbol) {
            if (prop === 'exit') {
              return function (code?: number) {
                const err: any = new Error('__nimbus_bun_exit__');
                err.__nimbus_exit_code = typeof code === 'number' ? code : 0;
                throw err;
              };
            }
            return target[prop as any];
          },
        }),
        // Surface common globals user code expects.
        Bun: g.Bun,
        Buffer: g.Buffer,
        URL: g.URL,
        URLSearchParams: g.URLSearchParams,
        TextEncoder: g.TextEncoder,
        TextDecoder: g.TextDecoder,
        fetch: g.fetch,
        crypto: g.crypto,
        atob: g.atob,
        btoa: g.btoa,
        setTimeout: g.setTimeout,
        setInterval: g.setInterval,
        clearTimeout: g.clearTimeout,
        clearInterval: g.clearInterval,
        require: (globalThis as any).require,
      };
      sandbox.globalThis = sandbox;
      g.__nimbus_bun_stdout = [];
      g.__nimbus_bun_stderr = [];
      g.__nimbus_bun_ctx = vmMod.createContext(sandbox);
      g.__nimbus_bun_vm = vmMod;
      return { stdout: '', stderr: '' };
    }

    const source = args.source || '';
    const vmMod = g.__nimbus_bun_vm;
    const ctx = g.__nimbus_bun_ctx;
    const utilMod = g.__nimbus_bun_util;
    if (!vmMod || !ctx) {
      return { stdout: '', stderr: '', error: 'bun repl context not initialised' };
    }
    const stdoutStart = g.__nimbus_bun_stdout.length;
    const stderrStart = g.__nimbus_bun_stderr.length;

    // Pre-parse via Function constructor to detect recoverable SyntaxError.
    // Node's repl uses an equivalent isRecoverable() helper; we mirror
    // the heuristics. Strategy:
    //   - Try `new Function("(function () { return (\n" + src + "\n); })")`
    //     — when Function ctor throws "Unexpected end of input"-class
    //     message, the input is incomplete.
    //   - Otherwise, run vm.runInContext directly; SyntaxError there is a
    //     real syntax error (surfaced as stderr).
    try {
      new Function('(function(){\n' + source + '\n})');
    } catch (parseErr: any) {
      const msg = parseErr?.message || '';
      // Patterns Node's repl recognises as incomplete:
      const incompletePatterns = [
        /Unexpected end of input/i,
        /Unterminated template literal/i,
        /Unterminated string constant/i,
        /missing \) after argument list/i,
        /Unexpected token \}/i,  // unbalanced brace inside multiline
      ];
      if (incompletePatterns.some((re) => re.test(msg))) {
        return {
          stdout: g.__nimbus_bun_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_bun_stderr.slice(stderrStart).join(''),
          incomplete: true,
        };
      }
      // Real syntax error — fall through to vm.runInContext which will
      // emit a parseable error message.
    }

    // Wrap expression statements so they yield a value for displayhook.
    // Heuristic: if source starts with '{' it might be a block; otherwise
    // try wrapping as expression first; on SyntaxError fall back to
    // statement-mode.
    let result: any;
    let evaluatedAs: 'expr' | 'stmt' = 'stmt';
    try {
      // Expression mode: wrap in parens.
      result = vmMod.runInContext('(' + source + '\n)', ctx, {
        breakOnSigint: false,
        timeout: 30_000,
        displayErrors: false,
      });
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
      // Statement mode — assignment, function decl, etc.
      try {
        result = vmMod.runInContext(source, ctx, {
          breakOnSigint: false,
          timeout: 30_000,
          displayErrors: false,
        });
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
        // Genuine runtime/syntax error in user code.
        const errStr = (stmtErr && stmtErr.stack) || String(stmtErr);
        return {
          stdout: g.__nimbus_bun_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_bun_stderr.slice(stderrStart).join('') + errStr + '\n',
        };
      }
    }

    // Displayhook: if expression mode produced a non-undefined value, render it.
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
