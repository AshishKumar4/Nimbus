/**
 * tsrs-runner.ts — `tsc` as tsrs, the Rust port of the TypeScript compiler
 * built to wasm (@tsrs/wasm), run as a WASI process.
 *
 * One invocation is one process, on one of the session's warm workers for
 * tsrs, which keeps the compiled module; each run instantiates it afresh,
 * as tsrs's own hosts do (the compiler keeps process-wide state). Its files
 * are the process's resident filesystem (facet-tasks.ts tsrsFacetCall), its
 * output streams to the session as it is written, and its exit status is
 * tsc's own (0-4), or 5 for a run that crashed.
 */

import { TSRS_CALL_TASK } from './compiled-bodies.generated.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type { Facet, FacetImage, FacetSpec, FacetSubmitOptions } from './facet-host.js';
import type { TsrsFacetArgs, TsrsFacetResult } from './facet-tasks.js';
import { gateSyncLaunch, requireVfsCred, type NimbusFilesystemAuthority } from './os-contracts.js';
import { WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';
import { openRuntimeStdio } from './runtime-stdio.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import { errorText } from '../_shared/error-text.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { warmFacetKeys, type WarmCallEnd } from './warm-facets.js';

/** What the runner uses of a facet: the tsrs call, and its disposal. */
export interface TsrsFacet extends Pick<Facet, 'dispose'> {
  submit(task: typeof TSRS_CALL_TASK, args: TsrsFacetArgs, options?: FacetSubmitOptions): Promise<TsrsFacetResult>;
}

/** tsc's watch flags: tsrs's wasm build has no watch mode. */
const WATCH_FLAGS: ReadonlySet<string> = new Set(['--watch', '-w']);

/** The tsrs command a session runs by `binName`: one set of warm workers for all of them. */
export function makeTsrsCommand(deps: {
  facets: { open(spec: FacetSpec): TsrsFacet };
  filesystem: NimbusFilesystemAuthority;
  processes: SessionProcessSupervisor;
  /** The session its processes run in: its warm workers are its own (warm-facets.ts). */
  session: string;
  /** tsrs.wasm, its bytes read when a worker is built for it. */
  image(): FacetImage;
}): (binName: string) => Command {
  const warm = warmFacetKeys(deps.session, 'tsrs');
  return (binName) => async function tsrs(ctx: CommandContext): Promise<number> {
    const argv = (ctx.args ?? []).map(String);
    if (argv.some((arg) => WATCH_FLAGS.has(arg))) {
      ctx.stderr.write(`${binName}: tsrs's wasm build has no watch mode; install typescript in the project (\`npm i -D typescript\`) for \`tsc --watch\`\n`);
      return 1;
    }
    const cwd = ctx.cwd || '/home/user';
    const blocked = await gateSyncLaunch(ctx.vfs.process, cwd, null, argv);
    if (blocked !== null) { ctx.stderr.write(`${binName}: ${blocked}\n`); return 1; }
    const cred = requireVfsCred(ctx.cred, binName);
    const stdio = openRuntimeStdio(deps, ctx, [binName, ...argv].join(' '));
    const key = warm.take();
    let end: WarmCallEnd = { reusable: false, killed: false };
    let facet: TsrsFacet | null = null;
    let outcome = 1;
    try {
      facet = deps.facets.open({
        tag: 'tsrs',
        concurrency: 1,
        syscalls: stdio.syscalls,
        preamble: WASI_INSTANCE_PREAMBLE_SRC,
        wasmModules: { 'tsrs.wasm': deps.image() },
        warm: key,
      });
      // Killed before it began: it never starts.
      stdio.signal.throwIfAborted();
      const result = await facet.submit(TSRS_CALL_TASK, {
        argv, cwd: `/${normalizeVfsPath(cwd)}`, env: { ...ctx.env }, cred, processPid: stdio.pid,
      }, { signal: stdio.signal });
      end = { reusable: result.reusable, error: result.error, killed: stdio.signal.aborted };
      if (result.error) ctx.stderr.write(`${binName}: ${result.error}\n`);
      if (ctx.env?.NIMBUS_WASI_FS_STATS === '1') ctx.stderr.write(`[wasi-fs] tsrs ${JSON.stringify(result.fsStats ?? null)}\n`);
      outcome = result.exitCode;
    } catch (error) {
      end = { reusable: false, killed: stdio.signal.aborted };
      // Killed: it ends as an interrupted program does.
      if (stdio.signal.aborted) outcome = 130;
      else ctx.stderr.write(`${binName}: ${errorText(error)}\n`);
    } finally {
      warm.give(key, end);
      facet?.dispose();
      await stdio.finish(outcome);
    }
    return outcome;
  };
}
