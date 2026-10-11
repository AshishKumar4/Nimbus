/**
 * one-shot-entry.ts — how a one-shot program its host builds is entered: by
 * `run`, from that host (runOneShot), with the host's capability. A staged
 * program, assembled in a stateless isolate, is entered by fetch with a
 * binding instead (NimbusLoadedEntrypoint).
 */
/** The entry module's name in a one-shot's module map. */
export declare const ONE_SHOT_ENTRY = "nimbus-one-shot.js";
/**
 * Set on whatever a one-shot's program throws, once its run was entered
 * (carried across by enhanced_error_serialization): the platform refuses a
 * run before entering it, so only an error without it can be a refusal.
 */
export declare const RUN_ENTERED = "nimbusRunEntered";
/**
 * `code`, entered by `run(request, supervisor, ended)`: its SUPERVISOR is the
 * call's capability, a run its host ended (untilEnded) aborts itself where it
 * stands, and the program is its main module's default export's fetch.
 */
export declare function enteredByRun<C extends {
    mainModule: string;
    modules: Record<string, unknown>;
}>(code: C): C;
//# sourceMappingURL=one-shot-entry.d.ts.map