import { ISOLATE_NETWORK, type WorkspaceNetwork } from '../../../_shared/workspace-network.js';
import { ProcessRegistry } from '../shell/ProcessRegistry.js';
import { NetworkStack } from './network/NetworkStack.js';
import { PortBridge } from './network/PortBridge.js';

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
	headers: Record<string, string>;
	body: string;
}

export type VirtualRequestHandler = (req: VirtualRequest, res: VirtualResponse) => void;

export type LoopbackRouter = (port: number, request: Request) => Promise<Response | null>;

export { isLoopbackHost } from '../../../_shared/loopback.js';

/**
 * What a session's processes share besides their filesystem (which is
 * ProcessFiles'): the process table, the virtual ports and the network stack,
 * whose resolver starts from the default /etc/hosts.
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
	portBridge: PortBridge;
	processRegistry: ProcessRegistry;
	networkStack: NetworkStack;

	constructor() {
		this.processRegistry = new ProcessRegistry();
		this.networkStack = new NetworkStack();
		this.portBridge = new PortBridge(this.portRegistry);
		this.networkStack.getDNS().loadHostsFile(DEFAULT_HOSTS);
	}

	getDefaultEnv(): Record<string, string> {
		return {
			HOME: '/home/user',
			USER: 'user',
			HOSTNAME: 'lifo',
			SHELL: '/bin/sh',
			PATH: '/usr/bin:/bin',
			TERM: 'xterm-256color',
			PWD: '/home/user',
		};
	}
}
