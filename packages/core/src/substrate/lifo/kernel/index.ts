import { ProcessRegistry } from '../shell/ProcessRegistry.js';
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
	headers: Record<string, string>;
	body: string;
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
 * ProcessFiles'): the process table, the virtual ports and the resolver,
 * which starts from the default /etc/hosts.
 */
export class Kernel {
	portRegistry: Map<number, VirtualRequestHandler> = new Map();
	routeLoopback?: LoopbackRouter;
	processRegistry: ProcessRegistry;
	readonly dns = createHostsResolver();

	constructor() {
		this.processRegistry = new ProcessRegistry();
	}
}
