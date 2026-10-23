/**
 * Source for the generated entries a facet's task request comes through
 * (the pool's fetch, a one-shot's run): `__nimbusTaskBodyError(error,
 * request)` is `error`, its message naming the task's request body when the
 * task marked the failure as its body's (TASK_BODY_FAILED). Every task reads
 * its body as JSON, so a body that arrived changed in transit fails there.
 */
export declare const TASK_BODY_ERROR_SOURCE: string;
/**
 * Set on whatever a task throws once its call entered it (the pool's
 * execute, a one-shot's run), carried across by enhanced_error_serialization:
 * the platform refuses a call before entering it, so only an error without it
 * can be a refusal (budgets.ts refusedStart).
 */
export declare const RUN_ENTERED = "nimbusRunEntered";
/** Source for the same entries: \`__nimbusEntered(error)\` is \`error\`, as an Error, marked RUN_ENTERED. */
export declare const ENTERED_FAILURE_SOURCE: string;
//# sourceMappingURL=task-body-error.d.ts.map