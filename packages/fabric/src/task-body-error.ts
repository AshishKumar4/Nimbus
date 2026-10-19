/**
 * Source for the generated entries a facet's task request comes through
 * (the pool's fetch, a one-shot's run): `__nimbusTaskBodyError(error,
 * request)` is `error`, its message saying the task's request body did not
 * parse as JSON when that is what failed. Every task reads its body as JSON,
 * so a body that arrived changed in transit fails there, and this names it.
 */
export const TASK_BODY_ERROR_SOURCE = `function __nimbusTaskBodyError(error, request) {
  if (!(error instanceof SyntaxError) || !request.bodyUsed || !error.message.includes('JSON')) return error;
  error.message = 'Nimbus: the task request body, as it arrived (content-length ' + (request.headers.get('content-length') ?? 'unknown') + '), is not JSON: ' + error.message;
  return error;
}`;
