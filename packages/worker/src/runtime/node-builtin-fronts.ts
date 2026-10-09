/**
 * Node's own argument checks in front of the builtins workerd provides
 * (zlib, buffer, crypto, path, url, events): the shims run each over its forwarded module (node-shims.ts,
 * "the builtins workerd provides"). A call Node refuses throws Node's error,
 * from core _shared/node-error.ts or Node's own validator (node-lib-host.ts),
 * which is loaded only once a cheap check has failed. A call Node takes goes
 * on to workerd's function with its arguments as Node's function would pass
 * them on. Each front names the Node v22.22.3 function whose checks it runs.
 * The text is ASCII: bun prints a String.raw template's other characters as
 * escapes, which tsc does not, so the staged shims would differ from src.
 */
export const NODE_BUILTIN_FRONTS_SOURCE = String.raw`
const __nimbusTypes = __realUtil.types;
// Node's validator \`name\` from its library, for a value a cheap check refused.
function __nimbusNodeValidator(name) {
  return __nimbusNodeLib().require("internal/validators")[name];
}
// \`target[name]\` replaced by \`make(real)\`, named as the real one; a
// property the module fixed is left as it is.
function __nimbusFront(target, name, make) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  const real = target[name];
  if (typeof real !== "function" || descriptor?.configurable === false) return;
  const fronted = make(real);
  Object.defineProperty(fronted, "name", { value: name, configurable: true });
  Object.defineProperty(target, name, { value: fronted, writable: true, enumerable: descriptor?.enumerable ?? true, configurable: true });
}

// lib/path.js: validate from the right until an absolute path ends resolution.
function __nimbusFrontPath(path) {
  __nimbusFront(path, "resolve", (real) => function (...paths) {
    for (let i = paths.length - 1; i >= 0; i--) {
      if (typeof paths[i] !== "string") throw invalidArgType("paths[" + i + "]", "string", paths[i]);
      if (paths[i].charCodeAt(0) === 47) break;
    }
    return Reflect.apply(real, this, paths);
  });
  __nimbusFront(path, "relative", (real) => function (from, to) {
    if (typeof from !== "string") throw invalidArgType("from", "string", from);
    if (typeof to !== "string") throw invalidArgType("to", "string", to);
    return Reflect.apply(real, this, arguments);
  });
  for (const mod of [path, path.win32]) {
    __nimbusFront(mod, "basename", (real) => function (path, suffix) {
      if (suffix !== undefined && typeof suffix !== "string") throw invalidArgType("suffix", "string", suffix);
      return Reflect.apply(real, this, arguments);
    });
    __nimbusFront(mod, "matchesGlob", (real) => function (path, pattern) {
      if (typeof path !== "string") throw invalidArgType("path", "string", path);
      if (typeof pattern !== "string") throw invalidArgType("pattern", "string", pattern);
      return Reflect.apply(real, this, arguments);
    });
    mod._makeLong = mod.toNamespacedPath;
  }
}

function __nimbusFrontUrl(url) {
  __nimbusFront(url, "pathToFileURL", (real) => function (path, options) {
    if (typeof path !== "string") throw invalidArgType("paths[0]", "string", path);
    return Reflect.apply(real, this, arguments);
  });
  __nimbusFront(url, "fileURLToPath", (real) => function (path, options) {
    if (typeof path === "string") path = new url.URL(path);
    return Reflect.apply(real, this, [path, options]);
  });
  __nimbusFront(url, "urlToHttpOptions", (real) => function (value) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      __nimbusNodeValidator("validateObject")(value, "url", __nimbusNodeLib().require("internal/validators").kValidateObjectAllowObjects);
    }
    return Reflect.apply(real, this, arguments);
  });
  // lib/internal/url.js fileURLToPathBuffer: percent decoding preserves non-UTF8 bytes.
  url.fileURLToPathBuffer = function fileURLToPathBuffer(path, options) {
    const windows = options?.windows ?? false;
    if (typeof path === "string") path = new url.URL(path);
    else if (!(path instanceof url.URL)) throw invalidArgType("path", ["string", "URL"], path);
    if (path.protocol !== "file:") throw nodeError(TypeError, "ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
    if (!windows && path.hostname !== "") throw nodeError(TypeError, "ERR_INVALID_FILE_URL_HOST", 'File URL host must be "localhost" or empty on linux');
    const pathname = windows ? path.pathname.replace(/\//g, "\\") : path.pathname;
    const decoded = __nimbusNodeLib().require("querystring").unescapeBuffer(pathname, false);
    if (!windows) return decoded;
    if (path.hostname !== "") return __BufferMod.concat([__BufferMod.from("\\\\" + url.domainToUnicode(path.hostname)), decoded]);
    const letter = decoded[1] | 0x20;
    if (letter < 97 || letter > 122 || decoded[2] !== 58) throw nodeError(TypeError, "ERR_INVALID_FILE_URL_PATH", "File URL path must be absolute", { input: String(path) });
    return decoded.subarray(1);
  };
  delete url.toPathIfFileURL;
}

function __nimbusFrontEvents(events) {
  __nimbusFront(events, "setMaxListeners", (real) => function (n = events.defaultMaxListeners, ...targets) {
    if (typeof n !== "number" || n < 0 || Number.isNaN(n)) __nimbusNodeValidator("validateNumber")(n, "setMaxListeners", 0);
    return Reflect.apply(real, this, [n, ...targets]);
  });
  __nimbusFront(events, "getMaxListeners", (real) => function (emitter) {
    if (typeof emitter?.getMaxListeners === "function") return Reflect.apply(real, this, arguments);
    if (emitter instanceof EventTarget) return emitter[events.kMaxEventTargetListeners] ?? events.defaultMaxListeners;
    throw invalidArgType("emitter", ["EventEmitter", "EventTarget"], emitter);
  });
  const RealResource = events.EventEmitterAsyncResource;
  class EventEmitterAsyncResource extends RealResource {
    constructor(options) {
      if (typeof options === "string") options = { name: options };
      else if (new.target === EventEmitterAsyncResource && typeof options?.name !== "string") throw invalidArgType("options.name", "string", options?.name);
      super(options);
    }
  }
  events.EventEmitterAsyncResource = EventEmitterAsyncResource;
}

// zlib
function __nimbusFrontZlib(zlib) {
  // lib/zlib.js zlibBufferSync: a string, an ArrayBufferView, or any
  // ArrayBuffer (as a Buffer). Node constructs its engine from the options
  // first; here the buffer is checked first, which differs only where both
  // are wrong.
  const bufferOf = (buffer) => {
    if (typeof buffer === "string" || ArrayBuffer.isView(buffer)) return buffer;
    if (__nimbusTypes.isAnyArrayBuffer(buffer)) return __BufferMod.from(buffer);
    throw invalidArgType("buffer", ["string", "Buffer", "TypedArray", "DataView", "ArrayBuffer"], buffer);
  };
  // Node's engines read their options' fields: options that are no object are the defaults.
  const optionsOf = (opts) => (opts !== null && typeof opts === "object" ? opts : undefined);
  for (const name of ["deflateSync", "inflateSync", "gzipSync", "gunzipSync", "deflateRawSync", "inflateRawSync", "unzipSync",
    "brotliCompressSync", "brotliDecompressSync", "zstdCompressSync", "zstdDecompressSync"]) {
    __nimbusFront(zlib, name, (real) => function (buffer, opts) {
      return Reflect.apply(real, this, [bufferOf(buffer), optionsOf(opts)]);
    });
  }
  // lib/zlib.js crc32.
  __nimbusFront(zlib, "crc32", (real) => function (data, value = 0) {
    if (typeof data !== "string" && !ArrayBuffer.isView(data)) throw invalidArgType("data", ["Buffer", "TypedArray", "DataView", "string"], data);
    if (typeof value !== "number" || value >>> 0 !== value) __nimbusNodeValidator("validateUint32")(value, "value");
    return Reflect.apply(real, this, [data, value]);
  });
}

// buffer
function __nimbusFrontBuffer(buffer) {
  // lib/buffer.js isUtf8 and isAscii: a TypedArray or any ArrayBuffer, its bytes.
  const bytesOf = (input) => (ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input));
  for (const name of ["isUtf8", "isAscii"]) {
    __nimbusFront(buffer, name, (real) => function (input) {
      if (__nimbusTypes.isTypedArray(input) || __nimbusTypes.isAnyArrayBuffer(input)) return Reflect.apply(real, this, [bytesOf(input)]);
      throw invalidArgType("input", ["ArrayBuffer", "Buffer", "TypedArray"], input);
    });
  }
  // lib/buffer.js transcode.
  __nimbusFront(buffer, "transcode", (real) => function (source, fromEncoding, toEncoding) {
    if (!__nimbusTypes.isUint8Array(source)) throw invalidArgType("source", ["Buffer", "Uint8Array"], source);
    return Reflect.apply(real, this, arguments);
  });
  // lib/buffer.js SlowBuffer.
  __nimbusFront(buffer, "SlowBuffer", (real) => function (size) {
    if (typeof size !== "number" || !(size >= 0 && size <= buffer.kMaxLength)) __nimbusNodeValidator("validateNumber")(size, "size", 0, buffer.kMaxLength);
    return Reflect.apply(real, this, [size]);
  });
  // lib/buffer.js btoa and atob: Node's errors over the platform's codec, the
  // input made a string as a template literal makes it.
  __nimbusFront(buffer, "btoa", (real) => function (input) {
    if (arguments.length === 0) throw new nodeErrorCodes.ERR_MISSING_ARGS("input");
    const text = "".concat(input);
    if (/[^\u0000-\u00ff]/.test(text)) throw new DOMException("Invalid character", "InvalidCharacterError");
    return Reflect.apply(real, this, [text]);
  });
  __nimbusFront(buffer, "atob", (real) => function (input) {
    if (arguments.length === 0) throw new nodeErrorCodes.ERR_MISSING_ARGS("input");
    const text = "".concat(input);
    try {
      return Reflect.apply(real, this, [text]);
    } catch (error) {
      if (error?.name !== "InvalidCharacterError") throw error;
      // Node's _atob (simdutf's forgiving base64): a character outside the
      // alphabet, or one character left over.
      const data = text.replace(/[\t\n\f\r ]/g, "");
      const unpadded = data.length % 4 === 0 ? data.replace(/={1,2}$/, "") : data;
      if (/[^A-Za-z0-9+/]/.test(unpadded) || unpadded.length % 4 !== 1) throw new DOMException("Invalid character", "InvalidCharacterError");
      throw new DOMException("The string to be decoded is not correctly encoded.", "InvalidCharacterError");
    }
  });
  // lib/internal/blob.js Blob and lib/internal/file.js File: the platform's
  // classes, constructed past Node's checks; each the constructor of its
  // instances, the platform's too.
  const sourcesChecked = (sources = [], options) => {
    if (sources === null || typeof sources[Symbol.iterator] !== "function" || typeof sources === "string") {
      throw invalidArgType("sources", "a sequence", sources);
    }
    if (options != null && typeof options !== "object" && typeof options !== "function") __nimbusNodeValidator("validateDictionary")(options, "options");
  };
  const fronts = new Map();
  for (const [name, check] of [
    ["Blob", sourcesChecked],
    ["File", function (fileBits, fileName, options) {
      if (arguments.length < 2) throw new nodeErrorCodes.ERR_MISSING_ARGS("fileBits", "fileName");
      sourcesChecked(fileBits, options);
    }],
  ]) {
    const Class = buffer[name];
    if (typeof Class !== "function" || Object.getOwnPropertyDescriptor(buffer, name)?.configurable === false) continue;
    const fronted = new Proxy(Class, {
      construct(target, args, newTarget) {
        Reflect.apply(check, undefined, args);
        return Reflect.construct(target, args, newTarget === fronted ? target : newTarget);
      },
      getPrototypeOf: (target) => fronts.get(Object.getPrototypeOf(target)) ?? Object.getPrototypeOf(target),
    });
    fronts.set(Class, fronted);
    Object.defineProperty(Class.prototype, "constructor", { value: fronted, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(buffer, name, { value: fronted, writable: true, enumerable: true, configurable: true });
    if (globalThis[name] === Class) globalThis[name] = fronted;
  }
  // Node's atob and btoa globals are buffer's.
  for (const name of ["atob", "btoa"]) if (typeof buffer[name] === "function") globalThis[name] = buffer[name];
}

// crypto
function __nimbusFrontCrypto(crypto) {
  const isAnyArrayBuffer = __nimbusTypes.isAnyArrayBuffer;
  const isStringOrBuffer = (value) => typeof value === "string" || ArrayBuffer.isView(value) || isAnyArrayBuffer(value);
  const isKeyObject = (value) => typeof crypto.KeyObject === "function" && value instanceof crypto.KeyObject;
  const isCryptoKey = (value) => typeof globalThis.CryptoKey === "function" && value instanceof globalThis.CryptoKey;
  // An error Node's C++ binding throws: its code on the error, not in its stack's header.
  const bindingError = (Base, code, message) => Object.assign(new Base(message), { code });
  const string = (value, name) => {
    if (typeof value !== "string") throw invalidArgType(name, "string", value);
  };
  const callback = (value, name = "callback") => {
    if (typeof value !== "function") throw invalidArgType(name, "Function", value);
  };
  const object = (value, name) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) __nimbusNodeValidator("validateObject")(value, name);
  };
  const int32 = (value, name, min) => {
    if (!Number.isInteger(value) || value < min || value > 2147483647) __nimbusNodeValidator("validateInt32")(value, name, min);
  };
  // lib/internal/crypto/util.js getArrayBufferOrView's check.
  const bufferOrView = (value, name) => {
    if (!isStringOrBuffer(value)) throw invalidArgType(name, ["string", "ArrayBuffer", "Buffer", "TypedArray", "DataView"], value);
  };
  // lib/internal/crypto/keys.js getKeyTypes.
  const keyTypes = (allowKeyObject, bufferOnly = false) => {
    const types = ["ArrayBuffer", "Buffer", "TypedArray", "DataView", "string", "KeyObject", "CryptoKey"];
    return bufferOnly ? types.slice(0, 4) : allowKeyObject ? types : types.slice(0, 5);
  };
  // lib/internal/crypto/util.js getStringOption.
  const stringOption = (options, key) => {
    let value;
    if (options && (value = options[key]) != null) string(value, "options." + key);
    return value;
  };
  // lib/internal/crypto/keys.js prepareSecretKey's checks.
  const secretKey = (key, bufferOnly = false) => {
    if (!bufferOnly && (isKeyObject(key) || isCryptoKey(key))) {
      if (key.type !== "secret") throw new nodeErrorCodes.ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE(key.type, "secret");
      return;
    }
    if (!isStringOrBuffer(key)) throw invalidArgType("key", keyTypes(!bufferOnly, bufferOnly), key);
  };
  // lib/internal/crypto/keys.js prepareAsymmetricKey's checks, by its context.
  const CREATE_PRIVATE = 0, CREATE_PUBLIC = 1, CONSUME_PRIVATE = 2, CONSUME_PUBLIC = 3;
  const keyObjectChecked = (key, context) => {
    if (context === CREATE_PRIVATE) throw invalidArgType("key", ["string", "ArrayBuffer", "Buffer", "TypedArray", "DataView"], key);
    if (key.type !== "private") {
      if (context === CONSUME_PRIVATE || context === CREATE_PUBLIC) throw new nodeErrorCodes.ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE(key.type, "private");
      if (key.type !== "public") throw new nodeErrorCodes.ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE(key.type, "private or public");
    }
  };
  const asymmetricKey = (key, context) => {
    if (isKeyObject(key) || isCryptoKey(key)) return keyObjectChecked(key, context);
    if (isStringOrBuffer(key)) return;
    if (typeof key === "object") {
      const { key: data, format } = key;
      if (isKeyObject(data) || isCryptoKey(data)) return keyObjectChecked(data, context);
      if (format === "jwk") return __nimbusNodeValidator("validateObject")(data, "key.key");
      if (!isStringOrBuffer(data)) throw invalidArgType("key.key", keyTypes(context !== CREATE_PRIVATE), data);
      return;
    }
    throw invalidArgType("key", keyTypes(context !== CREATE_PRIVATE), key);
  };

  // lib/internal/crypto/cipher.js createCipherWithIV.
  for (const name of ["createCipheriv", "createDecipheriv"]) {
    __nimbusFront(crypto, name, (real) => function (cipher, key, iv, options) {
      string(cipher, "cipher");
      stringOption(options, "encoding");
      secretKey(key);
      if (iv !== null) bufferOrView(iv, "iv");
      return Reflect.apply(real, this, arguments);
    });
  }
  // lib/internal/crypto/cipher.js getCipherInfo.
  __nimbusFront(crypto, "getCipherInfo", (real) => function (nameOrNid) {
    if (typeof nameOrNid !== "string" && typeof nameOrNid !== "number") throw invalidArgType("nameOrNid", ["string", "number"], nameOrNid);
    return Reflect.apply(real, this, arguments);
  });
  // lib/internal/crypto/cipher.js rsaFunctionFor.
  for (const [name, context] of [["publicEncrypt", CONSUME_PUBLIC], ["privateDecrypt", CONSUME_PRIVATE], ["privateEncrypt", CONSUME_PRIVATE], ["publicDecrypt", CONSUME_PUBLIC]]) {
    __nimbusFront(crypto, name, (real) => function (options, buffer) {
      asymmetricKey(options, context);
      const { oaepHash, oaepLabel } = options;
      if (oaepHash !== undefined) string(oaepHash, "key.oaepHash");
      if (oaepLabel !== undefined) bufferOrView(oaepLabel, "key.oaepLabel");
      bufferOrView(buffer, "buffer");
      return Reflect.apply(real, this, arguments);
    });
  }
  // lib/internal/crypto/diffiehellman.js ECDH and DiffieHellmanGroup (its binding's words).
  __nimbusFront(crypto, "createECDH", (real) => function (curve) {
    string(curve, "curve");
    try {
      return Reflect.apply(real, this, arguments);
    } catch (error) {
      if (error?.message === "Invalid curve") throw bindingError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
      throw error;
    }
  });
  // src/crypto/crypto_dh.cc FindDiffieHellmanGroup: the groups Node knows,
  // their names compared ASCII case-insensitively (StringEqualNoCase).
  const knownGroups = new Set(["modp1", "modp2", "modp5", "modp14", "modp15", "modp16", "modp17", "modp18"]);
  const asciiLower = (text) => text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
  for (const name of ["createDiffieHellmanGroup", "getDiffieHellman"]) {
    __nimbusFront(crypto, name, (real) => function (groupName) {
      if (typeof groupName !== "string") throw bindingError(TypeError, "ERR_INVALID_ARG_TYPE", "Group name must be a string");
      if (!knownGroups.has(asciiLower(groupName))) throw bindingError(Error, "ERR_CRYPTO_UNKNOWN_DH_GROUP", "Unknown DH group");
      return Reflect.apply(real, this, arguments);
    });
  }
  // lib/internal/crypto/hash.js Hmac and hash.
  __nimbusFront(crypto, "createHmac", (real) => function (hmac, key, options) {
    string(hmac, "hmac");
    stringOption(options, "encoding");
    secretKey(key);
    return Reflect.apply(real, this, arguments);
  });
  __nimbusFront(crypto, "hash", (real) => function (algorithm, input) {
    string(algorithm, "algorithm");
    if (typeof input !== "string" && !ArrayBuffer.isView(input)) throw invalidArgType("input", ["Buffer", "TypedArray", "DataView", "string"], input);
    return Reflect.apply(real, this, arguments);
  });
  // lib/internal/crypto/keys.js createSecretKey, createPublicKey and createPrivateKey.
  __nimbusFront(crypto, "createSecretKey", (real) => function (key) {
    secretKey(key, true);
    return Reflect.apply(real, this, arguments);
  });
  for (const [name, context] of [["createPublicKey", CREATE_PUBLIC], ["createPrivateKey", CREATE_PRIVATE]]) {
    __nimbusFront(crypto, name, (real) => function (key) {
      asymmetricKey(key, context);
      return Reflect.apply(real, this, arguments);
    });
  }
  // lib/internal/crypto/keygen.js generateKey and generateKeySync (generateKeyJob),
  // generateKeyPair and generateKeyPairSync (createJob, parseKeyEncoding).
  const keyJob = (type, options) => {
    string(type, "type");
    object(options, "options");
  };
  const keyPairJob = (type, options) => {
    string(type, "type");
    if (options !== undefined) {
      const { publicKeyEncoding, privateKeyEncoding } = options;
      object(options, "options");
    }
  };
  for (const [name, job, async] of [["generateKey", keyJob, true], ["generateKeySync", keyJob, false], ["generateKeyPair", keyPairJob, true], ["generateKeyPairSync", keyPairJob, false]]) {
    __nimbusFront(crypto, name, (real) => function (type, options, done) {
      if (async) {
        if (typeof options === "function") {
          done = options;
          options = undefined;
        }
        callback(done);
      }
      job(type, options);
      return Reflect.apply(real, this, arguments);
    });
  }
  // lib/internal/crypto/pbkdf2.js pbkdf2 and its check.
  __nimbusFront(crypto, "pbkdf2", (real) => function (password, salt, iterations, keylen, digest, done) {
    if (typeof digest === "function") {
      done = digest;
      digest = undefined;
    }
    string(digest, "digest");
    bufferOrView(password, "password");
    bufferOrView(salt, "salt");
    int32(iterations, "iterations", 1);
    int32(keylen, "keylen", 0);
    callback(done);
    return Reflect.apply(real, this, arguments);
  });
  // lib/internal/crypto/random.js randomBytes, randomFillSync and randomFill.
  // The platform's randomFillSync is the one random source: it hands its
  // region to getRandomValues, which takes 65536 bytes a call (the Web Crypto
  // quota), where Node's fill up to 2 ** 31 - 1. A region is filled through
  // it 65536 bytes at a time, as a byte view, so a wider element counts in
  // bytes (the native-esm port passed element offsets as byte offsets).
  const RANDOM_CALL_BYTES = 65536;
  const kMaxPossibleLength = 2 ** 31 - 1;
  const platformFillSync = crypto.randomFillSync;
  const number = (value, name) => {
    if (typeof value !== "number") __nimbusNodeValidator("validateNumber")(value, name);
  };
  const assertOffset = (offset, elementSize, length) => {
    number(offset, "offset");
    offset *= elementSize;
    const maxLength = Math.min(length, kMaxPossibleLength);
    if (Number.isNaN(offset) || offset > maxLength || offset < 0) throw new nodeErrorCodes.ERR_OUT_OF_RANGE("offset", ">= 0 && <= " + maxLength, offset);
    return offset >>> 0;
  };
  const assertSize = (size, elementSize, offset, length) => {
    number(size, "size");
    size *= elementSize;
    if (Number.isNaN(size) || size > kMaxPossibleLength || size < 0) throw new nodeErrorCodes.ERR_OUT_OF_RANGE("size", ">= 0 && <= " + kMaxPossibleLength, size);
    if (size + offset > length) throw new nodeErrorCodes.ERR_OUT_OF_RANGE("size + offset", "<= " + length, size + offset);
    return size >>> 0;
  };
  const randomBuffer = (buf) => {
    if (!isAnyArrayBuffer(buf) && !ArrayBuffer.isView(buf)) throw invalidArgType("buf", ["ArrayBuffer", "ArrayBufferView"], buf);
  };
  // \`buf\`'s bytes from \`offset\` for \`size\`, filled 65536 at a time.
  const fillBytes = (buf, offset, size) => {
    const bytes = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset + offset, size) : new Uint8Array(buf, offset, size);
    for (let at = 0; at < size; at += RANDOM_CALL_BYTES) Reflect.apply(platformFillSync, crypto, [bytes.subarray(at, at + RANDOM_CALL_BYTES)]);
    return buf;
  };
  __nimbusFront(crypto, "randomFillSync", () => function (buf, offset = 0, size) {
    randomBuffer(buf);
    const elementSize = buf.BYTES_PER_ELEMENT || 1;
    offset = assertOffset(offset, elementSize, buf.byteLength);
    size = size === undefined ? buf.byteLength - offset : assertSize(size, elementSize, offset, buf.byteLength);
    return size === 0 ? buf : fillBytes(buf, offset, size);
  });
  __nimbusFront(crypto, "randomFill", () => function (buf, offset, size, done) {
    randomBuffer(buf);
    const elementSize = buf.BYTES_PER_ELEMENT || 1;
    if (typeof offset === "function") {
      done = offset;
      offset = 0;
      size = buf.length;
    } else if (typeof size === "function") {
      done = size;
      size = buf.length - offset;
    } else {
      callback(done);
    }
    offset = assertOffset(offset, elementSize, buf.byteLength);
    size = size === undefined ? buf.byteLength - offset : assertSize(size, elementSize, offset, buf.byteLength);
    if (size !== 0) fillBytes(buf, offset, size);
    __processMod.nextTick(done, null, buf);
  });
  __nimbusFront(crypto, "randomBytes", () => function (size, done) {
    size = assertSize(size, 1, 0, Infinity);
    if (done !== undefined) callback(done);
    const buf = fillBytes(__BufferMod.allocUnsafe(size), 0, size);
    if (done === undefined) return buf;
    __processMod.nextTick(done, null, buf);
  });
  // Node's deprecated names for randomBytes are the same function.
  for (const name of ["pseudoRandomBytes", "prng", "rng"]) {
    if (typeof crypto[name] === "function" && Object.getOwnPropertyDescriptor(crypto, name)?.configurable !== false) {
      Object.defineProperty(crypto, name, { value: crypto.randomBytes, writable: true, enumerable: true, configurable: true });
    }
  }
  __nimbusFront(crypto, "randomInt", (real) => function (min, max, done) {
    const minNotSpecified = typeof max === "undefined" || typeof max === "function";
    if (minNotSpecified) {
      done = max;
      max = min;
      min = 0;
    }
    if (typeof done !== "undefined") callback(done);
    if (!Number.isSafeInteger(min)) throw invalidArgType("min", "a safe integer", min);
    if (!Number.isSafeInteger(max)) throw invalidArgType("max", "a safe integer", max);
    if (max <= min) throw new nodeErrorCodes.ERR_OUT_OF_RANGE("max", 'greater than the value of "min" (' + min + ")", max);
    if (!(max - min <= 0xFFFFFFFFFFFF)) throw new nodeErrorCodes.ERR_OUT_OF_RANGE("max" + (minNotSpecified ? "" : " - min"), "<= 281474976710655", max - min);
    return Reflect.apply(real, this, arguments);
  });
  // A typed array's kind from its internal slot ([[TypedArrayName]]), whatever
  // Symbol.toStringTag it carries, as Node's isFloat32Array and the rest read it.
  const typedArrayKind = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
  const floatKinds = new Set(["Float16Array", "Float32Array", "Float64Array"]);
  __nimbusFront(crypto, "getRandomValues", (real) => function (data) {
    if (!__nimbusTypes.isTypedArray(data) || floatKinds.has(Reflect.apply(typedArrayKind, data, []))) {
      throw new DOMException("The data argument must be an integer-type TypedArray", "TypeMismatchError");
    }
    if (data.byteLength > 65536) throw new DOMException("The requested length exceeds 65,536 bytes", "QuotaExceededError");
    return Reflect.apply(real, this, arguments);
  });
  // lib/internal/crypto/sig.js Sign, Verify, signOneShot and verifyOneShot.
  for (const name of ["createSign", "createVerify"]) {
    __nimbusFront(crypto, name, (real) => function (algorithm) {
      string(algorithm, "algorithm");
      try {
        return Reflect.apply(real, this, arguments);
      } catch (error) {
        if (typeof error?.message === "string" && error.message.startsWith("Unknown digest")) throw bindingError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", "Invalid digest");
        throw error;
      }
    });
  }
  __nimbusFront(crypto, "sign", (real) => function (algorithm, data, key, done) {
    if (algorithm != null) string(algorithm, "algorithm");
    if (done !== undefined) callback(done);
    bufferOrView(data, "data");
    if (!key) throw new nodeErrorCodes.ERR_CRYPTO_SIGN_KEY_REQUIRED();
    return Reflect.apply(real, this, arguments);
  });
  __nimbusFront(crypto, "verify", (real) => function (algorithm, data, key, signature, done) {
    if (algorithm != null) string(algorithm, "algorithm");
    if (done !== undefined) callback(done);
    bufferOrView(data, "data");
    if (!ArrayBuffer.isView(data) && typeof data !== "string") throw invalidArgType("data", ["Buffer", "TypedArray", "DataView"], data);
    return Reflect.apply(real, this, arguments);
  });
  // src/crypto/crypto_timing.cc TimingSafeEqual.
  __nimbusFront(crypto, "timingSafeEqual", (real) => function (buf1, buf2) {
    for (const [name, value] of [["buf1", buf1], ["buf2", buf2]]) {
      if (!ArrayBuffer.isView(value) && !isAnyArrayBuffer(value)) {
        throw bindingError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "' + name + '" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.');
      }
    }
    if (buf1.byteLength !== buf2.byteLength) throw bindingError(RangeError, "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length");
    return Reflect.apply(real, this, arguments);
  });
  // lib/internal/crypto/util.js setEngine: no engine is loadable here, so none is found.
  __nimbusFront(crypto, "setEngine", () => function (id, flags) {
    string(id, "id");
    if (flags) __nimbusNodeValidator("validateNumber")(flags, "flags");
    throw new nodeErrorCodes.ERR_CRYPTO_ENGINE_UNKNOWN(id);
  });
}
`;
