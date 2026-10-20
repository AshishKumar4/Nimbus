// session/process-env.ts — who gives a relaunched process its environment
// back (ask 62).
//
// Nimbus keeps no process's environment in any record, image or generated
// source: what the image store holds, every process on the box can read. A
// relaunch (a re-drive after a reset, an on-failure restart, a durable app's
// relaunch on its port, a dev server's restore) asks its host for the
// environment again, and fails, named, without one (FacetManagerHooks).
//
// An embedder that knows its processes' environments composes
// resolveProcessEnv alone and stores nothing. The session's own host has no
// such record elsewhere, so it keeps each relaunchable launch's environment
// itself: one row per record in the session object's own storage. That is
// this host's choice, and it is at rest by design, outside the filesystem,
// so no process can read it and no filesystem snapshot or export carries it.

import { DEV_SERVER_KEY_PREFIX, PROCESS_ENV_KEY_PREFIX } from './keys.js';
import { FENCED_WORK_KEY_PREFIX } from '@nimbus-sh/fabric/fenced-work.js';
import { keptEnv } from '../facets/process-env.js';
import type { FacetManagerHooks } from '../facets/manager.js';

/** How a host answers ask 62: the relaunch's question, and, for a host that keeps environments itself, where it keeps them. */
export type ProcessEnvHooks = Pick<FacetManagerHooks, 'resolveProcessEnv' | 'keepProcessEnv'>;

/** The records whose environments the session keeps: a resident launch's journal row, and a dev server's. */
const KEPT_RECORD = new RegExp(`^(${FENCED_WORK_KEY_PREFIX}|${DEV_SERVER_KEY_PREFIX})\\d+$`);

/**
 * The session's own keeping: each record's environment in a row of the
 * session object's storage, written and deleted with its record.
 */
export function sessionProcessEnv(storage: DurableObjectStorage): Required<ProcessEnvHooks> {
  const keeping = {
    rowOf(record: string): string {
      if (!KEPT_RECORD.test(record)) throw new Error(`Nimbus: no environment is kept for ${record}`);
      return `${PROCESS_ENV_KEY_PREFIX}${record}`;
    },
  };
  return {
    resolveProcessEnv: async (request) => keptEnv(await storage.get(keeping.rowOf(request.record))),
    keepProcessEnv: keeping,
  };
}
