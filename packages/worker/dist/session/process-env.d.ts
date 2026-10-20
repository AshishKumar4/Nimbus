import type { FacetManagerHooks } from '../facets/manager.js';
/** How a host answers ask 62: the relaunch's question, and, for a host that keeps environments itself, where it keeps them. */
export type ProcessEnvHooks = Pick<FacetManagerHooks, 'resolveProcessEnv' | 'keepProcessEnv'>;
/**
 * The session's own keeping: each record's environment in a row of the
 * session object's storage, written with its record and deleted with it.
 */
export declare function sessionProcessEnv(storage: DurableObjectStorage): Required<ProcessEnvHooks>;
//# sourceMappingURL=process-env.d.ts.map