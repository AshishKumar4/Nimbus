module.exports = { createCaresBinding: function createCaresBinding(platform, isIP) {
  const statusCodes = [null, "EFORMERR", "ESERVFAIL", "ENOTFOUND", "ENOTIMP", "EREFUSED"];
  const servers = ["1.1.1.1", "2606:4700:4700::1111", "1.0.0.1", "2606:4700:4700::1001"];
  const trimDot = (name) => name.endsWith(".") ? name.slice(0, -1) : name;
  const number = (text) => {
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) throw "EBADRESP";
    return value;
  };
  // DNS JSON uses the presentation form for record data, not DNS wire bytes.
  function fields(text) {
    const result = [];
    let value = "", quoted = false, active = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === "\\") {
        if (++i === text.length) throw "EBADRESP";
        const octet = text.slice(i, i + 3);
        if (/^[0-9]{3}$/.test(octet)) {
          if (Number(octet) > 255) throw "EBADRESP";
          value += String.fromCharCode(Number(octet));
          i += 2;
        } else value += text[i];
        active = true;
      } else if (char === '"') {
        quoted = !quoted;
        active = true;
      } else if (!quoted && /\s/.test(char)) {
        if (active) { result.push(value); value = ""; active = false; }
      } else { value += char; active = true; }
    }
    if (quoted) throw "EBADRESP";
    if (active) result.push(value);
    return result;
  }
  function record(type, data) {
    if (typeof data !== "string") throw "EBADRESP";
    if ([1, 28].includes(type)) return data;
    if ([2, 5, 12].includes(type)) return trimDot(data);
    const parts = fields(data);
    if (type === 16) return parts;
    if (type === 15 && parts.length === 2) return { exchange: trimDot(parts[1]), priority: number(parts[0]) };
    if (type === 33 && parts.length === 4) return { name: trimDot(parts[3]), port: number(parts[2]), priority: number(parts[0]), weight: number(parts[1]) };
    if (type === 257 && parts.length === 3) return { critical: number(parts[0]), [parts[1]]: parts[2] };
    if (type === 35 && parts.length === 6) return { flags: parts[2], service: parts[3], regexp: parts[4], replacement: trimDot(parts[5]), order: number(parts[0]), preference: number(parts[1]) };
    if (type === 6 && parts.length === 7) return { nsname: trimDot(parts[0]), hostmaster: trimDot(parts[1]), serial: number(parts[2]), refresh: number(parts[3]), retry: number(parts[4]), expire: number(parts[5]), minttl: number(parts[6]) };
    throw "EBADRESP";
  }
  async function query(name, type, signal) {
    let response;
    try {
      response = await platform.fetch("https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(name) + "&type=" + type, {
        headers: { Accept: "application/dns-json" }, signal,
      });
    } catch {
      throw signal.aborted ? signal.reason : "ECONNREFUSED";
    }
    if (!response.ok) throw "EBADRESP";
    let result;
    try { result = await response.json(); } catch { throw signal.aborted ? signal.reason : "EBADRESP"; }
    if (!result || !Number.isInteger(result.Status)) throw "EBADRESP";
    if (result.Status !== 0) throw statusCodes[result.Status] || "EBADRESP";
    if (result.TC) throw "EBADRESP";
    if (result.Answer !== undefined && (!Array.isArray(result.Answer) || result.Answer.some((answer) => !answer || !Number.isInteger(answer.type)))) throw "EBADRESP";
    const answers = [];
    let cnameTtl = Infinity;
    for (const answer of result.Answer || []) {
      if (answer.type === type && (type !== 5 || answers.length === 0)) answers.push(answer);
      if ((type === 1 || type === 28) && answer.type === 5) cnameTtl = Math.min(cnameTtl, number(answer.TTL));
    }
    if (answers.length === 0) throw "ENODATA";
    return { values: answers.map((answer) => record(type, answer.data)), ttls: answers.map((answer) => Math.min(cnameTtl, number(answer.TTL))) };
  }
  class QueryReqWrap {}
  class GetAddrInfoReqWrap {}
  class GetNameInfoReqWrap {}
  class ChannelWrap {
    constructor(timeout, tries, maxTimeout) {
      this.timeout = maxTimeout > 0 ? Math.min(timeout < 0 ? 5000 : timeout, maxTimeout) : timeout < 0 ? 5000 : timeout;
      this.tries = tries;
      this.pending = new Map();
      this.local = false;
    }
    cancel() {
      for (const [controller, finish] of this.pending) {
        controller.abort("ECANCELLED");
        finish("ECANCELLED");
      }
    }
    getServers() { return servers.map((address) => [address, 53]); }
    setServers(value) {
      return value.length === servers.length && value.every((entry, i) => entry[1] === servers[i] && entry[2] === 53) ? 0 : 5;
    }
    setLocalAddress(first, second) {
      const family = isIP(first), other = second === undefined ? 0 : isIP(second);
      if (!family || (second !== undefined && !other)) throw Object.assign(new TypeError("Invalid IP address."), { code: "ERR_INVALID_ARG_VALUE" });
      if (family === other) throw Object.assign(new TypeError("Cannot specify two IPv" + family + " addresses."), { code: "ERR_INVALID_ARG_VALUE" });
      this.local = [first, second].some((address) => address !== undefined && address !== "0.0.0.0" && address !== "::");
    }
    run(req, name, type) {
      const controller = new AbortController();
      let timer;
      const finish = (error, result) => {
        if (!this.pending.delete(controller)) return;
        if (timer !== undefined) platform.timers.clearTimeout(timer);
        platform.process.nextTick(() => req.oncomplete(error, result && (type === 6 ? result.values[0] : result.values), type === 1 || type === 28 ? result?.ttls : undefined));
      };
      this.pending.set(controller, finish);
      if (this.local || type === 255 || type === 52) {
        finish(this.local ? "ECONNREFUSED" : "ENOTIMP");
        return 0;
      }
      const run = async () => {
        for (let attempt = 0; attempt < this.tries; attempt++) {
          if (controller.signal.aborted) return;
          const request = new AbortController();
          const cancelled = () => request.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", cancelled, { once: true });
          timer = platform.timers.setTimeout(() => request.abort("ETIMEOUT"), this.timeout);
          let failure;
          try {
            const result = await query(name, type, request.signal);
            finish(null, result);
            return;
          } catch (error) { failure = error; }
          finally {
            platform.timers.clearTimeout(timer);
            controller.signal.removeEventListener("abort", cancelled);
          }
          if (!["ETIMEOUT", "ECONNREFUSED", "ESERVFAIL"].includes(failure) || attempt + 1 === this.tries) {
            finish(failure);
            return;
          }
        }
      };
      void run();
      return 0;
    }
    getHostByAddr(req, address) {
      const family = isIP(address);
      if (!family) return -22;
      if (family === 4) return this.run(req, address.split(".").reverse().join(".") + ".in-addr.arpa", 12);
      let ip = address.split("%")[0];
      if (ip.includes(".")) {
        const colon = ip.lastIndexOf(":");
        const bytes = ip.slice(colon + 1).split(".").map(Number);
        ip = ip.slice(0, colon + 1) + ((bytes[0] << 8) | bytes[1]).toString(16) + ":" + ((bytes[2] << 8) | bytes[3]).toString(16);
      }
      const halves = ip.split("::");
      const head = halves[0] ? halves[0].split(":") : [];
      const tail = halves[1] ? halves[1].split(":") : [];
      const groups = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
      return this.run(req, groups.map((part) => part.padStart(4, "0")).join("").split("").reverse().join(".") + ".ip6.arpa", 12);
    }
  }
  for (const [method, type] of Object.entries({ queryA: 1, queryAaaa: 28, queryCname: 5, queryMx: 15, queryNs: 2, queryTxt: 16, querySrv: 33, queryPtr: 12, queryNaptr: 35, querySoa: 6, queryCaa: 257, queryAny: 255, queryTlsa: 52 })) {
    ChannelWrap.prototype[method] = function(req, name) { return this.run(req, name, type); };
  }
  return {
    QueryReqWrap, GetAddrInfoReqWrap, GetNameInfoReqWrap, ChannelWrap,
    AI_ADDRCONFIG: 32, AI_ALL: 16, AI_V4MAPPED: 8,
    DNS_ORDER_VERBATIM: 0, DNS_ORDER_IPV4_FIRST: 1, DNS_ORDER_IPV6_FIRST: 2,
    strerror: () => "DNS server does not implement requested operation",
    getnameinfo: () => -3004,
    getaddrinfo(req, name, family, hints, order) {
      if (name.toLowerCase() === "localhost") {
        platform.process.nextTick(() => req.oncomplete(0, family === 6 ? ["::1"] : ["127.0.0.1"]));
        return 0;
      }
      const types = family === 4 ? [1] : family === 6 && !(hints & 8) ? [28] : order === 2 ? [28, 1] : [1, 28];
      const channel = new ChannelWrap(-1, 4, 0);
      Promise.all(types.map((type) => new Promise((resolve) => {
        const lookup = new QueryReqWrap();
        lookup.oncomplete = (error, values) => resolve({ error, values });
        channel.run(lookup, name, type);
      }))).then((answers) => platform.process.nextTick(() => {
        const addresses = answers.flatMap((answer) => answer.values || []);
        if (family === 6 && (hints & 8)) {
          const ipv6 = addresses.filter((address) => isIP(address) === 6);
          const mapped = addresses.filter((address) => isIP(address) === 4).map((address) => "::ffff:" + address);
          req.oncomplete(ipv6.length || mapped.length ? 0 : -3008, hints & 16 ? [...ipv6, ...mapped] : ipv6.length ? ipv6 : mapped);
        } else {
          const errors = answers.map((answer) => answer.error);
          req.oncomplete(addresses.length ? 0
            : errors.every((error) => error === "ENODATA") ? -3007
            : errors.some((error) => ["ETIMEOUT", "ESERVFAIL"].includes(error)) ? -3001
            : errors.some((error) => ["ECONNREFUSED", "EBADRESP", "EREFUSED"].includes(error)) ? -3004 : -3008, addresses);
        }
      }));
      return 0;
    },
  };
}, sources: {
    "dns": function (exports, require, module, process, internalBinding, primordials) {
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ObjectDefineProperties,
  ObjectDefineProperty,
  Symbol,
} = primordials;

const cares = internalBinding('cares_wrap');
const { isIP } = require('internal/net');
const { customPromisifyArgs } = require('internal/util');
const {
  DNSException,
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_MISSING_ARGS,
  },
} = require('internal/errors');
const {
  bindDefaultResolver,
  setDefaultResolver,
  validateHints,
  emitInvalidHostnameWarning,
  getDefaultResultOrder,
  setDefaultResultOrder,
  errorCodes: dnsErrorCodes,
  validDnsOrders,
  validFamilies,
} = require('internal/dns/utils');
const {
  Resolver,
} = require('internal/dns/callback_resolver');
const {
  NODATA,
  FORMERR,
  SERVFAIL,
  NOTFOUND,
  NOTIMP,
  REFUSED,
  BADQUERY,
  BADNAME,
  BADFAMILY,
  BADRESP,
  CONNREFUSED,
  TIMEOUT,
  EOF,
  FILE,
  NOMEM,
  DESTRUCTION,
  BADSTR,
  BADFLAGS,
  NONAME,
  BADHINTS,
  NOTINITIALIZED,
  LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS,
  CANCELLED,
} = dnsErrorCodes;
const {
  validateBoolean,
  validateFunction,
  validateNumber,
  validateOneOf,
  validatePort,
  validateString,
} = require('internal/validators');

