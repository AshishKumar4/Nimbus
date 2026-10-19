import { TASK_BODY_FAILED } from '@nimbus-sh/core/runtime/facet-host.js';

/**
 * Source for the generated entries a facet's task request comes through
 * (the pool's fetch, a one-shot's run): `__nimbusTaskBodyError(error,
 * request)` is `error`, its message naming the task's request body when the
 * task marked the failure as its body's (TASK_BODY_FAILED). Every task reads
 * its body as JSON, so a body that arrived changed in transit fails there.
 */
export const TASK_BODY_ERROR_SOURCE = `function __nimbusTaskBodyError(error, request) {
  if (!(error instanceof Error) || error[${JSON.stringify(TASK_BODY_FAILED)}] !== true) return error;
  error.message = 'Nimbus: the task request body, as it arrived (content-length ' + (request.headers.get('content-length') ?? 'unknown') + '), is not JSON: ' + error.message;
  return error;
}`;
