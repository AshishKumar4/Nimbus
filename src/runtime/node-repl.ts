/**
 * node-repl.ts — Node REPL adapter.
 *
 * Node is native (workerd nodejs_compat). Pattern mirrors bun-repl.ts:
 * a long-lived child-facet holds a vm.Context across submits.
 *
 * We do NOT use `node:repl` directly. Although workerd's nodejs_compat
 * exposes node:repl, it expects a terminal stream interface (stdin/
 * stdout) that the facet doesn't have — and trying to attach a
 * Duplex stream to a Worker isolate is a bigger surgery than worth.
 * Instead we replicate the core repl behaviours:
 *   - `> ` primary prompt, `... ` continuation
 *   - util.inspect of expression values (displayhook)
 *   - SyntaxError recoverable-detection for multi-line input
 *   - process.exit(code) propagation
 *   - .exit / .help / .clear dotted commands
 *
 * NOT supported in v1 (deferred):
 *   - REPL_MODE_STRICT switch
 *   - Top-level await at the prompt
 *   - Tab-completion
 *   - History pickling
 */

import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { ReplAdapter, ReplPushResult } from './repl-session.js';
import { ReplSession } from './repl-session.js';
import { NODE_VERSION } from '../constants.js';

export interface NodeReplDeps {
  facetMgr: FacetManager;
  terminal: WebSocketTerminal;
}

/** Result returned by the REPL-step facet fn. */
interface NodeReplFacetResult {
  stdout: string;
  stderr: string;
  incomplete?: boolean;
  exit?: boolean;
  exitCode?: number;
  error?: string;
}

class NodeReplAdapter implements ReplAdapter {
  private pool: any = null;
  private initDone: boolean = false;
  private deps: NodeReplDeps;

  ps1: string = '> ';
  ps2: string = '... ';

  constructor(deps: NodeReplDeps) {
    this.deps = deps;
  }

  banner(): string {
    return (
      `Welcome to Node.js ${NODE_VERSION} (Nimbus).\r\n` +
      'Type ".help" for more information.\r\n'
    );
  }

