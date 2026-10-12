/**
 * _shared/workspace-network.ts - the network a workspace's commands and
 * programs use, and the one place that decides it.
 *
 * A host may route that network through an egress of its own
 * (NimbusWorkspaceOptions.egress): a Fetcher, typically a service binding or
 * a `ctx.exports` entrypoint minted with the workspace's identity in its
 * props, which sees every request as it leaves and may record, rewrite or
 * refuse it. Absent, the workspace uses the isolate's own network, as it
 * always has.
 *
 * Everything that reaches the network for the workspace takes it from here:
 * code in the host's isolate calls `network.fetch`, and a Dynamic Worker
 * loaded for the workspace takes `loaderOutbound(network)` into its loader
 * config, so its own `fetch()` and `connect()` reach the egress as its
 * globalOutbound. The key is omitted when there is no egress, which keeps
 * the loader's default: the parent's network.
 */
/** The isolate's own network: what a kernel or command holds before a workspace gives it one. */
export const ISOLATE_NETWORK = {
    egress: undefined,
    id: '',
    fetch: (input, init) => globalThis.fetch(input, init),
    forProcess: () => ISOLATE_NETWORK,
};
/** The network each egress object stands for (workspaceNetwork, selectProcessEgress). */
const networks = new WeakMap();
/** The process table a workspace egress's network selects for (selectProcessEgress). */
const selecting = new WeakMap();
/** A network that selects for no process: every process's is this one. */
function egressNetwork(egress, id) {
    const network = {
        egress, id,
        fetch: (input, init) => egress.fetch(new Request(input, init)),
        forProcess: () => network,
    };
    return network;
}
/**
 * The workspace network over `egress` whose processes each go out through
 * the egress `egressFor` mints for them: asked once per live entry of
 * `processes`, the source of its exec id.
 */
function selectingNetwork(egress, id, egressFor, processes) {
    const selections = new WeakMap();
    const network = {
        egress, id,
        fetch: (input, init) => egress.fetch(new Request(input, init)),
        forProcess: (pid) => {
            if (pid === 0)
                return network;
            const entry = processes.get(pid);
            if (entry === undefined)
                throw Object.assign(new Error(`no process ${pid} to select a network for`), { code: 'ESRCH' });
            let selected = selections.get(entry);
            if (selected === undefined) {
                const own = egressFor(entry.execId === undefined ? { pid } : { pid, execId: entry.execId });
                selected = own === undefined ? network : processNetwork(network, own, `${id}:p${pid}:${crypto.randomUUID()}`);
                selections.set(entry, selected);
            }
            return selected;
        },
    };
    return network;
}
/** One process's network: its own egress and id; any other process's is the workspace's to select. */
function processNetwork(workspace, egress, id) {
    const network = {
        egress, id,
        fetch: (input, init) => egress.fetch(new Request(input, init)),
        forProcess: (pid) => (pid === 0 ? network : workspace.forProcess(pid)),
    };
    return network;
}
/**
 * The workspace network over `egress`, made to give each process of
 * `processes` the egress `egressFor` mints for it
 * (NimbusWorkspaceOptions.egressFor). Decided when the network is made: a
 * host that builds the network itself (for its facets) selects first, then
 * `workspaceNetwork(egress)` answers this one. Refused when the network over
 * `egress` was made without this table.
 */
export function selectProcessEgress(egress, egressFor, processes) {
    const known = networks.get(egress);
    if (known !== undefined) {
        if (selecting.get(egress) !== processes) {
            throw new Error('selectProcessEgress: the network over this egress was made before without this process table; select before workspaceNetwork(egress)');
        }
        return known;
    }
    const network = selectingNetwork(egress, 'egress-' + crypto.randomUUID(), egressFor, processes);
    networks.set(egress, network);
    selecting.set(egress, processes);
    return network;
}
/**
 * The workspace network over `egress`, or the isolate's own network when
 * there is none. One per egress object: whatever asks for it (the workspace,
 * or a session re-driving a process before its workspace exists) holds the
 * same network, under the same id. `id` is given only where a network
 * crosses to another Durable Object: a peer that runs the workspace's work
 * rebuilds it over the stub it received, under the coordinator's id.
 */
export function workspaceNetwork(egress, id) {
    if (egress === undefined)
        return ISOLATE_NETWORK;
    if (id !== undefined)
        return egressNetwork(egress, id);
    let network = networks.get(egress);
    if (network === undefined) {
        network = egressNetwork(egress, 'egress-' + crypto.randomUUID());
        networks.set(egress, network);
    }
    return network;
}
export function networkRef(network) {
    return network?.egress === undefined ? undefined : { egress: network.egress, id: network.id };
}
/**
 * The part of a Dynamic Worker's loader config that routes it through the
 * workspace's egress: `{ globalOutbound }`, or nothing (the loader's default)
 * when there is none.
 */
export function loaderOutbound(network) {
    return network?.egress === undefined ? {} : { globalOutbound: network.egress };
}
/**
 * `network`, checked where a pool, a fanout or a facet host takes it: a caller
 * that does not type-check (a host's JavaScript) is refused by name rather
 * than given the isolate's network unasked.
 */
export function requireNetwork(network, who) {
    if (network === undefined || network === null || typeof network.fetch !== 'function' || typeof network.forProcess !== 'function' || typeof network.id !== 'string') {
        throw new TypeError(`${who}: a network is required: the workspace's (workspace.network), or ISOLATE_NETWORK for Nimbus's own work`);
    }
    return network;
}
/** Why a program's TLS socket is refused when the workspace's network goes through an egress. */
export const EGRESS_TLS_REFUSAL = "Nimbus: TLS sockets are not available when the workspace's network goes through an egress "
    + "(a Fetcher's connect() carries plain TCP only); use fetch() or https for HTTPS";
