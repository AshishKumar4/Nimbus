/**
 * Node.js `dns` module shim for Lifo.
 *
 * Real DNS resolution is not available in the browser. The callback-style API
 * invokes callbacks with an ENOTFOUND error, while the promises API rejects.
 * `lookup` is the most commonly used function so it gets special treatment:
 * for "localhost" it resolves to 127.0.0.1, everything else errors.
 */
declare const NOTFOUND = "ENOTFOUND";
type LookupCallback = (err: Error | null, address?: string, family?: number) => void;
type LookupAllCallback = (err: Error | null, addresses?: Array<{
    address: string;
    family: number;
}>) => void;
declare function lookup(hostname: string, options: {
    all: true;
}, cb: LookupAllCallback): void;
declare function lookup(hostname: string, options: {
    family?: number;
} | number, cb: LookupCallback): void;
declare function lookup(hostname: string, cb: LookupCallback): void;
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
declare const promises: {
    lookup: (hostname: string, options?: {
        all?: boolean;
        family?: number;
    } | number) => Promise<{
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
declare const ADDRGETNETWORKPARAMS = "EADDRGETNETWORKPARAMS";
declare const BADFAMILY = "EBADFAMILY";
declare const BADFLAGS = "EBADFLAGS";
declare const BADHINTS = "EBADHINTS";
declare const BADNAME = "EBADNAME";
declare const BADQUERY = "EBADQUERY";
declare const BADRESP = "EBADRESP";
declare const BADSTR = "EBADSTR";
declare const CANCELLED = "ECANCELLED";
declare const CONNREFUSED = "ECONNREFUSED";
declare const DESTRUCTION = "EDESTRUCTION";
declare const EOF = "EEOF";
declare const FILE = "EFILE";
declare const FORMERR = "EFORMERR";
declare const LOADIPHLPAPI = "ELOADIPHLPAPI";
declare const NODATA = "ENODATA";
declare const NOMEM = "ENOMEM";
declare const NONAME = "ENONAME";
declare const NOTINITIALIZED = "ENOTINITIALIZED";
declare const REFUSED = "EREFUSED";
declare const SERVFAIL = "ESERVFAIL";
declare const TIMEOUT = "ETIMEOUT";
export { lookup, resolve, resolve4, resolve6, resolveMx, resolveTxt, resolveSrv, resolveNs, resolveCname, reverse, setServers, getServers, promises, NOTFOUND, ADDRGETNETWORKPARAMS, BADFAMILY, BADFLAGS, BADHINTS, BADNAME, BADQUERY, BADRESP, BADSTR, CANCELLED, CONNREFUSED, DESTRUCTION, EOF, FILE, FORMERR, LOADIPHLPAPI, NODATA, NOMEM, NONAME, NOTINITIALIZED, REFUSED, SERVFAIL, TIMEOUT, };
declare const _default: {
    lookup: typeof lookup;
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
        lookup: (hostname: string, options?: {
            all?: boolean;
            family?: number;
        } | number) => Promise<{
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
};
export default _default;
//# sourceMappingURL=dns.d.ts.map