import { createHostsResolver } from '../kernel/index.js';
const NOTFOUND = 'ENOTFOUND';
function makeError(hostname, syscall) {
    const err = new Error(`getaddrinfo ${NOTFOUND} ${hostname}`);
    err.code = NOTFOUND;
    err.hostname = hostname;
    err.syscall = syscall;
    return err;
}
/** `hostname` as getaddrinfo would answer it here: a literal as itself, a name from `resolver`. */
function lookupAddress(resolver, hostname) {
    const address = /^[0-9.]+$/.test(hostname) || hostname.includes(':') ? hostname : resolver.lookup(hostname)?.value;
    return address === undefined ? null : { address, family: address.includes(':') ? 6 : 4 };
}
function createLookup(resolver) {
    function lookup(hostname, optionsOrCb, cb) {
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
        const all = typeof optionsOrCb === 'object' && optionsOrCb?.all === true;
        const entry = lookupAddress(resolver, hostname);
        if (entry === null)
            callback(makeError(hostname, 'getaddrinfo'));
        else if (all)
            callback(null, [entry]);
        else
            callback(null, entry.address, entry.family);
    }
    return lookup;
}
function resolve(hostname, rrtypeOrCb, cb) {
    const callback = typeof rrtypeOrCb === 'function' ? rrtypeOrCb : cb;
    callback(makeError(hostname, 'queryA'));
}
function resolve4(hostname, cb) {
    cb(makeError(hostname, 'queryA'));
}
function resolve6(hostname, cb) {
    cb(makeError(hostname, 'queryAaaa'));
}
function resolveMx(hostname, cb) {
    cb(makeError(hostname, 'queryMx'));
}
function resolveTxt(hostname, cb) {
    cb(makeError(hostname, 'queryTxt'));
}
function resolveSrv(hostname, cb) {
    cb(makeError(hostname, 'querySrv'));
}
function resolveNs(hostname, cb) {
    cb(makeError(hostname, 'queryNs'));
}
function resolveCname(hostname, cb) {
    cb(makeError(hostname, 'queryCname'));
}
function reverse(ip, cb) {
    cb(makeError(ip, 'getHostByAddr'));
}
function setServers(_servers) {
    // no-op
}
function getServers() {
    return [];
}
// dns.promises API, but for lookup, which createDns binds to a resolver.
const promises = {
    resolve: (hostname, _rrtype) => {
        return Promise.reject(makeError(hostname, 'queryA'));
    },
    resolve4: (hostname) => {
        return Promise.reject(makeError(hostname, 'queryA'));
    },
    resolve6: (hostname) => {
        return Promise.reject(makeError(hostname, 'queryAaaa'));
    },
    reverse: (ip) => {
        return Promise.reject(makeError(ip, 'getHostByAddr'));
    },
    setServers: (_servers) => { },
    getServers: () => [],
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
export function createDns(resolver = createHostsResolver()) {
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
            lookup: (hostname, options) => {
                const entry = lookupAddress(resolver, hostname);
                if (entry === null)
                    return Promise.reject(makeError(hostname, 'getaddrinfo'));
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