const {
  GetAddrInfoReqWrap,
  GetNameInfoReqWrap,
  DNS_ORDER_VERBATIM,
  DNS_ORDER_IPV4_FIRST,
  DNS_ORDER_IPV6_FIRST,
} = cares;

const kPerfHooksDnsLookupContext = Symbol('kPerfHooksDnsLookupContext');
const kPerfHooksDnsLookupServiceContext = Symbol('kPerfHooksDnsLookupServiceContext');

const {
  hasObserver,
  startPerf,
  stopPerf,
} = require('internal/perf/observe');

let promises = null; // Lazy loaded

function onlookup(err, addresses) {
  if (err) {
    return this.callback(new DNSException(err, 'getaddrinfo', this.hostname));
  }
  this.callback(null, addresses[0], this.family || isIP(addresses[0]));
  if (this[kPerfHooksDnsLookupContext] && hasObserver('dns')) {
    stopPerf(this, kPerfHooksDnsLookupContext, { detail: { addresses } });
  }
}


function onlookupall(err, addresses) {
  if (err) {
    return this.callback(new DNSException(err, 'getaddrinfo', this.hostname));
  }

  const family = this.family;
  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    addresses[i] = {
      address: addr,
      family: family || isIP(addr),
    };
  }

  this.callback(null, addresses);
  if (this[kPerfHooksDnsLookupContext] && hasObserver('dns')) {
    stopPerf(this, kPerfHooksDnsLookupContext, { detail: { addresses } });
  }
}


