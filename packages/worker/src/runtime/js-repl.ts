/**
 * js-repl.ts — the JavaScript REPL shared by `node` and `bun`.
 *
 * Both run on workerd's V8 (`nodejs_compat`); `bun` adds the Bun shim
 * (bun-runner.ts BUN_SHIM_PREAMBLE). A long-lived child facet evaluates each
 * line, so the two differ only in what a {@link JsReplFlavor} names: the
 * banner, the dotted-command texts and the facet's preamble.
 *
 * We do NOT use `node:repl` (it wants a terminal stream the facet does not
 * have) or `node:vm` (a non-functional stub in workerd). The core repl
 * behaviours are replicated instead:
 *   - `> ` primary prompt, `... ` continuation
 *   - util.inspect of expression values (displayhook), thenables awaited
 *   - SyntaxError recoverable-detection for multi-line input
 *   - process.exit(code) propagation
 *   - .exit / .help / .clear dotted commands
 *
 * NOT supported (deferred): REPL_MODE_STRICT, top-level await at the
 * prompt, Ctrl-C mid-execution, tab-completion, history pickling.
 */

import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { FacetManager } from '../facets/manager.js';
import type { Facet } from '@nimbus-sh/core/runtime/facet-host.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { ReplSession, replPushResult, type ReplAdapter, type ReplFacetResult, type ReplPushResult } from './repl-session.js';
import { facetHostForManager } from './facet-loader-host.js';

export interface JsReplDeps {
  facetMgr: FacetManager;
  terminal: WebSocketTerminal;
}

/** What one JavaScript runtime's REPL says and loads; the protocol is shared. */
export interface JsReplFlavor {
  /**
   * The command: names the facet pool (`<name>-repl`), the diagnostics'
   * prefix, the facet's REPL state on its globalThis, and the `-e` advice.
   */
  name: 'node' | 'bun';
  banner: string;
  /** `.help`'s text. */
  help: string;
  /** What `.clear` prints. */
  cleared: string;
  /** Evaluated in the facet before the first line (the Bun shim; none for node). */
  preamble: string;
}

export interface JsReplStep {
  name: JsReplFlavor['name'];
  mode: 'init' | 'push';
  source?: string;
}

const STEP_TIMEOUT = { timeoutMs: 60_000 };

class JsReplAdapter implements ReplAdapter {
  private facet: Facet | null = null;
  private initDone = false;

  ps1 = '> ';
  ps2 = '... ';

  constructor(private readonly flavor: JsReplFlavor, private readonly deps: JsReplDeps) {}

  banner(): string {
    return this.flavor.banner;
  }

  async push(source: string): Promise<ReplPushResult> {
    const { name } = this.flavor;
    const trimmed = source.trim();
    if (trimmed === '.exit') {
      return { kind: 'exit', exitCode: 0 };
    }
    if (trimmed === '.help') {
      return { kind: 'output', stdout: this.flavor.help, stderr: '' };
    }
    if (trimmed === '.clear') {
      this.initDone = false;
      return { kind: 'output', stdout: this.flavor.cleared, stderr: '' };
    }
    let facet: Facet;
    try {
      facet = this.facet ??= facetHostForManager(this.deps.facetMgr).open({
        tag: `${name}-repl`,
        concurrency: 1,
        preamble: this.flavor.preamble,
      });
    } catch (e) {
      return { kind: 'error', stderr: `[${name}-repl] bootstrap failed: ${errorText(e)}\n` };
    }
    if (!this.initDone) {
      try {
        const initResult = await facet.submit(jsReplStepFacetFn, { name, mode: 'init' }, STEP_TIMEOUT);
        if (initResult.error) {
          return { kind: 'error', stderr: `[${name}-repl] init failed: ${initResult.error}\n` };
        }
        this.initDone = true;
      } catch (e) {
        return { kind: 'error', stderr: `[${name}-repl] init dispatch failed: ${errorText(e)}\n` };
      }
    }

    let result: ReplFacetResult;
    try {
      result = await facet.submit(jsReplStepFacetFn, { name, mode: 'push', source }, STEP_TIMEOUT);
    } catch (e) {
      return { kind: 'error', stderr: `[${name}-repl] push dispatch failed: ${errorText(e)}\n` };
    }

    return replPushResult(result);
  }

  async close(): Promise<void> {
    if (this.facet) {
      try { this.facet.dispose(); } catch { /* fail-soft */ }
      this.facet = null;
    }
    this.initDone = false;
  }
}

/** The REPL's state in the facet, on globalThis.__nimbus_<name>_repl. */
interface JsReplState {
  util: { inspect(value: unknown, options: { colors: boolean; depth?: number }): string };
  stdout: string[];
  stderr: string[];
  /** Every line evaluated so far, replayed before the next one. */
  history: string[];
}

/**
 * Facet-side function. Self-contained — serialized via fn.toString()
 * across the LOADER boundary; no closure captures, no class refs, no bare
 * receiver keyword (the serializer rejects it).
 *
 * Modes:
 *   - 'init': install console capture and a process.exit sentinel.
 *   - 'push': try expression-mode eval; fall back to statement-mode;
 *     util.inspect non-undefined result; surface process.exit sentinel.
 */
