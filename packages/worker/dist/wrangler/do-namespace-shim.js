/**
 * The Durable Object namespace a Worker under `wrangler dev` sees.
 *
 * Cloudflare's DurableObjectNamespace is synchronous where it can be:
 * `idFromName`, `newUniqueId`, `idFromString`, `get` and `getByName` return at
 * once, and only a stub's `fetch` and RPC methods are calls. Nimbus reaches an
 * inner object through a loopback entrypoint (NimbusDurableObjectNamespace),
 * whose every method is an RPC call, so ids and stubs are made here, inside the
 * Worker, and only a stub's calls cross to the session. Code written for the
 * real API runs unchanged: `env.NS.get(env.NS.idFromName("a")).fetch(req)`.
 *
 * Module source for the Worker's own module map, beside the bundle.
 * `nimbusDurableObjectEnv(env, names)` swaps each named binding in `env`
 * for a namespace over it, in place and once, and returns `env`. In place
 * because `import { env } from "cloudflare:workers"` reads the same bindings.
 */
export const DO_NAMESPACE_SHIM_MODULE = 'nimbus-do-namespace.js';
export const DO_NAMESPACE_SHIM_SOURCE = String.raw `
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// SHA-256 of a string's UTF-8, as hex. Synchronous, as idFromName is: the
// platform's digests are all asynchronous.
function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bytes.length * 8);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

const ID_PATTERN = /^[0-9a-f]{64}$/;

class DurableObjectId {
  #hex;
  #name;
  constructor(hex, name) {
    this.#hex = hex;
    this.#name = name;
  }
  get name() { return this.#name; }
  toString() { return this.#hex; }
  toJSON() { return this.#hex; }
  equals(other) { return other instanceof DurableObjectId && other.#hex === this.#hex; }
}

// A stub: fetch() and any RPC method reach the object through its namespace
// binding; id and name are the stub's own.
function stubFor(binding, id) {
  const remote = () => binding.get(id.toString());
  return new Proxy(Object.freeze({ id, name: id.name }), {
    get(target, key) {
      if (key === "id" || key === "name") return target[key];
      if (typeof key !== "string" || key === "then") return undefined;
      if (key === "fetch") return (input, init) => remote().fetch(new Request(input, init));
      return (...args) => remote().invoke(key, args);
    },
  });
}

const NAMESPACE = Symbol.for("nimbus.durableObjectNamespace");

class DurableObjectNamespace {
  #binding;
  constructor(binding) {
    this.#binding = binding;
    Object.defineProperty(this, NAMESPACE, { value: true });
  }
  idFromName(name) { return new DurableObjectId(sha256Hex(String(name)), String(name)); }
  newUniqueId() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return new DurableObjectId(Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""), undefined);
  }
  idFromString(hex) {
    if (typeof hex !== "string" || !ID_PATTERN.test(hex)) throw new TypeError("Invalid Durable Object ID: expected 64 hex digits");
    return new DurableObjectId(hex, undefined);
  }
  get(id) {
    if (!(id instanceof DurableObjectId)) throw new TypeError("Durable Object namespace get() takes a DurableObjectId");
    return stubFor(this.#binding, id);
  }
  getByName(name) { return this.get(this.idFromName(name)); }
  jurisdiction() { return this; }
}

export function nimbusDurableObjectEnv(env, names) {
  for (const name of names) {
    const binding = env[name];
    if (binding && !binding[NAMESPACE]) env[name] = new DurableObjectNamespace(binding);
  }
  return env;
}
`;
/**
 * The Worker's main module when it binds Durable Objects: the bundle as
 * `user.js`, every export passed through, and each entry that receives `env`
 * — the default handlers and the bound classes' constructors — handed it with
 * the namespaces in place.
 */
export function doNamespaceWrapperSource(bindingNames, classNames) {
    const names = JSON.stringify(bindingNames);
    // A class name is an export name of the bundle, so an identifier; one that
    // is not stays exported as the bundle has it, and its probe load says why.
    const classes = [...new Set(classNames)].filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)).map((name) => [
        `export const ${name} = typeof user.${name} === "function"`,
        `  ? class ${name} extends user.${name} { constructor(ctx, env) { super(ctx, nimbusDurableObjectEnv(env, NAMES)); } }`,
        `  : user.${name};`,
    ].join('\n'));
    return [
        `import * as user from "./user.js";`,
        `import { nimbusDurableObjectEnv } from "./${DO_NAMESPACE_SHIM_MODULE}";`,
        `export * from "./user.js";`,
        `const NAMES = ${names};`,
        ...classes,
        `const handlers = user.default;`,
        `export default typeof handlers === "function"`,
        `  ? class extends handlers { constructor(ctx, env) { super(ctx, nimbusDurableObjectEnv(env, NAMES)); } }`,
        `  : Object.fromEntries(Object.entries(handlers ?? {}).map(([key, value]) => [key, typeof value === "function"`,
        `    ? function (input, env, ctx) { return value.call(handlers, input, nimbusDurableObjectEnv(env, NAMES), ctx); }`,
        `    : value]));`,
    ].join('\n');
}
