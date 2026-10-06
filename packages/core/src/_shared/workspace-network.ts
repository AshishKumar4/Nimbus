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

/**
 * What a host supplies: a `fetch` for HTTP (WebSocket upgrades included) and,
 * for programs that open TCP sockets, a `connect` (a Fetcher's own; its
 * sockets carry plain TCP only, so a program's TLS socket is refused under an
 * egress, see `EGRESS_TLS_REFUSAL`).
 */
export interface WorkspaceEgress {
  fetch(request: Request): Promise<Response>;
  connect?(address: string | { hostname: string; port: number }, options?: unknown): unknown;
}

export interface WorkspaceNetwork {
  /** The host's egress, or undefined for the isolate's own network. */
  readonly egress: WorkspaceEgress | undefined;
  /**
   * Who this network is, for anything that caches what it fetched or loaded
   * through it (a loader id, a response cache): '' for the isolate's own
   * network, else an id unique to this egress, so nothing made under one
   * workspace's egress is reused under another's.
   */
  readonly id: string;
  /** `fetch` for code that runs in the host's isolate on the workspace's behalf. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The isolate's own network: what a kernel or command holds before a workspace gives it one. */
export const ISOLATE_NETWORK: WorkspaceNetwork = {
  egress: undefined,
  id: '',
  fetch: (input, init) => globalThis.fetch(input, init),
};

/** The network each egress object stands for (workspaceNetwork). */
const networks = new WeakMap<WorkspaceEgress, WorkspaceNetwork>();

function egressNetwork(egress: WorkspaceEgress, id: string): WorkspaceNetwork {
  return { egress, id, fetch: (input, init) => egress.fetch(new Request(input, init)) };
}

/**
 * The workspace network over `egress`, or the isolate's own network when
 * there is none. One per egress object: whatever asks for it (the workspace,
 * or a session re-driving a process before its workspace exists) holds the
 * same network, under the same id. `id` is given only where a network
 * crosses to another Durable Object: a peer that runs the workspace's work
 * rebuilds it over the stub it received, under the coordinator's id.
 */
export function workspaceNetwork(egress?: WorkspaceEgress, id?: string): WorkspaceNetwork {
  if (egress === undefined) return ISOLATE_NETWORK;
  if (id !== undefined) return egressNetwork(egress, id);
  let network = networks.get(egress);
  if (network === undefined) {
    network = egressNetwork(egress, 'egress-' + crypto.randomUUID());
    networks.set(egress, network);
  }
  return network;
}

/** What crosses to another Durable Object for `network` (an egress stub crosses RPC; the network rebuilds there). */
export interface WorkspaceNetworkRef {
  egress: WorkspaceEgress;
  id: string;
}

export function networkRef(network: WorkspaceNetwork | undefined): WorkspaceNetworkRef | undefined {
  return network?.egress === undefined ? undefined : { egress: network.egress, id: network.id };
}

/**
 * The part of a Dynamic Worker's loader config that routes it through the
 * workspace's egress: `{ globalOutbound }`, or nothing (the loader's default)
 * when there is none.
 */
export function loaderOutbound(network: WorkspaceNetwork | undefined): { globalOutbound?: WorkspaceEgress } {
  return network?.egress === undefined ? {} : { globalOutbound: network.egress };
}

/** Why a program's TLS socket is refused when the workspace's network goes through an egress. */
export const EGRESS_TLS_REFUSAL =
  "Nimbus: TLS sockets are not available when the workspace's network goes through an egress "
  + "(a Fetcher's connect() carries plain TCP only); use fetch() or https for HTTPS";
