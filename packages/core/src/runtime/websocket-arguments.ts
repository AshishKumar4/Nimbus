// Node v22.22.3's undici WebSocket/WebIDL entrypoints. Native WebSocket has
// no message-transport hook; conversions stay here, separate from the relay.
const toUSVString = (value: unknown): string => {
  const string = `${value as string}` as string & { toWellFormed(): string };
  return string.toWellFormed();
};
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const isArrayBuffer = (value: unknown): value is ArrayBuffer => {
  try { Reflect.apply(arrayBufferLength, value, []); return true; }
  catch { return false; }
};
const object = (value: unknown): value is Record<PropertyKey, unknown> => value !== null && (typeof value === 'object' || typeof value === 'function');
const domString = (value: unknown): string => {
  if (typeof value === 'symbol') throw new TypeError('A symbol cannot be converted to a DOMString');
  return String(value);
};
const protocols = (value: unknown): string[] => {
  if (object(value) && Symbol.iterator in value) {
    const method = value[Symbol.iterator];
    if (typeof method !== 'function') throw new TypeError('Protocols are not iterable');
    const iterator = Reflect.apply(method, value, []) as Iterator<unknown>;
    if (!iterator || typeof iterator.next !== 'function') throw new TypeError('Protocols are not iterable');
    const sequence = [];
    for (;;) {
      const next = iterator.next();
      if (next.done) return sequence;
      sequence.push(domString(next.value));
    }
  }
  return [domString(value)];
};

export function webSocketConstructor(input: unknown, options: unknown): { url: URL; headers: Headers } {
  const init = object(options) && !(Symbol.iterator in options) ? options : { protocols: options };
  const protocolValue = init.protocols;
  const offered = protocols(protocolValue === undefined ? [] : protocolValue);
  void init.dispatcher;
  const headerValue = init.headers;
  const headers = new Headers(headerValue == null ? undefined : headerValue as HeadersInit);
  const text = toUSVString(input as string);
  const url = (() => {
    try { return new URL(text); }
    catch (error) { throw new DOMException(String(error), 'SyntaxError'); }
  })();
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new DOMException('Invalid WebSocket protocol', 'SyntaxError');
  if (url.hash || url.href.endsWith('#')) throw new DOMException('Got fragment', 'SyntaxError');
  if (new Set(offered.map((part) => part.toLowerCase())).size !== offered.length
    || offered.some((part) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(part))) throw new DOMException('Invalid Sec-WebSocket-Protocol value', 'SyntaxError');
  headers.set('Upgrade', 'websocket');
  if (offered.length) headers.set('Sec-WebSocket-Protocol', offered.join(', '));
  return { url, headers };
}

export function webSocketSend(value: unknown): string | Uint8Array | Blob {
  if (object(value)) {
    const tag = value[Symbol.toStringTag];
    if (value instanceof Blob || ((tag === 'Blob' || tag === 'File')
      && (typeof value.stream === 'function' || typeof value.arrayBuffer === 'function'))) {
      const blob = value as unknown as Blob;
      return blob;
    }
    if (ArrayBuffer.isView(value) || isArrayBuffer(value)) {
      const buffer = ArrayBuffer.isView(value) ? value.buffer : value;
      if (!isArrayBuffer(buffer)) throw new TypeError('SharedArrayBuffer is not allowed');
      if ('resizable' in buffer && buffer.resizable || 'growable' in buffer && buffer.growable) throw new TypeError('Received a resizable ArrayBuffer');
      const data = ArrayBuffer.isView(value)
        ? new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) : new Uint8Array(new Uint8Array(buffer));
      return data;
    }
  }
  return toUSVString(value as string);
}

export function webSocketClose(code: unknown, reason: unknown): { code: number | undefined; reason: string } {
  let number: number | undefined;
  if (code !== undefined) {
    let value = Number(code);
    if (!Number.isNaN(value)) {
      value = Math.min(Math.max(value, 0), 65535);
      value = Math.floor(value) % 2 === 0 ? Math.floor(value) : Math.ceil(value);
    } else value = 0;
    number = value;
  }
  const text = reason === undefined ? '' : toUSVString(reason as string);
  if (number !== undefined && number !== 1000 && (number < 3000 || number > 4999)) throw new DOMException('invalid code', 'InvalidAccessError');
  if (new TextEncoder().encode(text).byteLength > 123) throw new DOMException('Reason must be less than 123 bytes', 'SyntaxError');
  return { code: number, reason: text };
}
