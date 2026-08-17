/**
 * process-host.ts — which substrate this deployment runs resident processes
 * on. The substrates themselves live in `@nimbus-sh/fabric/process-host.js`;
 * this module owns only the deployment config that picks between them.
 */
import { createProcessHost, } from '@nimbus-sh/fabric/process-host.js';
/**
 * The var that picks the substrate, and the only place its name appears.
 * Unset means `facet`; an unrecognized value is refused rather than defaulted,
 * because a typo that silently kept the old substrate would make an operator's
 * comparison a lie.
 */
export function processHostMode(env) {
    const raw = (typeof env === 'object' || typeof env === 'function') && env !== null
        ? Reflect.get(env, 'NIMBUS_PROCESS_HOST')
        : undefined;
    if (raw === undefined || raw === null || raw === '' || raw === 'facet')
        return 'facet';
    if (raw === 'peer')
        return 'peer';
    throw new Error(`Nimbus: NIMBUS_PROCESS_HOST must be 'facet' or 'peer' (got '${String(raw)}')`);
}
/** The substrate for this deployment, resolved once. */
export function processHostFor(ctx, env, disk) {
    return createProcessHost(processHostMode(env), ctx, env, disk);
}
