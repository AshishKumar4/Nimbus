import { classifyDoCall } from '@nimbus-sh/platform/oom-classify.js';
/**
 * Describe platform unavailability at a public DO boundary. This classifies
 * only; it never repeats a call whose mutation or upgrade may have run.
 */
export function doUnavailableError(error) {
    const classification = classifyDoCall(error);
    const code = classification === 'overloaded'
        ? 'E_NIMBUS_DO_OVERLOADED'
        : classification === 'superseded_isolate'
            ? 'E_NIMBUS_DO_CODE_UPDATED'
            : null;
    if (code === null)
        return null;
    return {
        code,
        error: error instanceof Error ? error.message : String(error),
        // Give a caller a cooldown instead of encouraging an immediate retry
        // against an overloaded object or a deployment still propagating.
        retryAfter: '5',
    };
}
