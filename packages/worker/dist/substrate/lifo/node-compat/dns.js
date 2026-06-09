/**
 * Node.js `dns` module shim for Lifo.
 *
 * Real DNS resolution is not available in the browser. The callback-style API
 * invokes callbacks with an ENOTFOUND error, while the promises API rejects.
 * `lookup` is the most commonly used function so it gets special treatment:
 * for "localhost" it resolves to 127.0.0.1, everything else errors.
 */
const NOTFOUND = 'ENOTFOUND';
function makeError(hostname, syscall) {
    const err = new Error(`getaddrinfo ${NOTFOUND} ${hostname}`);
    err.code = NOTFOUND;
    err.hostname = hostname;
    err.syscall = syscall;
    return err;
}
function lookup(hostname, optionsOrCb, cb) {
    let callback;
    let all = false;
    if (typeof optionsOrCb === 'function') {
        callback = optionsOrCb;
    }
    else {
        if (typeof optionsOrCb === 'object' && optionsOrCb?.all)
            all = true;
        callback = cb;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        if (all) {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
        }
        else {
            callback(null, '127.0.0.1', 4);
        }
        return;
    }
    callback(makeError(hostname, 'getaddrinfo'));
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
// dns.promises API
const promises = {
    lookup: (hostname, options) => {
        return new Promise((resolve, reject) => {
            if (hostname === 'localhost' || hostname === '127.0.0.1') {
                const entry = { address: '127.0.0.1', family: 4 };
                if (typeof options === 'object' && options?.all) {
                    resolve([entry]);
                }
                else {
                    resolve(entry);
                }
                return;
            }
            reject(makeError(hostname, 'getaddrinfo'));
        });
    },
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
export { lookup, resolve, resolve4, resolve6, resolveMx, resolveTxt, resolveSrv, resolveNs, resolveCname, reverse, setServers, getServers, promises, NOTFOUND, ADDRGETNETWORKPARAMS, BADFAMILY, BADFLAGS, BADHINTS, BADNAME, BADQUERY, BADRESP, BADSTR, CANCELLED, CONNREFUSED, DESTRUCTION, EOF, FILE, FORMERR, LOADIPHLPAPI, NODATA, NOMEM, NONAME, NOTINITIALIZED, REFUSED, SERVFAIL, TIMEOUT, };
export default {
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
    promises,
    NOTFOUND,
};