  async push(source: string): Promise<ReplPushResult> {
    const trimmed = source.trim();
    if (trimmed === '.exit') {
      return { kind: 'exit', exitCode: 0 };
    }
    if (trimmed === '.help') {
      return {
        kind: 'output',
        stdout:
          '.exit    Exit the REPL\r\n' +
          '.help    Print this help\r\n' +
          '.clear   Reset context\r\n',
        stderr: '',
      };
    }
    if (trimmed === '.clear') {
      this.initDone = false;
      return { kind: 'output', stdout: 'Clearing context...\r\n', stderr: '' };
    }
    try {
      await this.ensurePool();
    } catch (e: any) {
      return { kind: 'error', stderr: `[node-repl] bootstrap failed: ${e?.message || e}\n` };
    }
    if (!this.initDone) {
      try {
        const initResult = await this.submitFacetFn({ mode: 'init' });
        if (initResult.error) {
          return { kind: 'error', stderr: `[node-repl] init failed: ${initResult.error}\n` };
        }
        this.initDone = true;
      } catch (e: any) {
        return { kind: 'error', stderr: `[node-repl] init dispatch failed: ${e?.message || e}\n` };
      }
    }

    let result: NodeReplFacetResult;
    try {
      result = await this.submitFacetFn({ mode: 'push', source });
    } catch (e: any) {
      return { kind: 'error', stderr: `[node-repl] push dispatch failed: ${e?.message || e}\n` };
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
    const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
    this.pool = new NimbusLoaderPool(env, ctx, {
      tag: 'node-repl',
      concurrency: 1,
      omitSupervisor: true,
      preamble: '',  // node is native — no preamble shim needed
    });
  }

  private async submitFacetFn(args: { mode: 'init' | 'push'; source?: string }):
      Promise<NodeReplFacetResult> {
    return await this.pool.submit(nodeReplStepFacetFn, args, {
      timeoutMs: 60_000,
    });
  }
}

/**
 * Facet-side function. Self-contained — serialized via fn.toString()
 * across the LOADER boundary; no closure captures, no class refs,
 * no bare 'this' word (the serializer rejects /\bthis\b/).
 *
 * Modes:
 *   - 'init': create vm.createContext(), expose curated globals,
 *     stash on globalThis.__nimbus_node_ctx.
 *   - 'push': try expression-mode eval; fall back to statement-mode;
 *     util.inspect non-undefined result; surface process.exit sentinel.
 */
function nodeReplStepFacetFn(
  args: { mode: 'init' | 'push'; source?: string },
): Promise<NodeReplFacetResult> {
  const g: any = globalThis as any;

  return (async function () {
    if (args.mode === 'init') {
      // @ts-ignore — node:vm via workerd nodejs_compat at runtime.
      const vmMod = await import('node:vm');
      // @ts-ignore — node:util via nodejs_compat at runtime.
      const utilMod = await import('node:util');
      g.__nimbus_node_util = utilMod;
      const sandbox: any = {
        globalThis: null as any,
        console: {
          log: (...xs: any[]) => g.__nimbus_node_stdout.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
          error: (...xs: any[]) => g.__nimbus_node_stderr.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
          warn: (...xs: any[]) => g.__nimbus_node_stderr.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
          info: (...xs: any[]) => g.__nimbus_node_stdout.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
          debug: (...xs: any[]) => g.__nimbus_node_stdout.push(xs.map((x) => typeof x === 'string' ? x : utilMod.inspect(x, { colors: false })).join(' ') + '\n'),
        },
        process: new Proxy((globalThis as any).process || {}, {
          get(target: any, prop: string | symbol) {
            if (prop === 'exit') {
              return function (code?: number) {
                const err: any = new Error('__nimbus_node_exit__');
                err.__nimbus_exit_code = typeof code === 'number' ? code : 0;
                throw err;
              };
            }
            return target[prop as any];
          },
        }),
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
      g.__nimbus_node_stdout = [];
      g.__nimbus_node_stderr = [];
      g.__nimbus_node_ctx = vmMod.createContext(sandbox);
      g.__nimbus_node_vm = vmMod;
      return { stdout: '', stderr: '' };
    }

    const source = args.source || '';
    const vmMod = g.__nimbus_node_vm;
    const ctx = g.__nimbus_node_ctx;
    const utilMod = g.__nimbus_node_util;
    if (!vmMod || !ctx) {
      return { stdout: '', stderr: '', error: 'node repl context not initialised' };
    }
    const stdoutStart = g.__nimbus_node_stdout.length;
    const stderrStart = g.__nimbus_node_stderr.length;

    // Recoverable-syntax detection: Node's repl wraps user input in
    // `(function () { return (<src>); })` and treats certain
    // SyntaxError messages as "input incomplete, ask for more".
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
          stdout: g.__nimbus_node_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_node_stderr.slice(stderrStart).join(''),
          incomplete: true,
        };
      }
    }

    let result: any;
    let evaluatedAs: 'expr' | 'stmt' = 'stmt';
    try {
      result = vmMod.runInContext('(' + source + '\n)', ctx, {
        breakOnSigint: false,
        timeout: 30_000,
        displayErrors: false,
      });
      evaluatedAs = 'expr';
    } catch (exprErr: any) {
      if (exprErr && exprErr.__nimbus_exit_code !== undefined) {
        return {
          stdout: g.__nimbus_node_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_node_stderr.slice(stderrStart).join(''),
          exit: true,
          exitCode: exprErr.__nimbus_exit_code,
        };
      }
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
            stdout: g.__nimbus_node_stdout.slice(stdoutStart).join(''),
            stderr: g.__nimbus_node_stderr.slice(stderrStart).join(''),
            exit: true,
            exitCode: stmtErr.__nimbus_exit_code,
          };
        }
        const errStr = (stmtErr && stmtErr.stack) || String(stmtErr);
        return {
          stdout: g.__nimbus_node_stdout.slice(stdoutStart).join(''),
          stderr: g.__nimbus_node_stderr.slice(stderrStart).join('') + errStr + '\n',
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
      g.__nimbus_node_stdout.push(rendered + '\n');
    }

    return {
      stdout: g.__nimbus_node_stdout.slice(stdoutStart).join(''),
      stderr: g.__nimbus_node_stderr.slice(stderrStart).join(''),
    };
  })();
}

/**
 * Top-level wrapper: builds a Node REPL adapter, drives a ReplSession
 * to completion, returns the exit code. Called from the node factory's
 * wrapper in init.ts when `node` is invoked with no args.
 */
export async function runNodeRepl(deps: NodeReplDeps): Promise<number> {
  const adapter = new NodeReplAdapter(deps);
  const session = new ReplSession(adapter, deps.terminal);
  return await session.run();
}
