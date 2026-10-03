/**
 * node:http2 as Nimbus provides it: exactly the names Node 22 exports, for
 * both node runtimes (the node shims a facet runs, and the substrate's
 * node-compat module map), from this one source.
 *
 * Nimbus serves HTTP/1.1 only, so nothing here opens a session or a server:
 * `createServer`, `createSecureServer`, `performServerHandshake` and the two
 * compatibility classes' constructors throw ERR_HTTP2_NOT_SUPPORTED, and
 * `connect` returns a client session that reports the same error, as a
 * failed connection does. What is pure computation is Node's:
 * `getDefaultSettings`, the 6-byte SETTINGS entries `getPackedSettings`
 * writes and `getUnpackedSettings` reads (lib/internal/http2/core.js and
 * util.js, with nghttp2's payload check), and `constants`. The two server
 * classes are real classes over the runtime's own streams, so an HTTP/1
 * request or response is never an instance of them (Astro's dev server asks
 * `res instanceof Http2ServerResponse` of every response).
 *
 * Self-contained: the node shims embed this function's compiled text
 * (scripts/bundle-facet-workers.mjs), so it reaches nothing outside itself
 * but `host`.
 */

/** What the runtime embedding the module supplies. */
export interface Http2ModuleHost {
  EventEmitter: new () => { emit(event: string, ...args: unknown[]): boolean };
  /** Node's Http2ServerRequest is a Readable. */
  Readable: new () => Record<never, never>;
  /** Node's Http2ServerResponse is a Stream (the legacy base class). */
  Stream: new () => Record<never, never>;
  Buffer: { alloc(size: number): Uint8Array };
  /** process.emitWarning, where the runtime has one. */
  emitWarning?: (message: string) => void;
}

/** A settings object, as Node's settings functions take and return one. */
export interface Http2Settings {
  headerTableSize?: number;
  enablePush?: boolean;
  initialWindowSize?: number;
  maxFrameSize?: number;
  maxConcurrentStreams?: number;
  maxHeaderListSize?: number;
  maxHeaderSize?: number;
  enableConnectProtocol?: boolean;
  customSettings?: Record<string, number>;
}

