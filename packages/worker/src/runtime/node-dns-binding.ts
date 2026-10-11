/** Node's cares_wrap contract over Cloudflare's structured DNS JSON endpoint. */
export const NODE_DNS_BINDING_SOURCE = String.raw`function createCaresBinding(platform, isIP) {
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
}`;
