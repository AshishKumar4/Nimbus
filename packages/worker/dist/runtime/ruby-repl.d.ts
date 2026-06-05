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
export interface RubyReplDeps {
    facetMgr: FacetManager;
    vfs: SqliteVFS;
    terminal: WebSocketTerminal;
    /** Per-user-VFS install dir for the ruby blob. */
    installRoot: string;
}
/**
 * Top-level wrapper: builds a Ruby REPL adapter, drives a ReplSession
 * to completion, returns the exit code. Called from the ruby factory's
 * wrapper in init.ts when `ruby` is invoked with no args.
 */
export declare function runRubyRepl(deps: RubyReplDeps): Promise<number>;
//# sourceMappingURL=ruby-repl.d.ts.map