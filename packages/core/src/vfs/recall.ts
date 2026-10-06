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
  constructor(readonly root: string, readonly kind: 'share' | 'revoke', readonly path: string, readonly recall: () => Promise<void>) {
    super(`EAGAIN: ${path}: delegated at /${root}; recalling it`);
    this.name = 'RecallRequired';
  }
}

/**
 * `run` again for as long as what it meets is a delegation to recall (at most
 * `attempts` times): the one way a caller that can wait passes a delegation.
 */
export async function withRecall<T>(run: () => T | Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const recall = recallOf(error);
      if (recall === null || attempt >= attempts) throw error;
      await recall.recall();
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