// Easy DNS A/AAAA look up
// lookup(hostname, [options,] callback)
function lookup(hostname, options, callback) {
  let hints = 0;
  let family = 0;
  let all = false;
  let dnsOrder = getDefaultResultOrder();

  // Parse arguments
  if (hostname) {
    validateString(hostname, 'hostname');
  }

  if (typeof options === 'function') {
    callback = options;
    family = 0;
  } else if (typeof options === 'number') {
    validateFunction(callback, 'callback');

    validateOneOf(options, 'family', validFamilies);
    family = options;
  } else if (options !== undefined && typeof options !== 'object') {
    validateFunction(arguments.length === 2 ? options : callback, 'callback');
    throw new ERR_INVALID_ARG_TYPE('options', ['integer', 'object'], options);
  } else {
    validateFunction(callback, 'callback');

    if (options?.hints != null) {
      validateNumber(options.hints, 'options.hints');
      hints = options.hints >>> 0;
      validateHints(hints);
    }
    if (options?.family != null) {
      switch (options.family) {
        case 'IPv4':
          family = 4;
          break;
        case 'IPv6':
          family = 6;
          break;
        default:
          validateOneOf(options.family, 'options.family', validFamilies);
          family = options.family;
          break;
      }
    }
    if (options?.all != null) {
      validateBoolean(options.all, 'options.all');
      all = options.all;
    }
    if (options?.verbatim != null) {
      validateBoolean(options.verbatim, 'options.verbatim');
      dnsOrder = options.verbatim ? 'verbatim' : 'ipv4first';
    }
    if (options?.order != null) {
      validateOneOf(options.order, 'options.order', validDnsOrders);
      dnsOrder = options.order;
    }
  }

  if (!hostname) {
    emitInvalidHostnameWarning(hostname);
    if (all) {
      process.nextTick(callback, null, []);
    } else {
      process.nextTick(callback, null, null, family === 6 ? 6 : 4);
    }
    return {};
  }

  const matchedFamily = isIP(hostname);
  if (matchedFamily) {
    if (all) {
      process.nextTick(
        callback, null, [{ address: hostname, family: matchedFamily }]);
    } else {
      process.nextTick(callback, null, hostname, matchedFamily);
    }
    return {};
  }

  const req = new GetAddrInfoReqWrap();
  req.callback = callback;
  req.family = family;
  req.hostname = hostname;
  req.oncomplete = all ? onlookupall : onlookup;

  let order = DNS_ORDER_VERBATIM;

  if (dnsOrder === 'ipv4first') {
    order = DNS_ORDER_IPV4_FIRST;
  } else if (dnsOrder === 'ipv6first') {
    order = DNS_ORDER_IPV6_FIRST;
  }

  const err = cares.getaddrinfo(
    req, hostname, family, hints, order,
  );
  if (err) {
    process.nextTick(callback, new DNSException(err, 'getaddrinfo', hostname));
    return {};
  }
  if (hasObserver('dns')) {
    const detail = {
      hostname,
      family,
      hints,
      verbatim: order === DNS_ORDER_VERBATIM,
      order: dnsOrder,
    };

    startPerf(req, kPerfHooksDnsLookupContext, { type: 'dns', name: 'lookup', detail });
  }
  return req;
}

ObjectDefineProperty(lookup, customPromisifyArgs,
                     { __proto__: null, value: ['address', 'family'], enumerable: false });


function onlookupservice(err, hostname, service) {
  if (err)
    return this.callback(new DNSException(err, 'getnameinfo', this.hostname));

  this.callback(null, hostname, service);
  if (this[kPerfHooksDnsLookupServiceContext] && hasObserver('dns')) {
    stopPerf(this, kPerfHooksDnsLookupServiceContext, { detail: { hostname, service } });
  }
}


function lookupService(address, port, callback) {
  if (arguments.length !== 3)
    throw new ERR_MISSING_ARGS('address', 'port', 'callback');

  if (isIP(address) === 0)
    throw new ERR_INVALID_ARG_VALUE('address', address);

  validatePort(port);

  validateFunction(callback, 'callback');

  port = +port;

  const req = new GetNameInfoReqWrap();
  req.callback = callback;
  req.hostname = address;
  req.port = port;
  req.oncomplete = onlookupservice;

  const err = cares.getnameinfo(req, address, port);
  if (err) throw new DNSException(err, 'getnameinfo', address);
  if (hasObserver('dns')) {
    startPerf(req, kPerfHooksDnsLookupServiceContext, {
      type: 'dns',
      name: 'lookupService',
      detail: {
        host: address,
        port,
      },
    });
  }
  return req;
}

ObjectDefineProperty(lookupService, customPromisifyArgs,
                     { __proto__: null, value: ['hostname', 'service'], enumerable: false });

function defaultResolverSetServers(servers) {
  const resolver = new Resolver();

  resolver.setServers(servers);
  setDefaultResolver(resolver);
  bindDefaultResolver(module.exports, Resolver.prototype);

  if (promises !== null)
    bindDefaultResolver(promises, promises.Resolver.prototype);
}