export function createHttp2Module(host: Http2ModuleHost) {
  type ErrorClass = new (message: string) => Error;
  const nodeError = (Base: ErrorClass, code: string, message: string, props: Record<string, unknown> = {}): Error =>
    Object.assign(new Base(message), { code }, props);
  const notSupported = (op: string) =>
    nodeError(Error, 'ERR_HTTP2_NOT_SUPPORTED', `http2.${op}: not implemented in Nimbus. Use fetch() or HTTP/1.1.`);

  // Node's ERR_INVALID_ARG_TYPE (lib/internal/errors.js), for the three
  // expectations these functions state.
  const describe = (value: unknown): string => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    switch (typeof value) {
      case 'bigint': return `type bigint (${value}n)`;
      case 'number':
        if (Object.is(value, -0)) return 'type number (-0)';
        return `type number (${value})`;
      case 'boolean': return `type boolean (${value})`;
      case 'symbol': return `type symbol (${String(value)})`;
      case 'function': return `function ${value.name}`;
      case 'string': {
        const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
        return shown.includes("'") ? `type string (${JSON.stringify(shown)})` : `type string ('${shown}')`;
      }
      default: {
        const ctor: unknown = Reflect.get(Object(value), 'constructor');
        return typeof ctor === 'function' && ctor.name ? `an instance of ${ctor.name}` : String(value);
      }
    }
  };
  const invalidArgType = (name: string, expected: string, value: unknown) =>
    nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${expected}. Received ${describe(value)}`);
  const invalidSetting = (Base: ErrorClass, name: string, actual: unknown, min?: number, max?: number) =>
    nodeError(Base, 'ERR_HTTP2_INVALID_SETTING_VALUE', `Invalid value for setting "${name}": ${String(actual)}`,
      min === undefined ? { actual } : { actual, min, max });

  const MAX_INT = 2 ** 32 - 1;
  const MAX_ADDITIONAL_SETTINGS = 10;
  // SETTINGS identifiers (RFC 9113 §6.5.2; 8 is RFC 8441's, 9 RFC 9218's).
  const HEADER_TABLE_SIZE = 1;
  const ENABLE_PUSH = 2;
  const MAX_CONCURRENT_STREAMS = 3;
  const INITIAL_WINDOW_SIZE = 4;
  const MAX_FRAME_SIZE = 5;
  const MAX_HEADER_LIST_SIZE = 6;
  const ENABLE_CONNECT_PROTOCOL = 8;
  const NO_RFC7540_PRIORITIES = 9;

  const isObjectArg = (value: unknown) => value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));
  const withinRange = (name: string, value: unknown, min: number, max: number) => {
    if (value !== undefined && (typeof value !== 'number' || value < min || value > max)) {
      throw invalidSetting(RangeError, name, value, min, max);
    }
  };
  const validate = (settings: Http2Settings | undefined) => {
    if (settings === undefined) return;
    if (!isObjectArg(settings.customSettings)) throw invalidArgType('customSettings', 'an instance of Number', settings.customSettings);
    if (settings.customSettings) {
      const entries = Object.entries(settings.customSettings);
      if (entries.length > MAX_ADDITIONAL_SETTINGS) {
        throw nodeError(Error, 'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS', 'Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS');
      }
      for (const [key, value] of entries) {
        withinRange('customSettings:id', Number(key), 0, 0xffff);
        withinRange('customSettings:value', Number(value), 0, MAX_INT);
      }
    }
    withinRange('headerTableSize', settings.headerTableSize, 0, MAX_INT);
    withinRange('initialWindowSize', settings.initialWindowSize, 0, 2 ** 31 - 1);
    withinRange('maxFrameSize', settings.maxFrameSize, 16384, 2 ** 24 - 1);
    withinRange('maxConcurrentStreams', settings.maxConcurrentStreams, 0, MAX_INT);
    withinRange('maxHeaderListSize', settings.maxHeaderListSize, 0, MAX_INT);
    withinRange('maxHeaderSize', settings.maxHeaderSize, 0, MAX_INT);
    for (const name of ['enablePush', 'enableConnectProtocol'] as const) {
      const value = settings[name];
      if (value !== undefined && typeof value !== 'boolean') throw invalidSetting(TypeError, name, value);
    }
  };

  function getDefaultSettings(): Http2Settings {
    // nghttp2's defaults, in the order Node assigns them.
    const settings: Http2Settings = Object.create(null);
    settings.headerTableSize = 4096;
    settings.enablePush = true;
    settings.initialWindowSize = 65535;
    settings.maxFrameSize = 16384;
    settings.maxConcurrentStreams = MAX_INT;
    settings.maxHeaderListSize = settings.maxHeaderSize = 65535;
    settings.enableConnectProtocol = false;
    return settings;
  }

  /**
   * A SETTINGS frame payload: one 6-byte entry (16-bit identifier, 32-bit
   * value, big-endian) per setting given, the known ones in identifier order
   * and then the custom ones; undefined when nghttp2 would refuse a value,
   * as Node returns it.
   */
  function getPackedSettings(settings?: Http2Settings) {
    if (!isObjectArg(settings)) throw invalidArgType('settings', 'of type object', settings);
    validate(settings);
    const given: Http2Settings = { ...settings };
    // Node's settings buffer, by its slots: a custom identifier below 7 names
    // the slot of that index (util.js updateSettingsBuffer).
    const slots: (keyof Http2Settings)[] = ['headerTableSize', 'enablePush', 'initialWindowSize', 'maxFrameSize',
      'maxConcurrentStreams', 'maxHeaderListSize', 'enableConnectProtocol'];
    const known = new Map<keyof Http2Settings, number>();
    const custom = new Map<number, number>();
    if (typeof given.customSettings === 'object') {
      for (const key in given.customSettings) {
        const value = given.customSettings[key];
        if (typeof value !== 'number') continue;
        const id = Number(key);
        if (Number.isNaN(id) || id <= 0 || id > 0xffff) throw invalidSetting(RangeError, 'Range Error', id, 0, 0xffff);
        if (Number.isNaN(value) || value <= 0 || value > 0xffffffff) throw invalidSetting(RangeError, 'Range Error', value, 0, 0xffffffff);
        if (id < slots.length) known.set(slots[id]!, value);
        else {
          if (!custom.has(id) && custom.size === MAX_ADDITIONAL_SETTINGS) {
            throw nodeError(Error, 'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS', 'Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS');
          }
          custom.set(id, value);
        }
      }
    }
    for (const name of ['headerTableSize', 'maxConcurrentStreams', 'initialWindowSize', 'maxFrameSize'] as const) {
      const value = given[name];
      if (typeof value === 'number') known.set(name, value);
    }
    if (typeof given.maxHeaderListSize === 'number' || typeof given.maxHeaderSize === 'number') {
      if (given.maxHeaderSize !== undefined && given.maxHeaderSize !== given.maxHeaderListSize) {
        host.emitWarning?.('settings.maxHeaderSize overwrite settings.maxHeaderListSize');
        known.set('maxHeaderListSize', Number(given.maxHeaderSize));
      } else {
        known.set('maxHeaderListSize', Number(given.maxHeaderListSize));
      }
    }
    for (const name of ['enablePush', 'enableConnectProtocol'] as const) {
      const value = given[name];
      if (typeof value === 'boolean') known.set(name, Number(value));
    }
    const ids: Partial<Record<keyof Http2Settings, number>> = {
      headerTableSize: HEADER_TABLE_SIZE, enablePush: ENABLE_PUSH, maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      initialWindowSize: INITIAL_WINDOW_SIZE, maxFrameSize: MAX_FRAME_SIZE, maxHeaderListSize: MAX_HEADER_LIST_SIZE,
      enableConnectProtocol: ENABLE_CONNECT_PROTOCOL,
    };
    const entries: [number, number][] = [];
    for (const name of ['headerTableSize', 'enablePush', 'maxConcurrentStreams', 'initialWindowSize', 'maxFrameSize',
      'maxHeaderListSize', 'enableConnectProtocol'] as const) {
      const value = known.get(name);
      if (value !== undefined) entries.push([ids[name]!, value >>> 0]);
    }
    for (const [id, value] of custom) entries.push([id, value >>> 0]);
    // nghttp2_pack_settings_payload refuses a value its identifier forbids.
    for (const [id, value] of entries) {
      if ((id === ENABLE_PUSH || id === ENABLE_CONNECT_PROTOCOL || id === NO_RFC7540_PRIORITIES) && value > 1) return undefined;
      if (id === INITIAL_WINDOW_SIZE && value > 2 ** 31 - 1) return undefined;
      if (id === MAX_FRAME_SIZE && (value < 16384 || value > 2 ** 24 - 1)) return undefined;
    }
    const out = host.Buffer.alloc(entries.length * 6);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    entries.forEach(([id, value], i) => {
      view.setUint16(i * 6, id);
      view.setUint32(i * 6 + 2, value);
    });
    return out;
  }

  /** A SETTINGS frame payload read back into a settings object (Node reads elements, as Buffer's readUInt*BE do). */
  function getUnpackedSettings(buf: ArrayLike<number>, options: { validate?: boolean } | null = {}) {
    if (!ArrayBuffer.isView(buf) || Reflect.get(buf, 'length') === undefined) {
      throw invalidArgType('buf', 'an instance of Buffer or TypedArray', buf);
    }
    if (buf.length % 6 !== 0) {
      throw nodeError(RangeError, 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', 'Packed settings length must be a multiple of six');
    }
    const settings: Http2Settings = {};
    for (let offset = 0; offset < buf.length; offset += 6) {
      const id = buf[offset]! * 2 ** 8 + buf[offset + 1]!;
      const value = buf[offset + 2]! * 2 ** 24 + buf[offset + 3]! * 2 ** 16 + buf[offset + 4]! * 2 ** 8 + buf[offset + 5]!;
      switch (id) {
        case HEADER_TABLE_SIZE: settings.headerTableSize = value; break;
        case ENABLE_PUSH: settings.enablePush = value !== 0; break;
        case MAX_CONCURRENT_STREAMS: settings.maxConcurrentStreams = value; break;
        case INITIAL_WINDOW_SIZE: settings.initialWindowSize = value; break;
        case MAX_FRAME_SIZE: settings.maxFrameSize = value; break;
        case MAX_HEADER_LIST_SIZE: settings.maxHeaderListSize = settings.maxHeaderSize = value; break;
        case ENABLE_CONNECT_PROTOCOL: settings.enableConnectProtocol = value !== 0; break;
        default: (settings.customSettings ??= {})[id] = value;
      }
    }
    if (options != null && options.validate) validate(settings);
    return settings;
  }

  /** A client session whose connection fails, as every HTTP/2 connection here does. */
  class ClientHttp2Session extends host.EventEmitter {
    destroyed = false;
    closed = false;
    constructor() {
      super();
      queueMicrotask(() => this.emit('error', notSupported('connect')));
    }
    request(): never { throw notSupported('request'); }
    settings(): void {}
    close(callback?: () => void): void {
      this.closed = true;
      queueMicrotask(() => { this.emit('close'); callback?.(); });
    }
    destroy(error?: unknown): void {
      this.destroyed = true;
      if (error) this.emit('error', error);
      this.emit('close');
    }
  }

  function connect(_authority: unknown, _options?: unknown, _listener?: unknown) {
    return new ClientHttp2Session();
  }
  function createServer(_options?: unknown, _onRequestHandler?: unknown): never { throw notSupported('createServer'); }
  function createSecureServer(_options?: unknown, _onRequestHandler?: unknown): never { throw notSupported('createSecureServer'); }
  function performServerHandshake(_socket: unknown, _options = {}): never { throw notSupported('performServerHandshake'); }

  // Node's compatibility API classes. They exist so code can test against
  // them; only an HTTP/2 stream makes one, and Nimbus has none.
  class Http2ServerRequest extends host.Readable {
    constructor(_stream: unknown, _headers: unknown, _options: unknown, _rawHeaders: unknown) {
      super();
      throw notSupported('Http2ServerRequest');
    }
  }
  class Http2ServerResponse extends host.Stream {
    constructor(_stream: unknown, _options: unknown) {
      super();
      throw notSupported('Http2ServerResponse');
    }
  }

  const constants: Record<string, number | string> = {
    NGHTTP2_ERR_FRAME_SIZE_ERROR: -522, NGHTTP2_SESSION_SERVER: 0, NGHTTP2_SESSION_CLIENT: 1,
    NGHTTP2_STREAM_STATE_IDLE: 1, NGHTTP2_STREAM_STATE_OPEN: 2, NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
    NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4, NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6, NGHTTP2_STREAM_STATE_CLOSED: 7, NGHTTP2_FLAG_NONE: 0,
    NGHTTP2_FLAG_END_STREAM: 1, NGHTTP2_FLAG_END_HEADERS: 4, NGHTTP2_FLAG_ACK: 1, NGHTTP2_FLAG_PADDED: 8,
    NGHTTP2_FLAG_PRIORITY: 32, DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096, DEFAULT_SETTINGS_ENABLE_PUSH: 1,
    DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295, DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535,
    DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384, DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,
    DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0, MAX_MAX_FRAME_SIZE: 16777215, MIN_MAX_FRAME_SIZE: 16384,
    MAX_INITIAL_WINDOW_SIZE: 2147483647, NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1, NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
    NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3, NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
    NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5, NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
    NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8, PADDING_STRATEGY_NONE: 0, PADDING_STRATEGY_ALIGNED: 1,
    PADDING_STRATEGY_MAX: 2, PADDING_STRATEGY_CALLBACK: 1, NGHTTP2_NO_ERROR: 0, NGHTTP2_PROTOCOL_ERROR: 1,
    NGHTTP2_INTERNAL_ERROR: 2, NGHTTP2_FLOW_CONTROL_ERROR: 3, NGHTTP2_SETTINGS_TIMEOUT: 4,
    NGHTTP2_STREAM_CLOSED: 5, NGHTTP2_FRAME_SIZE_ERROR: 6, NGHTTP2_REFUSED_STREAM: 7, NGHTTP2_CANCEL: 8,
    NGHTTP2_COMPRESSION_ERROR: 9, NGHTTP2_CONNECT_ERROR: 10, NGHTTP2_ENHANCE_YOUR_CALM: 11,
    NGHTTP2_INADEQUATE_SECURITY: 12, NGHTTP2_HTTP_1_1_REQUIRED: 13, NGHTTP2_DEFAULT_WEIGHT: 16,
    HTTP2_HEADER_STATUS: ":status", HTTP2_HEADER_METHOD: ":method", HTTP2_HEADER_AUTHORITY: ":authority",
    HTTP2_HEADER_SCHEME: ":scheme", HTTP2_HEADER_PATH: ":path", HTTP2_HEADER_PROTOCOL: ":protocol",
    HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding", HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language",
    HTTP2_HEADER_ACCEPT_RANGES: "accept-ranges", HTTP2_HEADER_ACCEPT: "accept",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: "access-control-allow-credentials",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: "access-control-allow-headers",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: "access-control-allow-methods",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: "access-control-allow-origin",
    HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: "access-control-expose-headers",
    HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: "access-control-request-headers",
    HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: "access-control-request-method", HTTP2_HEADER_AGE: "age",
    HTTP2_HEADER_AUTHORIZATION: "authorization", HTTP2_HEADER_CACHE_CONTROL: "cache-control",
    HTTP2_HEADER_CONNECTION: "connection", HTTP2_HEADER_CONTENT_DISPOSITION: "content-disposition",
    HTTP2_HEADER_CONTENT_ENCODING: "content-encoding", HTTP2_HEADER_CONTENT_LENGTH: "content-length",
    HTTP2_HEADER_CONTENT_TYPE: "content-type", HTTP2_HEADER_COOKIE: "cookie", HTTP2_HEADER_DATE: "date",
    HTTP2_HEADER_ETAG: "etag", HTTP2_HEADER_FORWARDED: "forwarded", HTTP2_HEADER_HOST: "host",
    HTTP2_HEADER_IF_MODIFIED_SINCE: "if-modified-since", HTTP2_HEADER_IF_NONE_MATCH: "if-none-match",
    HTTP2_HEADER_IF_RANGE: "if-range", HTTP2_HEADER_LAST_MODIFIED: "last-modified", HTTP2_HEADER_LINK: "link",
    HTTP2_HEADER_LOCATION: "location", HTTP2_HEADER_RANGE: "range", HTTP2_HEADER_REFERER: "referer",
    HTTP2_HEADER_SERVER: "server", HTTP2_HEADER_SET_COOKIE: "set-cookie",
    HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: "strict-transport-security",
    HTTP2_HEADER_TRANSFER_ENCODING: "transfer-encoding", HTTP2_HEADER_TE: "te",
    HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: "upgrade-insecure-requests", HTTP2_HEADER_UPGRADE: "upgrade",
    HTTP2_HEADER_USER_AGENT: "user-agent", HTTP2_HEADER_VARY: "vary",
    HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: "x-content-type-options",
    HTTP2_HEADER_X_FRAME_OPTIONS: "x-frame-options", HTTP2_HEADER_KEEP_ALIVE: "keep-alive",
    HTTP2_HEADER_PROXY_CONNECTION: "proxy-connection", HTTP2_HEADER_X_XSS_PROTECTION: "x-xss-protection",
    HTTP2_HEADER_ALT_SVC: "alt-svc", HTTP2_HEADER_CONTENT_SECURITY_POLICY: "content-security-policy",
    HTTP2_HEADER_EARLY_DATA: "early-data", HTTP2_HEADER_EXPECT_CT: "expect-ct", HTTP2_HEADER_ORIGIN: "origin",
    HTTP2_HEADER_PURPOSE: "purpose", HTTP2_HEADER_TIMING_ALLOW_ORIGIN: "timing-allow-origin",
    HTTP2_HEADER_X_FORWARDED_FOR: "x-forwarded-for", HTTP2_HEADER_PRIORITY: "priority",
    HTTP2_HEADER_ACCEPT_CHARSET: "accept-charset", HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: "access-control-max-age",
    HTTP2_HEADER_ALLOW: "allow", HTTP2_HEADER_CONTENT_LANGUAGE: "content-language",
    HTTP2_HEADER_CONTENT_LOCATION: "content-location", HTTP2_HEADER_CONTENT_MD5: "content-md5",
    HTTP2_HEADER_CONTENT_RANGE: "content-range", HTTP2_HEADER_DNT: "dnt", HTTP2_HEADER_EXPECT: "expect",
    HTTP2_HEADER_EXPIRES: "expires", HTTP2_HEADER_FROM: "from", HTTP2_HEADER_IF_MATCH: "if-match",
    HTTP2_HEADER_IF_UNMODIFIED_SINCE: "if-unmodified-since", HTTP2_HEADER_MAX_FORWARDS: "max-forwards",
    HTTP2_HEADER_PREFER: "prefer", HTTP2_HEADER_PROXY_AUTHENTICATE: "proxy-authenticate",
    HTTP2_HEADER_PROXY_AUTHORIZATION: "proxy-authorization", HTTP2_HEADER_REFRESH: "refresh",
    HTTP2_HEADER_RETRY_AFTER: "retry-after", HTTP2_HEADER_TRAILER: "trailer", HTTP2_HEADER_TK: "tk",
    HTTP2_HEADER_VIA: "via", HTTP2_HEADER_WARNING: "warning", HTTP2_HEADER_WWW_AUTHENTICATE: "www-authenticate",
    HTTP2_HEADER_HTTP2_SETTINGS: "http2-settings", HTTP2_METHOD_ACL: "ACL",
    HTTP2_METHOD_BASELINE_CONTROL: "BASELINE-CONTROL", HTTP2_METHOD_BIND: "BIND",
    HTTP2_METHOD_CHECKIN: "CHECKIN", HTTP2_METHOD_CHECKOUT: "CHECKOUT", HTTP2_METHOD_CONNECT: "CONNECT",
    HTTP2_METHOD_COPY: "COPY", HTTP2_METHOD_DELETE: "DELETE", HTTP2_METHOD_GET: "GET", HTTP2_METHOD_HEAD: "HEAD",
    HTTP2_METHOD_LABEL: "LABEL", HTTP2_METHOD_LINK: "LINK", HTTP2_METHOD_LOCK: "LOCK",
    HTTP2_METHOD_MERGE: "MERGE", HTTP2_METHOD_MKACTIVITY: "MKACTIVITY", HTTP2_METHOD_MKCALENDAR: "MKCALENDAR",
    HTTP2_METHOD_MKCOL: "MKCOL", HTTP2_METHOD_MKREDIRECTREF: "MKREDIRECTREF",
    HTTP2_METHOD_MKWORKSPACE: "MKWORKSPACE", HTTP2_METHOD_MOVE: "MOVE", HTTP2_METHOD_OPTIONS: "OPTIONS",
    HTTP2_METHOD_ORDERPATCH: "ORDERPATCH", HTTP2_METHOD_PATCH: "PATCH", HTTP2_METHOD_POST: "POST",
    HTTP2_METHOD_PRI: "PRI", HTTP2_METHOD_PROPFIND: "PROPFIND", HTTP2_METHOD_PROPPATCH: "PROPPATCH",
    HTTP2_METHOD_PUT: "PUT", HTTP2_METHOD_REBIND: "REBIND", HTTP2_METHOD_REPORT: "REPORT",
    HTTP2_METHOD_SEARCH: "SEARCH", HTTP2_METHOD_TRACE: "TRACE", HTTP2_METHOD_UNBIND: "UNBIND",
    HTTP2_METHOD_UNCHECKOUT: "UNCHECKOUT", HTTP2_METHOD_UNLINK: "UNLINK", HTTP2_METHOD_UNLOCK: "UNLOCK",
    HTTP2_METHOD_UPDATE: "UPDATE", HTTP2_METHOD_UPDATEREDIRECTREF: "UPDATEREDIRECTREF",
    HTTP2_METHOD_VERSION_CONTROL: "VERSION-CONTROL", HTTP_STATUS_CONTINUE: 100,
    HTTP_STATUS_SWITCHING_PROTOCOLS: 101, HTTP_STATUS_PROCESSING: 102, HTTP_STATUS_EARLY_HINTS: 103,
    HTTP_STATUS_OK: 200, HTTP_STATUS_CREATED: 201, HTTP_STATUS_ACCEPTED: 202,
    HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203, HTTP_STATUS_NO_CONTENT: 204, HTTP_STATUS_RESET_CONTENT: 205,
    HTTP_STATUS_PARTIAL_CONTENT: 206, HTTP_STATUS_MULTI_STATUS: 207, HTTP_STATUS_ALREADY_REPORTED: 208,
    HTTP_STATUS_IM_USED: 226, HTTP_STATUS_MULTIPLE_CHOICES: 300, HTTP_STATUS_MOVED_PERMANENTLY: 301,
    HTTP_STATUS_FOUND: 302, HTTP_STATUS_SEE_OTHER: 303, HTTP_STATUS_NOT_MODIFIED: 304,
    HTTP_STATUS_USE_PROXY: 305, HTTP_STATUS_TEMPORARY_REDIRECT: 307, HTTP_STATUS_PERMANENT_REDIRECT: 308,
    HTTP_STATUS_BAD_REQUEST: 400, HTTP_STATUS_UNAUTHORIZED: 401, HTTP_STATUS_PAYMENT_REQUIRED: 402,
    HTTP_STATUS_FORBIDDEN: 403, HTTP_STATUS_NOT_FOUND: 404, HTTP_STATUS_METHOD_NOT_ALLOWED: 405,
    HTTP_STATUS_NOT_ACCEPTABLE: 406, HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407,
    HTTP_STATUS_REQUEST_TIMEOUT: 408, HTTP_STATUS_CONFLICT: 409, HTTP_STATUS_GONE: 410,
    HTTP_STATUS_LENGTH_REQUIRED: 411, HTTP_STATUS_PRECONDITION_FAILED: 412, HTTP_STATUS_PAYLOAD_TOO_LARGE: 413,
    HTTP_STATUS_URI_TOO_LONG: 414, HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415,
    HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416, HTTP_STATUS_EXPECTATION_FAILED: 417, HTTP_STATUS_TEAPOT: 418,
    HTTP_STATUS_MISDIRECTED_REQUEST: 421, HTTP_STATUS_UNPROCESSABLE_ENTITY: 422, HTTP_STATUS_LOCKED: 423,
    HTTP_STATUS_FAILED_DEPENDENCY: 424, HTTP_STATUS_TOO_EARLY: 425, HTTP_STATUS_UPGRADE_REQUIRED: 426,
    HTTP_STATUS_PRECONDITION_REQUIRED: 428, HTTP_STATUS_TOO_MANY_REQUESTS: 429,
    HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431, HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451,
    HTTP_STATUS_INTERNAL_SERVER_ERROR: 500, HTTP_STATUS_NOT_IMPLEMENTED: 501, HTTP_STATUS_BAD_GATEWAY: 502,
    HTTP_STATUS_SERVICE_UNAVAILABLE: 503, HTTP_STATUS_GATEWAY_TIMEOUT: 504,
    HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505, HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506,
    HTTP_STATUS_INSUFFICIENT_STORAGE: 507, HTTP_STATUS_LOOP_DETECTED: 508,
    HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509, HTTP_STATUS_NOT_EXTENDED: 510,
    HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511,
  };

  return {
    connect,
    constants,
    createServer,
    createSecureServer,
    getDefaultSettings,
    getPackedSettings,
    getUnpackedSettings,
    performServerHandshake,
    sensitiveHeaders: Symbol('sensitiveHeaders'),
    Http2ServerRequest,
    Http2ServerResponse,
  };
}
