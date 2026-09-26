import { ProcessRegistry } from '../shell/ProcessRegistry.js';
import { NetworkStack } from './network/NetworkStack.js';
import { PortBridge } from './network/PortBridge.js';
const DEFAULT_HOSTS = `127.0.0.1       localhost
::1             localhost ip6-localhost ip6-loopback
`;
export function isLoopbackHost(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]';
}
/**
 * What a session's processes share besides their filesystem (which is
 * ProcessFiles'): the process table, the virtual ports and the network stack,
 * whose resolver starts from the default /etc/hosts.
 */
export class Kernel {
    portRegistry = new Map();
    routeLoopback;
    portBridge;
    processRegistry;
    networkStack;
    constructor() {
        this.processRegistry = new ProcessRegistry();
        this.networkStack = new NetworkStack();
        this.portBridge = new PortBridge(this.portRegistry);
        this.networkStack.getDNS().loadHostsFile(DEFAULT_HOSTS);
    }
    getDefaultEnv() {
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
