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
import type { Command } from '../substrate/lifo/commands/types.js';
import type { Facet, FacetImage, FacetSpec, FacetSubmitOptions } from './facet-host.js';
import type { TsrsFacetArgs, TsrsFacetResult } from './facet-tasks.js';
import { type NimbusFilesystemAuthority } from './os-contracts.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
/** What the runner uses of a facet: the tsrs call, and its disposal. */
export interface TsrsFacet extends Pick<Facet, 'dispose'> {
    submit(task: typeof TSRS_CALL_TASK, args: TsrsFacetArgs, options?: FacetSubmitOptions): Promise<TsrsFacetResult>;
}
/** The tsrs command a session runs by `binName`: one set of warm workers for all of them. */
export declare function makeTsrsCommand(deps: {
    facets: {
        open(spec: FacetSpec): TsrsFacet;
    };
    filesystem: NimbusFilesystemAuthority;
    processes: SessionProcessSupervisor;
    /** The session its processes run in: its warm workers are its own (warm-facets.ts). */
    session: string;
    /** tsrs.wasm, its bytes read when a worker is built for it. */
    image(): FacetImage;
}): (binName: string) => Command;
//# sourceMappingURL=tsrs-runner.d.ts.map