module.exports = {
  lookup,
  lookupService,

  Resolver,
  getDefaultResultOrder,
  setDefaultResultOrder,
  setServers: defaultResolverSetServers,

  // uv_getaddrinfo flags
  ADDRCONFIG: cares.AI_ADDRCONFIG,
  ALL: cares.AI_ALL,
  V4MAPPED: cares.AI_V4MAPPED,

  // ERROR CODES
  NODATA,
  FORMERR,
  SERVFAIL,
  NOTFOUND,
  NOTIMP,
  REFUSED,
  BADQUERY,
  BADNAME,
  BADFAMILY,
  BADRESP,
  CONNREFUSED,
  TIMEOUT,
  EOF,
  FILE,
  NOMEM,
  DESTRUCTION,
  BADSTR,
  BADFLAGS,
  NONAME,
  BADHINTS,
  NOTINITIALIZED,
  LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS,
  CANCELLED,
};

bindDefaultResolver(module.exports, Resolver.prototype);

ObjectDefineProperties(module.exports, {
  promises: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() {
      if (promises === null) {
        promises = require('internal/dns/promises');
      }
      return promises;
    },
  },
});

    },
    "dns/promises": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

module.exports = require('internal/dns/promises');

    },
    "internal/dns/utils": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypeForEach,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  FunctionPrototypeBind,
  NumberParseInt,
  RegExpPrototypeExec,
  RegExpPrototypeSymbolReplace,
  Symbol,
} = primordials;

const {
  codes: {
    ERR_DNS_SET_SERVERS_FAILED,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_IP_ADDRESS,
  },
} = require('internal/errors');
const { isIP } = require('internal/net');
const { getOptionValue } = require('internal/options');
const {
  validateArray,
  validateInt32,
  validateOneOf,
  validateString,
  validateUint32,
} = require('internal/validators');
let binding;
function lazyBinding() {
  binding ??= internalBinding('cares_wrap');
  return binding;
}
const IANA_DNS_PORT = 53;
const IPv6RE = /^\[([^[\]]*)\]/;
const addrSplitRE = /(^.+?)(?::(\d+))?$/;

const {
  namespace: {
    addSerializeCallback,
    addDeserializeCallback,
    isBuildingSnapshot,
  },
} = require('internal/v8/startup_snapshot');

function validateTimeout(options) {
  const { timeout = -1 } = { ...options };
  validateInt32(timeout, 'options.timeout', -1);
  return timeout;
}

function validateMaxTimeout(options) {
  const { maxTimeout = 0 } = { ...options };
  validateUint32(maxTimeout, 'options.maxTimeout');
  return maxTimeout;
}

function validateTries(options) {
  const { tries = 4 } = { ...options };
  validateInt32(tries, 'options.tries', 1);
  return tries;
}

const kSerializeResolver = Symbol('dns:resolver:serialize');
const kDeserializeResolver = Symbol('dns:resolver:deserialize');
const kSnapshotStates = Symbol('dns:resolver:config');
const kInitializeHandle = Symbol('dns:resolver:initializeHandle');
const kSetServersInternal = Symbol('dns:resolver:setServers');

// Resolver instances correspond 1:1 to c-ares channels.

class ResolverBase {
  constructor(options = undefined) {
    const timeout = validateTimeout(options);
    const tries = validateTries(options);
    const maxTimeout = validateMaxTimeout(options);
    // If we are building snapshot, save the states of the resolver along
    // the way.
    if (isBuildingSnapshot()) {
      this[kSnapshotStates] = { timeout, tries, maxTimeout };
    }
    this[kInitializeHandle](timeout, tries, maxTimeout);
  }

  [kInitializeHandle](timeout, tries, maxTimeout) {
    const { ChannelWrap } = lazyBinding();
    this._handle = new ChannelWrap(timeout, tries, maxTimeout);
  }

  cancel() {
    this._handle.cancel();
  }

  getServers() {
    return ArrayPrototypeMap(this._handle.getServers() || [], (val) => {
      if (!val[1] || val[1] === IANA_DNS_PORT)
        return val[0];

      const host = isIP(val[0]) === 6 ? `[${val[0]}]` : val[0];
      return `${host}:${val[1]}`;
    });
  }

  setServers(servers) {
    validateArray(servers, 'servers');

    // Cache the original servers because in the event of an error while
    // setting the servers, c-ares won't have any servers available for
    // resolution.
    const newSet = [];
    ArrayPrototypeForEach(servers, (serv, index) => {
      validateString(serv, `servers[${index}]`);
      let ipVersion = isIP(serv);

      if (ipVersion !== 0)
        return ArrayPrototypePush(newSet, [ipVersion, serv, IANA_DNS_PORT]);

      const match = RegExpPrototypeExec(IPv6RE, serv);

      // Check for an IPv6 in brackets.
      if (match) {
        ipVersion = isIP(match[1]);

        if (ipVersion !== 0) {
          const port = NumberParseInt(
            RegExpPrototypeSymbolReplace(addrSplitRE, serv, '$2')) || IANA_DNS_PORT;
          return ArrayPrototypePush(newSet, [ipVersion, match[1], port]);
        }
      }

      // addr::port
      const addrSplitMatch = RegExpPrototypeExec(addrSplitRE, serv);

      if (addrSplitMatch) {
        const hostIP = addrSplitMatch[1];
        const port = addrSplitMatch[2] || IANA_DNS_PORT;

        ipVersion = isIP(hostIP);

        if (ipVersion !== 0) {
          return ArrayPrototypePush(
            newSet, [ipVersion, hostIP, NumberParseInt(port)]);
        }
      }

      throw new ERR_INVALID_IP_ADDRESS(serv);
    });

    this[kSetServersInternal](newSet, servers);
  }

