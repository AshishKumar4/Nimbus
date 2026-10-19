/**
 * Whether `env` turns on Nimbus's operator diagnostics (NIMBUS_DEBUG): the
 * string '1' or 'true', as a wrangler var or a test harness sets it. The one
 * reading of the var, so a Durable Object session, a hosted runtime and the
 * facet manager they compose never disagree about the same binding.
 */
export function nimbusDebugEnabled(env) {
    const raw = (typeof env === 'object' || typeof env === 'function') && env !== null
        ? Reflect.get(env, 'NIMBUS_DEBUG')
        : undefined;
    return raw === '1' || raw === 'true';
}
