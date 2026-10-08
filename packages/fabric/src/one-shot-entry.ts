/**
 * one-shot-entry.ts — how every one-shot program is entered: by `run`, from
 * its host (runOneShot), whether its module map was built there or assembled
 * from a stage in a stateless isolate (NimbusLoadedEntrypoint).
 */

/** The entry module's name in a one-shot's module map. */
export const ONE_SHOT_ENTRY = 'nimbus-one-shot.js';

/**
 * Set on whatever a one-shot's program throws, once its run was entered
 * (carried across by enhanced_error_serialization): the platform refuses a
 * run before entering it, so only an error without it can be a refusal.
 */
export const RUN_ENTERED = 'nimbusRunEntered';

/**
 * `code`, entered by `run(request, supervisor, ended)`: its SUPERVISOR is the
 * call's capability, a run its host ended (untilEnded) aborts itself where it
 * stands, and the program is its main module's default export's fetch.
 */
export function enteredByRun<C extends { mainModule: string; modules: Record<string, unknown> }>(code: C): C {
  return { ...code, mainModule: ONE_SHOT_ENTRY, modules: { ...code.modules, [ONE_SHOT_ENTRY]: entrySource(code.mainModule) } };
}

function entrySource(mainModule: string): string {
  return `import { WorkerEntrypoint } from "cloudflare:workers";
import program from ${JSON.stringify(`./${mainModule}`)};
export default class extends WorkerEntrypoint {
  async run(request, supervisor, ended) {
    ended().then((reason) => { if (reason !== null) this.ctx.abort(reason); }, () => {});
    try {
      return await program.fetch(request, { ...this.env, SUPERVISOR: supervisor }, this.ctx);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { ${RUN_ENTERED}: true });
    }
  }
}
`;
}
