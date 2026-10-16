import { ISOLATE_NETWORK, type WorkspaceNetwork } from '../../../_shared/workspace-network.js';
import { DNSResolver } from './dns-resolver.js';

const DEFAULT_HOSTS = `127.0.0.1       localhost
::1             localhost ip6-localhost ip6-loopback
`;

export interface VirtualRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
}

export interface VirtualResponse {
	statusCode: number;
	/** The reason phrase its handler sent, if it named one (Node's http: writeHead's reason, statusMessage). */
	statusMessage?: string;
	headers: Record<string, string>;
	body: string;
	/**
	 * Set by a handler that returned before ending the response (a timer, an
	 * await, async middleware): settles when it ends, and whoever serves the
	 * request waits for it (kernel/local-serve.ts).
	 */
	_donePromise?: Promise<void>;
}

export type VirtualRequestHandler = (req: VirtualRequest, res: VirtualResponse) => void;

export type LoopbackRouter = (port: number, request: Request) => Promise<Response | null>;

export { isLoopbackHost } from '../../../_shared/loopback.js';

/** A resolver holding the default /etc/hosts: the one place `localhost` is named. */
export function createHostsResolver(): DNSResolver {
	const resolver = new DNSResolver();
	resolver.loadHostsFile(DEFAULT_HOSTS);
	return resolver;
}

/**
 * What a session's processes share besides their filesystem (which is
 * ProcessFiles') and their table (SessionProcessSupervisor's): the virtual
 * ports and the resolver, which starts from the default /etc/hosts.
 */
export class Kernel {
	portRegistry: Map<number, VirtualRequestHandler> = new Map();
	/**
	 * The network its commands reach off the box through: the workspace's
	 * egress when its host supplied one (NimbusWorkspaceOptions.egress), else
	 * the isolate's own. Loopback never goes here: the port registry and
	 * `routeLoopback` answer it.
	 */
	network: WorkspaceNetwork = ISOLATE_NETWORK;
	routeLoopback?: LoopbackRouter;
	readonly dns = createHostsResolver();
}
