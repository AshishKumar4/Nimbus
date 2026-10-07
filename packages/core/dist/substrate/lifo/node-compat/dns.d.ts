/**
 * Node.js `dns` module shim for Lifo.
 *
 * There is no DNS service to ask. `lookup` answers an address literal as
 * itself and a name from the kernel's resolver (its /etc/hosts, and what was
 * added to it, as curl and wget resolve), else ENOTFOUND; every query
 * (resolve*, reverse) fails with ENOTFOUND, callbacks called and promises
 * rejected.
 */
import type { DNSResolver } from '../kernel/dns-resolver.js';
type LookupCallback = (err: Error | null, address?: string, family?: number) => void;
type LookupAllCallback = (err: Error | null, addresses?: Array<{
    address: string;
    family: number;
}>) => void;
type LookupOptions = {
    all?: boolean;
    family?: number;
} | number;
declare function resolve(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void;
declare function resolve(hostname: string, rrtype: string, cb: (err: Error | null, addresses?: unknown[]) => void): void;
declare function resolve4(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void;
declare function resolve6(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void;
declare function resolveMx(hostname: string, cb: (err: Error | null, addresses?: Array<{
    exchange: string;
    priority: number;
}>) => void): void;
declare function resolveTxt(hostname: string, cb: (err: Error | null, addresses?: string[][]) => void): void;
declare function resolveSrv(hostname: string, cb: (err: Error | null, addresses?: Array<{
    name: string;
    port: number;
    priority: number;
    weight: number;
}>) => void): void;
declare function resolveNs(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void;
declare function resolveCname(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void;
declare function reverse(ip: string, cb: (err: Error | null, hostnames?: string[]) => void): void;
declare function setServers(_servers: string[]): void;
declare function getServers(): string[];
/** The dns module, its lookups answered from `resolver` (one holding the default /etc/hosts, without a kernel). */
export declare function createDns(resolver?: DNSResolver): {
    default: {
        lookup: {
            (hostname: string, options: {
                all: true;
            }, cb: LookupAllCallback): void;
            (hostname: string, options: LookupOptions, cb: LookupCallback): void;
            (hostname: string, cb: LookupCallback): void;
        };
        resolve: typeof resolve;
        resolve4: typeof resolve4;
        resolve6: typeof resolve6;
        resolveMx: typeof resolveMx;
        resolveTxt: typeof resolveTxt;
        resolveSrv: typeof resolveSrv;
        resolveNs: typeof resolveNs;
        resolveCname: typeof resolveCname;
        reverse: typeof reverse;
        setServers: typeof setServers;
        getServers: typeof getServers;
        promises: {
            lookup: (hostname: string, options?: LookupOptions) => Promise<{
                address: string;
                family: number;
            } | Array<{
                address: string;
                family: number;
            }>>;
            resolve: (hostname: string, _rrtype?: string) => Promise<string[]>;
            resolve4: (hostname: string) => Promise<string[]>;
            resolve6: (hostname: string) => Promise<string[]>;
            reverse: (ip: string) => Promise<string[]>;
            setServers: (_servers: string[]) => void;
            getServers: () => string[];
        };
        NOTFOUND: string;
        ADDRGETNETWORKPARAMS: string;
        BADFAMILY: string;
        BADFLAGS: string;
        BADHINTS: string;
        BADNAME: string;
        BADQUERY: string;
        BADRESP: string;
        BADSTR: string;
        CANCELLED: string;
        CONNREFUSED: string;
        DESTRUCTION: string;
        EOF: string;
        FILE: string;
        FORMERR: string;
        LOADIPHLPAPI: string;
        NODATA: string;
        NOMEM: string;
        NONAME: string;
        NOTINITIALIZED: string;
        REFUSED: string;
        SERVFAIL: string;
        TIMEOUT: string;
    };
    lookup: {
        (hostname: string, options: {
            all: true;
        }, cb: LookupAllCallback): void;
        (hostname: string, options: LookupOptions, cb: LookupCallback): void;
        (hostname: string, cb: LookupCallback): void;
    };
    resolve: typeof resolve;
    resolve4: typeof resolve4;
    resolve6: typeof resolve6;
    resolveMx: typeof resolveMx;
    resolveTxt: typeof resolveTxt;
    resolveSrv: typeof resolveSrv;
    resolveNs: typeof resolveNs;
    resolveCname: typeof resolveCname;
    reverse: typeof reverse;
    setServers: typeof setServers;
    getServers: typeof getServers;
    promises: {
        lookup: (hostname: string, options?: LookupOptions) => Promise<{
            address: string;
            family: number;
        } | Array<{
            address: string;
            family: number;
        }>>;
        resolve: (hostname: string, _rrtype?: string) => Promise<string[]>;
        resolve4: (hostname: string) => Promise<string[]>;
        resolve6: (hostname: string) => Promise<string[]>;
        reverse: (ip: string) => Promise<string[]>;
        setServers: (_servers: string[]) => void;
        getServers: () => string[];
    };
    NOTFOUND: string;
    ADDRGETNETWORKPARAMS: string;
    BADFAMILY: string;
    BADFLAGS: string;
    BADHINTS: string;
    BADNAME: string;
    BADQUERY: string;
    BADRESP: string;
    BADSTR: string;
    CANCELLED: string;
    CONNREFUSED: string;
    DESTRUCTION: string;
    EOF: string;
    FILE: string;
    FORMERR: string;
    LOADIPHLPAPI: string;
    NODATA: string;
    NOMEM: string;
    NONAME: string;
    NOTINITIALIZED: string;
    REFUSED: string;
    SERVFAIL: string;
    TIMEOUT: string;
};
export {};
//# sourceMappingURL=dns.d.ts.map