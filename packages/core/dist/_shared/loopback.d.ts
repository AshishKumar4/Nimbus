/**
 * _shared/loopback.ts — which hosts name this machine's loopback, for every
 * layer that routes them to the session's own ports instead of the network:
 * the shell's fetch and node:http (substrate kernel), and the node fetch
 * shim inside a process facet, which carries the list as a literal.
 */
/** Loopback hosts as a WHATWG URL's `hostname` spells them: an IPv6 address keeps its brackets. */
export declare const LOOPBACK_HOSTNAMES: readonly string[];
export declare function isLoopbackHost(host: string): boolean;
//# sourceMappingURL=loopback.d.ts.map