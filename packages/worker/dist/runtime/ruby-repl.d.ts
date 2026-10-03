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
import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import { type NimbusFilesystemAuthority } from '@nimbus-sh/core/runtime/os-contracts.js';
export interface RubyReplDeps {
    facetMgr: FacetManager;
    /** Owns the installed interpreter blob the prompt is booted from. */
    authority: NimbusFilesystemAuthority;
    terminal: WebSocketTerminal;
    /** Per-user-VFS install dir for the ruby blob. */
    installRoot: string;
    /**
     * The invoking process's pid. The supervisor derives the prompt's
     * credential from it: the session filesystem the prompt reads and writes is
     * the caller's, as the caller sees it.
     */
    pid: number;
    /** The caller's HOME. */
    home: string;
    /** The shell's working directory: where the prompt starts. */
    cwd: string;
    /** The command that started the prompt: what its own refusals name. */
    binName: string;
}
/** What one prompt step hands the facet: the driver and where the prompt starts. */
interface RubyReplStep {
    userCode: string;
    home: string;
    cwd: string;
    binName: string;
}
interface RubyReplFacetResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
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
export declare function rubyReplStepFacetFn(args: RubyReplStep, facetEnv: {
    SUPERVISOR?: unknown;
}): Promise<RubyReplFacetResult>;
/**
 * Top-level wrapper: builds a Ruby REPL adapter, drives a ReplSession
 * to completion, returns the exit code. Called from the ruby factory's
 * wrapper in init.ts when `ruby` is invoked with no args.
 */
export declare function runRubyRepl(deps: RubyReplDeps): Promise<number>;
export {};
//# sourceMappingURL=ruby-repl.d.ts.map