  [kSetServersInternal](newSet, servers) {
    const orig = ArrayPrototypeMap(this._handle.getServers() || [], (val) => {
      val.unshift(isIP(val[0]));
      return val;
    });
    const errorNumber = this._handle.setServers(newSet);

    if (errorNumber !== 0) {
      // Reset the servers to the old servers, because ares probably unset them.
      this._handle.setServers(orig);
      const { strerror } = lazyBinding();
      const err = strerror(errorNumber);
      throw new ERR_DNS_SET_SERVERS_FAILED(err, servers);
    }

    if (isBuildingSnapshot()) {
      this[kSnapshotStates].servers = newSet;
    }
  }


  setLocalAddress(ipv4, ipv6) {
    validateString(ipv4, 'ipv4');

    if (ipv6 !== undefined) {
      validateString(ipv6, 'ipv6');
    }

    this._handle.setLocalAddress(ipv4, ipv6);

    if (isBuildingSnapshot()) {
      this[kSnapshotStates].localAddress = { ipv4, ipv6 };
    }
  }

  // TODO(joyeecheung): consider exposing this if custom DNS resolvers
  // end up being useful for snapshot users.
  [kSerializeResolver]() {
    this._handle = null;  // We'll restore it during deserialization.
    addDeserializeCallback(function deserializeResolver(resolver) {
      resolver[kDeserializeResolver]();
    }, this);
  }

  [kDeserializeResolver]() {
    const { timeout, tries, maxTimeout, localAddress, servers } = this[kSnapshotStates];
    this[kInitializeHandle](timeout, tries, maxTimeout);
    if (localAddress) {
      const { ipv4, ipv6 } = localAddress;
      this._handle.setLocalAddress(ipv4, ipv6);
    }
    if (servers) {
      this[kSetServersInternal](servers, servers);
    }
  }
}

let defaultResolver;
let dnsOrder;
const validDnsOrders = ['verbatim', 'ipv4first', 'ipv6first'];
const validFamilies = [0, 4, 6];

function initializeDns() {
  const orderFromCLI = getOptionValue('--dns-result-order');
  if (!orderFromCLI) {
    dnsOrder ??= 'verbatim';
  } else {
    // Allow the deserialized application to override order from CLI.
    validateOneOf(orderFromCLI, '--dns-result-order', validDnsOrders);
    dnsOrder = orderFromCLI;
  }

  if (!isBuildingSnapshot()) {
    return;
  }

  addSerializeCallback(() => {
    defaultResolver?.[kSerializeResolver]();
  });
}

const resolverKeys = [
  'getServers',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
];

function getDefaultResolver() {
  // We do this here instead of pre-execution so that the default resolver is
  // only ever created when the user loads any dns module.
  if (defaultResolver === undefined) {
    defaultResolver = new ResolverBase();
  }
  return defaultResolver;
}

function setDefaultResolver(resolver) {
  defaultResolver = resolver;
}

function bindDefaultResolver(target, source) {
  const defaultResolver = getDefaultResolver();
  ArrayPrototypeForEach(resolverKeys, (key) => {
    target[key] = FunctionPrototypeBind(source[key], defaultResolver);
  });
}

function validateHints(hints) {
  const { AI_ADDRCONFIG, AI_ALL, AI_V4MAPPED } = lazyBinding();
  if ((hints & ~(AI_ADDRCONFIG | AI_ALL | AI_V4MAPPED)) !== 0) {
    throw new ERR_INVALID_ARG_VALUE('hints', hints);
  }
}

let invalidHostnameWarningEmitted = false;
function emitInvalidHostnameWarning(hostname) {
  if (!invalidHostnameWarningEmitted) {
    process.emitWarning(
      `The provided hostname "${hostname}" is not a valid ` +
      'hostname, and is supported in the dns module solely for compatibility.',
      'DeprecationWarning',
      'DEP0118',
    );
    invalidHostnameWarningEmitted = true;
  }
}

function setDefaultResultOrder(value) {
  validateOneOf(value, 'dnsOrder', validDnsOrders);
  dnsOrder = value;
}

function getDefaultResultOrder() {
  return dnsOrder;
}

function createResolverClass(resolver) {
  const resolveMap = { __proto__: null };

  class Resolver extends ResolverBase {}

  Resolver.prototype.resolveAny = resolveMap.ANY = resolver('queryAny');
  Resolver.prototype.resolve4 = resolveMap.A = resolver('queryA');
  Resolver.prototype.resolve6 = resolveMap.AAAA = resolver('queryAaaa');
  Resolver.prototype.resolveCaa = resolveMap.CAA = resolver('queryCaa');
  Resolver.prototype.resolveCname = resolveMap.CNAME = resolver('queryCname');
  Resolver.prototype.resolveMx = resolveMap.MX = resolver('queryMx');
  Resolver.prototype.resolveNs = resolveMap.NS = resolver('queryNs');
  Resolver.prototype.resolveTlsa = resolveMap.TLSA = resolver('queryTlsa');
  Resolver.prototype.resolveTxt = resolveMap.TXT = resolver('queryTxt');
  Resolver.prototype.resolveSrv = resolveMap.SRV = resolver('querySrv');
  Resolver.prototype.resolvePtr = resolveMap.PTR = resolver('queryPtr');
  Resolver.prototype.resolveNaptr = resolveMap.NAPTR = resolver('queryNaptr');
  Resolver.prototype.resolveSoa = resolveMap.SOA = resolver('querySoa');
  Resolver.prototype.reverse = resolver('getHostByAddr');

  return {
    resolveMap,
    Resolver,
  };
}

// ERROR CODES
const errorCodes = {
  NODATA: 'ENODATA',
  FORMERR: 'EFORMERR',
  SERVFAIL: 'ESERVFAIL',
  NOTFOUND: 'ENOTFOUND',
  NOTIMP: 'ENOTIMP',
  REFUSED: 'EREFUSED',
  BADQUERY: 'EBADQUERY',
  BADNAME: 'EBADNAME',
  BADFAMILY: 'EBADFAMILY',
  BADRESP: 'EBADRESP',
  CONNREFUSED: 'ECONNREFUSED',
  TIMEOUT: 'ETIMEOUT',
  EOF: 'EOF',
  FILE: 'EFILE',
  NOMEM: 'ENOMEM',
  DESTRUCTION: 'EDESTRUCTION',
  BADSTR: 'EBADSTR',
  BADFLAGS: 'EBADFLAGS',
  NONAME: 'ENONAME',
  BADHINTS: 'EBADHINTS',
  NOTINITIALIZED: 'ENOTINITIALIZED',
  LOADIPHLPAPI: 'ELOADIPHLPAPI',
  ADDRGETNETWORKPARAMS: 'EADDRGETNETWORKPARAMS',
  CANCELLED: 'ECANCELLED',
};

