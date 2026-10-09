/**
 * supervisor-props.ts — what every SUPERVISOR binding a Durable Object mints
 * for a process carries, and the one rule for naming the instance in it.
 *
 * A binding names its host INSTANCE (`hostIncarnation`) exactly when a
 * mutation sent through it can be delivered once
 * (@nimbus-sh/core/workspace/supervisor-delivery.js): the host opened a
 * delivery store, the binding acts as a real process (SupervisorRPC refuses
 * every filesystem mutation of pid 0), and it routes back to this very
 * object rather than another (a fanout pool writes to its coordinator).
 * Minting every binding here is what keeps a new mint site from forgetting
 * that, which would fail silently: its mutations would simply never be
 * re-sent.
 */
import { supervisorDeliveryProps } from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import { hostRoute, supervisorEntrypoint, supervisorEntrypointName } from './composition.js';
/**
 * The props of a SUPERVISOR binding minted in the Durable Object whose state
 * is `ctx`, for process `pid`, reaching `options.doId` (this object by
 * default) by `options.route` (this isolate's composition by default).
 */
export function supervisorBindingProps(ctx, pid, 
/**
 * `network` is the workspace's (`workspace.network`), required so that no
 * mint site can hand a process a binding that bypasses its egress; a
 * binding no workspace's work goes through passes ISOLATE_NETWORK.
 */
options) {
    if (typeof options.writerId !== 'string' || options.writerId.length === 0)
        throw new Error('a process supervisor binding requires a run');
    const own = ctx.id.toString();
    const doId = options.doId ?? own;
    const route = options.route ?? hostRoute() ?? undefined;
    const delivery = pid > 0 && doId === own ? supervisorDeliveryProps(ctx, pid) : {};
    const egress = options.network.egress === undefined ? {} : { egress: options.network.egress, networkId: options.network.id };
    return { doId, pid, route, ...delivery, bindingKind: 'process', writerId: options.writerId, ...egress };
}
/** The one mint for SUPERVISOR/outbound capabilities handed to a process. */
export function mintProcessSupervisor(mint, props) {
    if (props.bindingKind !== 'process' || typeof props.writerId !== 'string' || props.writerId.length === 0) {
        throw new Error('cannot hand a process a supervisor binding without its run');
    }
    return mint({ props });
}
/**
 * A process's SUPERVISOR as its binding, minted through the composed
 * entrypoint: a resident's, a run's network (its globalOutbound), a staged
 * run's (minted in its stateless hop, from that isolate's `exports`), and what
 * a host that answers none in-process hands its one-shots (Supervise). Each
 * call on it is a request to the host.
 */
export function bindingSupervisor(props, exports) {
    const mint = supervisorEntrypoint(exports, props.route?.supervisorEntrypoint);
    if (!mint) {
        throw new Error(`Nimbus: ctx.exports.${props.route?.supervisorEntrypoint ?? supervisorEntrypointName() ?? '<supervisor entrypoint>'} unavailable`);
    }
    return mintProcessSupervisor(mint, props);
}
/**
 * `key`, for a loader cache entry whose worker holds a binding with `props`:
 * made specific to the host instance the binding names, since the loader
 * outlives that instance and the next one refuses every mutation the binding
 * would deliver. A binding that names none keeps `key`, and its warm worker.
 */
export function supervisorLoaderKey(key, props) {
    return props.hostIncarnation === undefined ? key : `${key}:${props.hostIncarnation}`;
}
