/**
 * git/pack/upload-pack.ts — the client side of git's smart HTTP fetch
 * (Documentation/gitprotocol-http.txt, gitprotocol-pack.txt), protocol v0.
 *
 * discover() reads the advertisement; requestPack() sends one request (wants,
 * shallows, deepen, filter, haves, done: no multi-round negotiation) and
 * returns the shallow lines and the pack as a stream that is read only as
 * fast as its consumer pulls, so nothing between the network and the pack
 * processor buffers more than one side-band packet.
 */

import { retrying } from '@nimbus-sh/platform/retry.js';
import { RETRY_ATTEMPTS, RETRY_BACKOFF_MS, STALL_MS, TRANSIENT_HTTP_STATUSES, UPLOAD_PACK_ERROR_PREFIX } from './transport.js';
import { PackFormatError } from './format.js';

export interface GitTransportAuth {
  username: string;
  password: string;
}

export interface UploadPackOptions {
  url: string;
  auth?: GitTransportAuth;
  /**
   * The server's progress (side-band 2), a finished line at a time: a
   * phase's last line ("Compressing objects: 100% (42/42), done.") and its
   * summary ("Total ..."), not every percentage step it redraws over.
   */
  onProgress?(line: string): void;
  /** For tests: the fetch to use. */
  fetch?: typeof fetch;
  /** How long a response may send nothing (STALL_MS). */
  stallMs?: number;
  signal?: AbortSignal;
}

export interface Advertisement {
  /** Ref name → id, peeled tags under "<name>^{}". */
  refs: Map<string, string>;
  /** Symbolic refs the server named (symref=HEAD:refs/heads/main). */
  symrefs: Map<string, string>;
  capabilities: Set<string>;
}

export interface PackRequest {
  wants: readonly string[];
  haves?: readonly string[];
  /** The receiver's shallow commits (its .git/shallow). */
  shallows?: readonly string[];
  depth?: number;
  filter?: string;
  /** Ask for a thin pack: deltas against `haves` the server need not send. */
  thin?: boolean;
}

export interface PackResponse {
  shallows: string[];
  unshallows: string[];
  /** The pack's bytes; null when the server answered that there is nothing to send. */
  pack: AsyncIterable<Uint8Array> | null;
}

export class UploadPackError extends Error {
  constructor(message: string, readonly status?: number) {
    super(UPLOAD_PACK_ERROR_PREFIX + message);
    this.name = 'UploadPackError';
  }
}

const AGENT = 'agent=git/nimbus';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function pktLine(text: string): Uint8Array {
  const body = encoder.encode(text);
  const out = new Uint8Array(body.byteLength + 4);
  out.set(encoder.encode((body.byteLength + 4).toString(16).padStart(4, '0')));
  out.set(body, 4);
  return out;
}

function headers(options: UploadPackOptions, extra: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = { 'user-agent': 'git/nimbus', ...extra };
  if (options.auth && (options.auth.username || options.auth.password)) {
    result.authorization = 'Basic ' + btoa(options.auth.username + ':' + options.auth.password);
  }
  return result;
}

function repoUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** A request whose transient failures are retried before any byte is read (transport.ts). */
async function send(options: UploadPackOptions, path: string, init: RequestInit): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  // Headers that do not come within the stall time are a stall too.
  const stallMs = options.stallMs ?? STALL_MS;
  const attempt = async (): Promise<Response> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UploadPackError('no response for ' + Math.round(stallMs / 1000) + ' s')), stallMs);
    });
    try {
      return await Promise.race([doFetch(repoUrl(options.url) + path, { ...init, signal: options.signal }), stalled]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
  try {
    return await retrying(attempt, {
      retries: RETRY_ATTEMPTS - 1,
      schedule: RETRY_BACKOFF_MS,
      retryReason: (outcome) => !outcome.ok ? 'failed in transit'
        : TRANSIENT_HTTP_STATUSES.has(outcome.value.status) ? 'HTTP ' + outcome.value.status
        : null,
      discard: (response) => response.body?.cancel(),
    });
  } catch (error) {
    throw error instanceof UploadPackError ? error : new UploadPackError('the request failed: ' + (error instanceof Error ? error.message : String(error)));
  }
}

export { STALL_MS };

/** pkt-lines off a byte stream, pulled one at a time; null is a flush. */
class PktReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly stallMs = STALL_MS) {}

  /** The next chunk, or a stall error when none comes in time (the read is cancelled). */
  private read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new UploadPackError('the server sent nothing for ' + Math.round(this.stallMs / 1000) + ' s'));
        void this.reader.cancel().catch(() => undefined);
      }, this.stallMs);
    });
    const read = this.reader.read().catch((error: unknown) => {
      // A response cut off mid-stream is the transport's failure, as a stall is.
      throw error instanceof UploadPackError ? error
        : new UploadPackError('the response broke off: ' + (error instanceof Error ? error.message : String(error)));
    });
    return Promise.race([read, stalled]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  }

  private async fill(needed: number): Promise<boolean> {
    while (this.buffer.byteLength < needed) {
      if (this.done) return false;
      const { done, value } = await this.read();
      if (done) {
        this.done = true;
        return this.buffer.byteLength >= needed;
      }
      if (this.buffer.byteLength === 0) {
        this.buffer = value;
      } else {
        const merged = new Uint8Array(this.buffer.byteLength + value.byteLength);
        merged.set(this.buffer);
        merged.set(value, this.buffer.byteLength);
        this.buffer = merged;
      }
    }
    return true;
  }

  /** The next packet's payload, null for a flush, undefined at the stream's end. */
  async next(): Promise<Uint8Array | null | undefined> {
    if (!await this.fill(4)) {
      if (this.buffer.byteLength === 0) return undefined;
      throw new UploadPackError('stream ended inside a packet length');
    }
    const length = parseInt(decoder.decode(this.buffer.subarray(0, 4)), 16);
    if (!Number.isInteger(length) || (length > 0 && length < 4)) throw new UploadPackError('bad packet length');
    if (length === 0 || length === 1 || length === 2) {
      this.buffer = this.buffer.subarray(4);
      return null;
    }
    if (!await this.fill(length)) throw new UploadPackError('stream ended inside a packet');
    const payload = this.buffer.subarray(4, length);
    this.buffer = this.buffer.subarray(length);
    return payload;
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

function text(payload: Uint8Array): string {
  const line = decoder.decode(payload);
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

export async function discover(options: UploadPackOptions): Promise<Advertisement> {
  const response = await send(options, '/info/refs?service=git-upload-pack', {
    headers: headers(options, { accept: 'application/x-git-upload-pack-advertisement' }),
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new UploadPackError('authentication failed (HTTP ' + response.status + ')', response.status);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new UploadPackError('discovery answered HTTP ' + response.status, response.status);
  }
  const reader = new PktReader(response.body.getReader(), options.stallMs);
  const first = await reader.next();
  if (!first || text(first) !== '# service=git-upload-pack') throw new UploadPackError('not a smart HTTP server');
  if (await reader.next() !== null) throw new UploadPackError('advertisement header lacks its flush');
  const advertisement: Advertisement = { refs: new Map(), symrefs: new Map(), capabilities: new Set() };
  let firstRef = true;
  for (;;) {
    const payload = await reader.next();
    if (payload === null || payload === undefined) break;
    let line = text(payload);
    if (firstRef) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const capability of line.slice(nul + 1).split(' ')) {
          if (!capability) continue;
          advertisement.capabilities.add(capability);
          if (capability.startsWith('symref=')) {
            const [from, to] = capability.slice('symref='.length).split(':');
            if (from && to) advertisement.symrefs.set(from, to);
          }
        }
        line = line.slice(0, nul);
      }
      firstRef = false;
    }
    const space = line.indexOf(' ');
    const oid = line.slice(0, space);
    const name = line.slice(space + 1);
    if (name === 'capabilities^{}') continue;
    advertisement.refs.set(name, oid);
  }
  await reader.cancel().catch(() => undefined);
  return advertisement;
}

