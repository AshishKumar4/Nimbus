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
import { createHostsResolver } from '../kernel/index.js';

const NOTFOUND = 'ENOTFOUND';

function makeError(hostname: string, syscall: string): Error & { code: string; hostname: string; syscall: string } {
  const err = new Error(`getaddrinfo ${NOTFOUND} ${hostname}`) as Error & { code: string; hostname: string; syscall: string };
  err.code = NOTFOUND;
  err.hostname = hostname;
  err.syscall = syscall;
  return err;
}

type LookupCallback = (err: Error | null, address?: string, family?: number) => void;
type LookupAllCallback = (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void;
type LookupOptions = { all?: boolean; family?: number } | number;

/** `hostname` as getaddrinfo would answer it here: a literal as itself, a name from `resolver`. */
function lookupAddress(resolver: DNSResolver, hostname: string): { address: string; family: number } | null {
  const address = /^[0-9.]+$/.test(hostname) || hostname.includes(':') ? hostname : resolver.lookup(hostname)?.value;
  return address === undefined ? null : { address, family: address.includes(':') ? 6 : 4 };
}

function createLookup(resolver: DNSResolver) {
  function lookup(hostname: string, options: { all: true }, cb: LookupAllCallback): void;
  function lookup(hostname: string, options: LookupOptions, cb: LookupCallback): void;
  function lookup(hostname: string, cb: LookupCallback): void;
  function lookup(
    hostname: string,
    optionsOrCb?: LookupOptions | LookupCallback | LookupAllCallback,
    cb?: LookupCallback | LookupAllCallback,
  ): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    const all = typeof optionsOrCb === 'object' && optionsOrCb?.all === true;
    const entry = lookupAddress(resolver, hostname);
    if (entry === null) callback(makeError(hostname, 'getaddrinfo'));
    else if (all) (callback as LookupAllCallback)(null, [entry]);
    else (callback as LookupCallback)(null, entry.address, entry.family);
  }
  return lookup;
}

function resolve(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void;
function resolve(hostname: string, rrtype: string, cb: (err: Error | null, addresses?: unknown[]) => void): void;
function resolve(
  hostname: string,
  rrtypeOrCb: string | ((err: Error | null, addresses?: string[]) => void),
  cb?: (err: Error | null, addresses?: unknown[]) => void,
): void {
  const callback = typeof rrtypeOrCb === 'function' ? rrtypeOrCb : cb!;
  callback(makeError(hostname, 'queryA'));
}

function resolve4(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void {
  cb(makeError(hostname, 'queryA'));
}

function resolve6(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void {
  cb(makeError(hostname, 'queryAaaa'));
}

function resolveMx(hostname: string, cb: (err: Error | null, addresses?: Array<{ exchange: string; priority: number }>) => void): void {
  cb(makeError(hostname, 'queryMx'));
}

function resolveTxt(hostname: string, cb: (err: Error | null, addresses?: string[][]) => void): void {
  cb(makeError(hostname, 'queryTxt'));
}

function resolveSrv(hostname: string, cb: (err: Error | null, addresses?: Array<{ name: string; port: number; priority: number; weight: number }>) => void): void {
  cb(makeError(hostname, 'querySrv'));
}

function resolveNs(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void {
  cb(makeError(hostname, 'queryNs'));
}

function resolveCname(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void {
  cb(makeError(hostname, 'queryCname'));
}

function reverse(ip: string, cb: (err: Error | null, hostnames?: string[]) => void): void {
  cb(makeError(ip, 'getHostByAddr'));
}

function setServers(_servers: string[]): void {
  // no-op
}

function getServers(): string[] {
  return [];
}

// dns.promises API, but for lookup, which createDns binds to a resolver.
const promises = {
  resolve: (hostname: string, _rrtype?: string): Promise<string[]> => {
    return Promise.reject(makeError(hostname, 'queryA'));
  },
  resolve4: (hostname: string): Promise<string[]> => {
    return Promise.reject(makeError(hostname, 'queryA'));
  },
  resolve6: (hostname: string): Promise<string[]> => {
    return Promise.reject(makeError(hostname, 'queryAaaa'));
  },
  reverse: (ip: string): Promise<string[]> => {
    return Promise.reject(makeError(ip, 'getHostByAddr'));
  },
  setServers: (_servers: string[]): void => { /* no-op */ },
  getServers: (): string[] => [],
};

// Error code constants
const ADDRGETNETWORKPARAMS = 'EADDRGETNETWORKPARAMS';
const BADFAMILY = 'EBADFAMILY';
const BADFLAGS = 'EBADFLAGS';
const BADHINTS = 'EBADHINTS';
const BADNAME = 'EBADNAME';
const BADQUERY = 'EBADQUERY';
const BADRESP = 'EBADRESP';
const BADSTR = 'EBADSTR';
const CANCELLED = 'ECANCELLED';
const CONNREFUSED = 'ECONNREFUSED';
const DESTRUCTION = 'EDESTRUCTION';
const EOF = 'EEOF';
const FILE = 'EFILE';
const FORMERR = 'EFORMERR';
const LOADIPHLPAPI = 'ELOADIPHLPAPI';
const NODATA = 'ENODATA';
const NOMEM = 'ENOMEM';
const NONAME = 'ENONAME';
const NOTINITIALIZED = 'ENOTINITIALIZED';
const REFUSED = 'EREFUSED';
const SERVFAIL = 'ESERVFAIL';
const TIMEOUT = 'ETIMEOUT';

/** The dns module, its lookups answered from `resolver` (one holding the default /etc/hosts, without a kernel). */
export function createDns(resolver: DNSResolver = createHostsResolver()) {
  const lookup = createLookup(resolver);
  const mod = {
    lookup,
    resolve,
    resolve4,
    resolve6,
    resolveMx,
    resolveTxt,
    resolveSrv,
    resolveNs,
    resolveCname,
    reverse,
    setServers,
    getServers,
    promises: {
      ...promises,
      lookup: (hostname: string, options?: LookupOptions): Promise<{ address: string; family: number } | Array<{ address: string; family: number }>> => {
        const entry = lookupAddress(resolver, hostname);
        if (entry === null) return Promise.reject(makeError(hostname, 'getaddrinfo'));
        return Promise.resolve(typeof options === 'object' && options?.all ? [entry] : entry);
      },
    },
    NOTFOUND,
    ADDRGETNETWORKPARAMS,
    BADFAMILY,
    BADFLAGS,
    BADHINTS,
    BADNAME,
    BADQUERY,
    BADRESP,
    BADSTR,
    CANCELLED,
    CONNREFUSED,
    DESTRUCTION,
    EOF,
    FILE,
    FORMERR,
    LOADIPHLPAPI,
    NODATA,
    NOMEM,
    NONAME,
    NOTINITIALIZED,
    REFUSED,
    SERVFAIL,
    TIMEOUT,
  };
  return { ...mod, default: mod };
}