module.exports = {
  bindDefaultResolver,
  getDefaultResolver,
  setDefaultResolver,
  validateHints,
  validateTimeout,
  validateTries,
  emitInvalidHostnameWarning,
  getDefaultResultOrder,
  setDefaultResultOrder,
  errorCodes,
  createResolverClass,
  initializeDns,
  validDnsOrders,
  validFamilies,
};

    },
    "internal/dns/callback_resolver": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypeMap,
  ObjectDefineProperty,
  ReflectApply,
  Symbol,
} = primordials;

const {
  DNSException,
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
  },
} = require('internal/errors');

const {
  createResolverClass,
} = require('internal/dns/utils');

const {
  validateFunction,
  validateString,
} = require('internal/validators');

const {
  QueryReqWrap,
} = internalBinding('cares_wrap');

const {
  hasObserver,
  startPerf,
  stopPerf,
} = require('internal/perf/observe');

const kPerfHooksDnsLookupResolveContext = Symbol('kPerfHooksDnsLookupResolveContext');

function onresolve(err, result, ttls) {
  if (ttls && this.ttl)
    result = ArrayPrototypeMap(
      result, (address, index) => ({ address, ttl: ttls[index] }));

  if (err)
    this.callback(new DNSException(err, this.bindingName, this.hostname));
  else {
    this.callback(null, result);
    if (this[kPerfHooksDnsLookupResolveContext] && hasObserver('dns')) {
      stopPerf(this, kPerfHooksDnsLookupResolveContext, { detail: { result } });
    }
  }
}

function resolver(bindingName) {
  function query(name, /* options, */ callback) {
    let options;
    if (arguments.length > 2) {
      options = callback;
      callback = arguments[2];
    }

    validateString(name, 'name');
    validateFunction(callback, 'callback');

    const req = new QueryReqWrap();
    req.bindingName = bindingName;
    req.callback = callback;
    req.hostname = name;
    req.oncomplete = onresolve;
    req.ttl = !!(options?.ttl);
    const err = this._handle[bindingName](req, name);
    if (err) throw new DNSException(err, bindingName, name);
    if (hasObserver('dns')) {
      startPerf(req, kPerfHooksDnsLookupResolveContext, {
        type: 'dns',
        name: bindingName,
        detail: {
          host: name,
          ttl: req.ttl,
        },
      });
    }
    return req;
  }
  ObjectDefineProperty(query, 'name', { __proto__: null, value: bindingName });
  return query;
}

// This is the callback-based resolver. There is another similar
// resolver in dns/promises.js with resolve methods that are based
// on promises instead.
const { Resolver, resolveMap } = createResolverClass(resolver);
Resolver.prototype.resolve = resolve;

function resolve(hostname, rrtype, callback) {
  let resolver;
  if (typeof rrtype === 'string') {
    resolver = resolveMap[rrtype];
  } else if (typeof rrtype === 'function') {
    resolver = resolveMap.A;
    callback = rrtype;
  } else {
    throw new ERR_INVALID_ARG_TYPE('rrtype', 'string', rrtype);
  }

  if (typeof resolver === 'function') {
    return ReflectApply(resolver, this, [hostname, callback]);
  }
  throw new ERR_INVALID_ARG_VALUE('rrtype', rrtype);
}

module.exports = {
  Resolver,
};

    },
    "internal/dns/promises": function (exports, require, module, process, internalBinding, primordials) {
'use strict';
const {
  ArrayPrototypeMap,
  ObjectDefineProperty,
  Promise,
  ReflectApply,
  Symbol,
} = primordials;

const {
  bindDefaultResolver,
  createResolverClass,
  validateHints,
  emitInvalidHostnameWarning,
  errorCodes: dnsErrorCodes,
  getDefaultResultOrder,
  setDefaultResultOrder,
  setDefaultResolver,
  validDnsOrders,
  validFamilies,
} = require('internal/dns/utils');

const {
  NODATA,
  FORMERR,
  SERVFAIL,
  NOTFOUND,
  NOTIMP,
  REFUSED,
  BADQUERY,
  BADNAME,
  BADFAMILY,
  BADRESP,
  CONNREFUSED,
  TIMEOUT,
  EOF,
  FILE,
  NOMEM,
  DESTRUCTION,
  BADSTR,
  BADFLAGS,
  NONAME,
  BADHINTS,
  NOTINITIALIZED,
  LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS,
  CANCELLED,
} = dnsErrorCodes;
const {
  DNSException,
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_MISSING_ARGS,
  },
} = require('internal/errors');
const { isIP } = require('internal/net');
const {
  getaddrinfo,
  getnameinfo,
  GetAddrInfoReqWrap,
  GetNameInfoReqWrap,
  QueryReqWrap,
  DNS_ORDER_VERBATIM,
  DNS_ORDER_IPV4_FIRST,
  DNS_ORDER_IPV6_FIRST,
} = internalBinding('cares_wrap');
const {
  validateBoolean,
  validateNumber,
  validateOneOf,
  validatePort,
  validateString,
} = require('internal/validators');

const kPerfHooksDnsLookupContext = Symbol('kPerfHooksDnsLookupContext');
const kPerfHooksDnsLookupServiceContext = Symbol('kPerfHooksDnsLookupServiceContext');
const kPerfHooksDnsLookupResolveContext = Symbol('kPerfHooksDnsLookupResolveContext');

const {
  hasObserver,
  startPerf,
  stopPerf,
} = require('internal/perf/observe');

