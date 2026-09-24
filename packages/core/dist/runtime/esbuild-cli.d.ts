/**
 * esbuild-cli.ts — the `esbuild` command.
 *
 * Runs the real esbuild CLI: the Go program inside esbuild.wasm, not a
 * reimplementation of its flags, so every flag, default, path rule and message
 * is esbuild's own. It runs as the calling process, from the caller's working
 * directory, in whatever isolate the host's `run` dispatches to; the runner
 * there is ESBUILD_CLI_PREAMBLE (runtime/esbuild-cli/preamble.ts). On workerd
 * that is the session's esbuild facet, the one that also serves its transforms.
 *
 * Nothing about the build lives in the session's isolate. esbuild's Go heap
 * grows with the module graph and a WebAssembly memory never shrinks: a React
 * bundle takes the instance from 28 MiB to 76 MiB, which the session isolate
 * used to keep for the rest of its life.
 */
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type { EsbuildCliArgs, EsbuildCliOutput } from './esbuild-cli/types.js';
export type { EsbuildCliArgs, EsbuildCliOutput } from './esbuild-cli/types.js';
export interface EsbuildCommandDeps {
    /**
     * Runs one invocation where the host keeps esbuild, with filesystem
     * authority for `ctx.pid` and nothing more, and resolves to its exit
     * status. Its stdout and stderr go to `output` as they are written.
     */
    run(args: EsbuildCliArgs, ctx: CommandContext, output: EsbuildCliOutput): Promise<number>;
}
/**
 * Go's wasm_exec.js and the runner, as one script. Evaluated in the isolate
 * that hosts esbuild, it installs `globalThis.__esbuildCliRun(args,
 * supervisor, output, module)`.
 */
export declare const ESBUILD_CLI_PREAMBLE: string;
export declare function makeEsbuildCommand(deps: EsbuildCommandDeps): Command;
//# sourceMappingURL=esbuild-cli.d.ts.map