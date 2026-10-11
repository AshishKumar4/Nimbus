/**
 * Recalling a delegation (SqliteVFS: an exclusive-mutation lease whose
 * holder decides its subtree's operations itself and sends them later):
 * the refusal an access meets, and the one way a caller that can wait
 * passes it. Every layer reports the refusal as EAGAIN for its own call;
 * the recall rides along as the error or its cause.
 */

/**
 * An access meets a delegation another holder has (ExclusiveMutationOptions
 * .delegation): what the holder decided may not be stored yet. A caller that
 * can wait awaits `recall()` and tries again (withRecall); one that cannot is
 * refused (EAGAIN), the recall started, so its retry finds the subtree current.
 */
export class RecallRequired extends Error {
  readonly code = 'EAGAIN';
  readonly recalling = true;
  constructor(
    readonly root: string,
    readonly kind: 'share' | 'revoke',
    readonly path: string,
    readonly recall: () => Promise<void>,
    /**
     * A recall a caller that can wait may run ahead of (readers': SqliteVFS
     * read leases): what `run` changes is committed now, and published once
     * the recall is over (`published`); until then it holds what it changed.
     */
    readonly pipeline?: Pipelining,
  ) {
    super(`EAGAIN: ${path}: delegated at /${root}; recalling it`);
    this.name = 'RecallRequired';
  }
}

/** `run`, its changes committed now and published once the recalls it ran ahead of are over. */
export type Pipelining = <T>(run: () => T) => { value: T; published: Promise<void> };

/**
 * The caller's own timer, taken when this module is evaluated: a program
 * that shares the realm (a resident body run in-process) wraps the global
 * one as its own resumption.
 */
const callerSetTimeout = globalThis.setTimeout;

/**
 * `run` again for as long as what it meets is a delegation to recall (at most
 * `attempts` times): the one way a caller that can wait passes a delegation.
 * A recall it may run ahead of is sent first, one turn before `run` commits
 * (so the recall leaves ahead of the commit's own storage), and what `run`
 * changed is published once it is over: awaited here, or added to `held`
 * for a caller that makes several calls and awaits them all at its end.
 */
export async function withRecall<T>(run: () => T | Promise<T>, attempts = 8, held?: Set<Promise<void>>): Promise<T> {
  const publications: Promise<void>[] = [];
  const settle = async (): Promise<void> => {
    if (held === undefined) await Promise.all(publications);
    else for (const published of publications) held.add(published);
  };
  let met: RecallRequired | null = null;
  // What a pipelined attempt runs ahead of is its synchronous part: a call
  // whose commit comes after an await meets the recall again, and is made
  // again once the recall is over.
  let pipelined = false;
  for (let attempt = 1; ; attempt++) {
    try {
      let value: T;
      if (met?.pipeline !== undefined && !pipelined) {
        pipelined = true;
        await new Promise((resolve) => callerSetTimeout(resolve, 0));
        const ran = met.pipeline(run);
        publications.push(ran.published);
        value = await ran.value;
      } else {
        if (met !== null) await met.recall();
        value = await run();
      }
      await settle();
      return value;
    } catch (error) {
      met = recallOf(error);
      if (met === null || attempt >= attempts) {
        await settle().catch(() => {});
        throw error;
      }
    }
  }
}

/**
 * The recall `error` reports, itself or as the cause a layer kept when it
 * reported the refusal as its own call's (toVfsError, a namespace's
 * syscall error): every layer reports EAGAIN, and the recall rides along.
 */
export function recallOf(error: unknown): RecallRequired | null {
  for (let at = error, depth = 0; at !== null && typeof at === 'object' && depth < 8; at = (at as { cause?: unknown }).cause, depth++) {
    if (at instanceof RecallRequired) return at;
  }
  return null;
}