function onlookup(err, addresses) {
  if (err) {
    this.reject(new DNSException(err, 'getaddrinfo', this.hostname));
    return;
  }

  const family = this.family || isIP(addresses[0]);
  this.resolve({ address: addresses[0], family });
  if (this[kPerfHooksDnsLookupContext] && hasObserver('dns')) {
    stopPerf(this, kPerfHooksDnsLookupContext, { detail: { addresses } });
  }
}

function onlookupall(err, addresses) {
  if (err) {
    this.reject(new DNSException(err, 'getaddrinfo', this.hostname));
    return;
  }

  const family = this.family;

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];

    addresses[i] = {
      address,
      family: family || isIP(addresses[i]),
    };
  }

  this.resolve(addresses);
  if (this[kPerfHooksDnsLookupContext] && hasObserver('dns')) {
    stopPerf(this, kPerfHooksDnsLookupContext, { detail: { addresses } });
  }
}

/**
 * Creates a promise that resolves with the IP address of the given hostname.
 * @param {0 | 4 | 6} family - The IP address family (4 or 6, or 0 for both).
 * @param {string} hostname - The hostname to resolve.
 * @param {boolean} all - Whether to resolve with all IP addresses for the hostname.
 * @param {number} hints - One or more supported getaddrinfo flags (supply multiple via
 * bitwise OR).
 * @param {number} dnsOrder - How to sort results. Must be `ipv4first`, `ipv6first` or `verbatim`.
 * @returns {Promise<DNSLookupResult | DNSLookupResult[]>} The IP address(es) of the hostname.
 * @typedef {object} DNSLookupResult
 * @property {string} address - The IP address.
 * @property {0 | 4 | 6} family - The IP address type. 4 for IPv4 or 6 for IPv6, or 0 (for both).
 */
function createLookupPromise(family, hostname, all, hints, dnsOrder) {
  return new Promise((resolve, reject) => {
    if (!hostname) {
      emitInvalidHostnameWarning(hostname);
      resolve(all ? [] : { address: null, family: family === 6 ? 6 : 4 });
      return;
    }

    const matchedFamily = isIP(hostname);

    if (matchedFamily !== 0) {
      const result = { address: hostname, family: matchedFamily };
      resolve(all ? [result] : result);
      return;
    }

    const req = new GetAddrInfoReqWrap();

    req.family = family;
    req.hostname = hostname;
    req.oncomplete = all ? onlookupall : onlookup;
    req.resolve = resolve;
    req.reject = reject;

    let order = DNS_ORDER_VERBATIM;

    if (dnsOrder === 'ipv4first') {
      order = DNS_ORDER_IPV4_FIRST;
    } else if (dnsOrder === 'ipv6first') {
      order = DNS_ORDER_IPV6_FIRST;
    }

    const err = getaddrinfo(req, hostname, family, hints, order);

    if (err) {
      reject(new DNSException(err, 'getaddrinfo', hostname));
    } else if (hasObserver('dns')) {
      const detail = {
        hostname,
        family,
        hints,
        verbatim: order === DNS_ORDER_VERBATIM,
        order: dnsOrder,
      };
      startPerf(req, kPerfHooksDnsLookupContext, { type: 'dns', name: 'lookup', detail });
    }
  });
}

/**
 * Get the IP address for a given hostname.
 * @param {string} hostname - The hostname to resolve (ex. 'nodejs.org').
 * @param {object} [options] - Optional settings.
 * @param {boolean} [options.all=false] - Whether to return all or just the first resolved address.
 * @param {0 | 4 | 6} [options.family=0] - The record family. Must be 4, 6, or 0 (for both).
 * @param {number} [options.hints] - One or more supported getaddrinfo flags (supply multiple via
 * bitwise OR).
 * @param {string} [options.order='verbatim'] - Return results in same order DNS resolved them;
 * Must be `ipv4first`, `ipv6first` or `verbatim`.
 * New code should supply `verbatim`.
 */
function lookup(hostname, options) {
  let hints = 0;
  let family = 0;
  let all = false;
  let dnsOrder = getDefaultResultOrder();

  // Parse arguments
  if (hostname) {
    validateString(hostname, 'hostname');
  }

  if (typeof options === 'number') {
    validateOneOf(options, 'family', validFamilies);
    family = options;
  } else if (options !== undefined && typeof options !== 'object') {
    throw new ERR_INVALID_ARG_TYPE('options', ['integer', 'object'], options);
  } else {
    if (options?.hints != null) {
      validateNumber(options.hints, 'options.hints');
      hints = options.hints >>> 0;
      validateHints(hints);
    }
    if (options?.family != null) {
      validateOneOf(options.family, 'options.family', validFamilies);
      family = options.family;
    }
    if (options?.all != null) {
      validateBoolean(options.all, 'options.all');
      all = options.all;
    }
    if (options?.verbatim != null) {
      validateBoolean(options.verbatim, 'options.verbatim');
      dnsOrder = options.verbatim ? 'verbatim' : 'ipv4first';
    }
    if (options?.order != null) {
      validateOneOf(options.order, 'options.order', validDnsOrders);
      dnsOrder = options.order;
    }
  }

  return createLookupPromise(family, hostname, all, hints, dnsOrder);
}


function onlookupservice(err, hostname, service) {
  if (err) {
    this.reject(new DNSException(err, 'getnameinfo', this.host));
    return;
  }

  this.resolve({ hostname, service });
  if (this[kPerfHooksDnsLookupServiceContext] && hasObserver('dns')) {
    stopPerf(this, kPerfHooksDnsLookupServiceContext, { detail: { hostname, service } });
  }
}

function createLookupServicePromise(hostname, port) {
  return new Promise((resolve, reject) => {
    const req = new GetNameInfoReqWrap();

    req.hostname = hostname;
    req.port = port;
    req.oncomplete = onlookupservice;
    req.resolve = resolve;
    req.reject = reject;

    const err = getnameinfo(req, hostname, port);

    if (err)
      reject(new DNSException(err, 'getnameinfo', hostname));
    else if (hasObserver('dns')) {
      startPerf(req, kPerfHooksDnsLookupServiceContext, {
        type: 'dns',
        name: 'lookupService',
        detail: {
          host: hostname,
          port,
        },
      });
    }
  });
}