/** Capabilities to ask for, from those the server offers. */
function requestCapabilities(advertised: Set<string>, request: PackRequest): string[] {
  // include-tag: annotated tags of the objects sent come with them, as git asks (clone follows them).
  const capabilities = ['side-band-64k', 'ofs-delta', 'include-tag'].filter((capability) => advertised.has(capability));
  if (!advertised.has('side-band-64k')) throw new UploadPackError('the server does not offer side-band-64k');
  if (request.thin && advertised.has('thin-pack')) capabilities.push('thin-pack');
  if (request.depth !== undefined || (request.shallows?.length ?? 0) > 0) {
    if (!advertised.has('shallow')) throw new UploadPackError('the server does not support shallow fetches');
    capabilities.push('shallow');
  }
  if (request.filter !== undefined) {
    if (!advertised.has('filter')) throw new UploadPackError('the server does not support --filter');
    capabilities.push('filter');
  }
  capabilities.push(AGENT);
  return capabilities;
}

/** One request, and the pack it answers with. */
export async function requestPack(options: UploadPackOptions, advertised: Set<string>, request: PackRequest): Promise<PackResponse> {
  if (request.wants.length === 0) throw new UploadPackError('a fetch wants at least one object');
  const capabilities = requestCapabilities(advertised, request);
  const lines: Uint8Array[] = [];
  request.wants.forEach((oid, index) => lines.push(pktLine('want ' + oid + (index === 0 ? ' ' + capabilities.join(' ') : '') + '\n')));
  for (const oid of request.shallows ?? []) lines.push(pktLine('shallow ' + oid + '\n'));
  if (request.depth !== undefined) lines.push(pktLine('deepen ' + request.depth + '\n'));
  if (request.filter !== undefined) lines.push(pktLine('filter ' + request.filter + '\n'));
  lines.push(encoder.encode('0000'));
  for (const oid of request.haves ?? []) lines.push(pktLine('have ' + oid + '\n'));
  lines.push(pktLine('done\n'));
  let total = 0;
  for (const line of lines) total += line.byteLength;
  const body = new Uint8Array(total);
  let at = 0;
  for (const line of lines) {
    body.set(line, at);
    at += line.byteLength;
  }

  const response = await send(options, '/git-upload-pack', {
    method: 'POST',
    body,
    headers: headers(options, {
      'content-type': 'application/x-git-upload-pack-request',
      accept: 'application/x-git-upload-pack-result',
    }),
  });
  if (!response.ok || !response.body) {
    const detail = response.body ? (await response.text()).slice(0, 300) : '';
    throw new UploadPackError('the request answered HTTP ' + response.status + (detail ? ': ' + detail : ''), response.status);
  }
  const reader = new PktReader(response.body.getReader(), options.stallMs);
  const result: PackResponse = { shallows: [], unshallows: [], pack: null };

  // shallow-info (after deepen or shallow lines), then ACK/NAK.
  for (;;) {
    const payload = await reader.next();
    if (payload === undefined) throw new UploadPackError('the response ended before its acknowledgement');
    if (payload === null) continue;
    const line = text(payload);
    if (line.startsWith('shallow ')) result.shallows.push(line.slice(8));
    else if (line.startsWith('unshallow ')) result.unshallows.push(line.slice(10));
    else if (line === 'NAK' || line.startsWith('ACK ')) break;
    else if (line.startsWith('ERR ')) throw new UploadPackError(line.slice(4));
    else throw new UploadPackError('unexpected line ' + JSON.stringify(line.slice(0, 80)));
  }
  result.pack = sideBandPack(reader, options.onProgress);
  return result;
}

/** Band 1 of side-band-64k, pulled packet by packet; band 2 is progress, band 3 a fatal error. */
async function* sideBandPack(reader: PktReader, onProgress?: (line: string) => void): AsyncGenerator<Uint8Array> {
  let finished = false;
  let partial = '';
  const progress = (text: string): void => {
    if (!onProgress) return;
    // A redraw ends in \r, a finished line in \n.
    const lines = (partial + text).split(/\r|\n/);
    partial = lines.pop() ?? '';
    for (const line of lines) if (/, done\.$|^Total /.test(line)) onProgress(line);
  };
  try {
    for (;;) {
      const payload = await reader.next();
      if (payload === undefined || payload === null) {
        finished = true;
        return;
      }
      const band = payload[0];
      if (band === 1) yield payload.subarray(1);
      else if (band === 2) progress(decoder.decode(payload.subarray(1)));
      else if (band === 3) throw new UploadPackError('remote error: ' + decoder.decode(payload.subarray(1)).trim());
      else throw new PackFormatError('side-band packet on unknown band ' + band);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
  }
}
