/**
 * inner-do-registry.ts — Module-level registry of inner DO classes.
 *
 * `nimbus-wrangler` populates this on each successful buildAndLoad()
 * with the DurableObject classes extracted from the freshly-loaded
 * inner Worker via `worker.getDurableObjectClass(name)`. The supervisor
 * DO (`NimbusSession`) reads it on each inner-DO fetch to synthesize a
 * NimbusDurableObjectNamespace stub for `env.MY_DO`.
 *
 * Why a separate leaf module:
 *   Before this extraction, the registry lived inside nimbus-session.ts,
 *   which forced nimbus-wrangler.ts to import from nimbus-session.ts —
 *   producing the cycle
 *     index.ts -> nimbus-session.ts -> nimbus-wrangler.ts -> nimbus-session.ts
 *   Promoting the registry to its own leaf breaks that cycle without
 *   changing any semantics. The Map identity is preserved across the
 *   isolate (it's still process-scoped — module-level state — survives
 *   across DO instances in the same workerd process).
 *
 * Key shape:
 *   `<supervisor-DO-id>:<binding-name>` — both halves are required to
 *   prevent multiple supervisor DOs in the same isolate from clobbering
 *   each other's registrations.
 *
 * The values are DurableObject class constructors. `any` here is
 * deliberate: the inner DO's class shape is whatever the user defines
 * in their inner Worker, and we only need to invoke it via
 * `ctx.facets.get(name, { class: cls, id })` — workerd does the rest.
 */

const _NIMBUS_INNER_DO_CLASSES: Map<string, any> = new Map();

/** Look up a registered inner-DO class. Returns undefined if not found. */
export function getInnerDoClass(supervisorDoId: string, bindingName: string): any | undefined {
  return _NIMBUS_INNER_DO_CLASSES.get(supervisorDoId + ':' + bindingName);
}

/**
 * Register an inner DO class for synthesis. Called by nimbus-wrangler.ts
 * after each successful buildAndLoad() with the class extracted from
 * the fresh worker stub. Keys are `<doId>:<bindingName>` so multiple
 * supervisor DOs don't collide.
 */
export function registerInnerDoClass(
  supervisorDoId: string,
  bindingName: string,
  cls: any,
): void {
  _NIMBUS_INNER_DO_CLASSES.set(supervisorDoId + ':' + bindingName, cls);
}

/** Clear all registrations belonging to a supervisor DO (called on rebuild). */
export function clearInnerDoClasses(supervisorDoId: string): void {
  const prefix = supervisorDoId + ':';
  for (const k of _NIMBUS_INNER_DO_CLASSES.keys()) {
    if (k.startsWith(prefix)) _NIMBUS_INNER_DO_CLASSES.delete(k);
  }
}
