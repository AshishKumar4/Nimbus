import { toUSVString, types } from 'node:util';

// Node v22.22.3's undici WebSocket/WebIDL entrypoints. Native WebSocket has
// no message-transport hook; conversions stay here, separate from the relay.
const object = (value: unknown): value is Record<PropertyKey, unknown> => value !== null && (typeof value === 'object' || typeof value === 'function');
const domString = (value: unknown): string => {
  if (typeof value === 'symbol') throw new TypeError('A symbol cannot be converted to a DOMString');
  return String(value);
};
const protocols = (value: unknown): string[] => {
  if (object(value) && Symbol.iterator in value) return Array.from(value as unknown as Iterable<unknown>, domString);
  return [domString(value)];
};

export function webSocketConstructor(input: unknown, options: unknown): { url: URL; headers: Headers } {
  const init = object(options) && !(Symbol.iterator in options) ? options : { protocols: options };
  const offered = protocols(init.protocols === undefined ? [] : init.protocols);
  const headers = new Headers(init.headers == null ? undefined : init.headers as HeadersInit);
  const url = (() => {
    try { return new URL(toUSVString(input as string)); }
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

export function webSocketSend(value: unknown): { data: string | Uint8Array | Promise<Uint8Array>; length: number } {
  if (object(value)) {
    const tag = value[Symbol.toStringTag];
    if (value instanceof Blob || ((tag === 'Blob' || tag === 'File')
      && (typeof value.stream === 'function' || typeof value.arrayBuffer === 'function'))) {
      const blob = value as unknown as Blob;
      return { data: blob.arrayBuffer().then((buffer) => new Uint8Array(buffer)), length: blob.size };
    }
    if (ArrayBuffer.isView(value) || types.isArrayBuffer(value)) {
      const buffer = ArrayBuffer.isView(value) ? value.buffer : value as ArrayBuffer;
      if ('resizable' in buffer && buffer.resizable || 'growable' in buffer && buffer.growable) throw new TypeError('Received a resizable ArrayBuffer');
      const data = ArrayBuffer.isView(value)
        ? new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) : new Uint8Array(new Uint8Array(buffer));
      return { data, length: data.byteLength };
    }
  }
  const data = toUSVString(value as string);
  return { data, length: new TextEncoder().encode(data).byteLength };
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