function lookupService(address, port) {
  if (arguments.length !== 2)
    throw new ERR_MISSING_ARGS('address', 'port');

  if (isIP(address) === 0)
    throw new ERR_INVALID_ARG_VALUE('address', address);

  validatePort(port);

  return createLookupServicePromise(address, +port);
}


function onresolve(err, result, ttls) {
  if (err) {
    this.reject(new DNSException(err, this.bindingName, this.hostname));
    return;
  }

  if (ttls && this.ttl)
    result = ArrayPrototypeMap(
      result, (address, index) => ({ address, ttl: ttls[index] }));

  this.resolve(result);
  if (this[kPerfHooksDnsLookupResolveContext] && hasObserver('dns')) {
    stopPerf(this, kPerfHooksDnsLookupResolveContext, { detail: { result } });
  }
}

function createResolverPromise(resolver, bindingName, hostname, ttl) {
  return new Promise((resolve, reject) => {
    const req = new QueryReqWrap();

    req.bindingName = bindingName;
    req.hostname = hostname;
    req.oncomplete = onresolve;
    req.resolve = resolve;
    req.reject = reject;
    req.ttl = ttl;

    const err = resolver._handle[bindingName](req, hostname);

    if (err)
      reject(new DNSException(err, bindingName, hostname));
    else if (hasObserver('dns')) {
      startPerf(req, kPerfHooksDnsLookupResolveContext, {
        type: 'dns',
        name: bindingName,
        detail: {
          host: hostname,
          ttl,
        },
      });
    }
  });
}

function resolver(bindingName) {
  function query(name, options) {
    validateString(name, 'name');

    const ttl = !!(options?.ttl);
    return createResolverPromise(this, bindingName, name, ttl);
  }

  ObjectDefineProperty(query, 'name', { __proto__: null, value: bindingName });
  return query;
}

function resolve(hostname, rrtype) {
  let resolver;

  if (rrtype !== undefined) {
    validateString(rrtype, 'rrtype');

    resolver = resolveMap[rrtype];

    if (typeof resolver !== 'function')
      throw new ERR_INVALID_ARG_VALUE('rrtype', rrtype);
  } else {
    resolver = resolveMap.A;
  }

  return ReflectApply(resolver, this, [hostname]);
}

// Promise-based resolver.
const { Resolver, resolveMap } = createResolverClass(resolver);
Resolver.prototype.resolve = resolve;

function defaultResolverSetServers(servers) {
  const resolver = new Resolver();

  resolver.setServers(servers);
  setDefaultResolver(resolver);
  bindDefaultResolver(module.exports, Resolver.prototype);
}

module.exports = {
  lookup,
  lookupService,
  Resolver,
  getDefaultResultOrder,
  setDefaultResultOrder,
  setServers: defaultResolverSetServers,

  // ERROR CODES
  NODATA,
  FORMERR,
  SERVFAIL,
  NOTFOUND,
  NOTIMP,
  REFUSED,
  BADQUERY,
  BADNAME,
  BADFAMILY,
  BADRESP,
  CONNREFUSED,
  TIMEOUT,
  EOF,
  FILE,
  NOMEM,
  DESTRUCTION,
  BADSTR,
  BADFLAGS,
  NONAME,
  BADHINTS,
  NOTINITIALIZED,
  LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS,
  CANCELLED,
};
bindDefaultResolver(module.exports, Resolver.prototype);

    },
    "internal/net": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  RegExp,
  RegExpPrototypeTest,
  Symbol,
} = primordials;

const Buffer = require('buffer').Buffer;
const { writeBuffer } = internalBinding('fs');
const {
  UVException,
} = require('internal/errors');

// IPv4 Segment
const v4Seg = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
const IPv4Reg = new RegExp(`^${v4Str}$`);

// IPv6 Segment
const v6Seg = '(?:[0-9a-fA-F]{1,4})';
const IPv6Reg = new RegExp('^(?:' +
  `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
  `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
  `(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|` +
  `(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|` +
  `(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|` +
  `(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|` +
  `(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|` +
  `(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
')(?:%[0-9a-zA-Z-.:]{1,})?$');

function isIPv4(s) {
  // TODO(aduh95): Replace RegExpPrototypeTest with RegExpPrototypeExec when it
  // no longer creates a perf regression in the dns benchmark.
  // eslint-disable-next-line node-core/avoid-prototype-pollution
  return RegExpPrototypeTest(IPv4Reg, s);
}

function isIPv6(s) {
  // TODO(aduh95): Replace RegExpPrototypeTest with RegExpPrototypeExec when it
  // no longer creates a perf regression in the dns benchmark.
  // eslint-disable-next-line node-core/avoid-prototype-pollution
  return RegExpPrototypeTest(IPv6Reg, s);
}

function isIP(s) {
  if (isIPv4(s)) return 4;
  if (isIPv6(s)) return 6;
  return 0;
}

function makeSyncWrite(fd) {
  return function(chunk, enc, cb) {
    if (enc !== 'buffer')
      chunk = Buffer.from(chunk, enc);

    this._handle.bytesWritten += chunk.length;

    const ctx = {};
    writeBuffer(fd, chunk, 0, chunk.length, null, undefined, ctx);
    if (ctx.errno !== undefined) {
      const ex = new UVException(ctx);
      ex.errno = ctx.errno;
      return cb(ex);
    }
    cb();
  };
}

/**
 * https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
 * https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
 * https://www.iana.org/assignments/special-use-domain-names/special-use-domain-names.xhtml
 */
function isLoopback(host) {
  const hostLower = host.toLowerCase();

  return (
    hostLower === 'localhost' ||
    hostLower.startsWith('127.') ||
    hostLower === '[::1]' ||
    hostLower === '[0:0:0:0:0:0:0:1]'
  );
}

module.exports = {
  kReinitializeHandle: Symbol('kReinitializeHandle'),
  isIP,
  isIPv4,
  isIPv6,
  makeSyncWrite,
  normalizedArgsSymbol: Symbol('normalizedArgs'),
  isLoopback,
};

    },
} };