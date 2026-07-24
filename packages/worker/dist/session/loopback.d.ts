/**
 * session/loopback.ts — where an in-session request to 127.0.0.1:<port> goes.
 *
 * Both loopback entrypoints route through here: `kernel.routeLoopback`
 * (session/init.ts — the shell's curl and the in-DO node client) and
 * `_rpcRouteLoopback` (session/rpc.ts — a facet's patched global fetch). They
 * were the same lookup written twice; now the policy lives once.
 *
 * The policy is: the supervisor's own services answer first, then the port
 * registry. Today the only supervisor-served port is the AI gateway, and it is
 * deliberately NOT a PortRegistry entry — the registry also backs the external
 * `/port/<n>`, `/preview/?port=N` and the shareable `<port>--<sid>` preview
 * hostname, so registering it would publish a credential-backed inference
 * endpoint to the internet. Serving it here keeps it reachable only from
 * inside the session.
 */
import { type SessionAiHost } from './ai.js';
interface LoopbackHost extends SessionAiHost {
    portRegistry: {
        has(port: number): boolean;
        routeRequest(port: number, request: Request, pathname: string): Promise<Response | null>;
    };
}
/**
 * Resolve one loopback request. Returns null when nothing is listening on the
 * port, which callers render as a connection refusal.
 */
export declare function routeSessionLoopback(self: LoopbackHost, port: number, request: Request): Promise<Response | null>;
export {};
//# sourceMappingURL=loopback.d.ts.map