export function jsReplStepFacetFn(args: JsReplStep): Promise<ReplFacetResult> {
  // The facet's own global scope: console and process.exit are replaced on it.
  const g = globalThis as unknown as { console: unknown; process?: { exit?: unknown }; [key: string]: unknown };
  const key = '__nimbus_' + args.name + '_repl';

  return (async function () {
    if (args.mode === 'init') {
      // A function serialized into the facet cannot carry a static import;
      // node:util is workerd's nodejs_compat module there.
      // @ts-ignore — node:util is not in this package's types.
      const util: JsReplState['util'] = await import('node:util');
      // Lines evaluated before a `.clear` still replay after it.
      const history = (g[key] as JsReplState | undefined)?.history ?? [];
      const state: JsReplState = { util, stdout: [], stderr: [], history };
      g[key] = state;
      const capture = (sink: string[]) => (...xs: unknown[]) => {
        sink.push(xs.map((x) => typeof x === 'string' ? x : util.inspect(x, { colors: false })).join(' ') + '\n');
      };
      const toStdout = capture(state.stdout);
      const toStderr = capture(state.stderr);
      g.console = { log: toStdout, error: toStderr, warn: toStderr, info: toStdout, debug: toStdout };
      if (g.process && typeof g.process === 'object') {
        g.process.exit = (code?: number) => {
          throw Object.assign(new Error('__nimbus_' + args.name + '_exit__'), {
            __nimbus_exit_code: typeof code === 'number' ? code : 0,
          });
        };
      }
      return { stdout: '', stderr: '' };
    }

    const source = args.source || '';
    const state = g[key] as JsReplState | undefined;
    if (!state) {
      return { stdout: '', stderr: '', error: args.name + ' repl not initialised' };
    }
    const stdoutStart = state.stdout.length;
    const stderrStart = state.stderr.length;
    const output = (extraStderr = '') => ({
      stdout: state.stdout.slice(stdoutStart).join(''),
      stderr: state.stderr.slice(stderrStart).join('') + extraStderr,
    });
    const failure = (error: unknown) => (error instanceof Error && error.stack) || String(error);

    // Recoverable-syntax detection: compile the source as a function body;
    // an 'Unexpected end of input'-class message means more lines follow.
    try {
      new Function('(function(){\n' + source + '\n})');
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : '';
      const incompletePatterns = [
        /Unexpected end of input/i,
        /Unterminated template literal/i,
        /Unterminated string constant/i,
        /missing \) after argument list/i,
        /Unexpected token \}/i,
      ];
      if (incompletePatterns.some((re) => re.test(msg))) {
        return { ...output(), incomplete: true };
      }
    }

    // workerd's CSP blocks eval() at request time ("Code generation from
    // strings disallowed"), but `new Function` is permitted. var/let/const
    // bindings inside the Function body are local to it, so each push
    // re-runs the session's history with the new line appended, returning
    // the value of the current line's expression for the displayhook.
    let result: unknown;
    let evaluatedAs: 'expr' | 'stmt' = 'stmt';
    try {
      result = new Function(state.history.join('\n') + '\nreturn (' + source + '\n);').call(globalThis);
      evaluatedAs = 'expr';
      state.history.push(source);
    } catch (exprErr) {
      if (exprErr instanceof Error && '__nimbus_exit_code' in exprErr) {
        return { ...output(), exit: true, exitCode: Number(exprErr.__nimbus_exit_code) };
      }
      if (exprErr instanceof Error && /EvalError|Code generation from strings disallowed/i.test(exprErr.message)) {
        return output('workerd CSP: cannot evaluate JS at request time. Use `' + args.name + ' -e "<code>"` instead.\n');
      }
      try {
        result = new Function(state.history.join('\n') + '\n' + source).call(globalThis);
        evaluatedAs = 'stmt';
        state.history.push(source);
      } catch (stmtErr) {
        if (stmtErr instanceof Error && '__nimbus_exit_code' in stmtErr) {
          return { ...output(), exit: true, exitCode: Number(stmtErr.__nimbus_exit_code) };
        }
        return output(failure(stmtErr) + '\n');
      }
    }

    // An expression may be a Promise (`fetch('/api')`): the displayhook
    // shows what it resolves to, not "[object Promise]".
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof Reflect.get(result, 'then') === 'function') {
      try {
        result = await result;
      } catch (awaitErr) {
        return output(failure(awaitErr) + '\n');
      }
    }

    if (evaluatedAs === 'expr' && result !== undefined) {
      let rendered: string;
      try {
        rendered = state.util.inspect(result, { colors: false, depth: 4 });
      } catch {
        rendered = '<inspect failed>';
      }
      state.stdout.push(rendered + '\n');
    }

    return output();
  })();
}

/** Drive a `flavor` REPL on the terminal to completion; returns the exit code. */
export async function runJsRepl(flavor: JsReplFlavor, deps: JsReplDeps): Promise<number> {
  const adapter = new JsReplAdapter(flavor, deps);
  const session = new ReplSession(adapter, deps.terminal);
  return await session.run();
}
