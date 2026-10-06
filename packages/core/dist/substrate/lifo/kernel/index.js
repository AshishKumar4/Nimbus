import { ProcessRegistry } from '../shell/ProcessRegistry.js';
import { DNSResolver } from './dns-resolver.js';
const DEFAULT_HOSTS = `127.0.0.1       localhost
::1             localhost ip6-localhost ip6-loopback
`;
export { isLoopbackHost } from '../../../_shared/loopback.js';
/** A resolver holding the default /etc/hosts: the one place `localhost` is named. */
export function createHostsResolver() {
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
    portRegistry = new Map();
    routeLoopback;
    processRegistry;
    dns = createHostsResolver();
    constructor() {
        this.processRegistry = new ProcessRegistry();
    }
}
